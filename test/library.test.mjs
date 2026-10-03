/**
 * library.test.mjs —— 评论库（v1.5 起的权威数据源）的回归测试
 *
 * 定位变了：这个扩展的核心从「批量删评论」变成「本地评论管理 + 备份」，
 * 数据也从收藏夹搬到 chrome.storage.local 里的一份「库」。库是地基，
 * 它错了上面全错，所以这里测得比较狠。
 *
 * 纯 Node，零依赖：node test/library.test.mjs
 */

import assert from 'node:assert/strict';

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

/* ------------------------------------------------------- 假的 chrome.storage */

const localData = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        for (const k of list) if (localData.has(k)) out[k] = localData.get(k);
        return out;
      },
      async set(obj) { for (const k of Object.keys(obj)) localData.set(k, obj[k]); },
      async remove(keys) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) localData.delete(k);
      }
    }
  }
};

const shared = await import('../src/shared.js');
const {
  K_LIBRARY, K_AICU,
  getLibrary, saveLibrary, upsertLibItems, setLibStates, markLibDeleted,
  removeLibItems, listLibItems, libraryStats, queryLib,
  saveVideoTitles, missingVideoTitles, videoKey,
  exportLibraryJSON, exportLibraryHTML, exportLibraryMarkdown, importLibraryJSON,
  normalizeLibItem, stateFromAlive, aliveFromState
} = shared;

const item = (rpid, extra) => Object.assign({
  rpid: rpid, type: 1, oid: '555', root: '0', rank: 1,
  message: '评论 ' + rpid, ctime: 1700000000
}, extra || {});

console.log('\n评论库（数据层）回归测试\n');
console.log('— 老数据迁移 —');

await test('第一次读库时，把老的 bc_aicu 清单迁过来（alive → state）', async () => {
  localData.clear();
  localData.set(K_AICU, {
    uid: '350067609',
    total: 1188,
    items: {
      '1': { rpid: '1', type: 1, oid: '555', root: '0', rank: 1, message: 'a', ctime: 100, alive: true },
      '2': { rpid: '2', type: 1, oid: '555', root: '0', rank: 1, message: 'b', ctime: 200, alive: false },
      '3': { rpid: '3', type: 1, oid: '555', root: '0', rank: 1, message: 'c', ctime: 300 }
    }
  });

  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'live', 'alive:true → live');
  assert.equal(lib.items['2'].state, 'gone', 'alive:false → gone');
  assert.equal(lib.items['3'].state, 'unknown', '没有 alive → unknown');
  assert.equal(lib.uid, '350067609');
  assert.equal(lib.total, 1188);

  // 迁移会写回库，**写成功之后才删老键**
  const raw = localData.get(K_LIBRARY);
  assert.ok(raw && raw.items['1'], '迁移结果要落盘');
  assert.ok(!localData.has(K_AICU),
    '老键要删掉 —— 留着的话「清空导入」会被下一次读库的迁移悄悄撤销');
});

await test('库已经存在时不再看老键', async () => {
  localData.clear();
  localData.set(K_AICU, { items: { '1': item('1') } });
  localData.set(K_LIBRARY, { items: { '9': item('9') } });

  const lib = await getLibrary();
  assert.ok(lib.items['9']);
  assert.ok(!lib.items['1'], '不该混进老数据');
});

await test('state / alive 双向换算', async () => {
  assert.equal(stateFromAlive(true), 'live');
  assert.equal(stateFromAlive(false), 'gone');
  assert.equal(stateFromAlive(undefined), 'unknown');
  assert.equal(aliveFromState('live'), true);
  assert.equal(aliveFromState('gone'), false);
  assert.equal(aliveFromState('unknown'), undefined);
  assert.equal(aliveFromState('deleted'), undefined);
});

await test('normalizeLibItem 保留兼容字段 alive，老代码不用改就能用', async () => {
  assert.equal(normalizeLibItem(item('1', { alive: false })).alive, false);
  assert.equal(normalizeLibItem(item('1', { state: 'live' })).alive, true);
  assert.equal(normalizeLibItem(item('1', { state: 'deleted' })).alive, undefined);
  assert.equal(normalizeLibItem({ rpid: 'x' }), null, '缺关键字段要丢掉');
});

