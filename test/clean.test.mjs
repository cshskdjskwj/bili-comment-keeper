/**
 * clean.test.mjs —— 删除链路（控制台侧）的回归测试
 *
 * 为什么专门给这块写测试：删除依赖一条**跨三个世界**的链路
 *   注入 bilibili 页面(MAIN) → 页面回传 → 内容脚本(ISOLATED) → 控制台
 * 这条链上任何一环断了，外在表现都是「点了删除之后一片安静」，然后每条各等满超时。
 * 这个坑已经真实发生过两次，而且**单元测试、语法检查、打包验证全抓不到**。
 *
 * clean.js 是个 ES module 而且一加载就碰 DOM，没法直接 import。
 * 所以这里把它当**经典脚本**丢进 vm：去掉 import（改成把 shared.js 的导出铺在全局上）、
 * 去掉末尾的 init()，于是里面的顶层 function 声明都变成可以直接调的全局函数。
 * 测的是真代码，不是复制品。
 *
 * 纯 Node，零依赖：node test/clean.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`      ${(e && e.message) || e}`);
    failed++;
  }
}

/* --------------------------------------------------- 把 clean.js 装进 vm */

const CLEAN_PATH = fileURLToPath(new URL('../src/../clean/clean.js', import.meta.url));
const RAW = readFileSync(CLEAN_PATH, 'utf8');

const SRC = RAW
  // import 换成「shared 的导出已经在全局上」
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\.\/src\/shared\.js';\s*$/m, '')
  // 末尾那句 init() 会在加载时碰 DOM，去掉
  .replace(/^init\(\)\.catch\(.*$/m, '');

assert.ok(!/^\s*import\s/m.test(SRC), 'import 应该已经被剥掉');
assert.ok(!/^init\(\)/m.test(SRC), '末尾的 init() 应该已经被剥掉');

/** 一个够用的假 DOM 元素 */
function fakeEl() {
  return {
    textContent: '', className: '', innerHTML: '', disabled: false, checked: true,
    open: false, style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }
  };
}

const els = new Map();
const fakeDoc = {
  cookie: 'bili_jct=deadbeef; SESSDATA=abc',
  getElementById(id) { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};

/** 建一个沙箱；injectHook 决定「注入删除脚本」这一步的行为 */
async function makeSandbox(injectHook) {
  const shared = await import('../src/shared.js');
  const pageStore = {};          // 模拟页面上的 window.__bcDelResults
  const posts = [];              // 模拟页面发出的 postMessage
  const worlds = [];             // 记录每次注入用的世界（MAIN / ISOLATED）

  const chromeStub = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({}),
      getManifest: () => ({ version: '1.2.0' }),
      openOptionsPage() {}
    },
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    bookmarks: {
      getChildren: async () => [], get: async () => null, search: async () => [],
      create: async () => ({ id: 'x' }), move: async () => {}, remove: async () => {}, removeTree: async () => {}
    },
    tabs: {
      query: async () => [], get: async () => ({ id: 1, status: 'complete' }),
      create: async () => ({ id: 1 }), remove: async () => {}, sendMessage: async () => {},
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ args, world }) {
        const a = args || [];
        worlds.push(world || 'MAIN');
        // 轮询读取：args[0] 是字符串（requestId）
        if (typeof a[0] === 'string') {
          return [{ result: pageStore[a[0]] || null }];
        }
        // 注入删除脚本 / 自检探针（自检那次不带 args）
        return await injectHook(a[0], pageStore);
      }
    }
  };

  const sandbox = Object.assign({}, shared, {
    chrome: chromeStub,
    document: fakeDoc,
    console, setTimeout, clearTimeout, clearInterval,
    URL, URLSearchParams, AbortController, Promise,
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, Error
  });

  // fetch 装成 getter/setter：任何测试塞进来的假响应都自动补上 text()。
  // 生产代码要拿 text() 才能分辨「返回的到底是数据、还是被反爬拦成的 HTML」，
  // 但让每个测试桩都手写一遍 text() 太啰嗦，这里统一补上。
  let fetchImpl = async () => ({ status: 200, json: async () => ({ code: 0, message: '' }) });
  Object.defineProperty(sandbox, 'fetch', {
    configurable: true,
    get() {
      return async function (...args) {
        const res = await fetchImpl(...args);
        if (res && typeof res === 'object') {
          if (typeof res.text !== 'function' && typeof res.json === 'function') {
            res.text = async () => JSON.stringify(await res.json());
          }
          if (res.status === undefined) res.status = 200;
        }
        return res;
      };
    },
    set(fn) { fetchImpl = fn; }
  });
  sandbox.window = sandbox;
  sandbox.window.postMessage = m => posts.push(m);

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'clean.js' });

  return { sandbox, pageStore, posts, worlds };
}

