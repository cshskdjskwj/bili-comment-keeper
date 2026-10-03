/**
 * aicu.test.mjs —— aicu.cc 历史评论导入的回归测试
 *
 * 覆盖两块：
 *   1) src/aicu-main.js 的抓取：真的把 /api/v4/search/getreply 的响应读成
 *      rpid / type / oid —— 这三个正好是 B 站删除接口要的参数；
 *   2) src/shared.js 的数据层：去重、混入不同 UID 的标记、排序、移除。
 *
 * aicu-main.js 是注入网页主世界执行的经典脚本（不能 import），
 * 所以这里用 vm 造一个假的 window / location 把它**原样跑起来**，
 * 测的是真代码，而不是一份迟早会走样的复制品。
 *
 * 纯 Node，零依赖：node test/aicu.test.mjs
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

const settle = () => new Promise(r => setTimeout(r, 0));
async function settleAll() { for (let i = 0; i < 6; i++) await settle(); }

/* ============================================ 第一部分：aicu-main.js 抓取 */

const AICU_MAIN = readFileSync(fileURLToPath(new URL('../src/aicu-main.js', import.meta.url)), 'utf8');

const SAMPLE = {
  code: 0,
  data: {
    cursor: { all_count: 4321 },
    replies: [
      { rpid: 111, time: 1700000000, rank: 1, message: '前排', dyn: { type: 1, oid: 555 } },
      { rpid: 222, time: 1700000100, rank: 2, message: '楼中楼回复', dyn: { type: 1, oid: 555 }, parent: { rootid: 111 } },
      { rpid: '333', time: 1700000200, rank: 1, message: '动态里的', dyn: { type: 17, oid: 999 } },
      { rpid: 444, dyn: { type: 12, oid: 888 } },              // 没有 message/time，也该收下
      { rpid: 'abcdef', dyn: { type: 1, oid: 5 } },            // rpid 不是数字 -> 丢掉
      { rpid: 666, dyn: { type: 1 } }                          // 缺 oid -> 丢掉
    ]
  }
};

/** 造一个只够 aicu-main.js 跑起来的假页面环境 */
function makePage({ search = '?uid=350067609&pn=2&mode=1', body = JSON.stringify(SAMPLE), replyTo = () => body } = {}) {
  const posted = [];

  function FakeXHR() { this._listeners = {}; }
  FakeXHR.prototype.open = function (m, u) { this._url = u; };
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function (t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  };

  const sandbox = {
    console, URL, URLSearchParams, JSON, Number, String, Array, Object, RegExp,
    isFinite, Promise, Error, setTimeout, clearTimeout,
    location: { origin: 'https://www.aicu.cc', pathname: '/reply', search },
    XMLHttpRequest: FakeXHR
  };
  sandbox.window = sandbox;
  sandbox.window.postMessage = m => posted.push(m);
  sandbox.window.addEventListener = () => {};
  sandbox.window.fetch = function (url) {
    return Promise.resolve({
      clone() { return { text: () => Promise.resolve(replyTo(String(url))) }; }
    });
  };

  vm.createContext(sandbox);
  vm.runInContext(AICU_MAIN, sandbox, { filename: 'aicu-main.js' });

  return { sandbox, posted, FakeXHR };
}

console.log('\naicu.cc 历史评论导入回归测试\n');
console.log('— aicu-main.js 抓取 —');

await test('挂钩 fetch：把 getreply 的响应读成 rpid / type / oid', async () => {
  const { sandbox, posted } = makePage();

  await sandbox.fetch('https://api.aicu.cc/api/v4/search/getreply?uid=350067609&pn=2');
  await settleAll();

  assert.equal(posted.length, 1, '应该恰好转发一条消息');
  const msg = posted[0];
  assert.equal(msg.__bcAicu, true, '消息要带 __bcAicu 标记');
  assert.equal(msg.payload.uid, '350067609');
  assert.equal(msg.payload.page, 2);
  assert.equal(msg.payload.total, 4321, '应带上站上记录的总条数');

  const items = msg.payload.items;
  assert.equal(items.length, 4, `结构不对的条目该被丢掉，实际留下 ${items.length} 条`);
  // 注意：items 来自 vm 沙箱，跨 realm 的对象原型不同，deepStrictEqual 会误判，
  // 所以先做一次 JSON 往返归一化到本 realm 再比。
  assert.deepEqual(JSON.parse(JSON.stringify(items[0])), {
    rpid: '111', type: 1, oid: '555', root: '0',
    rank: 1, message: '前排', ctime: 1700000000
  });
});

