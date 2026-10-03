/**
 * background.js —— 扩展后台（MV3 service worker）
 *
 * 职责：
 *   1) 收到网页转发来的「我刚发了一条评论」→ 写进书签栏目录；
 *   2) 维护 rpid -> {oid, type, ...} 索引，供删除时使用；
 *   3) 维护工具栏角标上的评论条数。
 */

import {
  getSettings, getIndex, setIndex, ensureFolder, findFolder, buildTitle,
  parseCommentUrl, isBiliUrl, listBookmarks, listComments, mergeAicuItems,
  getAicuStore, K_SETTINGS
} from './shared.js';

/* ------------------------------------------------------------------ 记录 */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'RECORD_COMMENT') {
    withIndexLock(function () { return handleRecord(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true; // 异步回复
  }
  if (msg && msg.type === 'COMMENT_DELETED') {
    withIndexLock(function () { return handleDeleted(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  if (msg && msg.type === 'REFRESH_BADGE') {
    updateBadge().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  // 清除面板删完成功后，把对应的索引项交回后台来删。
  // 面板不能自己整体写回索引：它在 init() 时读了一份快照，
  // 删除期间后台可能又记了新评论，整体写回会把那些新的覆盖掉。
  if (msg && msg.type === 'FORGET_RPIDS') {
    withIndexLock(function () { return forgetRpids(msg.rpids); })
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
 * aicu 导入：只做去重落盘和通知，不碰索引。
 * 真正的删除仍然走清除面板里那套（注入 B 站页面调 /x/v2/reply/del）。
 */
async function handleAicuImport(payload) {
  const r = await mergeAicuItems(payload);
  if (r.added) {
    broadcast({ type: 'AICU_UPDATED', added: r.added, total: r.total });
  }
  return { ok: true, added: r.added, total: r.total, capped: r.capped };
}

/**
 * 索引锁：rpid -> 元数据的「读-改-写」必须串行。
 *
 * getIndex() 每次都从 storage 反序列化出一份独立副本，所以两个并发的 handler
 * 各自加完自己的条目、再各自整份写回时，后写的会把先写的覆盖掉，那条评论的
 * oid / type 就静默丢了 —— 之后删它就会报「缺少评论区 oid」。
 * 一秒内连发两条评论、或者清除面板收尾时正好在另一个标签页发评论，都会撞上。
 */
let indexLock = Promise.resolve();

function withIndexLock(task) {
  const next = indexLock.then(task, task);
  // 无论成功还是抛错都把锁解开，别让一次异常卡死后面所有写入
  indexLock = next.then(function () {}, function () {});
  return next;
}

/** 按 rpid 列表清理索引项。现读现写，不覆盖删除期间新记进来的条目。 */
async function forgetRpids(rpids) {
  const list = Array.isArray(rpids)
    ? rpids.map(function (r) { return String(r); }).filter(function (r) { return /^\d+$/.test(r); })
    : [];
  if (!list.length) return { ok: true, removed: 0 };

  const index = await getIndex();
  let removed = 0;
  for (const rpid of list) {
    if (Object.prototype.hasOwnProperty.call(index, rpid)) {
      delete index[rpid];
      removed++;
    }
  }
  if (removed) await setIndex(index);
  return { ok: true, removed: removed };
}

/** 只接受纯数字字符串，其余一律返回 null */
function digits(v) {
  if (v === undefined || v === null || v === '') return null;
  return /^\d+$/.test(String(v)) ? String(v) : null;
}

/** 校验并规整网页传来的数据，防止页面脚本伪造垃圾书签 */
function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const url = String(payload.url || '');
  if (url.length > 2000 || !isBiliUrl(url)) return null;

  const parsed = parseCommentUrl(url);
  if (!parsed || !/^\d+$/.test(String(parsed.rpid))) return null;

  const type = digits(payload.type);
  const oid = digits(payload.oid);

  return {
    url: parsed.url,
    rpid: parsed.rpid,
    root: parsed.rootId,
    secondaryId: parsed.secondaryId,
    isSecondary: parsed.isSecondary,
    bvid: parsed.bvid,
    pageUrl: String(payload.pageUrl || parsed.pageUrl || '').slice(0, 500),
    type: type === null ? null : Number(type),
    oid: oid,
    message: String(payload.message || '').slice(0, 300),
    ctime: Number(payload.ctime) || Math.floor(Date.now() / 1000),
    source: String(payload.source || 'network').slice(0, 20)
  };
}

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

  const folderId = await ensureFolder(settings.folderActive);
  const index = await getIndex();

  // 已有记录：确认书签还在，在的话直接跳过
  const prev = index[info.rpid];
  if (prev) {
    if (prev.bookmarkId) {
      const alive = await chrome.bookmarks.get(prev.bookmarkId).catch(function () { return null; });
      if (alive && alive.length) return { ok: true, duplicated: true, title: prev.title };
    }
    // 书签被手动删掉了，补一条
  }

  const same = await chrome.bookmarks.search({ url: info.url }).catch(function () { return []; });
  if (same.length) {
    index[info.rpid] = Object.assign({}, info, {
      title: same[0].title,
      bookmarkId: same[0].id,
      addedAt: Date.now()
    });
    await setIndex(index);
    await updateBadge();
    return { ok: true, duplicated: true, title: same[0].title };
  }

  const title = settings.recordContent
    ? buildTitle(info)
    : buildTitle(Object.assign({}, info, { message: '' }));

  const node = await chrome.bookmarks.create({
    parentId: folderId,
    title: title,
    url: info.url
  });

  index[info.rpid] = Object.assign({}, info, {
    title: title,
    bookmarkId: node.id,
    addedAt: Date.now()
  });
  await setIndex(index);
  await updateBadge();

  return { ok: true, title: title, url: info.url };
}

/* -------------------------------------------------- 手动删除的同步归档
 * 你在 B 站网页上自己点了某条评论的「删除」时，网页会请求 /x/v2/reply/del，
 * 我们把这条消息接住，把对应的书签从「我的评论」挪到「已删除」，
 * 这样不管从哪儿删的，账都是平的。
 */

async function findByRpid(rpid, folderIds) {
  for (const fid of folderIds) {
    if (!fid) continue;
    const list = await listBookmarks(fid);
    for (const b of list) {
      const parsed = parseCommentUrl(b.url);
      if (parsed && parsed.rpid === rpid) return b;
    }
  }
  return null;
}

/** nodeId 是否位于 ancestorId 目录（含更深层子目录）之下 */
async function isDescendantOf(nodeId, ancestorId) {
  let cur = nodeId;
  for (let i = 0; i < 10 && cur; i++) {
    const arr = await chrome.bookmarks.get(cur).catch(function () { return null; });
    if (!arr || !arr.length) return false;
    const parentId = arr[0].parentId;
    if (!parentId) return false;
    if (parentId === ancestorId) return true;
    cur = parentId;
  }
  return false;
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* 没有页面在监听时会抛错，忽略 */ }
}

async function handleDeleted(payload) {
  const rpid = String((payload && payload.rpid) || '');
  if (!/^\d+$/.test(rpid)) return { ok: false, reason: 'rpid 无效' };

  const settings = await getSettings();
  const index = await getIndex();
  const deletedFolderId = await ensureFolder(settings.folderDeleted);
  const activeFolderId = await findFolder(settings.folderActive);

  // 1) 先按索引找书签
  let node = null;
  const meta = index[rpid];
  if (meta && meta.bookmarkId) {
    const arr = await chrome.bookmarks.get(meta.bookmarkId).catch(function () { return null; });
    if (arr && arr.length) node = arr[0];
  }

  // 2) 索引里没有（比如扩展重装过），就按 rpid 在书签里翻
  if (!node) {
    node = await findByRpid(rpid, [activeFolderId, deletedFolderId]);
  }

  if (!node) return { ok: false, reason: '没有这条评论对应的书签' };

  // 已经在「已删除」里了，把索引清掉就算完
  if (node.parentId === deletedFolderId) {
    if (meta) {
      delete index[rpid];
      await setIndex(index);
    }
    return { ok: true, already: true };
  }

  // 只动「我的评论」目录（含其子目录）里的书签，绝不碰你自己整理到别处的收藏
  const inActive = activeFolderId ? await isDescendantOf(node.id, activeFolderId) : false;
  if (!inActive) return { ok: false, reason: '书签不在记录目录里，已跳过' };

  await chrome.bookmarks.move(node.id, { parentId: deletedFolderId });
  if (meta) {
    delete index[rpid];
    await setIndex(index);
  }
  await updateBadge();
  broadcast({ type: 'SYNC_ARCHIVED', rpid: rpid });

  return { ok: true, title: node.title };
}

/* ------------------------------------------------------------------ 角标 */

/**
 * 角标 = **待处理总数** = 待删书签 + aicu 导入里还没处理的（按 rpid 去重，两边可能指着同一条）。
 *
 * v1.0.x 的角标数的是「已删除、但还没清空记录」的条数 —— 发评论不涨、删评论才涨，
 * 反直觉到 README 得反复解释。现在改成「还有多少条等着你处理」。
 */
async function updateBadge() {
  try {
    const settings = await getSettings();

    const rpids = new Set();
    const activeId = await findFolder(settings.folderActive);
    if (activeId) {
      for (const b of await listComments(activeId)) rpids.add(b.parsed.rpid);
    }

    const aicu = await getAicuStore();
    const aicuN = Object.keys(aicu.items).length;
    for (const rpid of Object.keys(aicu.items)) rpids.add(rpid);

    const count = rpids.size;

    await chrome.action.setBadgeBackgroundColor({ color: '#fb7299' });
    await chrome.action.setBadgeText({
      text: count > 0 ? (count > 999 ? '999+' : String(count)) : ''
    });
    await chrome.action.setTitle({
      title: count > 0
        ? `B站评论管家 · 待处理 ${count} 条` + (aicuN ? `（其中 aicu 导入 ${aicuN} 条）` : '')
        : 'B站评论管家 · 没有待处理的评论'
    });
  } catch (e) {
    // 角标失败不影响主流程
  }
}

/** 书签被创建/删除/移动/改名时（含你手动整理），稍后重算一次角标 */
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
  await ensureFolder(settings.folderActive);
  await ensureFolder(settings.folderDeleted);
  await updateBadge();
});

chrome.runtime.onStartup.addListener(function () {
  updateBadge();
});