console.log('\n删除链路（clean.js）回归测试\n');
console.log('— 注入脚本的回传契约 —');

await test('mainWorldDelete 把结果挂到 window.__bcDelResults 上，同时发出 postMessage', async () => {
  const { sandbox, posts } = await makeSandbox(async () => [{ result: undefined }]);

  const out = await sandbox.mainWorldDelete({ requestId: 'r1', type: 1, oid: '555', rpid: '999' });

  assert.equal(out.requestId, 'r1');
  assert.equal(out.ok, true, '接口返回 code 0，应当算成功');

  // 通道 ①：控制台靠这个来取结果
  const stored = sandbox.window.__bcDelResults && sandbox.window.__bcDelResults.r1;
  assert.ok(stored, '必须写进 window.__bcDelResults —— 这是主通道的数据来源');
  assert.deepEqual(JSON.parse(JSON.stringify(stored)),
    { ok: true, code: 0, message: '', requestId: 'r1' });

  // 通道 ②：兜底的老路子
  assert.ok(posts.some(m => m && m.__bcDeleterResult && m.__bcDeleterResult.requestId === 'r1'),
    '也应该发出 __bcDeleterResult');
});

await test('页面读不到 bili_jct 时，回传的是可读的失败原因', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const saved = sandbox.document.cookie;
  sandbox.document.cookie = 'SESSDATA=abc';

  const out = await sandbox.mainWorldDelete({ requestId: 'r2', type: 1, oid: '5', rpid: '9' });
  assert.equal(out.ok, false);
  assert.match(out.message, /bili_jct/);

  sandbox.document.cookie = saved;
});

await test('接口报错时把 code 原样带回（交给 explainCode 翻译）', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ json: async () => ({ code: -509, message: '请求过于频繁' }) });

  const out = await sandbox.mainWorldDelete({ requestId: 'r3', type: 1, oid: '5', rpid: '9' });
  assert.equal(out.ok, false);
  assert.equal(out.code, -509);
  assert.equal(sandbox.window.__bcDelResults.r3.code, -509);
});

console.log('\n— deleteOne 的两条回传通道 —');

await test('主通道：控制台自己轮询页面上的结果（不依赖内容脚本）', async () => {
  // 注入后 550ms 才把结果写到页面上；期间内容脚本那条通道完全不参与
  const { sandbox, pageStore } = await makeSandbox(async (arg, store) => {
    setTimeout(() => {
      store[arg.requestId] = { requestId: arg.requestId, ok: true, code: 0, message: '' };
    }, 550);
    return [{ result: undefined }];
  });

  const r = await sandbox.deleteOne(1, { type: 1, oid: '5', rpid: '9' });
  assert.equal(r.ok, true, '应当拿到成功结果');
  assert.equal(r.code, 0);
});

await test('主通道带回失败码时原样透出', async () => {
  const { sandbox } = await makeSandbox(async (arg, store) => {
    setTimeout(() => {
      store[arg.requestId] = { requestId: arg.requestId, ok: false, code: 12022, message: '该评论已经被删除了' };
    }, 550);
    return [{ result: undefined }];
  });

  const r = await sandbox.deleteOne(1, { type: 1, oid: '5', rpid: '9' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 12022, '早就删过的标记必须原样带回，面板靠它记账');
});

await test('注入抛错（标签页被关了）会标记 tabGone，交给上层换标签页重试', async () => {
  const { sandbox } = await makeSandbox(async () => { throw new Error('No tab with id: 1'); });

  const r = await sandbox.deleteOne(1, { type: 1, oid: '5', rpid: '9' });
  assert.equal(r.tabGone, true);
  assert.match(r.message, /注入网页失败/);
});

await test('页面一直不回话时，给出可读的超时原因而不是永远卡住', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.BC_DELETE_TIMEOUT_MS = 2500;   // 生产是 23 秒，测试里调小

  const t0 = Date.now();
  const r = await sandbox.deleteOne(1, { type: 1, oid: '5', rpid: '9' });
  const took = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.match(r.message, /等待页面响应超时/, `实际：${r.message}`);
  assert.ok(took < 8000, `不该拖太久，实际 ${took}ms`);
});

console.log('\n— 开工前自检 —');

await test('自检：注入正常 + 有登录态 → 放行', async () => {
  const { sandbox } = await makeSandbox(async () => [
    { result: { hasJct: true, href: 'https://www.bilibili.com/', ready: 'complete' } }
  ]);
  sandbox.BC_PREFLIGHT_MS = 300;   // 测试里不用真等 6 秒

  const r = await sandbox.preflight(1);
  assert.equal(r.ok, true);
});

