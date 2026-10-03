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
      async executeScript({ args }) {
        const a = args || [];
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
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, Error,
    fetch: async () => ({ json: async () => ({ code: 0, message: '' }) })
  });
  sandbox.window = sandbox;
  sandbox.window.postMessage = m => posts.push(m);

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'clean.js' });

  return { sandbox, pageStore, posts };
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

console.log('\n— 存活探测（只读，不发删除请求） —');

await test('探测：一级评论还在 → alive=true，且走的是只读 GET', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const calls = [];
  sandbox.fetch = async (url) => {
    calls.push(url);
    return { json: async () => ({ code: 0, data: { root: { rpid: '999' } } }) };
  };

  const out = await sandbox.mainWorldCheck({ requestId: 'c1', type: 1, oid: '555', rpid: '999' });
  assert.equal(out.alive, true);
  assert.match(calls[0], /\/x\/v2\/reply\/reply/, '必须是读取接口');
  assert.match(calls[0], /root=999/);
  assert.ok(!/reply\/del/.test(calls[0]), '绝不能碰删除接口');
});

await test('探测：12006 没有该评论 → alive=false', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ json: async () => ({ code: 12006, message: '没有该评论' }) });

  const out = await sandbox.mainWorldCheck({ requestId: 'c2', type: 1, oid: '555', rpid: '999' });
  assert.equal(out.alive, false);
});

await test('探测：楼中楼被解析到根评论时，必须去会话里把本人找出来', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  const calls = [];
  sandbox.fetch = async (url) => {
    calls.push(url);
    // 第一次：拿二级评论 222 当 root 查 —— B 站解析到了根评论 111
    if (url.includes('root=222')) {
      return { json: async () => ({ code: 0, data: { root: { rpid: '111' } } }) };
    }
    // 第二次：拉 111 这条会话的回复，里面能找到 222
    if (url.includes('root=111')) {
      return {
        json: async () => ({
          code: 0,
          data: { replies: [{ rpid: '222' }, { rpid: '333' }], page: { count: 2 } }
        })
      };
    }
    return { json: async () => ({ code: 0, data: {} }) };
  };

  const out = await sandbox.mainWorldCheck({ requestId: 'c3', type: 1, oid: '555', rpid: '222' });
  assert.equal(out.alive, true, '会话里找到了本人 → 还在');
  assert.ok(calls.length >= 2, '楼中楼必须多问一次会话列表，光看 code 会误判');
});

await test('探测：楼中楼已经不在会话里 → alive=false', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async (url) => {
    if (url.includes('root=222')) {
      return { json: async () => ({ code: 0, data: { root: { rpid: '111' } } }) };
    }
    if (url.includes('root=111')) {
      return { json: async () => ({ code: 0, data: { replies: [{ rpid: '333' }], page: { count: 1 } } }) };
    }
    return { json: async () => ({ code: 0, data: {} }) };
  };

  const out = await sandbox.mainWorldCheck({ requestId: 'c4', type: 1, oid: '555', rpid: '222' });
  assert.equal(out.alive, false, '翻完会话都没有本人 → 已经没了');
});

await test('探测：风控/未登录一律算「不确定」，绝不误判成已删除', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ json: async () => ({ code: -509, message: '请求过于频繁' }) });

  const out = await sandbox.mainWorldCheck({ requestId: 'c5', type: 1, oid: '555', rpid: '999' });
  assert.equal(out.ok, false);
  assert.equal(out.alive, null, '拿不准就得给 null —— 误判成"没了"会把还活着的评论漏掉');
});

await test('探测：接口返回不是 JSON 时也是「不确定」', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ json: async () => { throw new Error('bad json'); } });

  const out = await sandbox.mainWorldCheck({ requestId: 'c6', type: 1, oid: '555', rpid: '999' });
  assert.equal(out.alive, null);
});

await test('探测结果写进 window.__bcDelResults（和删除共用同一条回传通道）', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);
  sandbox.fetch = async () => ({ json: async () => ({ code: 12006, message: '没有该评论' }) });

  await sandbox.mainWorldCheck({ requestId: 'c7', type: 1, oid: '555', rpid: '999' });
  const stored = sandbox.window.__bcDelResults.c7;
  assert.ok(stored, '必须写进结果槽，控制台靠它取结果');
  assert.equal(stored.alive, false);
});

await test('checkAliveOne：把注入结果收敛成 alive 三态', async () => {
  const { sandbox } = await makeSandbox(async (arg, store) => {
    setTimeout(() => {
      store[arg.requestId] = { requestId: arg.requestId, ok: true, alive: false, code: 12006, message: '' };
    }, 550);
    return [{ result: undefined }];
  });

  const r = await sandbox.checkAliveOne(1, { type: 1, oid: '5', rpid: '9' });
  assert.equal(r.alive, false);
});

await test('checkAliveOne：拿不准时返回 null 而不是 false', async () => {
  const { sandbox } = await makeSandbox(async (arg, store) => {
    setTimeout(() => {
      store[arg.requestId] = { requestId: arg.requestId, ok: false, alive: null, code: -509, message: '请求过于频繁' };
    }, 550);
    return [{ result: undefined }];
  });

  const r = await sandbox.checkAliveOne(1, { type: 1, oid: '5', rpid: '9' });
  assert.equal(r.alive, null);
});

await test('注入永不 settle 时也必须返回 —— 绝不能静默卡死（线上真实事故）', async () => {
  // 事故现场：点了「探测存活」之后界面一动不动、风扇狂转、连「停止」都没反应。
  // 根因是 await chrome.scripting.executeScript(...) 永不 settle，
  // 于是 Promise.race 里的总超时**根本执行不到**。这条用例就是钉住这个回归。
  const { sandbox } = await makeSandbox(async () => new Promise(function () { /* 永远不 settle */ }));
  sandbox.BC_DELETE_TIMEOUT_MS = 2500;

  const t0 = Date.now();
  const r = await sandbox.deleteOne(1, { type: 1, oid: '5', rpid: '9' });
  const took = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.match(r.message, /等待页面响应超时/, `实际：${r.message}`);
  assert.ok(took < 8000, `必须在总超时内返回，实际 ${took}ms`);
});

await test('注入永不 settle 时，探测也一样会返回', async () => {
  const { sandbox } = await makeSandbox(async () => new Promise(function () { /* 永远不 settle */ }));

  const t0 = Date.now();
  const r = await sandbox.checkAliveOne(1, { type: 1, oid: '5', rpid: '9' });
  const took = Date.now() - t0;

  assert.equal(r.alive, null, '拿不准就是 null，不能卡住也不能误判');
  assert.ok(took < 20000, `必须返回，实际 ${took}ms`);
});

await test('withTimeout：到点就返回兜底值', async () => {
  const { sandbox } = await makeSandbox(async () => [{ result: undefined }]);

  const t0 = Date.now();
  const v = await sandbox.withTimeout(new Promise(function () {}), 400, '兜底');
  assert.equal(v, '兜底');
  assert.ok(Date.now() - t0 < 3000);

  const fast = await sandbox.withTimeout(Promise.resolve('正常'), 5000, '兜底');
  assert.equal(fast, '正常', '正常返回时不该动它');
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