await test('楼中楼带上 parent.rootid，rank 也保留', async () => {
  const { sandbox, posted } = makePage();
  await sandbox.fetch('https://api.aicu.cc/api/v4/search/getreply?uid=1&pn=1');
  await settleAll();

  const second = posted[0].payload.items[1];
  assert.equal(second.rpid, '222');
  assert.equal(second.root, '111', '楼中楼要带根评论 id');
  assert.equal(second.rank, 2);
});

await test('缺 message / time 的条目照样收下（清空补漏时不能漏）', async () => {
  const { sandbox, posted } = makePage();
  await sandbox.fetch('https://api.aicu.cc/api/v4/search/getreply?uid=1&pn=1');
  await settleAll();

  const fourth = posted[0].payload.items[3];
  assert.equal(fourth.rpid, '444');
  assert.equal(fourth.type, 12);
  assert.equal(fourth.message, '');
  assert.equal(fourth.ctime, 0);
});

await test('不相关的请求一个字节都不碰', async () => {
  const { sandbox, posted } = makePage();
  await sandbox.fetch('https://api.aicu.cc/api/v4/search/getdynamic?uid=1');
  await sandbox.fetch('https://www.aicu.cc/assets/index.js');
  await sandbox.fetch('https://api.bilibili.com/x/v2/reply/add', { method: 'POST' });
  await settleAll();

  assert.equal(posted.length, 0, '只有 getreply 才该被抓');
});

await test('响应不是合法 JSON / 结构不对时安静放弃，不抛异常', async () => {
  const { sandbox, posted } = makePage({ replyTo: () => '<html>Cloudflare 挑战页</html>' });
  await sandbox.fetch('https://api.aicu.cc/api/v4/search/getreply?uid=1&pn=1');
  await settleAll();
  assert.equal(posted.length, 0);

  const bad = makePage({ replyTo: () => JSON.stringify({ code: -419, data: null, message: '排队凭据无效' }) });
  await bad.sandbox.fetch('https://api.aicu.cc/api/v4/search/getreply?uid=1&pn=1');
  await settleAll();
  assert.equal(bad.posted.length, 0, '排队失败之类的错误响应不该产出条目');
});

await test('挂钩 XMLHttpRequest：老式请求同样能被读到', async () => {
  const { sandbox, posted, FakeXHR } = makePage();

  const x = new FakeXHR();
  x.open('GET', 'https://api.aicu.cc/api/v4/search/getreply?uid=77&pn=1');
  x.send();
  x.responseText = JSON.stringify(SAMPLE);
  (x._listeners.load || []).forEach(fn => fn.call(x));
  await settleAll();

  assert.equal(posted.length, 1, 'XHR 路径也该抓到');
  assert.equal(posted[0].payload.uid, '77');
  assert.equal(posted[0].payload.items.length, 4);
});

/* ========================================== 第二部分：shared.js 数据层 */

const localData = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) {
          if (localData.has(k)) out[k] = JSON.parse(localData.get(k));
        }
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) localData.set(k, JSON.stringify(v)); },
      async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) localData.delete(k); }
    }
  }
};

const shared = await import('../src/shared.js');
const {
  normalizeAicuItem, aicuPageUrl, aicuTypeName,
  mergeAicuItems, listAicuItems, removeAicuItems, clearAicuStore, getAicuStore
} = shared;

const item = (rpid, over) => Object.assign({
  rpid: rpid, type: 1, oid: '555', root: '0', rank: 1, message: '评论', ctime: 1700000000
}, over || {});

console.log('\n— shared.js 数据层 —');