await test('自检：注入失败 → 拦下并说明原因', async () => {
  const { sandbox } = await makeSandbox(async () => { throw new Error('Cannot access contents of the page'); });
  const r = await sandbox.preflight(1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /注入脚本失败/);
});

await test('自检：页面里读不到 bili_jct → 拦下并让人去登录', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: { hasJct: false, href: 'https://www.bilibili.com/' } }]);
  const r = await sandbox.preflight(1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /bili_jct/);
});

console.log('\n— 删除目标的解析 —');

await test('aicu 导入的条目直接用自带的 type/oid，不去查索引', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);

  const r = await sandbox.resolveTarget({
    source: 'aicu', type: 1, oid: '555',
    parsed: { rpid: '999', bvid: '', pageUrl: 'https://www.bilibili.com/video/av555' }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(r)), { type: 1, oid: '555', rpid: '999' });
});

await test('aicu 条目的 type 是字符串时也能用', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const r = await sandbox.resolveTarget({
    source: 'aicu', type: '17', oid: 888, parsed: { rpid: '1', bvid: '', pageUrl: '' }
  });
  assert.equal(r.type, 17);
  assert.equal(r.oid, '888');
});

console.log('\n— 存活判定（纯逻辑，拿真实样本对照） —');

await test('判定：12006「没有该评论」→ 已删（样本1就是这个）', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const r = sandbox.interpretReplyCheck({ code: 12006, message: '没有该评论' });
  assert.equal(r.alive, false);
  assert.equal(r.code, 12006);
});

await test('判定：一级评论还在 → 活着，且 rootRpid 就是它自己', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const r = sandbox.interpretReplyCheck({ code: 0, data: { root: { rpid: 317447018496 } } });
  assert.equal(r.alive, true);
  assert.equal(r.rootRpid, '317447018496');
});

await test('判定：会话还在但根评论没了 → 已删', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  assert.equal(sandbox.interpretReplyCheck({ code: 0, data: {} }).alive, false);
});

await test('判定：风控等其它 code 一律「不确定」，绝不误判成已删', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  assert.equal(sandbox.interpretReplyCheck({ code: -509, message: '请求过于频繁' }).alive, null);
  assert.equal(sandbox.interpretReplyCheck(null).alive, null);
  assert.equal(sandbox.interpretReplyCheck({ message: '没有 code' }).alive, null);
});

await test('判定：楼中楼 —— rootRpid 不等于被查的那条，就得再去会话里确认', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  // 样本2：查的是二级评论，B 站把 root 给成了会话的根 316906615664
  const r = sandbox.interpretReplyCheck({ code: 0, data: { root: { rpid: 316906615664 } } });
  assert.equal(r.alive, true, 'code 0 只说明这条会话还在');
  assert.equal(r.rootRpid, '316906615664');
});

await test('buildReplyUrl：参数齐全', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const u = sandbox.buildReplyUrl({ type: 1, oid: '117267354356619', root: '317447018496', pn: 1, ps: 1 });
  assert.match(u, /\/x\/v2\/reply\/reply/);
  assert.match(u, /type=1/);
  assert.match(u, /oid=117267354356619/);
  assert.match(u, /root=317447018496/);
  assert.ok(!/reply\/del/.test(u), '探测绝不能碰删除接口');
});

console.log('\n— 取数据：两条路自动选 —');

await test('扩展直发：通了就直接用，压根不去动标签页', async () => {
  const { sandbox, worlds } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.probeDirectWorks = null;
  sandbox.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 12006 }) });

  const r = await sandbox.fetchReplyRaw({ type: 1, oid: '5', root: '9', pn: 1, ps: 1 });
  assert.equal(r.json.code, 12006);
  assert.equal(sandbox.probeDirectWorks, true);
  assert.equal(worlds.length, 0, '直发通了就不该去借 bilibili 标签页');
});

await test('扩展直发被拦成 HTML → 自动退回借标签页，并记住以后别再试直发', async () => {
  const { sandbox, worlds } = await makeSandbox(async (arg, store) => {
    setTimeout(() => {
      store[arg.requestId] = {
        requestId: arg.requestId, ok: true, status: 200, text: JSON.stringify({ code: 12006 })
      };
    }, 550);
    return [{ result: undefined }];
  });
  sandbox.probeDirectWorks = null;
  sandbox.fetch = async () => ({ status: 412, text: async () => '<!DOCTYPE html><html>风险</html>' });

  const first = await sandbox.fetchReplyRaw({ type: 1, oid: '5', root: '9', pn: 1, ps: 1 });
  assert.equal(first.json.code, 12006, '退回标签页之后应该拿到数据');
  assert.equal(sandbox.probeDirectWorks, false);

  const before = worlds.length;
  const second = await sandbox.fetchReplyRaw({ type: 1, oid: '5', root: '9', pn: 1, ps: 1 });
  assert.equal(second.json.code, 12006);
  assert.equal(sandbox.probeDirectWorks, false, '记住哪条路通，不必每条都重新试错');
  assert.ok(worlds.length > before, '第二次应该直接走标签页那条路');
});

