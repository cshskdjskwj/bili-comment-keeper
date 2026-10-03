/**
 * background.js —— 扩展后台（MV3 service worker）
 *
 * v1.7 起数据只有**一份**：chrome.storage.local 里的评论库（bc_library）。
 * 老的「收藏夹 + 索引 + 云同步」三件套已经拆掉了 —— 收藏夹只是个可选的镜像
 * （设置里的「同时写入浏览器收藏夹」，默认关）。
 *
 * 职责：
 *   1) 收到网页转发来的「我刚发了一条评论」→ 写进评论库；
 *   2) 你在 B 站网页上自己删了评论时，把库里那条标成已删除；
 *   3) aicu.cc 页面上读到的历史评论 → 并进库里；
 *   4) 维护工具栏角标。
 */

import {
  getSettings, ensureFolder, K_SETTINGS,
  getLibrary, upsertLibItems, markLibDeleted, libraryStats, fmtTime
} from './shared.js';

/* ------------------------------------------------------------------ 记录 */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'RECORD_COMMENT') {
    withLibLock(function () { return handleRecord(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true; // 异步回复
  }
  if (msg && msg.type === 'COMMENT_DELETED') {
    withLibLock(function () { return handleDeleted(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  if (msg && msg.type === 'REFRESH_BADGE') {
    updateBadge().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  // 清除面板删完成功后，把对应的条目交回后台标成"已删除"。
  // 面板不能自己整库写回：它在启动时读了一份快照，删除期间后台可能又记了
  // 新评论，整库写回会把那些新的覆盖掉。
  if (msg && msg.type === 'FORGET_RPIDS') {
    withLibLock(function () { return handleForget(msg.rpids); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // aicu.cc 页面上顺手读到的历史评论清单
  if (msg && msg.type === 'AICU_REPLIES') {
    handleAicuImport(msg.payload)
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  return false;
});

/**
 * 库的写锁：「读-改-写」必须串行。
 *
 * getLibrary() 每次都从 storage 反序列化出一份独立副本，所以两个并发的 handler
 * 各自加完自己的条目、再各自整份写回时，后写的会把先写的覆盖掉，那条评论就静默丢了。
 * 一秒内连发两条评论、或者面板收尾时正好在另一个标签页发评论，都会撞上。
 */
let libLock = Promise.resolve();

function withLibLock(task) {
  const next = libLock.then(task, task);
  // 无论成功还是抛错都把锁解开，别让一次异常卡死后面所有写入
  libLock = next.then(function () {}, function () {});
  return next;
}

/** 把一批 rpid 标成「我们自己删掉的」 */
async function handleForget(rpids) {
  const list = Array.isArray(rpids)
    ? rpids.map(function (r) { return String(r); }).filter(function (r) { return /^\d+$/.test(r); })
    : [];
  if (!list.length) return { ok: true, removed: 0 };

  const n = await markLibDeleted(list);
  await updateBadge();
  return { ok: true, removed: n };
}

/**
 * aicu 导入：并进库，不碰别的。
 * 真正的删除仍然走控制台里那套（注入 B 站页面调 /x/v2/reply/del）。
 */
async function handleAicuImport(payload) {
  const r = await upsertLibItems(payload);
  if (r.added || r.enriched) {
    broadcast({ type: 'AICU_UPDATED', added: r.added, enriched: r.enriched, total: r.total });
  }
  await updateBadge();
  return { ok: true, added: r.added, enriched: r.enriched, total: r.total, capped: false };
}

/** 只接受纯数字字符串，其余一律返回 null */
function digits(v) {
  if (v === undefined || v === null || v === '') return null;
  return /^\d+$/.test(String(v)) ? String(v) : null;
}

/** 校验并规整网页传来的数据，防止页面脚本伪造垃圾 */
function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const rpid = digits(payload.rpid);
  if (!rpid) return null;

  const type = digits(payload.type);
  const oid = digits(payload.oid);

  return {
    rpid: rpid,
    root: digits(payload.root) || '0',
    parent: digits(payload.parent) || '0',
    type: type === null ? null : Number(type),
    oid: oid,
    url: String(payload.url || '').slice(0, 2000),
    message: String(payload.message || '').slice(0, 300),
    ctime: Number(payload.ctime) || Math.floor(Date.now() / 1000),
    isSecondary: !!payload.isSecondary,
    source: String(payload.source || 'network').slice(0, 20)
  };
}

/**
 * 记下一条「你刚发出去的评论」。
 *
 * **数据以本地库为准**：直接写进评论库，source='record'、state='live'，
 * 首页的「所有历史评论」立刻就能看到它。
 *
 * 收藏夹只剩一个可选动作（设置里的「同时写入浏览器收藏夹」，默认关）。
 */
async function handleRecord(payload) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: '自动记录已关闭' };

  const info = normalize(payload);
  if (!info) return { ok: false, reason: '无效的评论数据' };

  // 剪贴板兜底会把「别人评论的链接」也一起记下来（你复制别人评论分享时），
  // 所以默认关闭，需要时在设置里打开。
  if (info.source === 'clipboard' && !settings.clipboardFallback) {
    return { ok: false, reason: '剪贴板兜底记录未开启' };
  }

  if (!info.oid || info.type === null) {
    // 没有 oid / type 就没法删它，但仍然值得存下来（至少能看、能导出）
    broadcast({ type: 'RECORD_INCOMPLETE', rpid: info.rpid });
  }

  const before = await getLibrary();
  const existed = !!before.items[info.rpid];

  await upsertLibItems({
    items: [{
      rpid: info.rpid,
      type: info.type,
      oid: info.oid,
      root: info.root,
      rank: info.isSecondary ? 2 : 1,
      message: info.message,
      ctime: info.ctime,
      state: 'live',        // 刚发出去的，肯定是活的
      source: 'record'
    }]
  });

  let bookmarkId = null;
  if (settings.useBookmarks && info.url) {
    bookmarkId = await mirrorToBookmarks(settings, info);
  }

  await updateBadge();
  return { ok: true, duplicated: existed, url: info.url, bookmarkId: bookmarkId };
}

/** 可选的收藏夹镜像；失败不影响记录本身 */
async function mirrorToBookmarks(settings, info) {
  try {
    const parentId = await ensureFolder(settings.folderActive);
    const same = await chrome.bookmarks.search({ url: info.url }).catch(function () { return []; });
    if (same.length) return same[0].id;

    const title = `[${fmtTime(info.ctime * 1000)}] ` +
      (info.message ? String(info.message).replace(/\s+/g, ' ').slice(0, 20) : '评论');
    const node = await chrome.bookmarks.create({ parentId: parentId, title: title, url: info.url });
    return node.id;
  } catch (e) {
    return null;
  }
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* 没有页面在监听时会抛错，忽略 */ }
}

/* -------------------------------------------------- 手动删除的同步归档
 * 你在 B 站网页上自己点了某条评论的「删除」时，网页会请求 /x/v2/reply/del，
 * 我们把这条消息接住，把库里那条标成「已删除」。
 * 这样不管从哪儿删的，账都是平的。
 */

async function handleDeleted(payload) {
  const rpid = String((payload && payload.rpid) || '');
  if (!/^\d+$/.test(rpid)) return { ok: false, reason: 'rpid 无效' };

  const lib = await getLibrary();
  const it = lib.items[rpid];

  if (it && it.state === 'deleted') return { ok: true, already: true };

  const n = await markLibDeleted([rpid]);
  await updateBadge();
  broadcast({ type: 'SYNC_ARCHIVED', rpid: rpid });

  if (!n) return { ok: true, already: true, note: '库里本来就没有这条' };
  return { ok: true };
}

/* ------------------------------------------------------------------ 角标 */

/**
 * 角标。显示什么由设置里的 badgeMode 决定：
 *
 *   off     不显示（**默认**）
 *   live    显示库里"还在"的条数
 *   pending 显示还没处理的条数（库里除"已删除"之外的全部）
 *
 * 为什么默认不显示：产品定位是"本地评论管理器 + 备份"，角标不再是任务提醒 ——
 * 一个档案柜不需要在图标上顶一个数字催你。想留着的在设置里打开即可。
 */
async function updateBadge() {
  try {
    const settings = await getSettings();
    const mode = String(settings.badgeMode || 'off');
    const s = await libraryStats();

    if (mode === 'off') {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({
        title: `B站评论管家 · 库里 ${s.total} 条` +
          (s.live ? `，还在 ${s.live} 条` : '') +
          (s.probedAt ? `（上次巡检 ${fmtTime(s.probedAt)}）` : '')
      });
      return;
    }

    let count = 0;
    let tip = '';
    if (mode === 'live') {
      count = s.live;
      tip = `还在 ${s.live} 条（库里共 ${s.total} 条）`;
    } else {
      count = s.total - s.deleted;
      tip = `还没处理 ${count} 条（库里共 ${s.total} 条）`;
    }

    await chrome.action.setBadgeBackgroundColor({ color: '#fb7299' });
    await chrome.action.setBadgeText({
      text: count > 0 ? (count > 999 ? '999+' : String(count)) : ''
    });
    await chrome.action.setTitle({ title: `B站评论管家 · ${tip}` });
  } catch (e) {
    // 角标失败不影响主流程
  }
}

/** 书签被创建/删除/移动/改名时（打开收藏夹镜像时才有意义），稍后重算一次角标 */
let badgeTimer = null;
function scheduleBadgeUpdate() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(function () {
    badgeTimer = null;
    updateBadge();
  }, 800);
}

chrome.bookmarks.onCreated.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onRemoved.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onMoved.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onChanged.addListener(scheduleBadgeUpdate);

/* -------------------------------------------------------------- 生命周期 */

chrome.runtime.onInstalled.addListener(async function () {
  const settings = await getSettings();
  await chrome.storage.local.set({ [K_SETTINGS]: Object.assign({}, settings) });
  if (settings.useBookmarks) await ensureFolder(settings.folderActive);
  await updateBadge();
});

chrome.runtime.onStartup.addListener(function () {
  updateBadge();
});
