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

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
