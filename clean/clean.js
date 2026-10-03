/**
 * clean.js —— 一键清除面板
 *
 * 删除请求必须从 bilibili 页面里发出去：扩展页面的 origin 是 chrome-extension://，
 * 对 bilibili.com 属于跨站，SESSDATA 会被 SameSite 拦掉。所以下面会把一小段脚本
 * 注入到 bilibili 标签页（没有就开一个后台标签页），由那个页面以同站身份发请求。
 */

import {
  getSettings, getIndex, ensureFolder, parseCommentUrl, listBookmarks,
  sleep, randInt, escapeHtml, explainCode, sourceLabel, fmtTime, folderPath,
  getAicuStore, listAicuItems, clearAicuStore, removeAicuItems, aicuPageUrl, aicuTypeName
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://api.bilibili.com/x/v2/reply/del', {
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

let running = false, stopRequested = false;
let workerTabId = null, workerCreated = false;
let settings = null, activeFolderId = null, deletedFolderId = null;
let indexCache = {}, items = [], stats = { ok: 0, fail: 0, gone: 0 }, purgeTimer = null;
let indexRefreshDone = false;   // 本轮删除里是否已经重读过索引
let sourceFilter = 'all';       // 来源筛选：all | bookmark | aicu
let logAutoOpened = false;      // 出错后日志是否已经自动展开过
let aicuFoldAutoOpened = false; // aicu 折叠区是否已经自动展开过

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
  activeFolderId = await ensureFolder(settings.folderActive);
  deletedFolderId = await ensureFolder(settings.folderDeleted);
  indexCache = await getIndex();

  buildFilters();
  bindEvents();
  await reload();
  await loadArchive();
  await loadAicu();
}