console.log('\n— checkAliveOne：完整判定 —');

await test('一级评论还在 → 活着', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({
    status: 200, text: async () => JSON.stringify({ code: 0, data: { root: { rpid: 999 } } })
  });
  const r = await sandbox.checkAliveOne({ type: 1, oid: '5', rpid: '999' });
  assert.equal(r.alive, true);
});

await test('一级评论没了 → 已删', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 12006 }) });
  const r = await sandbox.checkAliveOne({ type: 1, oid: '5', rpid: '999' });
  assert.equal(r.alive, false);
});

await test('楼中楼：会话里能找到本人 → 活着', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const seen = [];
  sandbox.fetch = async (url) => {
    seen.push(url);
    if (/root=222/.test(url)) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { root: { rpid: 111 } } }) };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { replies: [{ rpid: 222 }, { rpid: 333 }], page: { count: 2 } } })
    };
  };

  const r = await sandbox.checkAliveOne({ type: 1, oid: '5', rpid: '222' });
  assert.equal(r.alive, true);
  assert.ok(seen.length >= 2, '楼中楼必须多问一次会话，光看 code 会误判');
  assert.ok(seen.some(u => /root=111/.test(u)), '要拿解析出来的根评论去查会话');
});

await test('楼中楼：会话还在但本人不在里面 → 已删（样本2的真实情形）', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async (url) => {
    if (/root=999/.test(url)) {
      // B 站把这个二级评论解析到了会话的根
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { root: { rpid: 316906615664 } } }) };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { replies: [{ rpid: 1 }, { rpid: 2 }], page: { count: 2 } } })
    };
  };

  const r = await sandbox.checkAliveOne({ type: 11, oid: '408598859', rpid: '999' });
  assert.equal(r.alive, false, '翻完会话都没有本人 → 判定为已删');
});

await test('楼中楼：会话太长没翻完 → 「不确定」，不能当成已删', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async (url) => {
    if (/ps=1/.test(url)) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { root: { rpid: 111 } } }) };
    }
    // 每次都返回一堆别人的评论，而且 count 远大于我们翻过的量
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { replies: [{ rpid: 7 }], page: { count: 9999 } } })
    };
  };

  const r = await sandbox.checkAliveOne({ type: 1, oid: '5', rpid: '222' });
  assert.equal(r.alive, null, '没确认完就不能下结论');
  assert.match(r.message, /太长/);
});

await test('探测拿不准时的原因会原样带出来（便于排查）', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ status: 412, text: async () => '<!DOCTYPE html><html>风险</html>' });
  sandbox.window.__bcNativeFetch = sandbox.fetch;

  const r = await sandbox.checkAliveOne({ type: 1, oid: '5', rpid: '999' });
  assert.equal(r.alive, null);
  assert.ok(r.message && r.message.length > 0, '必须给得出原因');
});

console.log('\n— 注入的搬运函数 —');

await test('mainWorldFetchReply：用原生 fetch、不带凭据、只把原文带回来', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const calls = [];
  sandbox.window.__bcNativeFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => '{"code":12006}' };
  };
  sandbox.fetch = async () => { throw new Error('不该用被包过的 fetch'); };

  const out = await sandbox.mainWorldFetchReply({ requestId: 'x', type: 1, oid: '5', root: '9', pn: 1, ps: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.text, '{"code":12006}', '只搬运原文，判断交给控制台');
  assert.equal(calls[0].init.credentials, 'omit', '探测不带任何凭据');
  assert.match(calls[0].url, /reply\/reply/);
  assert.ok(sandbox.window.__bcDelResults.x, '结果要写进结果槽，供控制台取回');
});

await test('mainWorldFetchReply：页面里没有原生 fetch 时退回页面的 fetch', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const seen = [];
  delete sandbox.window.__bcNativeFetch;
  sandbox.fetch = async () => { seen.push(1); return { status: 200, text: async () => '{"code":0}' }; };

  await sandbox.mainWorldFetchReply({ requestId: 'y', type: 1, oid: '5', root: '9', pn: 1, ps: 1 });
  assert.equal(seen.length, 1);
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
