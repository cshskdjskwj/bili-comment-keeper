/**
 * clean.js —— 一键清除面板
 *
 * 删除请求必须从 bilibili 页面里发出去：扩展页面的 origin 是 chrome-extension://，
 * 对 bilibili.com 属于跨站，SESSDATA 会被 SameSite 拦掉。所以下面会把一小段脚本
 * 注入到 bilibili 标签页（没有就开一个后台标签页），由那个页面以同站身份发请求。
 */

import {
  getSettings, setSettings, DEFAULT_SETTINGS, parseCommentUrl,
  sleep, randInt, escapeHtml, explainCode, sourceLabel, fmtTime,
  aicuTypeName, aicuCommentUrl, aicuSubUrl,
  getLibrary, listLibItems, clearLibrary, removeLibItems, setLibStates, markLibDeleted,
  libraryStats, queryLib, getLibItems, missingVideoTitles, saveVideoTitles, videoKey,
  isDeletable,
  exportLibraryJSON, exportLibraryHTML, exportLibraryMarkdown, importLibraryJSON
} from '../src/shared.js';

const $ = id => document.getElementById(id);
const STATE_CLS = { done: 'ok', failed: 'bad', working: 'run' };

/* 注入网页主世界执行，必须完全自包含（不能引用本文件任何变量） */
async function mainWorldDelete(arg) {
  const done = out => {
    out.requestId = arg.requestId;

    // 回传通道 ①（主）：把结果挂在页面的 window 上，控制台自己回来取。
    // 这条不经过内容脚本，所以「标签页是装扩展之前打开的、内容脚本已失效」也不影响。
    try {
      if (!window.__bcDelResults) window.__bcDelResults = {};
      const keys = Object.keys(window.__bcDelResults);
      if (keys.length > 200) {            // 别在页面上越堆越多
        for (let i = 0; i < keys.length - 100; i++) delete window.__bcDelResults[keys[i]];
      }
      window.__bcDelResults[arg.requestId] = out;
    } catch (e) { /* 忽略 */ }

    // 回传通道 ②（兜底）：老路子的 postMessage，交给隔离世界的内容脚本转发
    try { window.postMessage({ __bcDeleterResult: out }, '*'); } catch (e) { /* 忽略 */ }

    return out;
  };

  const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
  if (!m) return done({ ok: false, code: null, message: '页面里读不到 bili_jct，请确认浏览器已登录 bilibili' });

  // 用原生 fetch（recorder-main.js 在 document_start 抢存的那份）。
  // 直接用 window.fetch 的话，请求会穿过 B 站自己的 API 包装层，行为不可预期。
  const doFetch = (typeof window.__bcNativeFetch === 'function')
    ? window.__bcNativeFetch
    : window.fetch.bind(window);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await doFetch('https://api.bilibili.com/x/v2/reply/del', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        type: String(arg.type), oid: String(arg.oid), rpid: String(arg.rpid), csrf: m[1]
      }).toString(),
      signal: ctrl.signal
    });
    const json = await res.json().catch(() => null);
    if (!json) return done({ ok: false, code: null, message: '接口返回不是 JSON，可能被风控拦截了' });
    return done({ ok: json.code === 0, code: json.code, message: json.message || '' });
  } catch (err) {
    const msg = (err && err.name === 'AbortError') ? '请求超时（15 秒）' : '网络错误：' + ((err && err.message) || err);
    return done({ ok: false, code: null, message: msg });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注入网页主世界执行：**只把接口的原始返回搬回来**，不做任何判断。
 *
 * 为什么把判断挪走：判断逻辑（尤其是楼中楼的确认）放在这里的话，它就跑在页面里、
 * 依赖注入 + 序列化，既难测也难查。现在这里只负责"发一个 GET、把原文带回来"，
 * 判定统一由控制台那侧做 —— 那部分是纯函数，有测试盯着。
 *
 * 用的是**原生 fetch**（recorder-main.js 在 document_start 抢存的那份）。
 * 直接用 window.fetch 的话，请求会穿过 B 站自己的 API 包装层，行为不可预期。
 *
 * **不需要登录、不需要 cookie**：查询评论的接口是公开可读的，别人本来就能查你的评论，
 * 所以这里用 credentials: 'omit'，不带任何凭据。
 */
async function mainWorldFetchReply(arg) {
  const done = out => {
    out.requestId = arg.requestId;
    try {
      if (!window.__bcDelResults) window.__bcDelResults = {};
      const keys = Object.keys(window.__bcDelResults);
      if (keys.length > 200) {
        for (let i = 0; i < keys.length - 100; i++) delete window.__bcDelResults[keys[i]];
      }
      window.__bcDelResults[arg.requestId] = out;
    } catch (e) { /* 忽略 */ }
    try { window.postMessage({ __bcDeleterResult: out }, '*'); } catch (e) { /* 忽略 */ }
    return out;
  };

  const url = String(arg.url || '');
  if (!url) return done({ ok: false, message: '没有给地址' });

  const doFetch = (typeof window.__bcNativeFetch === 'function')
    ? window.__bcNativeFetch
    : window.fetch.bind(window);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await doFetch(url, { credentials: 'omit', signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    // 只带原文回来，解析交给控制台
    return done({ ok: true, status: res.status, text: String(text).slice(0, 50000) });
  } catch (err) {
    const msg = (err && err.name === 'AbortError') ? '请求超时（15 秒）' : ('网络错误：' + ((err && err.message) || err));
    return done({ ok: false, message: msg });
  } finally {
    clearTimeout(timer);
  }
}

const pending = new Map();   // requestId -> resolve，等网页用 postMessage 回传结果
const aidCache = new Map();  // bvid -> aid

/**
 * 单条删除的总超时（毫秒）。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里可以调小它来验证「超时后给出可读原因」，
 * 否则那一条用例要真等 23 秒。生产代码只读不写。
 */
var BC_DELETE_TIMEOUT_MS = 23000;

/** 自检里等「兜底通道回话」的时长；同样用 var 方便测试调小。 */
var BC_PREFLIGHT_MS = 6000;

/**
 * 给任何 await 套一个硬上限。
 *
 * 这一条是被真实事故逼出来的：探测功能上线后，有人点了「探测存活」，界面一动不动、
 * 风扇狂转、连「停止」都没反应。根因是某一步 await（最可能是 executeScript）
 * **永远不 settle** —— 于是 Promise.race 里的总超时压根执行不到，整个流程静默卡死。
 *
 * 教训：不能只在最后加一个 race 就以为万无一失，**每一个可能卡住的 await 都得自己带上限**。
 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    sleep(ms).then(function () { return fallback; })
  ]);
}

let running = false, stopRequested = false;
let workerTabId = null, workerCreated = false;
let settings = null;
let items = [], stats = { ok: 0, fail: 0, gone: 0 }, purgeTimer = null;
let sourceFilter = 'all';       // 来源筛选：all | bookmark | aicu
let logAutoOpened = false;      // 出错后日志是否已经自动展开过

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg) return;

  if (msg.type === 'DELETE_RESULT' && msg.requestId && pending.has(msg.requestId)) {
    const resolve = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    resolve({ ok: !!msg.ok, code: msg.code, message: msg.message || '' });
    return;
  }

  // 在 aicu.cc 页面又抓到一批历史评论，跟着刷新导入区
  // （自动翻页时每页都会推一次，节流一下，别把列表反复重绘几百次）
  if (msg.type === 'AICU_UPDATED') {
    scheduleAicuRender();
    return;
  }

  // 自动翻页抓取的进度 / 结束
  if (msg.type === 'AICU_AUTOPAGE' && msg.payload) {
    const p = msg.payload;
    if (p.kind === 'done') {
      setAicuAuto(false);
      setAicuHint('自动抓取结束：' + (p.reason || '已结束') +
        (p.pages ? `（共翻了 ${p.pages} 页）` : ''), 'warn');
      loadAicu().catch(function () {});
    } else if (p.kind === 'progress') {
      setAicuHint('自动抓取中：' + (p.note || '…') +
        '　—— 这是替你点 aicu 页面上的「下一页」，不会多发任何请求。', '');
    }
    return;
  }

  // 你在 B 站网页上自己删了评论，后台同步归档后通知面板更新那一行
  if (msg.type === 'SYNC_ARCHIVED' && msg.rpid) {
    const it = items.find(i => i.parsed && i.parsed.rpid === String(msg.rpid));
    if (it && it.status !== 'done') {
      it.status = 'done';
      it.note = '你在网页上手动删除，已同步归档';
      renderRow(it);
      syncCounts();
    }
    loadArchive().catch(function () {});
  }
});

/* ------------------------------------------------------------------ 初始化 */

async function init() {
  settings = await getSettings();
  buildFilters();
  bindEvents();
  render();
  await loadArchive();
  await loadAicu();
}

function bindEvents() {
  bindLibraryEvents();
  $('btn-start').addEventListener('click', start);

  $('btn-settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  // 主视图 ⇄ 导入视图 ⇄ 数据页
  $('btn-open-import').addEventListener('click', function () { showView('import'); });
  $('btn-back-main').addEventListener('click', function () { showView('main'); });
  $('btn-open-data').addEventListener('click', function () { showView('data'); });
  $('btn-back-home2').addEventListener('click', function () { showView('main'); });

  // 数据页上的操作
  $('btn-data-export').addEventListener('click', function () { doExport('json'); });
  $('btn-data-purge').addEventListener('click', function () {
    purgeArchive().then(renderDataPage).catch(function (e) {
      setHint('清理失败：' + ((e && e.message) || e), 'bad');
    });
  });
  $('btn-data-clear').addEventListener('click', function () { setDataClearConfirm(true); });
  $('btn-data-clear-no').addEventListener('click', function () { setDataClearConfirm(false); });
  $('btn-data-clear-yes').addEventListener('click', function () {
    clearWholeLibrary().catch(function (e) { setHint('清空失败：' + ((e && e.message) || e), 'bad'); });
  });
  $('btn-data-reset').addEventListener('click', function () {
    setSettings(Object.assign({}, DEFAULT_SETTINGS))
      .then(async function () {
        settings = await getSettings();
        await renderDataPage();
        setHint('设置已恢复默认。评论库没动。', '');
      })
      .catch(function (e) { setHint('恢复失败：' + ((e && e.message) || e), 'bad'); });
  });

  // 来源筛选
  $('filters').addEventListener('click', function (e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    sourceFilter = btn.dataset.src || 'all';
    render();
  });

  $('btn-stop').addEventListener('click', function () {
    if (!running) return;
    stopRequested = true;
    log('收到停止指令，当前这条删完就停…');
    setHint('正在停止…（等当前这一条处理完）', 'warn');
  });

  $('btn-reload').addEventListener('click', async function () {
    if (running) return;
    await reload();
    setHint('列表已刷新。', '');
  });

  $('btn-retry').addEventListener('click', async function () {
    if (running) return;
    const failed = items.filter(i => i.status === 'failed');
    if (!failed.length) { setHint('没有失败项。', ''); return; }
    failed.forEach(i => { i.status = 'idle'; i.note = ''; i.checked = true; });
    render();
    await start();
  });

  $('check-all').addEventListener('change', function (e) {
    // 只作用于当前筛选出来的那批，别把筛掉的也一起改了
    const vis = new Set(visibleItems().map(i => i.id));
    items.forEach(i => { if (vis.has(i.id) && i.status !== 'done') i.checked = e.target.checked; });
    render();
  });

  $('queue-list').addEventListener('change', function (e) {
    if (!e.target.classList.contains('ck')) return;
    const row = e.target.closest('.row');
    const it = row && items.find(i => String(i.id) === row.dataset.id);
    if (it) { it.checked = e.target.checked; syncCounts(); }
  });

  // aicu.cc 导入区
  $('btn-aicu-auto').addEventListener('click', function () {
    startAutoPage().catch(e => setAicuHint('启动失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-aicu-autostop').addEventListener('click', stopAutoPage);

  // 只读探测：先问清楚哪些还活着，再决定删什么
  $('btn-aicu-probe').addEventListener('click', function () {
    probeAicuAlive().catch(e => {
      setAicuProbing(false);
      setAicuHint('探测失败：' + ((e && e.message) || e), 'bad');
    });
  });

  // 只读当前这一页（不翻页）。这是最重要的逃生口：
  // 页面明明有评论、导入却一直是 0 的时候，点它试试 —— 它直接从渲染结果里抠，
  // 完全不依赖「挂钩页面请求」那条路。
  $('btn-aicu-read').addEventListener('click', function () {
    if (running) return;
    readCurrentAicuPage().catch(e => setAicuHint('读取失败：' + ((e && e.message) || e), 'bad'));
  });

  // 备份：导出 / 导入
  $('btn-export-json').addEventListener('click', function () { doExport('json'); });
  $('btn-export-html').addEventListener('click', function () { doExport('html'); });
  $('btn-export-md').addEventListener('click', function () { doExport('md'); });

  $('btn-import-json').addEventListener('click', function () { $('file-import').click(); });
  $('file-import').addEventListener('change', function (ev) {
    const f = ev.target.files && ev.target.files[0];
    doImport(f).then(function () { ev.target.value = ''; });
  });


  // 清掉已确认没了的，清单里只留活着的
  $('btn-aicu-prune').addEventListener('click', function () {
    pruneDeadAicu().catch(e => setAicuHint('清理失败：' + ((e && e.message) || e), 'bad'));
  });

  $('btn-aicu-merge').addEventListener('click', function () {
    if (running) return;
    mergeAicu().catch(e => setAicuHint('加入失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-aicu-clear').addEventListener('click', function () {
    if (running) return;
    clearLibrary()
      .then(function () {
        setAicuHint('已清空导入清单。这不影响书签，也不影响 B 站上的评论。', '');
        return loadAicu();
      })
      .catch(e => setAicuHint('清空失败：' + ((e && e.message) || e), 'bad'));
  });

  // 清空归档：先弹确认，8 秒没动作自动收起
  $('btn-purge').addEventListener('click', function () { if (!running) setPurgeConfirm(true); });
  $('btn-purge-yes').addEventListener('click', function () {
    purgeArchive().catch(e => setHint('清空失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-purge-no').addEventListener('click', function () { setPurgeConfirm(false); });
}

/* ------------------------------------------------- 已删除记录（库里的账本） */

/**
 * 「已删除记录」现在直接读库里 state === 'deleted' 的条目。
 * 以前这里是浏览器收藏夹里那个「B站已删除评论」目录 —— 收藏夹已经淘汰了，
 * 数据只有库这一份。
 */
async function loadArchive() {
  const lib = await getLibrary();
  const list = Object.keys(lib.items)
    .map(k => lib.items[k])
    .filter(it => it.state === 'deleted')
    .sort((a, b) => (b.deletedAt || b.ctime) - (a.deletedAt || a.ctime));

  $('arc-count').textContent = String(list.length);
  $('arc-path').textContent = '这些是已经删掉的评论，记录留在本地库里，方便你事后核对。';

  $('arc-list').innerHTML = list.length
    ? list.map(function (it) {
        const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
        const text = String(it.message || '').replace(/\s+/g, ' ').trim() || '（没有正文）';
        const url = aicuCommentUrl(it);
        return `<div class="arc-item" title="${escapeHtml(text)}">• ` +
          `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">[${escapeHtml(when)}] ` +
          `${escapeHtml(text.slice(0, 40))}</a></div>`;
      }).join('')
    : '<div class="empty" style="padding:10px 13px">还没有删除记录。删掉的评论会在这里留一条账。</div>';
}

/* ------------------------------------------------- aicu.cc 导入的历史评论
 * 本扩展只记录「装好之后」发出的评论；装之前发的、手机上发的都抓不到。
 * aicu.cc 存着完整历史，由 src/aicu-main.js 在它页面上顺手读回来。
 * 这里只负责展示与并入待删列表 —— 删除走的是上面那套完全相同的流程。
 */

const AICU_RENDER_LIMIT = 200;

let autoRunning = false;        // 自动翻页是否正在进行
let probing = false;            // 存活探测是否正在进行
let probeStop = false;          // 探测的停止请求
let aicuRenderTimer = null;     // 导入区重绘节流

/**
 * 存活探测每条之间的间隔。
 * 比删除的 1.5~4 秒短得多 —— 因为探测是**只读 GET**，不是写操作，
 * 对风控的压力小一个量级。（真被限流了会自动歇 15 秒再继续。）
 */
const BC_PROBE_DELAY_MS = 350;

function setAicuHint(text, kind) {
  const el = $('aicu-hint');
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

/** 把一条 aicu 记录转成待删列表里的行 */
function aicuRow(item) {
  const pageUrl = aicuPageUrl(item.type, item.oid);
  const text = String(item.message || '').replace(/\s+/g, ' ').trim();
  const when = item.ctime ? fmtTime(item.ctime * 1000) : '时间未知';
  const excerpt = text ? (text.length > 24 ? text.slice(0, 24) + '…' : text) : '评论';

  return {
    id: 'aicu:' + item.rpid,
    source: 'aicu',
    type: Number(item.type),
    oid: String(item.oid),
    title: `[${when}] ${aicuTypeName(item.type)} · ${excerpt}`,
    url: pageUrl,
    parsed: {
      url: pageUrl,
      rpid: item.rpid,
      rootId: item.root || item.rpid,
      secondaryId: '',
      isSecondary: Number(item.rank) !== 1,
      bvid: '',
      pageUrl: pageUrl
    },
    checked: true,
    status: 'idle',
    note: ''
  };
}

async function loadAicu() {
  if (!settings) return;   // 初始化还没走完

  const store = await getLibrary();
  const list = await listLibItems();
  const merged = items.filter(i => i.source === 'aicu').length;

  $('aicu-count').textContent = String(list.length);

  $('aicu-uid').textContent = store.uid
    ? ('UID ' + store.uid + (store.total ? ' · 站上记着 ' + store.total + ' 条' : ''))
    : '';

  const notes = [];
  if (!list.length) {
    notes.push('还没有导入。打开 https://www.aicu.cc/reply?uid=你的UID 之后，' +
      '点「自动翻页抓取」让它替你翻，或者点「读当前页」只把眼前这页捞进来。');
  } else {
    const aliveN = list.filter(i => i.state === 'live').length;
    const goneN = list.filter(i => i.state === 'gone').length;
    const untestedN = list.length - aliveN - goneN;

    notes.push(`共 ${list.length} 条，其中 ${merged} 条已加入待删列表。`);
    if (aliveN || goneN) {
      notes.push(`存活探测：还在 ${aliveN} 条，已经没了 ${goneN} 条` +
        (untestedN ? `，还没探过 ${untestedN} 条。` : '。'));
    } else {
      notes.push(`${untestedN} 条都还没探测过存活 —— 点「探测存活」可以先筛掉早就删掉的那些，` +
        '不然要一条条去问 B 站，很慢。');
    }
    notes.push('提醒：aicu.cc 只是索引，删除发生在 B 站；已删评论也可能仍留在它的存档里。');
  }
  if (store.mixed) {
    notes.push('⚠️ 这份清单里混了不止一个 UID 的数据，请确认都是你自己的账号。');
  }
  if (store.uid) {
    notes.push('⚠️ 请确认上面的 UID 是你自己的。');
  }
  setAicuHint(notes.join(' '), store.mixed ? 'warn' : '');

  // 这个折叠区现在只管"抓取"，列表本身已经在上面那个库视图里了 ——
  // 两边都画一遍只会让人分不清哪个才是真的，所以这里只留一句指向。
  $('aicu-list').innerHTML = list.length
    ? `<div class="empty" style="padding:10px 13px">这 ${list.length} 条都在上面的评论库里，` +
      '用搜索和筛选看它们。这里只负责把它们抓下来。</div>'
    : '<div class="empty" style="padding:10px 13px">还没有从 aicu.cc 抓到任何评论。</div>';

  await refreshLibrary();
}

/** 库里已经删过的 rpid —— 别再浪费一次接口调用 */
async function archivedRpids() {
  const set = new Set();
  const lib = await getLibrary();
  for (const k of Object.keys(lib.items)) {
    if (lib.items[k].state === 'deleted') set.add(k);
  }
  return set;
}

/** 把整个导入清单并进待删列表（按 rpid 去重，已删过的不再放回） */
async function mergeAicu() {
  const list = await listLibItems();
  if (!list.length) {
    setAicuHint('清单是空的。先去 aicu.cc 打开你自己的评论页翻几页，再回来。', 'warn');
    return;
  }
  if (running) return;

  const known = new Set();
  for (const i of items) if (i.parsed && i.parsed.rpid) known.add(i.parsed.rpid);

  const archived = await archivedRpids();
  let added = 0, skipped = 0, alreadyGone = 0, probedGone = 0, probedDeleted = 0, untested = 0;

  for (const item of list) {
    if (known.has(item.rpid)) { skipped++; continue; }
    // 已经没了的 / 我们自己删过的，都不该再进队列 —— 为它们发请求只会白拿一个 12022。
    // 这里必须看 state 而不是老的 alive：alive 对 deleted 是 undefined，会漏网。
    if (item.state === 'gone') { probedGone++; continue; }
    if (item.state === 'deleted') { probedDeleted++; continue; }
    if (!isDeletable(item.state)) { probedGone++; continue; }
    if (archived.has(item.rpid)) { alreadyGone++; continue; }
    if (item.state === 'unknown') untested++;
    items.push(aicuRow(item));
    known.add(item.rpid);
    added++;
  }

  render();
  const parts = [];
  if (skipped) parts.push(`${skipped} 条已在列表里`);
  if (probedGone) parts.push(`${probedGone} 条探测过、确认已经没了，跳过`);
  if (probedDeleted) parts.push(`${probedDeleted} 条是之前删过的，跳过`);
  if (alreadyGone) parts.push(`${alreadyGone} 条已在「已删除记录」里，跳过`);
  const tail = parts.length ? `（${parts.join('，')}）` : '';
  const warn = untested ? `　注意：其中 ${untested} 条还没探测过存活，` +
    '想先筛掉已经删掉的，点「巡检存活」。' : '';
  setAicuHint(`已加入 ${added} 条${tail}。${warn}后点「开始删除」即可。`, added ? '' : 'warn');
  await loadAicu();
}

/* -------------------------------------------- aicu.cc 自动翻页抓取 */

function scheduleAicuRender() {
  if (aicuRenderTimer) return;
  aicuRenderTimer = setTimeout(function () {
    aicuRenderTimer = null;
    loadAicu().catch(function () {});
  }, 1500);
}

function setAicuAuto(on) {
  autoRunning = !!on;
  refreshAicuButtons();
}

function setAicuProbing(on) {
  probing = !!on;
  refreshAicuButtons();
}

/** 抓取/探测期间，这几个按钮统一收起或禁用，避免两件事互相干扰 */
function refreshAicuButtons() {
  const busy = autoRunning || probing || running;
  $('btn-aicu-auto').classList.toggle('hide', autoRunning || probing);
  $('btn-aicu-probe').classList.toggle('hide', autoRunning || probing);
  $('btn-aicu-autostop').classList.toggle('hide', !(autoRunning || probing));
  for (const id of ['btn-aicu-read', 'btn-aicu-merge', 'btn-aicu-clear', 'btn-aicu-prune']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
}

/* ------------------------------------------------------ 备份：导出 / 导入 */

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 在扩展页面里下载一段文本。
 * 用 Blob + <a download>，**不需要 downloads 权限** —— 为一个导出功能多要一项权限不值。
 */
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

async function doExport(kind) {
  setAicuHint('正在生成备份…', '');
  const name = `b站评论备份-${stamp()}`;
  try {
    if (kind === 'json') {
      downloadText(name + '.json', await exportLibraryJSON(), 'application/json');
      setAicuHint('已导出 JSON。它是完整备份（含存活结论和视频标题），可以用「导入备份」原样恢复。', '');
    } else if (kind === 'html') {
      downloadText(name + '.html', await exportLibraryHTML(), 'text/html');
      setAicuHint('已导出 HTML。双击就能在浏览器里离线翻看，不依赖扩展、不联网。', '');
    } else {
      downloadText(name + '.md', await exportLibraryMarkdown(), 'text/markdown');
      setAicuHint('已导出 Markdown，方便丢进笔记软件。', '');
    }
  } catch (e) {
    setAicuHint('导出失败：' + ((e && e.message) || e), 'bad');
  }
}

async function doImport(file) {
  if (!file) return;
  setAicuHint('正在导入备份…', '');
  try {
    const r = await importLibraryJSON(await file.text());
    if (!r || !r.ok) {
      setAicuHint('导入失败：' + ((r && r.reason) || '文件读不出来'), 'bad');
      return;
    }
    await loadAicu();
    setAicuHint(`导入完成：新增 ${r.added} 条，补全 ${r.enriched} 条，` +
      `现共 ${r.total} 条。已有的存活结论不会被覆盖。`, '');
  } catch (e) {
    setAicuHint('导入失败：' + ((e && e.message) || e), 'bad');
  }
}

/** 把「已确认没了」的条目从库里删掉，只留活着的 */
async function pruneDeadAicu() {
  if (running || probing || autoRunning) return;

  const list = await listLibItems();
  const dead = list.filter(i => i.state === 'gone');
  if (!dead.length) {
    setAicuHint('没有「已确认没了」的条目要清。先点「巡检存活」筛一遍。', 'warn');
    return;
  }

  await removeLibItems(dead.map(i => i.rpid));
  await loadAicu();
  setAicuHint(`已经清掉 ${dead.length} 条确认没了的，清单里只剩 ${list.length - dead.length} 条。`, '');
}

/**
 * 只读地探测每一条还在不在，把结果记下来。
 *
 * 这是这个功能最实用的一步：aicu 的清单里**绝大多数是早就删掉的评论**，
 * 如果不管三七二十一全导进待删列表，就要花几十分钟一条条去问 B 站。
 * 先探一遍，就只剩真正还活着的那些要处理了。
 *
 * 全程只发 GET（`/x/v2/reply/reply`），不碰删除接口 —— 探测本身不会改变任何东西。
 */
async function probeAicuAlive() {
  if (probing || autoRunning || running) return;

  const all = await listLibItems();
  const todo = all.filter(i => i.state === 'unknown');
  if (!all.length) { setAicuHint('清单是空的，先导入再说。', 'warn'); return; }
  if (!todo.length) { setAicuHint('所有条目都已经探测过了，没有要再探的。', ''); return; }

  setAicuProbing(true);
  probeStop = false;

  // 不预先开标签页、也不做登录自检：
  // 探测的接口是公开只读的（不需要登录），而且优先让扩展自己直发 ——
  // 只有直发被反爬拦了才会去借 bilibili 标签页，那一步由取数据的地方按需触发。
  // 先单独试一条。
  //
  // **只有"链路本身不通"才中止整轮**。单条问不出结果是这一条的事 ——
  // 比如它的页面评论功能关了、视频不可访问，这些都是**合法的结论**，
  // 不该因此让整个按钮从此点不动。
  // （踩过的坑：待检查列表最前面几条恰好都是"评论功能已关闭"，于是每次点按钮
  //   都只跑完试运行就放弃，看起来就是"按键失效"。）
  const firstTry = await withTimeout(checkAliveOne(todo[0]), 20000,
    { state: 'unknown', alive: null, message: '第一条就超时（20 秒）', transport: true });

  const stateText0 = {
    live: '还在', gone: '已经没了', unreachable: '查不到', unknown: '没问出结果'
  }[firstTry.state] || '没问出结果';

  log(`探测试运行：第 1 条 rpid ${todo[0].rpid} → ${stateText0}` +
    (firstTry.message ? '（' + firstTry.message + '）' : ''));

  if (firstTry.transport) {
    setAicuProbing(false);
    setAicuHint('探测没有开始：取数据的链路不通。' + (firstTry.message || '') +
      '　把 bilibili 标签页刷新一下（F5）再试，或者先随便打开一个 bilibili 页面。', 'bad');
    return;
  }

  const estMin = Math.max(1, Math.round(todo.length * BC_PROBE_DELAY_MS / 60000));
  setAicuHint(`正在只读探测存活：本次 ${todo.length} 条，预计约 ${estMin} 分钟。` +
    '这不会删任何东西，只是问 B 站「这条还在不在」。中途可以点「停止」，测过的会记住。', '');

  let alive = 0, gone = 0, unknown = 0, unreachable = 0, errStreak = 0;
  const marks = {};

  const flush = async function () {
    if (!Object.keys(marks).length) return;
    await setLibStates(marks);
    for (const k of Object.keys(marks)) delete marks[k];
  };

  // 进度条 + 列表即时刷新：不这样，巡检时界面是死的，看不出在动
  const bar = $('probe-bar');
  const inner = $('probe-progress');
  if (bar) bar.classList.remove('hide');
  const setBar = (done, total) => {
    if (inner) inner.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  };
  setBar(0, todo.length);

  let lastPaint = 0;

  for (let i = 0; i < todo.length; i++) {
    if (probeStop) break;

    const it = todo[i];
    const startedAt = Date.now();

    // 每条都带上限。外层再兜一层，是为了"就算 checkAliveOne 本身出了意料之外的问题，
    // 循环也一定能往下走" —— 这个功能已经因为一处不 settle 的 await 卡死过一次了。
    let r = { state: 'unknown', alive: null, message: '内部超时' };
    try {
      r = await withTimeout(checkAliveOne(it), 40000,
        { state: 'unknown', alive: null, message: '这条探测超时（40 秒）' });
    } catch (e) {
      r = { state: 'unknown', alive: null, message: '探测出错：' + ((e && e.message) || e) };
    }

    const took = Date.now() - startedAt;
    const state = r.state || (r.alive === true ? 'live' : r.alive === false ? 'gone' : 'unknown');
    // 原因一律记下来 —— 光显示"未检查"，事后根本没法排查
    marks[it.rpid] = { state: state, note: r.message || '' };

    if (state === 'live') { alive++; errStreak = 0; }
    else if (state === 'gone') { gone++; errStreak = 0; }
    else if (state === 'unreachable') { unreachable++; errStreak = 0; }
    else {
      unknown++;
      log(`探测 ${i + 1}/${todo.length} rpid ${it.rpid}：没问出结果（${took} 毫秒，${r.message || '无说明'}）`);
      // 连续问不出结果，多半是触发风控了，歇一会儿
      if (++errStreak >= 3) {
        errStreak = 0;
        setAicuHint('连续几次没问出结果，歇 15 秒再继续（多半是触发了风控）…', 'warn');
        await sleep(15000);
      }
    }

    setBar(i + 1, todo.length);
    await flush();

    // 列表每 1.5 秒重画一次就够了 —— 每条都重画会把滚动位置晃得没法看
    if (Date.now() - lastPaint > 1500 || i === todo.length - 1) {
      lastPaint = Date.now();
      await refreshLibrary();
    }

    setAicuHint(`探测中 ${i + 1}/${todo.length}（${Math.round((i + 1) / todo.length * 100)}%，` +
      `上一条 ${took} 毫秒）—— 还在 ${alive}，已经没了 ${gone}，查不到 ${unreachable}，` +
      `没问出结果 ${unknown}。`, '');

    if (i < todo.length - 1) await sleep(BC_PROBE_DELAY_MS);
  }

  await flush();
  setAicuProbing(false);
  if (bar) bar.classList.add('hide');
  await loadAicu();

  const tail = probeStop ? '　（你让它停了，下次会接着探剩下的）' : '';
  setAicuHint(`探测结束：还在 ${alive} 条，已经没了 ${gone} 条，查不到 ${unreachable} 条，` +
    `没问出结果 ${unknown} 条。` +
    `「加入待删列表」只会收下还活着的那些。${tail}`, 'warn');
}

/** 找一个已打开的 aicu.cc 标签页；没有就按已知 UID 开一个后台标签页 */
async function findAicuTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aicu.cc/*', 'https://aicu.cc/*'] });
  const usable = tabs.find(t => t.id !== undefined && t.id !== null && !t.discarded);
  if (usable) return usable;

  const store = await getLibrary();
  if (!store.uid) return null;

  const tab = await chrome.tabs.create({
    url: 'https://www.aicu.cc/reply?uid=' + encodeURIComponent(store.uid),
    active: false
  });
  await waitTabComplete(tab.id, 25000);
  return tab;
}

/** 内容脚本可能还没注入（刚打开的页面），重试几次再放弃 */
async function sendToAicuTab(tabId, payload) {
  for (let i = 0; i < 6; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'AICU_AUTOPAGE_CMD', payload: payload });
      return true;
    } catch (e) {
      await sleep(700);
    }
  }
  return false;
}

/**
 * 只让 aicu 页面把**当前这一页**已经渲染出来的评论读一遍，不翻页。
 *
 * 这是导入失灵时最重要的逃生口：它走的是「直接读渲染结果」那条路，
 * 完全不依赖「挂钩页面请求」——所以页面明明有评论、导入却一直是 0 的时候，
 * 点它基本都能立刻把数据捞回来。
 */
async function readCurrentAicuPage() {
  let tab = null;
  try { tab = await findAicuTab(); } catch (e) { /* 下面统一报 */ }

  if (!tab) {
    setAicuHint('没找到已打开的 aicu.cc 页面。先打开你自己的评论页（网址里带 uid=），再点这个按钮。', 'warn');
    return;
  }

  const ok = await sendToAicuTab(tab.id, { action: 'harvest-once' });
  if (!ok) {
    setAicuHint('联系不上 aicu 页面里的脚本。把那个页面刷新一下（F5）再点 —— ' +
      '最常见的原因是这个标签页在装/更新扩展之前就开着。', 'bad');
    return;
  }
  setAicuHint('已经让 aicu 页面把当前这页的评论读一遍了，稍等一下…', '');
}

async function startAutoPage() {  if (autoRunning) return;
  if (running) { setAicuHint('正在删评论，等这一轮结束再抓取。', 'warn'); return; }

  let tab = null;
  try {
    tab = await findAicuTab();
  } catch (e) {
    setAicuHint('打开 aicu.cc 页面失败：' + ((e && e.message) || e), 'bad');
    return;
  }

  if (!tab) {
    setAicuHint('没找到已打开的 aicu.cc 页面，也还不知道你的 UID。' +
      '请先手动打开 https://www.aicu.cc/reply?uid=你的UID 并翻一下，再回来点这个按钮。', 'warn');
    return;
  }

  setAicuAuto(true);
  setAicuHint('正在让 aicu.cc 页面自动翻页……（就是替你点页面上的「下一页」，不会多发任何请求）', '');

  const ok = await sendToAicuTab(tab.id, { action: 'autopage-start', maxPages: 300, gapMs: 1200 });
  if (!ok) {
    setAicuAuto(false);
    setAicuHint('联系不上 aicu 页面里的脚本。把那个页面刷新一下（F5）再试。', 'bad');
  }
}

function stopAutoPage() {
  // 探测是本地循环，置个标志就行
  if (probing) {
    probeStop = true;
    setAicuHint('正在停止探测……当前这一条问完就停。已经探过的都记住了。', 'warn');
    return;
  }
  if (!autoRunning) return;
  setAicuHint('正在停止……当前这一页处理完就停。', 'warn');

  chrome.tabs.query({ url: ['https://*.aicu.cc/*', 'https://aicu.cc/*'] }).then(function (tabs) {
    for (const t of tabs) {
      if (t.id === undefined || t.id === null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'AICU_AUTOPAGE_CMD', payload: { action: 'autopage-stop' } })
        .catch(function () { /* 页面没了就算了 */ });
    }
  }).catch(function () { /* 忽略 */ });

  // 万一页面已经关了、回话回不来，别让按钮永远卡在「停止抓取」
  setTimeout(function () {
    if (autoRunning) {
      setAicuAuto(false);
      setAicuHint('已停止（没等到页面回话，直接放开了）。导入到的东西都已经存下来了。', 'warn');
      loadAicu().catch(function () {});
    }
  }, 8000);
}

function setPurgeConfirm(on) {
  if (purgeTimer) { clearTimeout(purgeTimer); purgeTimer = null; }
  $('purge-confirm').classList.toggle('hide', !on);
  $('btn-purge').classList.toggle('hide', on);
  if (on) purgeTimer = setTimeout(function () { setPurgeConfirm(false); }, 8000);
}

/** 把「已删除记录」清掉 —— 也就是把库里那些标成 deleted 的条目真正删掉 */
async function purgeArchive() {
  setPurgeConfirm(false);

  const lib = await getLibrary();
  const dead = Object.keys(lib.items).filter(k => lib.items[k].state === 'deleted');
  if (!dead.length) { setHint('「已删除记录」本来就是空的。', 'warn'); return; }

  $('btn-purge').disabled = true;
  await removeLibItems(dead);
  await loadArchive();
  await refreshLibrary();
  await refreshBadge();
  $('btn-purge').disabled = false;

  log(`🧹 已清空「已删除记录」，共移除 ${dead.length} 条`);
  setHint(`已清空「已删除记录」，移除 ${dead.length} 条。此操作不可恢复。`, '');
}

/* ---------------------------------------------------------------- 列表渲染 */

/**
 * 刷新删除队列。
 *
 * 队列现在是**显式**的：从库里勾选之后点「删除选中」才会进来，
 * 不再像以前那样开机就自动把书签目录里的东西全灌进来。
 * 这个按钮的作用是「把已经处理完的从队列里摘掉」，并且把入口指清楚。
 */
async function reload() {
  const before = items.length;
  items = items.filter(i => i.status !== 'done');
  stats = { ok: 0, fail: 0, gone: 0 };
  render();
  setHint(before === items.length
    ? '队列没有变化。要删什么，在上面评论库里勾选后点「删除选中」。'
    : `已从队列里移走 ${before - items.length} 条处理完的。`, '');
}

function stText(it) {
  if (it.status === 'done') return it.note || '已删除';
  if (it.status === 'failed') return it.note || '失败';
  return it.status === 'working' ? '删除中…' : '';
}

/** 当前来源筛选下应该显示的条目 */
function visibleItems() {
  if (sourceFilter === 'all') return items;
  const wantAicu = sourceFilter === 'aicu';
  return items.filter(i => (i.source === 'aicu') === wantAicu);
}

const FILTER_LABEL = { all: '全部', bookmark: '书签记录', aicu: 'aicu 导入' };

/** 筛选栏只在初始化时建一次，之后只更新数字，避免每删一条都重建 DOM */
function buildFilters() {
  $('filters').innerHTML = ['all', 'bookmark', 'aicu'].map(k =>
    `<button class="chip" data-src="${k}">${FILTER_LABEL[k]} <b>0</b></button>`
  ).join('');
}

function renderFilters() {
  const counts = { all: 0, bookmark: 0, aicu: 0 };
  for (const i of items) {
    if (i.status === 'done') continue;
    counts.all++;
    counts[i.source === 'aicu' ? 'aicu' : 'bookmark']++;
  }
  for (const btn of $('filters').querySelectorAll('.chip')) {
    const k = btn.dataset.src;
    btn.querySelector('b').textContent = counts[k];
    btn.classList.toggle('on', k === sourceFilter);
  }
}

function rowHtml(it) {
  const cls = STATE_CLS[it.status] || '';
  const kind = it.parsed.isSecondary ? '楼中楼' : '一级评论';
  const tag = it.source === 'aicu'
    ? '<i class="tag aicu">aicu</i>'
    : '<i class="tag">书签</i>';
  return `<div class="row ${it.status}" data-id="${it.id}">
    <input type="checkbox" class="ck" ${it.checked && it.status !== 'done' ? 'checked' : ''} ${it.status === 'done' ? 'disabled' : ''}>
    <div class="row-main">
      <div class="row-title" title="${escapeHtml(it.title)}">${tag}${escapeHtml(it.title)}</div>
      <div class="row-sub">rpid ${escapeHtml(it.parsed.rpid)} · ${escapeHtml(sourceLabel(it.parsed.pageUrl))} · ${kind}</div>
    </div>
    <div class="row-state ${cls}">${escapeHtml(stText(it))}</div>
  </div>`;
}

function emptyText() {
  if (items.length && !visibleItems().length) return '这个来源下没有待处理的条目。';
  if (items.length) return '都处理完了 🎉';
  return '还没有记录。在 B 站发一条评论试试，或者从下面的 aicu.cc 导入历史评论。';
}

/* ============================================================ 评论库视图
 *
 * 这是产品的主界面：本地保存的所有评论，可搜索、可筛选、可排序、可翻页。
 * 删除只是这一层之上的一个可选操作（「删除选中」），不再是主界面。
 */

let libQ = '';                 // 搜索词
let libStates = [];            // 状态筛选；空 = 全部
let libSource = 'all';         // 来源筛选：all | record | aicu
let libSort = 'time-desc';
let libPage = 0;
let libTimer = null;

const LIB_PAGE_SIZE = 50;

/**
 * 库里勾选的 rpid。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里能直接摆布它来验证
 * 「哪些状态允许进删除队列」—— 这个准入规则出过一次线上 bug。
 */
var libSelected = new Set();

const LIB_STATE_TAG = {
  live: '<i class="tag live">还在</i>',
  gone: '<i class="tag gone">已没了</i>',
  deleted: '<i class="tag deleted">已删除</i>',
  unreachable: '<i class="tag unreachable">查不到</i>',
  unknown: '<i class="tag">未检查</i>'
};

/** 这条是哪来的：自己刚发的，还是从 aicu 导入的历史评论 */
function libSourceTag(it) {
  return it.source === 'record'
    ? '<i class="tag rec">记录</i>'
    : '<i class="tag aicu">导入</i>';
}

const LIB_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'checked', label: '已检查' },
  { id: 'live', label: '还在' },
  { id: 'gone', label: '已没了' },
  { id: 'deleted', label: '已删除' },
  { id: 'unreachable', label: '查不到' },
  { id: 'unknown', label: '未检查' }
];

/** 「已检查」不是库里真实的一种状态，而是其余四态的并集；查询时翻译成它们 */
const CHECKED_STATES = ['live', 'gone', 'deleted', 'unreachable'];

/** 库列表里的一行 */
function libRowHtml(it) {
  const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
  const text = String(it.message || '').replace(/\s+/g, ' ').trim() || '（没有正文）';
  const v = it.video;
  const title = (v && v.title)
    ? v.title
    : (Number(it.type) === 1 ? 'av' + it.oid : aicuTypeName(it.type) + ' ' + it.oid);
  const kind = Number(it.rank) === 2 ? '楼中楼' : '一级评论';
  const c0 = aicuCommentUrl(it);
  const c2 = aicuSubUrl(it);

  // 上次检查的结论说明。「查不到」和「未检查」光看标签分不出原因，得把话写出来。
  const note = it.note
    ? `<div class="lrow-note">${escapeHtml(it.note)}</div>`
    : '';

  return `<div class="lrow s-${escapeHtml(it.state)}" data-rpid="${escapeHtml(it.rpid)}">
    <input type="checkbox" class="ck" ${libSelected.has(it.rpid) ? 'checked' : ''}>
    <div class="lrow-main">
      <div class="lrow-title">${LIB_STATE_TAG[it.state] || ''}${libSourceTag(it)}${escapeHtml(text)}</div>
      <div class="lrow-vid">${escapeHtml(title)}${v && v.owner ? '　·　UP ' + escapeHtml(v.owner) : ''}</div>
      <div class="lrow-meta">${escapeHtml(when)}　·　${escapeHtml(aicuTypeName(it.type))}　·　${kind}
        　·　rpid ${escapeHtml(it.rpid)}${it.aliveCheckedAt ? '　·　查于 ' + escapeHtml(fmtTime(it.aliveCheckedAt)) : ''}</div>
      ${note}
    </div>
    <div class="lrow-links">
      ${c0 ? `<a href="${escapeHtml(c0)}" target="_blank" rel="noreferrer">方式0</a>` : ''}
      ${c2 ? `<a href="${escapeHtml(c2)}" target="_blank" rel="noreferrer">方式2</a>` : ''}
    </div>
  </div>`;
}

function libPagerHtml(total) {
  const pages = Math.max(1, Math.ceil(total / LIB_PAGE_SIZE));
  if (pages <= 1) return '';
  const cur = Math.min(libPage, pages - 1);
  return `<button class="btn mini ghost" data-page="prev"${cur === 0 ? ' disabled' : ''}>← 上一页</button>
    <span class="pager-info">第 ${cur + 1} / ${pages} 页</span>
    <button class="btn mini ghost" data-page="next"${cur >= pages - 1 ? ' disabled' : ''}>下一页 →</button>`;
}

function renderLibFilters(s) {
  const counts = {
    all: s.total,
    checked: s.total - s.unknown,          // 「已检查」= 除"未检查"之外的全部
    live: s.live, gone: s.gone, deleted: s.deleted,
    unknown: s.unknown, unreachable: s.unreachable
  };
  $('lib-states').innerHTML = LIB_FILTERS.map(function (f) {
    const on = (f.id === 'all' && !libStates.length) || (libStates.length === 1 && libStates[0] === f.id);
    return `<button class="chip${on ? ' on' : ''}" data-state="${f.id}">${f.label} <b>${counts[f.id] || 0}</b></button>`;
  }).join('');
}

function updateLibSelection() {
  $('btn-delete-selected').textContent = libSelected.size
    ? `删除选中（${libSelected.size}）`
    : '删除选中';
}

/** 重新算统计 + 重画列表。所有库操作最后都落到这里。 */
async function refreshLibrary() {
  const s = await libraryStats();

  $('lib-total').textContent = s.total;
  $('lib-live').textContent = s.live;
  $('lib-gone').textContent = s.gone;
  $('lib-deleted').textContent = s.deleted;
  $('lib-unknown').textContent = s.unknown;
  $('lib-unreachable').textContent = s.unreachable;
  $('aicu-count').textContent = s.total;

  const bits = [];
  if (s.uid) bits.push('UID ' + s.uid);
  if (s.totalOnSite > 0) bits.push('站上共 ' + s.totalOnSite + ' 条');
  if (s.videos) bits.push(s.videos + ' 个视频' + (s.titled < s.videos ? `（已缓存 ${s.titled} 个标题）` : ''));
  if (s.probedAt) bits.push('上次巡检 ' + fmtTime(s.probedAt));
  $('lib-updated').textContent = bits.join('　·　');

  renderLibFilters(s);

  const r = await queryLib({
    q: libQ,
    // 「已检查」翻译成其余四态；库里并没有 checked 这个状态
    states: (libStates.length === 1 && libStates[0] === 'checked') ? CHECKED_STATES : libStates,
    source: libSource,
    sort: libSort,
    offset: libPage * LIB_PAGE_SIZE,
    limit: LIB_PAGE_SIZE
  });

  const pages = Math.max(1, Math.ceil(r.total / LIB_PAGE_SIZE));
  if (libPage >= pages) {          // 删着删着当前页没了，退回去重画
    libPage = pages - 1;
    return await refreshLibrary();
  }

  const filtering = !!(libQ || libStates.length);
  $('lib-count').textContent = r.total
    ? `第 ${libPage * LIB_PAGE_SIZE + 1}–${Math.min(r.total, (libPage + 1) * LIB_PAGE_SIZE)} 条，共 ${r.total} 条`
    : (filtering ? '没有匹配的评论' : '库里还没有评论');

  // 巡检期间这个函数会被反复调用；不保住滚动位置的话列表会一直往回跳，没法看
  const listEl = $('list');
  const keepScroll = listEl.scrollTop;

  listEl.innerHTML = r.items.length
    ? r.items.map(libRowHtml).join('')
    : `<div class="empty" style="padding:18px">${escapeHtml(filtering
        ? '没有匹配的评论，换个词或者把筛选放宽。'
        : '库里还没有评论。点右上角的「导入历史」开始。')}</div>`;
  if (keepScroll) listEl.scrollTop = keepScroll;

  $('lib-pager').innerHTML = libPagerHtml(r.total);

  // 「全选本页」要和本页实际勾选情况对齐
  const pageCk = $('check-page');
  const rows = $('list').querySelectorAll('.lrow');
  let onPage = 0;
  for (const row of rows) if (libSelected.has(row.dataset.rpid)) onPage++;
  pageCk.checked = rows.length > 0 && onPage === rows.length;
  pageCk.indeterminate = onPage > 0 && onPage < rows.length;

  updateLibSelection();
}

/* ------------------------------------------------------- 库操作：删除选中 */

/**
 * 把库里勾选的评论放进删除队列。
 *
 * **已经没了的（gone）和我们自己删过的（deleted）进不来** —— 为它们发删除请求
 * 只会拿到 12022，纯属浪费一次接口调用，也正好把存活探测省下的功夫还回去。
 *
 * 而且是"放进队列"而不是立刻删：删除不可逆，先让人看一眼队列。
 */
async function deleteSelected() {
  if (running) return;
  if (!libSelected.size) { setHint('先在库里勾选要删除的评论。', 'warn'); return; }

  const picked = await getLibItems(Array.from(libSelected));
  if (!picked.length) { setHint('勾选的条目在库里找不到了，刷新一下再看看。', 'bad'); return; }

  const deletable = picked.filter(it => isDeletable(it.state));
  const blocked = picked.filter(it => !isDeletable(it.state));

  // 被挡下的一律从勾选集里摘掉，免得反复撞同一堵墙
  for (const it of blocked) libSelected.delete(it.rpid);

  if (!deletable.length) {
    const nGone = blocked.filter(x => x.state === 'gone').length;
    const nDel = blocked.filter(x => x.state === 'deleted').length;
    const why = [];
    if (nGone) why.push(`${nGone} 条已经没了`);
    if (nDel) why.push(`${nDel} 条是之前删过的`);
    await refreshLibrary();
    setHint(`选中的 ${picked.length} 条都不能进删除队列：${why.join('，')}。` +
      '已经不存在的评论不需要（也没法）再删一次 —— 为它们发请求只会白费一次接口调用。',
      'warn');
    return;
  }

  const have = new Set();
  for (const x of items) if (x.parsed && x.parsed.rpid) have.add(x.parsed.rpid);

  let added = 0;
  for (const it of deletable) {
    if (have.has(it.rpid)) continue;
    items.push(aicuRow(it));
    have.add(it.rpid);
    added++;
  }

  render();
  $('fold-delete').open = true;
  await refreshLibrary();

  const skip = blocked.length
    ? `　另有 ${blocked.length} 条已从勾选里去掉（已经没了或删过的，不该再删一次）。`
    : '';
  setHint(`已把 ${added} 条放进删除队列（重复的自动跳过）。${skip}` +
    '展开「删除执行」核对一下再点「开始删除」—— 删除不可逆。', added ? '' : 'warn');
}

/* ------------------------------------------------------- 库操作：视频标题 */

/**
 * 拉视频标题。
 *
 * 库里只有 type:oid，显示出来是一堆 av123456789，根本没法浏览 —— 标题是
 * 管理界面的刚需。按视频缓存，所以每个视频只会请求一次。
 */
async function fetchVideoTitles() {
  const missing = await missingVideoTitles(30);
  if (!missing.length) { setHint('所有视频都已经有标题了。', ''); return; }

  setHint(`正在拉取 ${missing.length} 个视频的标题…`, '');
  const map = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < missing.length; i++) {
    const info = await fetchVideoInfo(missing[i]);
    if (info && info.title) { map[videoKey(missing[i].type, missing[i].oid)] = info; ok++; }
    else fail++;
    setHint(`拉取标题 ${i + 1}/${missing.length} —— 成功 ${ok}，失败 ${fail}。`, '');
    if (i < missing.length - 1) await sleep(300);
  }

  if (ok) await saveVideoTitles(map);
  await refreshLibrary();

  const rest = (await missingVideoTitles(1)).length;
  setHint(`标题拉取完成：成功 ${ok} 个，失败 ${fail} 个。` +
    (fail ? '　失败的多半是被反爬拦了，过会儿再点一次。' : '') +
    (rest ? '　还有视频没拉，可以再点一次。' : ''), fail ? 'warn' : '');
}

/* ------------------------------------------------------------ 事件接线 */

function bindLibraryEvents() {
  $('lib-q').addEventListener('input', function (e) {
    const v = e.target.value;
    clearTimeout(libTimer);
    libTimer = setTimeout(function () { libQ = v; libPage = 0; refreshLibrary(); }, 220);
  });

  $('lib-sort').addEventListener('change', function (e) {
    libSort = e.target.value;
    libPage = 0;
    refreshLibrary();
  });

  $('lib-src').addEventListener('change', function (e) {
    libSource = e.target.value === 'record' || e.target.value === 'aicu' ? e.target.value : 'all';
    libPage = 0;
    refreshLibrary();
  });

  $('lib-states').addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('button[data-state]') : null;
    if (!btn) return;
    const id = btn.dataset.state;
    if (id === 'all') libStates = [];
    else libStates = (libStates.length === 1 && libStates[0] === id) ? [] : [id];
    libPage = 0;
    refreshLibrary();
  });

  $('lib-pager').addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('button[data-page]') : null;
    if (!btn || btn.disabled) return;
    libPage += btn.dataset.page === 'next' ? 1 : -1;
    if (libPage < 0) libPage = 0;
    refreshLibrary();
  });

  $('list').addEventListener('change', function (e) {
    const ck = e.target.closest ? e.target.closest('input.ck') : null;
    if (!ck) return;
    const row = ck.closest('.lrow');
    if (!row) return;
    if (ck.checked) libSelected.add(row.dataset.rpid);
    else libSelected.delete(row.dataset.rpid);

    const rows = $('list').querySelectorAll('.lrow');
    let on = 0;
    for (const r of rows) if (libSelected.has(r.dataset.rpid)) on++;
    $('check-page').checked = rows.length > 0 && on === rows.length;
    $('check-page').indeterminate = on > 0 && on < rows.length;
    updateLibSelection();
  });

  $('check-page').addEventListener('change', function (e) {
    const on = e.target.checked;
    const rows = $('list').querySelectorAll('.lrow');
    for (const row of rows) {
      if (on) libSelected.add(row.dataset.rpid);
      else libSelected.delete(row.dataset.rpid);
      const ck = row.querySelector('input.ck');
      if (ck) ck.checked = on;
    }
    updateLibSelection();
  });

  $('btn-delete-selected').addEventListener('click', function () {
    deleteSelected().catch(function (e) { setHint('操作失败：' + ((e && e.message) || e), 'bad'); });
  });

  $('btn-titles').addEventListener('click', function () {
    if (running || autoRunning || probing) return;
    fetchVideoTitles().catch(function (e) { setHint('拉标题失败：' + ((e && e.message) || e), 'bad'); });
  });
}

/* --------------------------------------------------------- 主视图 / 副视图 */

/**
 * 面板有三个视图：
 *   main   —— 评论库（**主页**：所有历史评论，日常都在这）
 *   import —— 导入历史（一次性的初始化步骤，不是日常功能）
 *   data   —— 数据与存储（数据都在哪、怎么删）
 *
 * 为什么把导入和存储都拆出去：它们回答的是"一开始怎么把数据弄进来"和
 * "数据到底放在哪"这两个一次性问题，摆在主页会喧宾夺主。
 */
function showView(name) {
  const want = (name === 'import' || name === 'data') ? name : 'main';
  $('view-main').classList.toggle('hide', want !== 'main');
  $('view-import').classList.toggle('hide', want !== 'import');
  $('view-data').classList.toggle('hide', want !== 'data');

  if (want === 'import') loadAicu().catch(function () {});
  else if (want === 'data') renderDataPage().catch(function () {});
  else refreshLibrary().catch(function () {});
}

/* -------------------------------------------------- 数据与存储页 */

let dataClearTimer = null;

function setDataClearConfirm(on) {
  if (dataClearTimer) { clearTimeout(dataClearTimer); dataClearTimer = null; }
  $('data-clear-confirm').classList.toggle('hide', !on);
  $('btn-data-clear').classList.toggle('hide', !!on);
  if (on) dataClearTimer = setTimeout(function () { setDataClearConfirm(false); }, 8000);
}

/** 把「数据都在哪、各有多少」如实写出来 */
async function renderDataPage() {
  const st = await libraryStats();
  const s = await getSettings();

  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (e) { bytes = 0; }

  $('data-lib').textContent =
    `共 ${st.total} 条　·　还在 ${st.live}　·　已没了 ${st.gone}　·　已删除 ${st.deleted}` +
    `　·　查不到 ${st.unreachable}　·　未检查 ${st.unknown}` +
    `　·　其中自己记录 ${st.recorded} 条、导入 ${st.imported} 条` +
    `　·　涉及 ${st.videos} 个视频` +
    (st.probedAt ? `　·　上次巡检 ${fmtTime(st.probedAt)}` : '') +
    (bytes ? `　·　本地存储共占用约 ${(bytes / 1024).toFixed(1)} KB` : '');

  const badge = { off: '不显示', live: '显示还在的条数', pending: '显示还没处理的条数' }[s.badgeMode] || '不显示';
  $('data-settings').textContent =
    `自动记录${s.enabled ? '已开启' : '已关闭'}　·　角标${badge}` +
    `　·　删除间隔 ${s.minDelay}~${s.maxDelay} 毫秒` +
    `　·　同时写收藏夹${s.useBookmarks ? '已开启' : '已关闭'}`;
}

/** 把整个评论库删掉（设置和导出的文件都不动） */
async function clearWholeLibrary() {
  setDataClearConfirm(false);
  $('btn-data-clear').disabled = true;
  try {
    await clearLibrary();
    libSelected.clear();
    items = [];
    render();
    await refreshLibrary();
    await loadArchive();
    await renderDataPage();
    await refreshBadge();
    setHint('评论库已经清空。设置没动，之前导出的备份文件也还在你自己的下载目录里。', 'warn');
  } catch (e) {
    setHint('清空失败：' + ((e && e.message) || e), 'bad');
  } finally {
    $('btn-data-clear').disabled = false;
  }
}

function render() {
  const list = visibleItems();
  $('queue-list').innerHTML = list.length
    ? list.map(rowHtml).join('')
    : `<div class="empty" style="padding:18px">${escapeHtml(emptyText())}</div>`;
  syncCounts();
}

function renderRow(it) {
  const el = $('queue-list').querySelector(`.row[data-id="${it.id}"]`);
  if (!el) { render(); return; }

  el.className = 'row ' + it.status;
  const ck = el.querySelector('.ck');
  if (ck) {
    ck.checked = it.checked && it.status !== 'done';
    ck.disabled = it.status === 'done';
  }
  const st = el.querySelector('.row-state');
  st.className = 'row-state ' + (STATE_CLS[it.status] || '');
  st.textContent = stText(it);
}

/** 一次算清所有计数：概览那一行 + 筛选栏 + 勾选数 + 按钮文案 */
function syncCounts() {
  const left = items.filter(i => i.status !== 'done');
  const sel = left.filter(i => i.checked).length;
  $('stat-pending').textContent = left.length;
  $('stat-ok').textContent = stats.ok;
  $('stat-fail').textContent = stats.fail;
  $('stat-gone').textContent = stats.gone;
  $('sel-count').textContent = sel === left.length
    ? `待处理 ${left.length} 条`
    : `已勾选 ${sel} / ${left.length} 条`;
  $('btn-start').textContent = (sel && sel !== left.length) ? `删除评论（${sel} 条）` : '删除评论';
  renderFilters();
}

function updateProgress(done, total) {
  $('progress-inner').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}

/** 顶部那行「预计还要多久」 */
function setEta(text) {
  const el = $('eta');
  if (el) el.textContent = text || '';
}

function setHint(text, kind) {
  const el = $('hint');
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

function log(line) {
  const el = $('log');
  el.textContent += `[${fmtTime(Date.now())}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

/** 失败时用的日志：顺手把日志区展开，别让它埋在折叠里没人看见 */
function logError(line) {
  log(line);
  if (logAutoOpened) return;
  logAutoOpened = true;
  const fold = $('fold-log');
  if (fold) fold.open = true;
}

function setUi(isRunning) {
  $('btn-start').disabled = isRunning;
  $('btn-stop').disabled = !isRunning;
  $('btn-reload').disabled = isRunning;
  $('btn-retry').disabled = isRunning;
  $('btn-purge').disabled = isRunning;
  refreshAicuButtons();
  if (isRunning) setPurgeConfirm(false);
}

/* ---------------------------------------------------------------- 删除执行 */

/** 索引里没有 oid 时，用 BV 号反查视频 aid（视频评论区的 oid 就是 aid） */
async function resolveAid(bvid) {
  if (aidCache.has(bvid)) return aidCache.get(bvid);
  let aid = '';
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { credentials: 'omit' });
    const json = await res.json();
    if (json && json.code === 0 && json.data && json.data.aid) aid = String(json.data.aid);
  } catch (e) { /* 忽略 */ }
  aidCache.set(bvid, aid);
  return aid;
}

async function resolveTarget(it) {
  const p = it.parsed;

  // 库里的条目自带评论区 id 与类型，直接就用
  if (it.oid && it.type !== null && it.type !== undefined) {
    return { type: Number(it.type), oid: String(it.oid), rpid: p.rpid };
  }

  // 兜底：只拿到 BV 号时反查 aid
  let type = (it.type !== null && it.type !== undefined) ? Number(it.type) : null;
  let oid = it.oid ? String(it.oid) : '';

  if (!oid && p.bvid) {
    oid = await resolveAid(p.bvid);
    if (type === null) type = 1;
  }
  if (!oid) return { error: '这条记录里没有评论区 oid，也没能用 BV 号反查出 aid' };

  if (type === null || Number.isNaN(type)) {
    if (!p.bvid) return { error: '缺少评论区类型 type，无法定位这条评论' };
    type = 1;
  }
  return { type: type, oid: oid, rpid: p.rpid };
}

/** 等目标标签页加载完（读不到 status 就稍等片刻直接开工） */
function waitTabComplete(tabId, timeout) {
  return new Promise(function (resolve) {
    const onUp = function (id, info) {
      if (id === tabId && info && info.status === 'complete') finish();
    };
    const finish = function () {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUp);
      resolve();
    };
    const timer = setTimeout(finish, timeout);

    chrome.tabs.onUpdated.addListener(onUp);
    chrome.tabs.get(tabId).then(function (tab) {
      if (!tab || tab.status === 'complete') return finish();
      if (typeof tab.status !== 'string') setTimeout(finish, 1200);
    }).catch(finish);
  });
}

/** 找一个（或开一个）bilibili 标签页当同站请求通道 */
async function getWorkerTab() {
  if (workerTabId !== null) {
    try { await chrome.tabs.get(workerTabId); return workerTabId; } catch (e) { workerTabId = null; }
  }

  const tabs = await withTimeout(chrome.tabs.query({ url: 'https://*.bilibili.com/*' }), 8000, []);
  const usable = (tabs || []).find(t => t.id !== undefined && t.id !== null && !t.discarded);
  if (usable) { workerTabId = usable.id; workerCreated = false; return workerTabId; }

  const tab = await withTimeout(chrome.tabs.create({ url: 'https://www.bilibili.com/', active: false }), 8000, null);
  if (!tab) throw new Error('打开 bilibili 标签页时卡住了');
  workerTabId = tab.id;
  workerCreated = true;
  await waitTabComplete(tab.id, 25000);
  return tab.id;
}

/** 确保手上有一个还活着的通道标签页；被关掉就重新找一个 */
async function acquireWorkerTab() {
  if (workerTabId !== null) {
    try {
      await withTimeout(chrome.tabs.get(workerTabId), 5000, null);
      return workerTabId;
    } catch (e) {
      workerTabId = null;      // 用户把它关了
      workerCreated = false;
    }
  }
  return await getWorkerTab();
}

/**
 * 把一个函数注入 bilibili 页面跑，然后等它回话。删除和存活探测都走这里。
 *
 * 结果有两条回传通道，谁先到用谁：
 *   ① **控制台自己去页面取**（主）：注入的脚本把结果挂在 `window.__bcDelResults` 上，
 *      我们隔一会儿用 executeScript 回去读一次。**完全不经过内容脚本**。
 *   ② 老路子：页面 postMessage → 隔离世界的内容脚本转发（兜底）。
 *
 * 为什么要把 ① 做成主通道：② 依赖「那个 bilibili 标签页里跑着当前版本的内容脚本」。
 * 如果标签页是装/更新扩展之前就开着的，内容脚本已经失效 —— 于是每条都静静地等满
 * 超时，一千多条就是八个多小时，而且看不出哪里坏了。① 没有这个依赖。
 *
 * **world 很重要，别随手改**：
 *   - `'MAIN'`（默认）：主世界。删除必须在这里 —— `recorder-main.js` 要在这一层
 *     挂钩删除请求，手动删除的评论才能被记进账本。
 *   - `'ISOLATED'`：内容脚本所在的世界。**它的 fetch 是干净的**，没有被我们自己的
 *     钩子包过，也没有被 B 站自己的 fetch 包装改写。存活探测是只读的、不需要谁记账，
 *     所以放这里 —— 之前放主世界，探测请求会走进 B 站的包装层，一条都问不出来。
 *
 * 返回注入脚本写下的那个结果对象（原样，含 ok/code/message 以及各自的业务字段）。
 */
async function runInjected(tabId, fn, arg, timeoutMs, world) {
  const requestId = 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const OVERALL_MS = Number(timeoutMs || BC_DELETE_TIMEOUT_MS) || 23000;
  const payload = Object.assign({}, arg, { requestId: requestId });
  const useWorld = world || 'MAIN';

  // 通道 ①：轮询页面上的结果（超时不 resolve，交给总超时收尾）
  const viaPoll = (async function () {
    const deadline = Date.now() + OVERALL_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      let out;
      try {
        // 每一次轮询也带上限：某一次 executeScript 卡住不能把整条流程拖死
        out = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: useWorld,          // 必须和被探测/删除的脚本在同一个世界，否则读不到那个结果槽
            func: function (id) {
              return (window.__bcDelResults && window.__bcDelResults[id]) || null;
            },
            args: [requestId]
          }),
          4000,
          null
        );
      } catch (e) {
        // 页面被关了 / 被导航走了
        return { ok: false, tabGone: true, message: '读取页面结果失败：' + ((e && e.message) || e) };
      }
      const r = out && out[0] && out[0].result;
      if (r && r.requestId === requestId) return r;
    }
    return new Promise(function () { /* 永不 resolve */ });
  })();

  // 通道 ②：页面 postMessage → 内容脚本转发（同样超时不 resolve）
  const viaMessage = new Promise(function (resolve) {
    pending.set(requestId, resolve);
    setTimeout(function () { pending.delete(requestId); }, OVERALL_MS);
  });

  const overallTimeout = sleep(OVERALL_MS + 1500).then(function () {
    return { ok: false, message: '等待页面响应超时（' + Math.round(OVERALL_MS / 1000) + ' 秒）' };
  });

  // 注入本身也必须有上限 —— 这一步不 settle 的话，下面的 race 根本执行不到
  let injectedOut = null;
  let injectFailed = null;
  try {
    injectedOut = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: useWorld,
        func: fn,
        args: [payload]
      }),
      OVERALL_MS,
      null                    // null = 注入本身就超时了
    );
  } catch (e) {
    injectFailed = e;
  }

  if (injectFailed) {
    pending.delete(requestId);
    // 最常见的原因是通道标签页被关掉了，标记出来交给调用方换一个重试
    return { ok: false, tabGone: true, message: '注入网页失败：' + ((injectFailed && injectFailed.message) || injectFailed) };
  }

  if (injectedOut) {
    // 同步返回（没走 async）时这里就能直接拿到结果
    const r = injectedOut[0] && injectedOut[0].result;
    if (r && r.requestId === requestId) {
      pending.delete(requestId);
      return r;
    }
  }

  const r = await Promise.race([viaPoll, viaMessage, overallTimeout]);
  pending.delete(requestId);
  return r;
}

/** 删一条。返回 { ok, code, message, tabGone? } */
async function deleteOne(tabId, target) {
  const r = await runInjected(tabId, mainWorldDelete,
    { type: target.type, oid: target.oid, rpid: target.rpid });
  if (r.tabGone) return { ok: false, code: null, tabGone: true, message: r.message };
  return { ok: !!r.ok, code: r.code, message: r.message || '' };
}

/* ------------------------------------------------ 存活判定（纯逻辑，不走网络） */

/** 拼出 /x/v2/reply/reply 的地址 */
function buildReplyUrl(arg) {
  return 'https://api.bilibili.com/x/v2/reply/reply?type=' + encodeURIComponent(String(arg.type)) +
    '&oid=' + encodeURIComponent(String(arg.oid)) +
    '&root=' + encodeURIComponent(String(arg.root)) +
    '&pn=' + encodeURIComponent(String(arg.pn || 1)) +
    '&ps=' + encodeURIComponent(String(arg.ps || 1));
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * 解读 /x/v2/reply/reply 的返回。
 *
 * 用真实数据实测过（含用户提供的两个样本）：
 *   还在       → code 0，data.root 有值
 *   已经没了   → code 12006「没有该评论」
 *   风控/其它  → 一律"不确定"，绝不误判成已删除
 *
 * 返回 { alive: true|false|null, code, message, rootRpid }
 * 注意 alive=true 时还要看 rootRpid 是不是等于被查的那条 —— 不等于说明这是
 * **楼中楼**，B 站把我们解析到了所属的根评论，还得再去会话里确认本人。
 */
/** 「这个页面的评论功能已经关了」的各种说法 —— 按 code 按文案都认一下 */
const COMMENT_CLOSED_RE = /评论功能已关闭|评论区已关闭|评论已关闭|comment.{0,4}clos/i;

function interpretReplyCheck(json) {
  if (!json || typeof json.code !== 'number') {
    return { alive: null, message: '接口返回的不是数据（多半被反爬拦了）' };
  }
  if (json.code === 12006) {
    return { alive: false, code: 12006, message: json.message || '没有该评论' };
  }
  // -404「啥都木有」：视频本身访问不到（被设成仅UP主可见、已下架之类）。
  // 这时候**查不到 ≠ 评论没了**，所以单独归一类，不能混进"未检查"里让人看不出原因。
  if (json.code === -404) {
    return {
      alive: null, unreachable: true, code: -404,
      message: '视频/评论区访问不到（' + (json.message || '啥都木有') + '），没法确认这条还在不在'
    };
  }
  // UP 主关掉了这个页面的评论区。评论可能还在，只是这个入口查不到 —— 同样不能当它没了。
  if (json.code === 12061 || COMMENT_CLOSED_RE.test(String(json.message || ''))) {
    return {
      alive: null, unreachable: true, code: json.code,
      message: '这个页面的评论功能已经关闭（' + (json.message || '') + '），没法确认这条还在不在'
    };
  }
  if (json.code !== 0) {
    return { alive: null, code: json.code, message: json.message || '' };
  }
  const root = json.data && json.data.root;
  if (!root) {
    return { alive: false, code: 0, message: '会话还在，但这条评论已经不在了' };
  }
  return { alive: true, code: 0, message: '', rootRpid: String(root.rpid) };
}

/* ------------------------------------------------ 取数据：两条路自动选 */

/**
 * 记住哪条取数通道通。null=还没试过；true/false=以后照这个来。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里能直接观察/设置它。
 */
var probeDirectWorks = null;

/**
 * 拿一个 B 站接口的原始返回。两条路：
 *
 *   ① **扩展自己直发**：查询评论的接口是公开只读的，不需要登录、不需要 cookie，
 *      所以理论上扩展自己就能问，而且快得多、不用开标签页。
 *   ② **借一个 bilibili 标签页发**：实测扩展发的请求会带上
 *      `Origin: chrome-extension://…`，B 站反爬这种情况下会回 HTML 而不是 JSON；
 *      从 B 站页面里发（同站、不带 Origin）才是稳定可用的那条。
 *
 * 先试 ①，被拦了就永久切到 ② —— 不会比只有 ② 更差，而 ① 通的话会快很多。
 */
async function fetchBiliJson(url) {
  if (probeDirectWorks !== false) {
    try {
      const res = await withTimeout(fetch(url, { credentials: 'omit' }), 12000, null);
      if (res) {
        const text = await res.text().catch(() => '');
        const json = safeJson(text);
        if (json && typeof json.code === 'number') {
          if (probeDirectWorks === null) {
            probeDirectWorks = true;
            log('取数通道：扩展直接发就行（更快，也不用开标签页）');
          }
          return { json: json };
        }
        probeDirectWorks = false;
        log('取数通道：扩展直接发被拦了（HTTP ' + res.status + '），改用 bilibili 标签页。');
      } else {
        probeDirectWorks = false;
        log('取数通道：扩展直接发超时，改用 bilibili 标签页。');
      }
    } catch (e) {
      probeDirectWorks = false;
      log('取数通道：扩展直接发失败（' + ((e && e.message) || e) + '），改用 bilibili 标签页。');
    }
  }

  // 路 ②：借 bilibili 标签页发
  let tabId = null;
  try {
    tabId = await withTimeout(acquireWorkerTab(), 20000, null);
  } catch (e) { tabId = null; }
  if (!tabId) return { error: '打不开 bilibili 标签页' };

  const r = await runInjected(tabId, mainWorldFetchReply, { url: url }, 12000, 'MAIN');

  if (r.tabGone) {
    workerTabId = null;
    workerCreated = false;
    return { error: r.message || 'bilibili 标签页失效' };
  }
  if (!r.ok) return { error: r.message || '页面里没取到数据' };

  const json = safeJson(r.text);
  if (!json) {
    return { error: '页面取回的是网页而不是数据（HTTP ' + r.status + '），可能被反爬拦了' };
  }
  return { json: json };
}

/** 按 /x/v2/reply/reply 的参数取一次 */
async function fetchReplyRaw(arg) {
  return await fetchBiliJson(buildReplyUrl(arg));
}

/**
 * 取视频信息（标题 / UP 主 / BV 号）。
 *
 * 库里只存了 type:oid，列表上显示出来就是一堆 av123456789 —— 标题是管理界面的刚需。
 * 只处理视频（type 1）；其它类型（专栏、动态）接口各不相同，先不碰，列表里退回类型名。
 */
async function fetchVideoInfo(v) {
  if (Number(v.type) !== 1) return null;

  const r = await fetchBiliJson('https://api.bilibili.com/x/web-interface/view?aid=' +
    encodeURIComponent(String(v.oid)));
  if (r.error) return null;

  const d = r.json && r.json.data;
  if (!d || !d.title) return null;

  return {
    title: String(d.title).slice(0, 200),
    bvid: String(d.bvid || ''),
    owner: String((d.owner && d.owner.name) || '')
  };
}

/**
 * 判断一条评论还在不在。返回 { alive: true|false|null, message }
 *
 * 楼中楼那一步是重点：把二级评论的 rpid 当 root 去查时，B 站会把它解析到所属的
 * 根评论、照样返回 code 0 —— 光看 code 会把已删的楼中楼误判成还在。
 * 所以这种情况必须再去那条会话的回复列表里把**它本人**找出来，找到才算活着。
 */
/** B 站把楼中楼每页硬限制在 20 条 —— 写 ps=49 它也只给 20，别被这个骗了 */
const THREAD_PAGE_SIZE = 20;

/** 取会话的一页；返回 { list, count } 或 { error } */
async function fetchThreadPage(item, rootId, pn) {
  const r = await fetchReplyRaw({
    type: item.type, oid: item.oid, root: rootId, pn: pn, ps: THREAD_PAGE_SIZE
  });
  if (r.error) return { error: r.error };

  const j = r.json;
  if (!j || j.code !== 0) {
    return { error: (j && j.message) || '会话没返回数据', code: j && j.code };
  }
  return {
    list: (j.data && j.data.replies) || [],
    count: (j.data && j.data.page && j.data.page.count) || 0
  };
}

/**
 * 在一条会话里找出"本人"。
 *
 * 会话列表**按时间升序**（实测过），而我们手上有这条评论的 ctime ——
 * 所以不需要一页页翻，**按时间二分定位到具体哪一页**就行：
 * 一千条的会话也只要约 6 次请求，而不是 50 次。
 *
 * 以前这里写 `ps=49` 并且用 `pn*49 >= count` 判断"翻完了"，是错的 ——
 * B 站默默只给 20 条，所以实际只翻了 60 条就以为翻完了整条会话，
 * 长会话里的楼中楼于是全被误判成"未检查"。
 */
async function findInThread(item, rootId) {
  const first = await fetchThreadPage(item, rootId, 1);
  if (first.error) return { alive: null, message: first.error };

  const has = list => list.some(x => String(x.rpid) === String(item.rpid));
  const pages = Math.max(1, Math.ceil(first.count / THREAD_PAGE_SIZE));

  if (has(first.list)) return { alive: true, message: '' };
  if (pages === 1) {
    return { alive: false, message: '整条会话只有这一页，里面没有它' };
  }

  const target = Number(item.ctime) || 0;
  if (!target) {
    return { alive: null, message: '这条没有时间，没法在长会话里定位它' };
  }

  const seen = { 1: first };
  const take = async pn => {
    if (seen[pn]) return seen[pn];
    const r = await fetchThreadPage(item, rootId, pn);
    if (!r.error) seen[pn] = r;
    return r;
  };

  let lo = 1, hi = pages, landed = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = await take(mid);
    if (page.error) return { alive: null, message: page.error };
    if (has(page.list)) return { alive: true, message: '' };

    const times = page.list.map(x => Number(x.ctime) || 0).filter(Boolean);
    if (!times.length) break;

    const t0 = times[0], t1 = times[times.length - 1];
    if (target < t0) hi = mid - 1;
    else if (target > t1) lo = mid + 1;
    else { landed = mid; break; }
  }

  // 时间正好落在两页之间（比如这条已经被删、时间戳留下了空档），
  // 就用二分收敛出的插入位置当落点，再看一眼左右邻居。
  if (landed === null) {
    landed = Math.min(Math.max(lo, 1), pages);
    for (const pn of [landed - 1, landed]) {
      if (pn < 1 || pn > pages) continue;
      const page = await take(pn);
      if (page.error) return { alive: null, message: page.error };
      if (has(page.list)) return { alive: true, message: '' };
    }
    return { alive: null, message: '按时间没能定位到它（时间可能有偏差），没敢下结论' };
  }

  for (const pn of [landed - 1, landed + 1]) {
    if (pn < 1 || pn > pages) continue;
    const page = await take(pn);
    if (page.error) return { alive: null, message: page.error };
    if (has(page.list)) return { alive: true, message: '' };
  }

  return { alive: false, message: '会话里已经没有它了（按时间定位到第 ' + landed + ' 页，那一带没有）' };
}

/**
 * 判断一条评论还在不在。
 *
 * 返回 { state, alive, message, transport }：
 *   state     四态里的一种（含查不到）
 *   alive     给老调用方的兼容字段
 *   transport **是不是"链路本身不通"**（取数失败/被拦/超时），
 *             而不是"接口答了但答不出结论"。这两者要分开：
 *             单条问不出结果是这一条的事，链路不通才是整轮该停的理由。
 */
async function checkAliveOne(item) {
  const done = a => ({
    state: a.unreachable ? 'unreachable'
      : a.alive === true ? 'live'
        : a.alive === false ? 'gone' : 'unknown',
    alive: a.alive === undefined ? null : a.alive,
    message: a.message || ''
  });

  const first = await fetchReplyRaw({ type: item.type, oid: item.oid, root: item.rpid, pn: 1, ps: 1 });
  if (first.error) {
    return Object.assign(done({ alive: null, message: first.error }), { transport: true });
  }

  const a = interpretReplyCheck(first.json);
  if (a.alive !== true) return done(a);

  // 一级评论：B 站返回的 root 就是它自己
  if (a.rootRpid === String(item.rpid)) return done({ alive: true, message: '' });

  // 楼中楼：B 站把我们解析到了所属的根评论，得去会话里把本人找出来
  return done(await findInThread(item, a.rootRpid));
}

/**
 * 删除一条；通道标签页中途没了就自动换一个再试一次。
 * v1.0.0 只在开跑前取一次通道，用户中途手一滑关掉那个标签页，
 * 后面每一条都会失败——这里补上恢复能力。
 */
async function deleteWithRecovery(target) {
  let tabId = await acquireWorkerTab();
  let r = await deleteOne(tabId, target);

  if (r.tabGone) {
    log('  ↻ 请求通道标签页已失效，正在换一个…');

    // 注入失败不一定是因为标签页被关了（也可能是那个页面被导航去了别的站点），
    // 所以别急着丢掉记录：如果当前用的正是我们自己开的临时标签页，先把它收掉，
    // 否则重新 acquire 之后就再也认不出它，会白白留在后台。
    if (workerCreated && workerTabId !== null) {
      try { await chrome.tabs.remove(workerTabId); } catch (e) { /* 早就没了 */ }
    }
    workerTabId = null;
    workerCreated = false;

    tabId = await acquireWorkerTab();
    r = await deleteOne(tabId, target);
  }
  return r;
}

/**
 * 开工前自检：确认「注入 bilibili 页面 → 页面 postMessage → 内容脚本转发 → 控制台收到」
 * 这条链路是通的。
 *
 * 为什么要专门做这件事：链上任何一环断了（最常见的是**这个 bilibili 标签页是在装/更新
 * 扩展之前打开的，里面的内容脚本已经失效**），外在表现都是「点了删除之后一片安静」，
 * 然后每条各自等 25 秒超时 —— 一千多条就是八个多小时，而且完全看不出哪里坏了。
 * 先拿一条假消息跑一遍，几秒钟就能给出可操作的结论。
 */
async function preflight(tabId, opts) {
  const requireLogin = !(opts && opts.requireLogin === false);
  // 第一关：能不能注入、页面里读不读得到登录态
  let probe;
  try {
    probe = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function () {
          const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
          return { hasJct: !!m, href: location.href, ready: document.readyState };
        }
      }),
      8000,
      null
    );
  } catch (e) {
    return { ok: false, reason: '往那个 bilibili 标签页注入脚本失败：' + ((e && e.message) || e) };
  }

  if (!probe) {
    return { ok: false, reason: '往那个 bilibili 标签页注入脚本时卡住了（8 秒没回应）。把那个页面刷新一下再试。' };
  }

  const info = probe && probe[0] && probe[0].result;
  if (!info) return { ok: false, reason: '脚本注入进去了但没拿到返回值，那个标签页可能还没加载完。' };
  if (requireLogin && !info.hasJct) {
    return {
      ok: false,
      reason: '在那个 bilibili 页面里读不到 bili_jct。请确认浏览器已登录 B 站，并把那个页面刷新一下再试。'
    };
  }
  log('自检 1/2：注入正常' + (requireLogin ? '，登录态正常' : '（探测不需要登录，跳过登录检查）') +
    '（' + String(info.href).slice(0, 70) + '）');

  // 第二关：消息回传链路
  const requestId = 'pre-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const arrived = await new Promise(function (resolve) {
    pending.set(requestId, function () { resolve(true); });
    setTimeout(function () {
      if (pending.has(requestId)) { pending.delete(requestId); resolve(false); }
    }, Number(BC_PREFLIGHT_MS) || 6000);

    withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function (id) {
          window.postMessage({ __bcDeleterResult: { requestId: id, ok: true, code: 0, message: '自检' } }, '*');
        },
        args: [requestId]
      }),
      4000,
      null
    ).catch(function () { /* 下面按超时处理 */ });
  });

  if (!arrived) {
    // 主通道（控制台自己去页面取结果）不走这里，所以只提示、不拦。
    log('自检 2/2：内容脚本那条兜底通道没回应。不影响删除（主通道不走它），' +
      '但如果这个 bilibili 标签页是装/更新扩展之前就开着的，建议刷新一下。');
  } else {
    log('自检 2/2：兜底通道也正常');
  }

  return { ok: true };
}

