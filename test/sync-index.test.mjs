/**
 * sync-index.test.mjs —— 索引云同步的分片 / 配额回归测试
 *
 * 纯 Node，零依赖：node test/sync-index.test.mjs
 *
 * 背景：v1.0.0 把整个 rpid 索引塞进 chrome.storage.sync 的一个键里，
 * 而单键上限是 8192 字节 —— 实测第 15 条评论就超限，失败还被静默吞掉，
 * 于是「换台设备记录自动回来」这条卖点无声无息地失效了。
 *
 * 这里用「会真的执行配额」的内存 storage 把三件事钉死：
 *   1) 旧写法确实会炸，不是我们瞎猜；
 *   2) 分片 + 只备份 oid/type 之后，上千条记录能完整往返；
 *   3) 真撞上总量上限时会如实报错，而不是假装成功。
 */

import assert from 'node:assert/strict';

const QUOTA_BYTES_PER_ITEM = 8192;
const QUOTA_BYTES = 102400;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/* ------------------------------------------------------------ storage 桩 */

/** 一个遵守 Chrome 配额语义的内存 storage area（0 表示不限制） */
function makeArea(quotaPerItem, quotaTotal) {
  const data = new Map();
  const sizeOf = (k, raw) => Buffer.byteLength(k, 'utf8') + Buffer.byteLength(raw, 'utf8');

  return {
    async get(keys) {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) {
        if (data.has(k)) out[k] = JSON.parse(data.get(k));
      }
      return out;
    },
    async set(obj) {
      // 和 Chrome 一样：先整体校验，任何一个键超限就整批失败，写进去半个都不算
      let incoming = 0;
      for (const [k, v] of Object.entries(obj)) {
        const size = sizeOf(k, JSON.stringify(v));
        if (quotaPerItem && size > quotaPerItem) {
          const err = new Error(`QUOTA_BYTES_PER_ITEM quota exceeded for '${k}' (${size} > ${quotaPerItem})`);
          err.name = 'QuotaExceededError';
          throw err;
        }
        incoming += size;
      }
      if (quotaTotal) {
        let kept = 0;
        for (const [k, raw] of data) if (!(k in obj)) kept += sizeOf(k, raw);
        if (kept + incoming > quotaTotal) {
          const err = new Error(`QUOTA_BYTES quota exceeded (${kept + incoming} > ${quotaTotal})`);
          err.name = 'QuotaExceededError';
          throw err;
        }
      }
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.stringify(v));
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) data.delete(k);
    },
    _data: data,
    _chunkKeys() { return [...data.keys()].filter(k => k.startsWith(K_SYNC_CHUNK)); },
    _largestItem() {
      let max = 0;
      for (const [k, raw] of data) max = Math.max(max, sizeOf(k, raw));
      return max;
    },
    _total() {
      let sum = 0;
      for (const [k, raw] of data) sum += sizeOf(k, raw);
      return sum;
    }
  };
}

let localArea, syncArea;
function resetStorage() {
  localArea = makeArea(0, 0);
  syncArea = makeArea(QUOTA_BYTES_PER_ITEM, QUOTA_BYTES);
  globalThis.chrome = { storage: { local: localArea, sync: syncArea } };
}

/* ------------------------------------- 让 setIndex 的 10 秒防抖立刻执行 */

const timers = new Map();
let nextTimerId = 1;

globalThis.setTimeout = fn => { const id = nextTimerId++; timers.set(id, fn); return id; };
globalThis.clearTimeout = id => { timers.delete(id); };

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(r => realSetTimeout(r, 0));
}

async function flushTimers() {
  while (timers.size) {
    const batch = [...timers.values()];
    timers.clear();
    for (const fn of batch) fn();
    await settle();
  }
}

resetStorage();

/* ------------------------------------------------------------ 测试脚手架 */

let passed = 0, failed = 0;