console.log('\n— 写操作 —');

await test('upsert：新增、去重、补全缺失字段', async () => {
  localData.clear();
  let r = await upsertLibItems({ uid: 'u', total: 100, items: [item('1'), item('2')] });
  assert.equal(r.added, 2);

  r = await upsertLibItems({ uid: 'u', items: [item('1'), item('3')] });
  assert.equal(r.added, 1, '已有的不该重复加');
  assert.equal(r.total, 3);

  // 老条目没有正文和时间，重新导入时应该补上
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1', { message: '', ctime: 0 })] });
  await upsertLibItems({ uid: 'u', items: [item('1', { message: '补上的', ctime: 12345 })] });
  const lib = await getLibrary();
  assert.equal(lib.items['1'].message, '补上的');
  assert.equal(lib.items['1'].ctime, 12345);
});

await test('upsert：重新导入不会冲掉已有的存活结论', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1', { message: '' })] });
  await setLibStates({ 1: 'gone' });
  await upsertLibItems({ uid: 'u', items: [item('1', { message: '又导了一遍' })] });

  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'gone', '探测结论是花时间换来的，不能被导入冲掉');
  assert.equal(lib.items['1'].message, '又导了一遍');
});

await test('upsert：换 UID 只做标记，不拒绝（按约定只警告不拦）', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'a', items: [item('1')] });
  await upsertLibItems({ uid: 'b', items: [item('2')] });
  const lib = await getLibrary();
  assert.equal(lib.mixed, true);
  assert.equal(Object.keys(lib.items).length, 2);
});

await test('setLibStates：记下结论和检查时间', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1'), item('2')] });

  const before = Date.now();
  await setLibStates({ 1: 'live', 2: 'gone' });
  const lib = await getLibrary();

  assert.equal(lib.items['1'].state, 'live');
  assert.equal(lib.items['2'].state, 'gone');
  assert.ok(lib.items['1'].aliveCheckedAt >= before, '要记下上次检查时间');
  assert.ok(lib.items['2'].goneAt >= before, '第一次发现没了要记下时间');
  assert.ok(lib.probedAt >= before, '整库巡检时间也要更新');
});

await test('setLibStates：goneAt 只记第一次，重复巡检不会把它刷新', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1')] });

  await setLibStates({ 1: 'gone' });
  const first = (await getLibrary()).items['1'].goneAt;

  await new Promise(r => setTimeout(r, 12));
  await setLibStates({ 1: 'gone' });
  const again = (await getLibrary()).items['1'].goneAt;

  assert.equal(again, first, '"哪一刻没的"是历史事实，不能被后来的巡检改写');
});

await test('setLibStates：又活了就把 goneAt 清掉', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1')] });
  await setLibStates({ 1: 'gone' });
  assert.ok((await getLibrary()).items['1'].goneAt);

  await setLibStates({ 1: 'live' });
  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'live');
  assert.equal(lib.items['1'].goneAt, undefined, '既然还在，就不该留着"没了"的时间');
});

await test('setLibStates：也接受老的 true/false 写法', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1'), item('2')] });
  await setLibStates({ 1: true, 2: false });
  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'live');
  assert.equal(lib.items['2'].state, 'gone');
});

await test('markLibDeleted：我们自己删掉的那些有独立状态', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1'), item('2')] });
  const n = await markLibDeleted(['1']);
  assert.equal(n, 1);

  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'deleted');
  assert.ok(lib.items['1'].deletedAt);
  assert.equal(lib.items['2'].state, 'unknown', '没删的不受影响');
});

await test('removeLibItems：只删指定的', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1'), item('2'), item('3')] });
  assert.equal(await removeLibItems(['1', '3', '999']), 2, '不存在的 rpid 不算数');

  const lib = await getLibrary();
  assert.deepEqual(Object.keys(lib.items), ['2']);
});

await test('视频标题缓存：存进去、能读出来', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1'), item('2', { oid: '777' })] });

  const missing = await missingVideoTitles(10);
  assert.equal(missing.length, 2, '两个不同视频都缺标题');
  assert.deepEqual(missing.map(m => m.oid).sort(), ['555', '777']);

  await saveVideoTitles({
    [videoKey(1, '555')]: { title: '视频甲', bvid: 'BV1', owner: 'UP甲' }
  });

  const left = await missingVideoTitles(10);
  assert.equal(left.length, 1);
  assert.equal(left[0].oid, '777', '有标题的就不该再要了');
});