await test('normalizeAicuItem 把可疑数据挡在门外', async () => {
  assert.equal(normalizeAicuItem(null), null);
  assert.equal(normalizeAicuItem({}), null);
  assert.equal(normalizeAicuItem({ rpid: 'abc', type: 1, oid: '5' }), null, 'rpid 必须是数字');
  assert.equal(normalizeAicuItem({ rpid: '1', type: 1 }), null, '缺 oid 要丢掉');
  assert.equal(normalizeAicuItem({ rpid: '1', type: 'x', oid: '5' }), null, 'type 必须是数');

  const ok = normalizeAicuItem({ rpid: 9, type: '1', oid: 5, root: 'zz', rank: 0, message: 'x'.repeat(500) });
  assert.equal(ok.rpid, '9');
  assert.equal(ok.type, 1);
  assert.equal(ok.oid, '5');
  assert.equal(ok.root, '0', 'root 不是数字时退回 0');
  assert.equal(ok.rank, 1, 'rank 为 0 时退回 1');
  assert.equal(ok.message.length, 200, '正文截到 200 字，别把 storage 撑爆');
});

await test('aicuPageUrl / aicuTypeName 按评论区类型给出可点开的地址', async () => {
  assert.equal(aicuPageUrl(1, '555'), 'https://www.bilibili.com/video/av555');
  assert.equal(aicuPageUrl(12, '888'), 'https://www.bilibili.com/read/cv888');
  assert.equal(aicuPageUrl(17, '999'), 'https://t.bilibili.com/999');
  assert.equal(aicuPageUrl(1, ''), '', '缺 oid 时不给地址');
  assert.equal(aicuTypeName(1), '视频');
  assert.equal(aicuTypeName(17), '动态');
  assert.equal(aicuTypeName(999), '类型999');
});

await test('mergeAicuItems 按 rpid 去重，并记住站上总条数', async () => {
  localData.clear();

  const r1 = await mergeAicuItems({ uid: '777', total: 100, items: [item('1'), item('2'), item('2')] });
  assert.equal(r1.added, 2, '同一批里的重复 rpid 只收一次');
  assert.equal(r1.total, 2);

  const r2 = await mergeAicuItems({ uid: '777', total: 100, items: [item('2'), item('3')] });
  assert.equal(r2.added, 1, '跨批次也要去重');
  assert.equal(r2.total, 3);

  const store = await getAicuStore();
  assert.equal(store.uid, '777');
  assert.equal(store.total, 100);
  assert.equal(store.mixed, false);
});

await test('换了 UID 只做标记，不拒绝（按约定只警告不拦）', async () => {
  localData.clear();
  await mergeAicuItems({ uid: 'aaa', items: [item('1')] });
  await mergeAicuItems({ uid: 'bbb', items: [item('2')] });

  const store = await getAicuStore();
  assert.equal(store.uid, 'bbb', 'uid 记最新的');
  assert.equal(store.mixed, true, '混了不同账号的数据要能提示出来');
  assert.equal(Object.keys(store.items).length, 2, '两边的条目都保留');
});

await test('listAicuItems 按时间倒序（新的在前）', async () => {
  localData.clear();
  await mergeAicuItems({
    uid: 'u',
    items: [item('1', { ctime: 100 }), item('2', { ctime: 300 }), item('3', { ctime: 200 })]
  });

  const list = await listAicuItems();
  assert.deepEqual(list.map(x => x.rpid), ['2', '3', '1']);
});

await test('removeAicuItems 只摘掉指定条目，其余原样保留', async () => {
  localData.clear();
  await mergeAicuItems({ uid: 'u', items: [item('1'), item('2'), item('3')] });

  const removed = await removeAicuItems(['1', '3', 'nope']);
  assert.equal(removed, 2, '不存在的 rpid 不算数');

  const list = await listAicuItems();
  assert.deepEqual(list.map(x => x.rpid), ['2']);
});

await test('clearAicuStore 清空后回到干净状态', async () => {
  localData.clear();
  await mergeAicuItems({ uid: 'u', items: [item('1')] });
  await clearAicuStore();

  const store = await getAicuStore();
  assert.equal(Object.keys(store.items).length, 0);
  assert.equal(store.uid, '');
  assert.equal(store.mixed, false);
});

await test('全是被删过的条目时不会误报成功条数（added 为 0）', async () => {
  localData.clear();
  await mergeAicuItems({ uid: 'u', items: [item('1')] });
  const again = await mergeAicuItems({ uid: 'u', items: [item('1')] });
  assert.equal(again.added, 0);
  assert.equal(again.total, 1);
});

/* ==================================== 第三部分：aicu-auto.js 自动翻页 */