/** 把库里这条标成「已删除」；返回空串表示成功，否则返回错误说明 */
async function archive(it) {
  // 没有 oid/type 的条目（比如剪贴板兜底记下来的）删掉就删掉了，库里也不留账
  if (!it.parsed || !it.parsed.rpid) return '';

  try {
    await markLibDeleted([it.parsed.rpid]);
    return '';
  } catch (e) {
    const m = '删除成功，但本地记录没能更新：' + ((e && e.message) || e);
    logError('  ！' + m);
    return m;
  }
}

const label = it => sourceLabel(it.parsed.pageUrl) + '#reply' + it.parsed.rpid;

async function refreshBadge() {
  try { await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }); } catch (e) { /* 后台可能刚好休眠 */ }
}

/**
 * 把已删除的 rpid 交回后台清索引。
 * 面板**刻意不做整体写回**：那会用打开面板时的旧快照，覆盖掉删除期间后台
 * 新记进来的条目，正是这一版要修掉的问题。所以这里只会重试消息，
 * 绝不能退化成整库覆盖写。
 */
async function forgetRpids(rpids) {
  if (!rpids.length) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.runtime.sendMessage({ type: 'FORGET_RPIDS', rpids: rpids });
      return;
    } catch (e) {
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
  }

  // 实在联系不上就放弃。残留的索引项无害：删除时会按 rpid 扫书签目录，
  // 而且真删过的话接口会返回 12022，一样能归档。
  log('  ！后台没应答，索引里会留下几条失效记录（无副作用，可忽略）');
}