function bindEvents() {
  $('btn-start').addEventListener('click', start);

  $('btn-settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
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

  $('list').addEventListener('change', function (e) {
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

  $('btn-aicu-merge').addEventListener('click', function () {
    if (running) return;
    mergeAicu().catch(e => setAicuHint('加入失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-aicu-clear').addEventListener('click', function () {
    if (running) return;
    clearAicuStore()
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

/* ------------------------------------------- 已删除记录（本地书签账本）的展示 */

async function loadArchive() {
  if (!deletedFolderId || !settings) return;   // 初始化还没走完

  const list = await listBookmarks(deletedFolderId);
  list.sort((a, b) => String(b.title || '').localeCompare(String(a.title || '')));
  $('arc-count').textContent = String(list.length);
  $('arc-path').textContent =
    `待删目录：${folderPath(settings, settings.folderActive)}　|　归档目录：${folderPath(settings, settings.folderDeleted)}`;

  $('arc-list').innerHTML = list.length
    ? list.map(b => `<div class="arc-item" title="${escapeHtml(b.title)}">• <a href="${escapeHtml(b.url)}" target="_blank">${escapeHtml(b.title)}</a></div>`).join('')
    : '<div class="empty" style="padding:10px 13px">归档还是空的。删除评论后，链接会原样搬到这里。</div>';
}

/* ------------------------------------------------- aicu.cc 导入的历史评论
 * 本扩展只记录「装好之后」发出的评论；装之前发的、手机上发的都抓不到。
 * aicu.cc 存着完整历史，由 src/aicu-main.js 在它页面上顺手读回来。
 * 这里只负责展示与并入待删列表 —— 删除走的是上面那套完全相同的流程。
 */

const AICU_RENDER_LIMIT = 200;

let autoRunning = false;        // 自动翻页是否正在进行
let aicuRenderTimer = null;     // 导入区重绘节流

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

  const store = await getAicuStore();
  const list = await listAicuItems();
  const merged = items.filter(i => i.source === 'aicu').length;

  $('aicu-count').textContent = String(list.length);

  // 第一次看到有待导入的条目时自动展开；之后尊重用户的手动开合
  if (!aicuFoldAutoOpened && list.length) {
    aicuFoldAutoOpened = true;
    const fold = $('fold-aicu');
    if (fold) fold.open = true;
  }
  $('aicu-uid').textContent = store.uid
    ? ('UID ' + store.uid + (store.total ? ' · 站上记着 ' + store.total + ' 条' : ''))
    : '';

  const notes = [];
  if (!list.length) {
    notes.push('还没有导入。打开 https://www.aicu.cc/reply?uid=你的UID 翻几页，' +
      '或者直接点右边的「自动翻页抓取」让扩展替你翻。');
  } else {
    notes.push(`共 ${list.length} 条，其中 ${merged} 条已加入待删列表。`);
    notes.push('提醒：aicu.cc 只是索引，删除发生在 B 站；已删评论也可能仍留在它的存档里。');
  }
  if (store.mixed) {
    notes.push('⚠️ 这份清单里混了不止一个 UID 的数据，请确认都是你自己的账号。');
  }
  if (store.uid) {
    notes.push('⚠️ 请确认上面的 UID 是你自己的。');
  }
  setAicuHint(notes.join(' '), store.mixed ? 'warn' : '');

  const shown = list.slice(0, AICU_RENDER_LIMIT);
  $('aicu-list').innerHTML = shown.length
    ? shown.map(function (it) {
        const url = aicuPageUrl(it.type, it.oid);
        const text = String(it.message || '').replace(/\s+/g, ' ').trim();
        const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
        return `<div class="arc-item" title="${escapeHtml(text || it.rpid)}">• <a href="${escapeHtml(url)}" target="_blank">[${when}] ${escapeHtml(aicuTypeName(it.type))} · ${escapeHtml(text.slice(0, 40) || '评论')}</a></div>`;
      }).join('') + (list.length > AICU_RENDER_LIMIT
        ? `<div class="empty" style="padding:8px 13px">…还有 ${list.length - AICU_RENDER_LIMIT} 条未显示</div>`
        : '')
    : '<div class="empty" style="padding:10px 13px">还没有从 aicu.cc 导入任何评论。</div>';
}

/** 收集「已删除记录」里已有的 rpid —— 这些已经确认删过，别再浪费一次接口调用 */
async function archivedRpids() {
  const set = new Set();
  if (!deletedFolderId) return set;
  const list = await listBookmarks(deletedFolderId).catch(function () { return []; });
  for (const b of list) {
    const p = parseCommentUrl(b.url);
    if (p) set.add(p.rpid);
  }
  return set;
}

/** 把整个导入清单并进待删列表（按 rpid 去重，已删过的不再放回） */
async function mergeAicu() {
  const list = await listAicuItems();
  if (!list.length) {
    setAicuHint('清单是空的。先去 aicu.cc 打开你自己的评论页翻几页，再回来。', 'warn');
    return;
  }
  if (running) return;

  const known = new Set();
  for (const i of items) if (i.parsed && i.parsed.rpid) known.add(i.parsed.rpid);

  const archived = await archivedRpids();
  let added = 0, skipped = 0, alreadyGone = 0;

  for (const item of list) {
    if (known.has(item.rpid)) { skipped++; continue; }
    if (archived.has(item.rpid)) { alreadyGone++; continue; }
    items.push(aicuRow(item));
    known.add(item.rpid);
    added++;
  }

  render();
  const parts = [];
  if (skipped) parts.push(`${skipped} 条已在列表里`);
  if (alreadyGone) parts.push(`${alreadyGone} 条已在「已删除记录」里，跳过`);
  const tail = parts.length ? `（${parts.join('，')}）` : '';
  setAicuHint(`已加入 ${added} 条${tail}。勾选后点上面的「开始删除」即可。`, added ? '' : 'warn');
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
  $('btn-aicu-auto').classList.toggle('hide', !!on);
  $('btn-aicu-autostop').classList.toggle('hide', !on);
}

/** 找一个已打开的 aicu.cc 标签页；没有就按已知 UID 开一个后台标签页 */
async function findAicuTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aicu.cc/*', 'https://aicu.cc/*'] });
  const usable = tabs.find(t => t.id !== undefined && t.id !== null && !t.discarded);
  if (usable) return usable;

  const store = await getAicuStore();
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

async function startAutoPage() {
  if (autoRunning) return;
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

async function purgeArchive() {
  setPurgeConfirm(false);
  if (!deletedFolderId) return;

  const children = await chrome.bookmarks.getChildren(deletedFolderId).catch(function () { return []; });
  if (!children.length) { setHint('「已删除记录」本来就是空的。', 'warn'); return; }

  $('btn-purge').disabled = true;
  let removed = 0;
  for (const c of children) {
    try {
      if (c.url) {
        await chrome.bookmarks.remove(c.id);
        removed++;
      } else {
        removed += (await listBookmarks(c.id)).length;   // 手动建过子目录的话一起清掉
        await chrome.bookmarks.removeTree(c.id);
      }
    } catch (e) { /* 单条失败不影响其他 */ }
  }
  await loadArchive();
  await refreshBadge();
  $('btn-purge').disabled = false;

  log(`🧹 已清空「已删除记录」，共移除 ${removed} 条书签`);
  setHint(`已清空「${folderPath(settings, settings.folderDeleted)}」，移除 ${removed} 条书签。此操作不可恢复。`, '');
}

/* ---------------------------------------------------------------- 列表渲染 */

async function reload() {
  const list = await listBookmarks(activeFolderId);
  let skipped = 0;
  const next = [];

  for (const bm of list) {
    const parsed = parseCommentUrl(bm.url);
    if (!parsed) { skipped++; continue; }
    const old = items.find(i => i.id === bm.id);
    next.push({
      id: bm.id, source: 'bookmark', title: bm.title, url: bm.url, parsed,
      checked: old ? (old.status === 'done' ? false : old.checked) : true,
      status: old ? old.status : 'idle',
      note: old ? old.note : ''
    });
  }

  // 书签列表重建时，把 aicu 导入的条目原样保留（它们没有书签）
  const aicu = items.filter(i => i.source === 'aicu');
  items = next.concat(aicu);
  stats = { ok: 0, fail: 0, gone: 0 };   // 刷新过列表，「本次成功/失败」不该再显示上一轮的旧数字
  render();
  if (skipped > 0) setHint(`目录里有 ${skipped} 条不是评论链接的书签，已自动跳过（不会被删除）。`, 'warn');
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

function render() {
  const list = visibleItems();
  $('list').innerHTML = list.length
    ? list.map(rowHtml).join('')
    : `<div class="empty" style="padding:18px">${escapeHtml(emptyText())}</div>`;
  syncCounts();
}

function renderRow(it) {
  const el = $('list').querySelector(`.row[data-id="${it.id}"]`);
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
  // 跑删除的时候别让用户同时去点 aicu 抓取/合并，两件事会互相干扰
  for (const id of ['btn-aicu-auto', 'btn-aicu-merge', 'btn-aicu-clear']) {
    const el = $(id);
    if (el) el.disabled = isRunning;
  }
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

  // aicu 导入的条目自带评论区 id 与类型，直接就用，不必查索引
  if (it.source === 'aicu' && it.oid && it.type !== null && it.type !== undefined) {
    return { type: Number(it.type), oid: String(it.oid), rpid: p.rpid };
  }

  let meta = indexCache[p.rpid] || null;

  // 面板手里的索引是打开那一刻的快照。这里没命中，很可能是刚发的评论，
  // 重新读一次再说，免得误报「缺少评论区 oid」。
  // 每轮删除最多重读一次：索引整体可能上百 KB，几千条老记录逐条重读太浪费。
  if (!meta && !indexRefreshDone) {
    indexRefreshDone = true;
    indexCache = await getIndex();
    meta = indexCache[p.rpid] || null;
  }

  let type = (meta && meta.type !== null && meta.type !== undefined) ? Number(meta.type) : null;
  let oid = (meta && meta.oid) ? String(meta.oid) : '';

  if (!oid && p.bvid) {
    oid = await resolveAid(p.bvid);
    if (type === null) type = 1;
  }
  if (!oid) return { error: '缺少评论区 oid（索引里没有这条记录，且没能用 BV 号反查出 aid）' };

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

  const tabs = await chrome.tabs.query({ url: 'https://*.bilibili.com/*' });
  const usable = tabs.find(t => t.id !== undefined && t.id !== null && !t.discarded);
  if (usable) { workerTabId = usable.id; workerCreated = false; return workerTabId; }

  const tab = await chrome.tabs.create({ url: 'https://www.bilibili.com/', active: false });
  workerTabId = tab.id;
  workerCreated = true;
  await waitTabComplete(tab.id, 25000);
  return tab.id;
}

/** 确保手上有一个还活着的通道标签页；被关掉就重新找一个 */
async function acquireWorkerTab() {
  if (workerTabId !== null) {
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch (e) {
      workerTabId = null;      // 用户把它关了
      workerCreated = false;
    }
  }
  return await getWorkerTab();
}

/**
 * 注入主世界脚本删一条，然后等结果。
 *
 * 结果有两条回传通道，谁先到用谁：
 *   ① **控制台自己去页面取**（主）：注入的脚本把结果挂在 `window.__bcDelResults` 上，
 *      我们隔一会儿用 executeScript 回去读一次。**完全不经过内容脚本**。
 *   ② 老路子：页面 postMessage → 隔离世界的内容脚本转发（兜底）。
 *
 * 为什么要把 ① 做成主通道：② 依赖「那个 bilibili 标签页里跑着当前版本的内容脚本」。
 * 如果标签页是装/更新扩展之前就开着的，内容脚本已经失效 —— 于是每条都静静地等满
 * 超时，一千多条就是八个多小时，而且看不出哪里坏了。① 没有这个依赖。
 */
async function deleteOne(tabId, target) {
  const requestId = 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const OVERALL_MS = Number(BC_DELETE_TIMEOUT_MS) || 23000;

  // 通道 ①：轮询页面上的结果（超时不 resolve，交给总超时收尾）
  const viaPoll = (async function () {
    const deadline = Date.now() + OVERALL_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      let out;
      try {
        out = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: function (id) {
            return (window.__bcDelResults && window.__bcDelResults[id]) || null;
          },
          args: [requestId]
        });
      } catch (e) {
        // 页面被关了 / 被导航走了
        return { ok: false, code: null, tabGone: true, message: '读取页面结果失败：' + ((e && e.message) || e) };
      }
      const r = out && out[0] && out[0].result;
      if (r && r.requestId === requestId) {
        return { ok: !!r.ok, code: r.code, message: r.message || '' };
      }
    }
    return new Promise(function () { /* 永不 resolve */ });
  })();

  // 通道 ②：页面 postMessage → 内容脚本转发（同样超时不 resolve）
  const viaMessage = new Promise(function (resolve) {
    pending.set(requestId, resolve);
    setTimeout(function () { pending.delete(requestId); }, OVERALL_MS);
  });

  const overallTimeout = sleep(OVERALL_MS + 1500).then(function () {
    return { ok: false, code: null, message: '等待页面响应超时（' + Math.round(OVERALL_MS / 1000) + ' 秒）' };
  });

  // 先把删除指令注入进去
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: mainWorldDelete,
      args: [{ requestId: requestId, type: target.type, oid: target.oid, rpid: target.rpid }]
    });
    // 同步返回（没走 async）时这里就能直接拿到结果
    const r = out && out[0] && out[0].result;
    if (r && r.requestId === requestId) {
      pending.delete(requestId);
      return { ok: !!r.ok, code: r.code, message: r.message || '' };
    }
  } catch (e) {
    pending.delete(requestId);
    // 最常见的原因是通道标签页被关掉了，标记出来交给调用方换一个重试
    return { ok: false, code: null, tabGone: true, message: '注入网页失败：' + ((e && e.message) || e) };
  }

  const r = await Promise.race([viaPoll, viaMessage, overallTimeout]);
  pending.delete(requestId);
  return r;
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
async function preflight(tabId) {
  // 第一关：能不能注入、页面里读不读得到登录态
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function () {
        const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
        return { hasJct: !!m, href: location.href, ready: document.readyState };
      }
    });
  } catch (e) {
    return { ok: false, reason: '往那个 bilibili 标签页注入脚本失败：' + ((e && e.message) || e) };
  }

  const info = probe && probe[0] && probe[0].result;
  if (!info) return { ok: false, reason: '脚本注入进去了但没拿到返回值，那个标签页可能还没加载完。' };
  if (!info.hasJct) {
    return {
      ok: false,
      reason: '在那个 bilibili 页面里读不到 bili_jct。请确认浏览器已登录 B 站，并把那个页面刷新一下再试。'
    };
  }
  log('自检 1/2：注入正常，登录态正常（' + String(info.href).slice(0, 70) + '）');

  // 第二关：消息回传链路
  const requestId = 'pre-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const arrived = await new Promise(function (resolve) {
    pending.set(requestId, function () { resolve(true); });
    setTimeout(function () {
      if (pending.has(requestId)) { pending.delete(requestId); resolve(false); }
    }, Number(BC_PREFLIGHT_MS) || 6000);

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (id) {
        window.postMessage({ __bcDeleterResult: { requestId: id, ok: true, code: 0, message: '自检' } }, '*');
      },
      args: [requestId]
    }).catch(function () { /* 下面按超时处理 */ });
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