const AICU_AUTO = readFileSync(fileURLToPath(new URL('../src/aicu-auto.js', import.meta.url)), 'utf8');

/**
 * 造一张评论卡片的假 DOM。
 * aicu 渲染出来的每条评论里有两个链接：
 *   方式2 → .../h5/comment/sub?oid=&pageType=&root=   （oid 和 type 在这里）
 *   方式0 → .../video/av{oid}#reply{rpid}            （rpid 在这里）
 * 两者是同一个卡片里的兄弟节点。
 */
function makeCard(rpid, type, oid, root) {
  const replyLink = {
    getAttribute: n => n === 'href' ? `https://www.bilibili.com/video/av${oid}#reply${rpid}` : null
  };
  const subLink = {
    getAttribute: n => n === 'href'
      ? `https://www.bilibili.com/h5/comment/sub?oid=${oid}&pageType=${type}` +
        `&root=${root === undefined ? rpid : root}`
      : null,
    parentElement: null
  };
  const card = {
    querySelector: sel => (sel.indexOf('#reply') >= 0 ? replyLink : null),
    parentElement: null
  };
  subLink.parentElement = { querySelector: () => null, parentElement: card };
  return { subLink, replyLink, card };
}

/**
 * 造一个假的 aicu 页面：一个「下一页」按钮 + 一个会转发消息的 window
 * +（可选）已经渲染出来的评论卡片。
 * 按钮的 click 会模拟 aicu 的行为：翻到最后之后把自己变灰，并推一份新数据出来。
 */
function makeAutoPage(opts = {}) {
  const totalClicks = opts.totalClicks === undefined ? 3 : opts.totalClicks;
  const hasNext = opts.hasNext !== false;
  const clickPostsData = opts.clickPostsData !== false;

  const reports = [];
  const posts = [];
  const listeners = [];
  let clicks = 0;
  let vmWindow = null;   // 上下文里的 window（和外面这个 sandbox 引用并不相等）

  const btn = {
    disabled: !!opts.startDisabled,
    offsetParent: {},                       // 非 null = 可见
    classList: { contains: () => false },
    getAttribute: () => null,
    click() {
      clicks++;
      if (clicks >= totalClicks) btn.disabled = true;
      if (clickPostsData) setTimeout(() => fire({ __bcAicu: true, payload: { items: [{}] } }), 5);
    }
  };

  const buttons = hasNext ? [btn] : [];
  const cards = opts.cards || [];

  const sandbox = {
    console, Promise, Number, String, Math, Date, Array, Object, isFinite,
    URL, URLSearchParams, setTimeout, clearTimeout,
    document: {
      querySelectorAll(sel) {
        if (sel.indexOf('h5/comment/sub') >= 0) return cards.map(c => c.subLink);
        if (sel.indexOf('MuiPaginationItem-next') >= 0 || sel.indexOf('next page') >= 0 || sel.indexOf('下一页') >= 0) return buttons;
        return [];
      }
    },
    location: { origin: 'https://www.aicu.cc', pathname: '/reply', search: opts.search || '?uid=1' }
  };
  sandbox.window = sandbox;

  function fire(data) {
    posts.push(data);
    // 真实的 window.postMessage 会把 event.source 设成 window 自己。
    // 在 vm 里 window 是上下文代理对象，跟外面这个 sandbox 引用不相等，
    // 所以必须用「上下文里的那个 window」当 source，否则会被 ev.source !== window 挡掉。
    for (const fn of listeners) fn({ source: vmWindow || sandbox, data });
    if (data && data.__bcAicuAuto) reports.push(data.__bcAicuAuto);
  }

  sandbox.window.addEventListener = (t, fn) => { if (t === 'message') listeners.push(fn); };
  sandbox.window.postMessage = fire;

  vm.createContext(sandbox);
  vmWindow = vm.runInContext('window', sandbox);
  vm.runInContext(AICU_AUTO, sandbox, { filename: 'aicu-auto.js' });

  return { sandbox, reports, posts, fire, btn, clicks: () => clicks };
}

async function waitDone(reports, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = reports.find(r => r.kind === 'done');
    if (d) return d;
    await new Promise(r => setTimeout(r, 40));
  }
  return null;
}

