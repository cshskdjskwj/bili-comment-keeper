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

let running = false, stopRequested = false;
let workerTabId = null, workerCreated = false;
let settings = null, activeFolderId = null, deletedFolderId = null;
let indexCache = {}, items = [], stats = { ok: 0, fail: 0 }, purgeTimer = null;
let indexRefreshDone = false;   // 本轮删除里是否已经重读过索引

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg) return;

  if (msg.type === 'DELETE_RESULT' && msg.requestId && pending.has(msg.requestId)) {
    const resolve = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    resolve({ ok: !!msg.ok, code: msg.code, message: msg.message || '' });
    return;
  }

  // 在 aicu.cc 页面又抓到一批历史评论，跟着刷新导入区
  if (msg.type === 'AICU_UPDATED') {
    loadAicu().catch(function () {});
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

  $('folders').textContent =
    `${folderPath(settings, settings.folderActive)}  →  删除后移入：${folderPath(settings, settings.folderDeleted)}`;

  bindEvents();
  await reload();
  await loadArchive();
  await loadAicu();
}

function bindEvents() {
  $('btn-start').addEventListener('click', start);

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
    items.forEach(i => { if (i.status !== 'done') i.checked = e.target.checked; });
    render();
  });

  $('list').addEventListener('change', function (e) {
    if (!e.target.classList.contains('ck')) return;
    const row = e.target.closest('.row');
    const it = row && items.find(i => String(i.id) === row.dataset.id);
    if (it) { it.checked = e.target.checked; syncCounts(); }
  });

  // aicu.cc 导入区
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

/* --------------------------------------------------------- 已删除归档的展示 */

async function loadArchive() {
  if (!deletedFolderId || !settings) return;   // 初始化还没走完

  const list = await listBookmarks(deletedFolderId);
  list.sort((a, b) => String(b.title || '').localeCompare(String(a.title || '')));
  $('arc-count').textContent = String(list.length);
  $('arc-path').textContent = folderPath(settings, settings.folderDeleted);

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
  $('aicu-uid').textContent = store.uid
    ? ('UID ' + store.uid + (store.total ? ' · 站上记着 ' + store.total + ' 条' : ''))
    : '';

  const notes = [];
  if (!list.length) {
    notes.push('还没有导入。打开 https://www.aicu.cc/reply?uid=你的UID 翻几页，本扩展会自动把列表读进来。');
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

/** 收集「已删除」归档里已有的 rpid —— 这些已经确认删过，别再浪费一次接口调用 */
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
  if (alreadyGone) parts.push(`${alreadyGone} 条已在「已删除」归档里，跳过`);
  const tail = parts.length ? `（${parts.join('，')}）` : '';
  setAicuHint(`已加入 ${added} 条${tail}。勾选后点上面的「开始删除」即可。`, added ? '' : 'warn');
  await loadAicu();
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
  if (!children.length) { setHint('「已删除」归档本来就是空的。', 'warn'); return; }

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

  log(`🧹 已清空「已删除」归档，共移除 ${removed} 条书签`);
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
      id: bm.id, title: bm.title, url: bm.url, parsed,
      checked: old ? (old.status === 'done' ? false : old.checked) : true,
      status: old ? old.status : 'idle',
      note: old ? old.note : ''
    });
  }

  // 书签列表重建时，把 aicu 导入的条目原样保留（它们没有书签）
  const aicu = items.filter(i => i.source === 'aicu');
  items = next.concat(aicu);
  stats = { ok: 0, fail: 0 };   // 刷新过列表，「本次成功/失败」不该再显示上一轮的旧数字
  render();
  if (skipped > 0) setHint(`目录里有 ${skipped} 条不是评论链接的书签，已自动跳过（不会被删除）。`, 'warn');
}

function stText(it) {
  if (it.status === 'done') return it.note || '已删除';
  if (it.status === 'failed') return it.note || '失败';
  return it.status === 'working' ? '删除中…' : '';
}

function rowHtml(it) {
  const cls = STATE_CLS[it.status] || '';
  const kind = it.parsed.isSecondary ? '楼中楼' : '一级评论';
  return `<div class="row ${it.status}" data-id="${it.id}">
    <input type="checkbox" class="ck" ${it.checked && it.status !== 'done' ? 'checked' : ''} ${it.status === 'done' ? 'disabled' : ''}>
    <div class="row-main">
      <div class="row-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>
      <div class="row-sub">rpid ${escapeHtml(it.parsed.rpid)} · ${escapeHtml(sourceLabel(it.parsed.pageUrl))} · ${kind}</div>
    </div>
    <div class="row-state ${cls}">${escapeHtml(stText(it))}</div>
  </div>`;
}