console.log('\n— 查询：搜索 / 筛选 / 排序 / 分页 —');

async function seedLib() {
  localData.clear();
  const items = [];
  for (let i = 1; i <= 30; i++) {
    items.push(item(String(i), {
      oid: i <= 10 ? '555' : (i <= 20 ? '666' : '777'),
      message: i % 3 === 0 ? '这是特殊评论 ' + i : '普通评论 ' + i,
      ctime: 1000 + i
    }));
  }
  await upsertLibItems({ uid: 'u', items: items });
  const marks = {};
  for (let i = 1; i <= 10; i++) marks[String(i)] = 'live';
  for (let i = 11; i <= 20; i++) marks[String(i)] = 'gone';
  await setLibStates(marks);
}

await test('查库：按状态筛选', async () => {
  await seedLib();
  const live = await queryLib({ states: ['live'] });
  assert.equal(live.total, 10);
  const gone = await queryLib({ states: ['gone'] });
  assert.equal(gone.total, 10);
  const unknown = await queryLib({ states: ['unknown'] });
  assert.equal(unknown.total, 10);
});

await test('查库：搜索命中正文，也命中 rpid / oid', async () => {
  await seedLib();
  const byText = await queryLib({ q: '特殊' });
  assert.equal(byText.total, 10, '3,6,9…30 共 10 条');

  const byRpid = await queryLib({ q: '15' });
  assert.ok(byRpid.total >= 1);
  assert.ok(byRpid.items.some(i => i.rpid === '15'));

  const byOid = await queryLib({ q: '666' });
  assert.equal(byOid.total, 10, '11~20 这十条属于 oid 666');
});

await test('查库：分页必须真的分页（几千条不能一次塞进 DOM）', async () => {
  await seedLib();
  const p1 = await queryLib({ limit: 12, offset: 0 });
  const p2 = await queryLib({ limit: 12, offset: 12 });
  const p3 = await queryLib({ limit: 12, offset: 24 });

  assert.equal(p1.total, 30);
  assert.equal(p1.items.length, 12);
  assert.equal(p2.items.length, 12);
  assert.equal(p3.items.length, 6, '最后一页只剩 6 条');

  const ids = new Set([...p1.items, ...p2.items, ...p3.items].map(i => i.rpid));
  assert.equal(ids.size, 30, '三页之间不能重复');
});

await test('查库：时间倒序 / 正序', async () => {
  await seedLib();
  const desc = await queryLib({ sort: 'time-desc', limit: 3 });
  assert.deepEqual(desc.items.map(i => i.rpid), ['30', '29', '28']);

  const asc = await queryLib({ sort: 'time-asc', limit: 3 });
  assert.deepEqual(asc.items.map(i => i.rpid), ['1', '2', '3']);
});

await test('查库：limit 有上限，防止有人一把要十万条', async () => {
  await seedLib();
  const r = await queryLib({ limit: 999999 });
  assert.ok(r.limit <= 500, `实际 limit=${r.limit}`);
});

await test('查库：顺带把视频标题带上', async () => {
  await seedLib();
  await saveVideoTitles({ [videoKey(1, '555')]: { title: '视频甲' } });
  const r = await queryLib({ q: '5', limit: 50 });
  const hit = r.items.find(i => i.oid === '555');
  assert.ok(hit);
  assert.equal(hit.video.title, '视频甲');
});

await test('libraryStats：各状态计数 + 涉及多少视频 / 有多少已缓存标题', async () => {
  await seedLib();
  assert.equal((await libraryStats()).titled, 0, '刚种下的库里还没有标题缓存');

  await saveVideoTitles({ [videoKey(1, '555')]: { title: '视频甲' } });

  const s = await libraryStats();
  assert.equal(s.total, 30);
  assert.equal(s.live, 10);
  assert.equal(s.gone, 10);
  assert.equal(s.unknown, 10);
  assert.equal(s.videos, 3, '555 / 666 / 777 三个视频');
  assert.equal(s.titled, 1, '只有 555 缓存过标题');
});