/* ------------------------------------------------------------------ 主流程 */

async function start() {
  if (running) return;

  const targets = items.filter(i => i.checked && i.status !== 'done');
  if (!targets.length) { setHint('没有勾选任何可删除的评论。', 'warn'); return; }

  running = true;
  stopRequested = false;
  stats = { ok: 0, fail: 0, gone: 0 };
  setUi(true);
  syncCounts();
  updateProgress(0, targets.length);
  $('log').textContent = '';
  setHint('正在删除…这个面板别关。删除期间会复用一个 bilibili 标签页发请求。', '');
  setEta('');

  let tabId;
  try {
    tabId = await acquireWorkerTab();
    log('请求通道：标签页 #' + tabId);
  } catch (e) {
    log('准备 bilibili 标签页失败：' + ((e && e.message) || e));
    setHint('打不开 bilibili 页面，删除已中止。请确认网络能访问 bilibili.com 后重试。', 'bad');
    running = false;
    setUi(false);
    return;
  }

  // 开工前自检：不然链子断了会演变成「一千多条各等 23 秒」，还看不出哪里坏了
  setHint('正在自检：确认能注入 bilibili 页面、能读到登录态…', '');
  const check = await preflight(tabId);
  if (!check.ok) {
    logError('✗ 自检没通过：' + check.reason);
    setHint('删除没有开始。' + check.reason, 'bad');
    running = false;
    setUi(false);
    setEta('');
    return;
  }

  let aborted = false;
  let timeoutFails = 0;            // 连续「等不到页面回话」的条数
  const deletedRpids = [];         // 删成功的 rpid，最后交回后台清索引
  const deletedAicuRpids = [];     // 其中来自 aicu 导入的，要从导入清单里移除

  // 每条都要真调一次接口（删除接口本身就是"这条还在不在"的判据），
  // 所以先把预计耗时说清楚，别让人以为卡住了。
  const avgDelay = (Number(settings.minDelay) + Number(settings.maxDelay)) / 2;
  const estMin = Math.max(1, Math.round(targets.length * avgDelay / 60000));
  setEta(`预计约 ${estMin} 分钟`);
  log(`本次 ${targets.length} 条，每条之间等 ${settings.minDelay}~${settings.maxDelay} 毫秒，预计约 ${estMin} 分钟。`);
  log('中途可以点「停止」：已经处理过的会记账，下次不会重复处理。');

  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    if (stopRequested) { aborted = true; break; }

    it.status = 'working';
    it.note = '';
    renderRow(it);

    const t = await withTimeout(resolveTarget(it), 20000, { error: '定位这条评论超时（20 秒）' });
    let r = null;

    if (t.error) {
      it.status = 'failed';
      it.note = t.error;
      stats.fail++;
      logError('✗ ' + label(it) + ' → ' + t.error);
    } else {
      // 每条删除也带上限：一处 await 不 settle 不能把整轮拖死（这个坑真踩过）
      r = await withTimeout(attemptDelete(t), 30000,
        { ok: false, code: null, message: '这条处理超时（30 秒）' });

      if (r.code === -509) {
        log('  ↻ 触发风控限流（-509），等 15 秒后重试一次…');
        await sleep(15000);
        r = await withTimeout(attemptDelete(t), 30000,
          { ok: false, code: null, message: '这条重试也超时了（30 秒）' });
      }

      if (r.ok || r.code === 12022) {
        const moveErr = await archive(it);
        it.status = 'done';
        if (r.ok) {
          it.note = moveErr || '已删除';
        } else {
          stats.gone++;
          it.note = it.source === 'aicu'
            ? 'B 站上已经没有这条了'
            : (moveErr || '本来就不存在（已归档）');
        }
        stats.ok++;
        deletedRpids.push(t.rpid);
        if (it.source === 'aicu') deletedAicuRpids.push(t.rpid);
        log('✓ ' + label(it) + (r.ok ? ' 已删除' : ' 早就被删了'));
      } else {
        it.status = 'failed';
        it.note = explainCode(r.code, r.message);
        stats.fail++;
        logError('✗ ' + label(it) + ' 删除失败：code=' + r.code + ' ' + (r.message || ''));

        // 连续几条都等不到页面回话 —— 链路断了，别再一条条空等 23 秒
        if (/等待页面响应超时/.test(r.message || '')) {
          if (++timeoutFails >= 3) {
            setHint('连续 3 条都等不到 bilibili 页面回话。已中止 —— ' +
              '把那个 bilibili 标签页刷新一下（或关掉让扩展自己开一个）再重试。', 'bad');
            aborted = true;
            break;
          }
        } else {
          timeoutFails = 0;
        }
      }
    }

    renderRow(it);
    syncCounts();
    updateProgress(i + 1, targets.length);

    if (r && (r.code === -101 || r.code === -111)) {
      setHint('登录态异常（' + explainCode(r.code) + '），已自动停止。请重新登录 B 站后再来一次。', 'bad');
      aborted = true;
      break;
    }
    if (i % 10 === 0) {
      const leftMin = Math.round((targets.length - i - 1) * avgDelay / 60000);
      setEta(leftMin > 0
        ? `还剩约 ${leftMin} 分钟（${i + 1}/${targets.length}）`
        : `${i + 1}/${targets.length}`);
    }
    if (!stopRequested && i < targets.length - 1) await sleep(randInt(settings.minDelay, settings.maxDelay));
  }

  await forgetRpids(deletedRpids);
  await removeLibItems(deletedAicuRpids);
  await refreshBadge();

  if (workerCreated && workerTabId !== null) {
    try { await chrome.tabs.remove(workerTabId); } catch (e) { /* 忽略 */ }
    workerTabId = null;
    workerCreated = false;
    log('已关闭临时打开的后台标签页');
  }

  running = false;
  setUi(false);
  syncCounts();
  setEta('');
  await loadArchive();
  await loadAicu();

  const left = items.filter(i => i.status !== 'done').length;
  const goneText = stats.gone ? `，其中 ${stats.gone} 条 B 站上早就没有了` : '';
  if (stats.fail === 0 && !aborted) {
    setHint(`全部搞定：本次处理 ${stats.ok} 条${goneText}。书签类已归档，aicu 导入的已从清单移除。列表里还剩 ${left} 条。`, '');
  } else {
    setHint(`本次成功 ${stats.ok} 条${goneText}，失败 ${stats.fail} 条。失败的条目仍然在库里里，日志里有原因，修好后可点「重试失败项」。`, 'warn');
  }
  log(`—— 结束：成功 ${stats.ok}（其中早就没有的 ${stats.gone} 条），失败 ${stats.fail}，列表剩余 ${left} ——`);
}

/** 删一条，并把「连标签页都拿不到」这种情况收敛成一条失败原因，不让它掀翻整个循环 */
async function attemptDelete(target) {
  try {
    return await deleteWithRecovery(target);
  } catch (e) {
    return { ok: false, code: null, message: '打不开 bilibili 标签页：' + ((e && e.message) || e) };
  }
}

init().catch(e => setHint('初始化失败：' + ((e && e.message) || e), 'bad'));