/** 把书签移进「已删除」目录；返回空串表示成功，否则返回错误说明 */
async function archive(it) {
  // aicu 导入的条目没有书签，删掉就是删掉了
  if (it.source === 'aicu') return '';

  const isArchived = async function () {
    const arr = await chrome.bookmarks.get(it.id).catch(function () { return null; });
    return !!(arr && arr.length && arr[0].parentId === deletedFolderId);
  };
  try {
    if (await isArchived()) return '';   // 后台的同步归档可能已经抢先移走了
    await chrome.bookmarks.move(it.id, { parentId: deletedFolderId });
    return '';
  } catch (e) {
    if (await isArchived()) return '';
    const m = '删除成功，但书签移动失败：' + ((e && e.message) || e);
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
 * 绝不退化成"自己 getIndex -> setIndex"。
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
  indexRefreshDone = false;
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

    const t = await resolveTarget(it);
    let r = null;

    if (t.error) {
      it.status = 'failed';
      it.note = t.error;
      stats.fail++;
      logError('✗ ' + label(it) + ' → ' + t.error);
    } else {
      r = await attemptDelete(t);

      if (r.code === -509) {
        log('  ↻ 触发风控限流（-509），等 15 秒后重试一次…');
        await sleep(15000);
        r = await attemptDelete(t);
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
        delete indexCache[t.rpid];
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
  await removeAicuItems(deletedAicuRpids);
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
    setHint(`本次成功 ${stats.ok} 条${goneText}，失败 ${stats.fail} 条。失败的书签仍然留在「${folderPath(settings, settings.folderActive)}」里，日志里有原因，修好后可点「重试失败项」。`, 'warn');
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