/** 起跑：先喂一份初始数据，再发开始指令 */
async function startAuto(p) {
  p.fire({ __bcAicu: true, payload: { items: [{}] } });
  await new Promise(r => setTimeout(r, 20));
}

console.log('\n— aicu-auto.js 自动翻页 —');

await test('替用户点「下一页」，翻到最后一页就自己停', async () => {
  const p = makeAutoPage({ totalClicks: 3 });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 50, gapMs: 300, waitMs: 1500 } });
  const done = await waitDone(p.reports);

  assert.ok(done, '应该在超时前结束');
  assert.match(done.reason, /最后一页/);
  assert.equal(p.clicks(), 3, `应该点 3 次「下一页」，实际 ${p.clicks()} 次`);
  assert.ok(p.reports.some(r => r.kind === 'progress' && r.pages > 0), '过程中要回报进度');
});

await test('按钮已经是灰的（末页）时，一次都不点', async () => {
  const p = makeAutoPage({ startDisabled: true });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 50, gapMs: 300, waitMs: 1500 } });
  const done = await waitDone(p.reports);

  assert.ok(done);
  assert.match(done.reason, /最后一页/);
  assert.equal(p.clicks(), 0, '按钮禁用了就不该再点');
});

await test('找不到「下一页」（页面结构变了）时安静收场', async () => {
  const p = makeAutoPage({ hasNext: false });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 50, gapMs: 300, waitMs: 1500 } });
  const done = await waitDone(p.reports);

  assert.ok(done);
  assert.match(done.reason, /找不到/);
  assert.equal(p.clicks(), 0);
});

await test('收到停止指令就停下，并说明是用户停的', async () => {
  const p = makeAutoPage({ totalClicks: 100 });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 500, gapMs: 400, waitMs: 1500 } });
  await new Promise(r => setTimeout(r, 600));
  assert.ok(p.clicks() > 0, '应该已经开始翻了');

  p.fire({ __bcAicuCmd: { action: 'autopage-stop' } });
  const done = await waitDone(p.reports);

  assert.ok(done);
  assert.match(done.reason, /停止/);
});

await test('尊重页数上限', async () => {
  const p = makeAutoPage({ totalClicks: 100 });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 2, gapMs: 300, waitMs: 1500 } });
  const done = await waitDone(p.reports);

  assert.ok(done);
  assert.match(done.reason, /上限/);
  assert.equal(p.clicks(), 2);
});

await test('点了下一页却等不到新数据时说明原因并停下，不无限空转', async () => {
  const p = makeAutoPage({ totalClicks: 100, clickPostsData: false });
  await startAuto(p);

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 50, gapMs: 300, waitMs: 1500 } });
  const done = await waitDone(p.reports, 10000);

  assert.ok(done, '应该在等待超时后结束');
  assert.match(done.reason, /既没有新请求/);
  assert.equal(p.clicks(), 1, '只该点一次就放弃');
});

await test('首屏一直没数据（还在排队）时，也会停下并说明', async () => {
  const p = makeAutoPage({ totalClicks: 3 });
  // 故意不喂初始数据
  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 50, gapMs: 300, firstWaitMs: 1500 } });
  const done = await waitDone(p.reports, 10000);

  assert.ok(done);
  assert.match(done.reason, /没读到评论/);
  assert.equal(p.clicks(), 0, '首屏都没数据就不该开始点');
});

await test('第二条路：直接从渲染出来的列表里抠出 rpid / type / oid', async () => {
  const p = makeAutoPage({
    cards: [makeCard('111', 1, '555'), makeCard('222', 12, '888')]
  });

  // 不翻页，只读当前页
  p.fire({ __bcAicuCmd: { action: 'harvest-once' } });
  await new Promise(r => setTimeout(r, 100));

  const dom = p.posts.filter(m => m && m.__bcAicuDom);
  assert.equal(dom.length, 1, '应该上报一次');

  const items = dom[0].payload.items;
  assert.equal(items.length, 2, `应该抠出 2 条，实际 ${items.length}`);

  const first = JSON.parse(JSON.stringify(items[0]));
  assert.equal(first.rpid, '111');
  assert.equal(first.type, 1, 'pageType 就是删除要的 type');
  assert.equal(first.oid, '555');
  assert.equal(first.rank, 1, 'root 等于自己就是一级评论');
  assert.equal(dom[0].payload.uid, '1', 'uid 从地址里取');
});