console.log('\n— 导出 / 导入 —');

await test('导出 JSON：能原样导回来（含存活结论和视频标题）', async () => {
  await seedLib();
  await saveVideoTitles({ [videoKey(1, '555')]: { title: '视频甲', bvid: 'BV1', owner: 'UP甲' } });

  const json = await exportLibraryJSON();
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'bili-comment-keeper/library');
  assert.equal(parsed.count, 30);
  assert.ok(parsed.videos[videoKey(1, '555')], '视频标题要一起导出，否则导回来只剩 av 号');

  // 清空再从备份恢复
  localData.clear();
  const r = await importLibraryJSON(json);
  assert.equal(r.ok, true);
  assert.equal(r.total, 30);

  const lib = await getLibrary();
  assert.equal(lib.items['1'].state, 'live', '存活结论要跟着回来，否则全变成"未检查"');
  assert.equal(lib.items['15'].state, 'gone');
  assert.equal(lib.videos[videoKey(1, '555')].title, '视频甲');
});

await test('导入：不是备份文件就明确拒绝', async () => {
  localData.clear();
  assert.equal((await importLibraryJSON('不是 json')).ok, false);
  assert.equal((await importLibraryJSON('{"a":1}')).ok, false);
  assert.equal((await importLibraryJSON('[]')).ok, false);
});

await test('导出 HTML：自包含、能离线打开、条目都在', async () => {
  await seedLib();
  await saveVideoTitles({ [videoKey(1, '555')]: { title: '视频甲', owner: 'UP甲' } });

  const html = await exportLibraryHTML('我的评论备份');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /我的评论备份/);
  assert.match(html, /视频甲/);
  assert.match(html, /方式0/);
  assert.match(html, /方式2/);
  assert.match(html, /还在 10/);
  assert.ok(html.indexOf('<link') < 0 && html.indexOf('<script') < 0,
    '不能引用外部资源 —— 离线打开要能正常看');
});

await test('导出的 HTML 必须转义正文 —— 评论内容来自互联网', async () => {
  localData.clear();
  await upsertLibItems({
    uid: 'u',
    items: [item('1', { message: '<script>alert(1)</script><img src=x onerror=alert(2)>' })]
  });

  const html = await exportLibraryHTML('测试');
  assert.ok(html.indexOf('<script>alert(1)</script>') < 0, '原始 script 标签绝不能写进导出文件');
  assert.ok(html.indexOf('&lt;script&gt;') >= 0, '应该转义成实体');
  assert.ok(html.indexOf('<img') < 0, '标签本身也必须被转义掉');
});

await test('导出 Markdown：条目、链接、状态都在', async () => {
  await seedLib();
  const md = await exportLibraryMarkdown('我的备份');
  assert.match(md, /^# 我的备份/);
  assert.match(md, /共 30 条/);
  assert.match(md, /\[方式0\]\(https:\/\//);
  assert.match(md, /\[方式2\]\(https:\/\//);
  assert.match(md, /rpid `1`/);
});

await test('导出 Markdown：正文里的换行不会把结构撑坏', async () => {
  localData.clear();
  await upsertLibItems({ uid: 'u', items: [item('1', { message: '第一行\n第二行\n## 假标题' })] });

  const md = await exportLibraryMarkdown('测试');
  const bodyLines = md.split('\n').filter(l => l.indexOf('第一行') >= 0);
  assert.ok(bodyLines.length, '正文应该在');
  assert.ok(bodyLines[0].startsWith('> '), '多行正文要走引用块，不能裸着插进来');
});

await test('准入规则：只有 live / unknown 值得为它发一次删除请求', async () => {
  const { isDeletable } = shared;
  assert.equal(isDeletable('live'), true, '确认还在 —— 该删');
  assert.equal(isDeletable('unknown'), true, '还没查过 —— 删一次正好当探测');
  assert.equal(isDeletable('gone'), false, '已经没了 —— 再问只会拿到 12022，白费一次请求');
  assert.equal(isDeletable('deleted'), false, '我们自己删过了 —— 同理');
  assert.equal(isDeletable(undefined), false, '状态不明的一律不放行');
  assert.equal(isDeletable('乱七八糟'), false);
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