function render() {
  $('list').innerHTML = items.length
    ? items.map(rowHtml).join('')
    : '<div class="empty" style="padding:18px">这个目录是空的～先去 B 站发一条评论吧 🎀</div>';
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

/** 一次算清所有计数：顶部四张卡 + 勾选数 + 按钮文案 */
function syncCounts() {
  const left = items.filter(i => i.status !== 'done');
  const sel = left.filter(i => i.checked).length;
  $('stat-total').textContent = sel;
  $('stat-ok').textContent = stats.ok;
  $('stat-fail').textContent = stats.fail;
  $('stat-left').textContent = left.length;
  $('sel-count').textContent = `已勾选 ${sel} 条 / 共 ${items.length} 条`;
  $('btn-start').textContent = sel ? `开始删除（${sel} 条）` : '开始删除';
}

function updateProgress(done, total) {
  $('progress-inner').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
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

function setUi(isRunning) {
  $('btn-start').disabled = isRunning;
  $('btn-stop').disabled = !isRunning;
  $('btn-reload').disabled = isRunning;
  $('btn-retry').disabled = isRunning;
  $('btn-purge').disabled = isRunning;
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

/** 注入主世界脚本并等结果（executeScript 的返回值可用就优先用，否则等 postMessage 回传） */
async function deleteOne(tabId, target) {
  const requestId = 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  const viaMessage = new Promise(function (resolve) {
    pending.set(requestId, resolve);
    setTimeout(function () {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve({ ok: false, code: null, message: '等待页面响应超时（25 秒）' });
      }
    }, 25000);
  });

  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: mainWorldDelete,
      args: [{ requestId: requestId, type: target.type, oid: target.oid, rpid: target.rpid }]
    });
    const r = out && out[0] && out[0].result;
    if (r && r.requestId === requestId) {
      pending.delete(requestId);
      return { ok: !!r.ok, code: r.code, message: r.message || '' };
    }
  } catch (e) {
    pending.delete(requestId);
    // 走到这里最常见的原因是通道标签页被关掉了，标记出来交给调用方换一个重试
    return { ok: false, code: null, tabGone: true, message: '注入网页失败：' + ((e && e.message) || e) };
  }
  return await viaMessage;
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
    log('  ！' + m);
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
  stats = { ok: 0, fail: 0 };
  setUi(true);
  syncCounts();
  updateProgress(0, targets.length);
  $('log').textContent = '';
  setHint('正在删除…请保持此页面开着。删除期间会复用一个 bilibili 标签页发送请求。', '');

  try {
    const tabId = await acquireWorkerTab();
    log('请求通道：标签页 #' + tabId);
  } catch (e) {
    log('准备 bilibili 标签页失败：' + ((e && e.message) || e));
    setHint('打不开 bilibili 页面，删除已中止。请确认网络能访问 bilibili.com 后重试。', 'bad');
    running = false;
    setUi(false);
    return;
  }

  let aborted = false;
  let gone = 0;                    // 其中 B 站上早就没有了的（aicu 导入里占大多数）
  const deletedRpids = [];         // 删成功的 rpid，最后交回后台清索引
  const deletedAicuRpids = [];     // 其中来自 aicu 导入的，要从导入清单里移除

  // 每条都要真调一次接口（删除接口本身就是"这条还在不在"的判据），
  // 所以先把预计耗时说清楚，别让人以为卡住了。
  const avgDelay = (Number(settings.minDelay) + Number(settings.maxDelay)) / 2;
  const estMin = Math.max(1, Math.round(targets.length * avgDelay / 60000));
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
      log('✗ ' + label(it) + ' → ' + t.error);
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
          gone++;
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
        log('✗ ' + label(it) + ' 删除失败：code=' + r.code + ' ' + (r.message || ''));
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
  await loadArchive();
  await loadAicu();

  const left = items.filter(i => i.status !== 'done').length;
  const goneText = gone ? `，其中 ${gone} 条 B 站上早就没有了` : '';
  if (stats.fail === 0 && !aborted) {
    setHint(`全部搞定：本次处理 ${stats.ok} 条${goneText}。书签类已归档，aicu 导入的已从清单移除。列表里还剩 ${left} 条。`, '');
  } else {
    setHint(`本次成功 ${stats.ok} 条${goneText}，失败 ${stats.fail} 条。失败的书签仍然留在「${folderPath(settings, settings.folderActive)}」里，日志里有原因，修好后可点「重试失败项」。`, 'warn');
  }
  log(`—— 结束：成功 ${stats.ok}（其中早就没有的 ${gone} 条），失败 ${stats.fail}，列表剩余 ${left} ——`);
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