await test('第二条路：楼中楼能正确区分 root 与 rank', async () => {
  const p = makeAutoPage({
    cards: [makeCard('222', 1, '555', '111')]   // root=111 ≠ 自己 -> 楼中楼
  });

  p.fire({ __bcAicuCmd: { action: 'harvest-once' } });
  await new Promise(r => setTimeout(r, 100));

  const it = JSON.parse(JSON.stringify(p.posts.find(m => m && m.__bcAicuDom).payload.items[0]));
  assert.equal(it.rpid, '222');
  assert.equal(it.root, '111', 'root 要原样带出来');
  assert.equal(it.rank, 2, 'root 不等于自己 -> 楼中楼');
});

await test('网络钩子完全失灵时，靠读页面照样能把评论导进来', async () => {
  // clickPostsData: false —— 模拟 aicu-main.js 那条钩子一点动静都没有
  const p = makeAutoPage({
    totalClicks: 5,
    clickPostsData: false,
    cards: [makeCard('111', 1, '555'), makeCard('222', 1, '556')]
  });

  // 注意：这里故意不喂任何 __bcAicu，模拟"钩子压根没装上"
  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 10, gapMs: 300, waitMs: 1500, firstWaitMs: 1500 } });
  const done = await waitDone(p.reports, 12000);

  const dom = p.posts.filter(m => m && m.__bcAicuDom);
  assert.ok(dom.length >= 1, '页面里明明有评论，就该从渲染结果里读到并上报');
  const rpids = dom.flatMap(m => m.payload.items.map(i => i.rpid));
  assert.ok(rpids.includes('111') && rpids.includes('222'), `实际读到：${rpids.join(', ')}`);
  assert.ok(done, '应该有个明确的收场');
});

await test('判断"翻页有没有生效"看的是新 rpid，不是本页条数', async () => {
  // 每页都是同样 2 条（条数不变），但内容不同 —— 不能因此误判成"没变化"而提前收工
  let page = 0;
  const cardsFor = n => [makeCard(String(n * 10 + 1), 1, '555'), makeCard(String(n * 10 + 2), 1, '556')];

  const p = makeAutoPage({ totalClicks: 3, clickPostsData: false, cards: cardsFor(1) });
  p.sandbox.document.querySelectorAll = function (sel) {
    if (sel.indexOf('h5/comment/sub') >= 0) return cardsFor(page + 1).map(c => c.subLink);
    if (sel.indexOf('MuiPaginationItem-next') >= 0 || sel.indexOf('next page') >= 0 || sel.indexOf('下一页') >= 0) {
      return [p.btn];
    }
    return [];
  };
  p.btn.click = function () { page++; if (page >= 2) p.btn.disabled = true; };

  p.fire({ __bcAicuCmd: { action: 'autopage-start', maxPages: 10, gapMs: 300, waitMs: 700, firstWaitMs: 700 } });
  const done = await waitDone(p.reports, 15000);

  assert.ok(done);
  const rpids = new Set(p.posts.filter(m => m && m.__bcAicuDom).flatMap(m => m.payload.items.map(i => i.rpid)));
  assert.ok(rpids.size >= 4, `页数变了就该继续翻，实际只读到 ${rpids.size} 个不同 rpid`);
});

await test('抓取期间重复发开始指令会被忽略，不会跑成两份', async () => {
  const p = makeAutoPage({ totalClicks: 100 });
  await startAuto(p);

  const cmd = { action: 'autopage-start', maxPages: 500, gapMs: 400, waitMs: 1500 };
  p.fire({ __bcAicuCmd: cmd });
  await new Promise(r => setTimeout(r, 200));
  const afterFirst = p.clicks();
  p.fire({ __bcAicuCmd: cmd });
  await new Promise(r => setTimeout(r, 600));
  const afterSecond = p.clicks();

  p.fire({ __bcAicuCmd: { action: 'autopage-stop' } });
  await waitDone(p.reports, 5000);

  // 两份一起跑的话，点击数会明显翻倍；这里只该按一份的节奏增长
  const delta = afterSecond - afterFirst;
  assert.ok(delta <= 4, `重复开始指令不该让翻页速度翻倍（这 600ms 内点了 ${delta} 次）`);
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