async function test(name, fn) {
  resetStorage();
  timers.clear();
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

/* ------------------------------------------------------------ 测试数据 */

const shared = await import('../src/shared.js');
const { K_INDEX, K_INDEX_SYNC, K_SYNC_META, K_SYNC_CHUNK, getIndex, setIndex, getSyncState } = shared;

/** 造一条和 background.js 真实写入结构完全一致的索引记录（实测 578 字节） */
function makeEntry(i) {
  const rpid = String(1122334455660000 + i);
  return [rpid, {
    url: `https://www.bilibili.com/video/BV1xx411c7mD?comment_on=1&comment_root_id=123456789012345&share_tag=s_i#reply${rpid}`,
    rpid,
    root: '0',
    secondaryId: '',
    isSecondary: false,
    bvid: 'BV1xx411c7mD',
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    type: 1,
    oid: '99887766554433',
    message: '哈哈哈哈这个太好笑了，前排围观一下',
    ctime: 1791000000,
    source: 'network',
    title: '[2026-10-04 02:24] BV1xx411c7mD · 哈哈哈哈这个太好笑了，前排围观',
    bookmarkId: '12345',
    addedAt: 1791000000000
  }];
}

function makeIndex(n) {
  const idx = {};
  for (let i = 0; i < n; i++) {
    const [k, v] = makeEntry(i);
    idx[k] = v;
  }
  return idx;
}

/** 从云备份恢复出来的索引：只剩下删除必需的 oid / type，其余从书签还原 */
function expectedRecovered(idx) {
  const out = {};
  for (const [rpid, m] of Object.entries(idx)) {
    out[rpid] = { rpid, oid: String(m.oid), type: Number(m.type) };
  }
  return out;
}

/* ---------------------------------------------------------------- 用例 */

console.log('\n索引云同步（v1.0.1 分片 + 精简备份）回归测试\n');

await test('还原病根：v1.0.0 的单键写法在第 15 条左右就撞上 QUOTA_BYTES_PER_ITEM', async () => {
  await assert.rejects(
    () => chrome.storage.sync.set({ [K_INDEX_SYNC]: makeIndex(200) }),
    /QUOTA_BYTES_PER_ITEM/,
    '旧写法本该因单键超限而失败'
  );
  // 顺便确认小索引不失败，说明失败确实来自容量，而不是桩写错了
  await chrome.storage.sync.set({ [K_INDEX_SYNC]: makeIndex(5) });
});

await test('1500 条记录分片后能完整往返（清掉本地也能从云备份恢复）', async () => {
  const idx = makeIndex(1500);
  await setIndex(idx);
  await flushTimers();

  assert.ok(syncArea._largestItem() <= QUOTA_BYTES_PER_ITEM,
    `有分片超过单键上限：${syncArea._largestItem()}`);
  assert.ok(syncArea._total() <= QUOTA_BYTES,
    `同步存储总量超限：${syncArea._total()}`);
  assert.ok(syncArea._data.has(K_SYNC_META), '应该写入了分片元信息');
  assert.ok(syncArea._chunkKeys().length > 1, '1500 条不可能只占一片');

  // 口径说明：这个桩按 UTF-8 字节计量，而 Chrome 的配额口径历来是字符串长度
  // （UTF-16 码元）。二者只对本项目这种「纯 ASCII 的 rpid / oid / type」备份数据
  // 恰好相等 —— 下面这条断言把这个前提钉住：哪天备份里混进 emoji 之类增补平面
  // 字符，它会立刻失败，提醒重新核对口径。
  for (const [k, raw] of syncArea._data) {
    assert.equal(Buffer.byteLength(raw, 'utf8'), raw.length,
      `备份数据的字节口径假设被打破（键 ${k}）`);
  }

  // 模拟「换了台设备 / 扩展被重装」：本地清空，只留云备份
  await chrome.storage.local.remove(K_INDEX);
  const restored = await getIndex();
  assert.deepEqual(restored, expectedRecovered(idx), '从云备份恢复出来的应覆盖全部 1500 条');

  const state = await getSyncState();
  assert.equal(state.ok, true, '这次备份应该被记为成功');
  assert.equal(state.count, 1500, '状态里的条数应是 1500');
});

await test('同一份配额下，精简备份的体积远小于直接存整个索引', async () => {
  const idx = makeIndex(1500);
  await setIndex(idx);
  await flushTimers();

  const fullBytes = Buffer.byteLength(JSON.stringify(idx), 'utf8');
  const syncBytes = syncArea._total();
  const ratio = syncBytes / fullBytes;

  console.log(`      [数据] 完整索引 ${fullBytes} 字节 → 云备份 ${syncBytes} 字节（${(ratio * 100).toFixed(1)}%）`);
  assert.ok(ratio < 0.2, `精简后应远小于完整索引，实际占比 ${(ratio * 100).toFixed(1)}%`);
});

await test('从 v1.0.0 的旧单键格式平滑迁移，并清掉旧键', async () => {
  const old = makeIndex(5);
  await chrome.storage.sync.set({ [K_INDEX_SYNC]: old });

  // 迁移前：本地为空，应能从旧键读回来
  assert.deepEqual(await getIndex(), expectedRecovered(old), '应该能读懂 v1.0.0 的旧单键备份');

  // 触发一次新写入，完成迁移
  const grown = makeIndex(60);
  await setIndex(grown);
  await flushTimers();

  assert.ok(syncArea._data.has(K_SYNC_META), '应该已经写成分片格式');
  assert.ok(!syncArea._data.has(K_INDEX_SYNC), '迁移后应删掉 v1.0.0 的旧单键');

  await chrome.storage.local.remove(K_INDEX);
  assert.deepEqual(await getIndex(), expectedRecovered(grown), '迁移后依然能完整恢复');
});

await test('索引变小后，多余的旧分片会被清掉', async () => {
  await setIndex(makeIndex(800));
  await flushTimers();
  const before = syncArea._chunkKeys().length;
  assert.ok(before > 1, `800 条应该切成多片，实际 ${before} 片`);

  await setIndex(makeIndex(3));
  await flushTimers();

  const after = syncArea._chunkKeys();
  assert.equal(after.length, 1, `缩到 3 条后应只剩 1 片，实际剩 ${after.length} 片`);

  await chrome.storage.local.remove(K_INDEX);
  assert.deepEqual(await getIndex(), expectedRecovered(makeIndex(3)), '缩小后恢复出来的应是最新内容');
});

await test('没有 oid/type 的条目不会进云备份，也不计入备份条数', async () => {
  // 剪贴板兜底路径写死 type/oid 为 null（src/recorder-main.js），
  // 这类条目对删除毫无帮助，备份里留着只是白占配额。
  const idx = makeIndex(3);
  idx['9999000011112222'] = {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD?comment_on=1&comment_root_id=9999000011112222&share_tag=s_i#reply9999000011112222',
    rpid: '9999000011112222', root: '0', secondaryId: '', isSecondary: false,
    bvid: 'BV1xx411c7mD', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    type: null, oid: null, message: '', ctime: 1791000000, source: 'clipboard',
    title: '[2026-10-04 02:24] BV1xx411c7mD · 评论', bookmarkId: '777',
    addedAt: 1791000000000
  };

  await setIndex(idx);
  await flushTimers();

  const state = await getSyncState();
  assert.equal(state.ok, true, '这种数据不该导致备份失败');
  assert.equal(state.count, 3, `备份条数不该把无 oid/type 的条目算进去，实际 ${state.count}`);

  await chrome.storage.local.remove(K_INDEX);
  const restored = await getIndex();
  assert.deepEqual(restored, expectedRecovered(makeIndex(3)), '恢复出来的应该只有那 3 条有元数据的');
});

// 放在最后：这一步会触发失败退避，不该影响前面的用例
await test('真撞上总量上限时如实报错，且不破坏上一版备份', async () => {
  // 先成功写一批，作为"上一版备份"
  await setIndex(makeIndex(100));
  await flushTimers();
  assert.ok(syncArea._data.has(K_SYNC_META), '上一版备份应该写成功了');
  const before = [...syncArea._data.entries()].map(([k, v]) => k + '=' + v).sort();

  // 再写一批超总量的
  const huge = makeIndex(4000);          // 精简后仍然超过预检阈值
  await setIndex(huge);
  await flushTimers();

  const after = [...syncArea._data.entries()].map(([k, v]) => k + '=' + v).sort();
  assert.deepEqual(after, before, '写入失败不该动到上一版备份的任何一个字节');

  const state = await getSyncState();
  assert.ok(state, '应该留下一条备份状态');
  assert.equal(state.ok, false, '超配额时必须标记为失败');
  assert.match(state.reason, /容量|quota/i, `失败原因应说明是容量问题，实际：${state.reason}`);
  assert.match(state.reason, /102400/, `失败原因应给出 Chrome 的真实上限，实际：${state.reason}`);

  // 关键：云备份失败绝不能连累本地索引
  assert.deepEqual(await getIndex(), huge, '云备份失败不该影响本地索引');
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
