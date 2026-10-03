/**
 * shared.js —— 公共工具
 * 被 background（service worker）与 popup / clean / options 三个页面共用。
 * 注意：这里不能引用任何 DOM，因为 service worker 里没有 document。
 */

export const DEFAULT_SETTINGS = {
  enabled: true,                    // 是否开启自动记录
  rootParent: '2',                  // 放在哪：'1' = 书签栏，'2' = 其他收藏夹
  containerFolder: '评论管家',       // 上层容器目录名；留空则两个目录直接放在 rootParent 下
  folderActive: 'B站我的评论',       // 存活的评论链接目录
  folderDeleted: 'B站已删除评论',    // 已删除的评论链接目录
  minDelay: 1500,                   // 删除间隔下限（毫秒）
  maxDelay: 4000,                   // 删除间隔上限（毫秒）
  recordContent: true,              // 是否把评论正文摘录进书签标题
  clipboardFallback: false          // 手动「复制评论链接」时也记录（可能误记别人的评论，默认关）
};

export const K_SETTINGS = 'bc_settings';
export const K_INDEX = 'bc_index';
export const K_INDEX_SYNC = 'bc_index_sync';   // v1.0.0 的单键格式，只用于兼容读取
export const K_SYNC_META = 'bc_sync_meta';     // { chunks, bytes, at }
export const K_SYNC_CHUNK = 'bc_sync_c';       // 分片键前缀，后面接序号
export const K_SYNC_STATE = 'bc_sync_state';   // 上次云备份成功与否，给设置页显示

/* chrome.storage.sync 的硬限制：单键 8192 字节、总量 102400 字节。
 * v1.0.0 把整个索引塞进一个键，实测第 15 条就超限，而失败被 .catch(() => {}) 静默吞掉，
 * 于是「换设备记录自动回来」这条卖点悄悄失效了。现在按字节数分片，并把结果落进
 * K_SYNC_STATE，让设置页能如实告诉用户备份到底成没成。 */
const SYNC_CHUNK_BUDGET = 7000;   // 每片留出余量，不贴着 8192 走
const SYNC_HARD_LIMIT = 102400;   // chrome.storage.sync 的 QUOTA_BYTES 硬上限
const SYNC_TOTAL_LIMIT = 100000;  // 预检阈值：给分片键名、meta 和其它键留出余量
const SYNC_BACKOFF_MS = 60000;    // 备份失败后 1 分钟内不再重试，免得反复撞配额

const textEncoder = new TextEncoder();
function utf8Bytes(str) {
  return textEncoder.encode(str).length;
}

/* ------------------------------------------------------------------ 设置 */

export async function getSettings() {
  const o = await chrome.storage.local.get(K_SETTINGS);
  return Object.assign({}, DEFAULT_SETTINGS, o[K_SETTINGS] || {});
}

export async function setSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}

/* ------------------------------------------------- 评论索引（rpid -> 元数据）
 * 书签本身只存「标题 + 链接」，删除时需要 oid(视频aid) 与 type(评论区类型)。
 * 索引就是用来补这两个字段的；万一索引丢了，视频类评论还能用 BV 号反查 aid。
 */

export async function getIndex() {
  const o = await chrome.storage.local.get(K_INDEX);
  const local = o[K_INDEX];
  if (local && Object.keys(local).length) return local;

  // 本地空了（例如扩展被重装），尝试从同步存储里恢复
  const remote = await readSyncIndex();
  if (remote && Object.keys(remote).length) {
    await chrome.storage.local.set({ [K_INDEX]: remote });
    return remote;
  }
  return {};
}

/**
 * 云备份只存删除时真正需要的两个字段：oid（评论区 id）和 type（评论区类型）。
 * 标题、正文、bookmarkId、完整链接这些，要么本来就在书签里跟着浏览器一起同步，
 * 要么可以从书签反推，塞进配额里纯属白占地方——实测每条从 578 字节压到约 55 字节，
 * 同样的 102400 字节总量上限，能备份的条数多出十倍。
 */
function compactIndex(index) {
  const out = {};
  for (const rpid of Object.keys(index)) {
    const meta = index[rpid];
    if (!meta) continue;
    const c = {};
    if (meta.oid !== undefined && meta.oid !== null && meta.oid !== '') c.o = String(meta.oid);
    if (meta.type !== undefined && meta.type !== null) c.t = Number(meta.type);
    if (c.o !== undefined || c.t !== undefined) out[rpid] = c;
  }
  return out;
}

/** compactIndex 的逆操作；同时兼容 v1.0.0 备份里那种「存整个对象」的格式 */
function expandIndex(stored) {
  const out = {};
  for (const rpid of Object.keys(stored)) {
    const c = stored[rpid];
    if (!c || typeof c !== 'object') continue;

    const rawOid = c.o !== undefined ? c.o : c.oid;
    const rawType = c.t !== undefined ? c.t : c.type;

    out[rpid] = {
      rpid: rpid,
      oid: (rawOid === undefined || rawOid === null) ? '' : String(rawOid),
      type: (rawType === undefined || rawType === null || Number.isNaN(Number(rawType)))
        ? null : Number(rawType)
    };
  }
  return out;
}

/** 把紧凑索引按 UTF-8 字节数切成若干片，保证每片都不超过 chrome 的单键上限 */
function packChunks(compact) {
  const chunks = [];
  let cur = {};
  for (const key of Object.keys(compact).sort()) {
    const probe = Object.assign({}, cur, { [key]: compact[key] });
    if (Object.keys(cur).length && utf8Bytes(JSON.stringify(probe)) > SYNC_CHUNK_BUDGET) {
      chunks.push(cur);
      cur = { [key]: compact[key] };
    } else {
      cur = probe;
    }
  }
  if (Object.keys(cur).length) chunks.push(cur);
  return chunks;
}

/**
 * 读同步存储里的索引。分片格式优先；没有分片元信息时退回 v1.0.0 的单键格式。
 * 同步存储不可用（未登录、被企业策略禁用等）时返回 null，由调用方当作「没有备份」处理。
 */
async function readSyncIndex() {
  try {
    const metaBox = await chrome.storage.sync.get(K_SYNC_META);
    const meta = metaBox && metaBox[K_SYNC_META];

    if (meta && typeof meta.chunks === 'number') {
      if (meta.chunks <= 0) return {};        // 已经迁移过，而且确实是空的
      const keys = [];
      for (let i = 0; i < meta.chunks; i++) keys.push(K_SYNC_CHUNK + i);
      const got = await chrome.storage.sync.get(keys);
      const merged = {};
      for (const k of keys) Object.assign(merged, got[k] || {});
      return expandIndex(merged);
    }

    // 兼容 v1.0.0：整个索引存在一个键里
    const legacyBox = await chrome.storage.sync.get(K_INDEX_SYNC);
    const legacy = legacyBox && legacyBox[K_INDEX_SYNC];
    return (legacy && Object.keys(legacy).length) ? expandIndex(legacy) : null;
  } catch (e) {
    return null;
  }
}

/** 写入同步存储。超过总量上限直接抛错，绝不半途静默放弃 */
async function writeSyncIndex(index) {
  const compact = compactIndex(index);
  const chunks = packChunks(compact);
  const count = Object.keys(compact).length;
  const bytes = chunks.reduce((n, c) => n + utf8Bytes(JSON.stringify(c)), 0);

  if (bytes > SYNC_TOTAL_LIMIT) {
    // 说清楚哪个数字是 Chrome 的硬上限、哪个是本扩展自己留的余量，
    // 免得用户把这个数字当成平台配额。
    throw new Error('索引 ' + count + ' 条约 ' + bytes + ' 字节，超过云同步容量' +
      '（Chrome 上限 ' + SYNC_HARD_LIMIT + ' 字节，扣掉分片键名等开销后按 ' +
      SYNC_TOTAL_LIMIT + ' 字节预检）');
  }

  const oldBox = await chrome.storage.sync.get(K_SYNC_META).catch(() => null);
  const hadMeta = !!(oldBox && oldBox[K_SYNC_META]);
  const oldCount = hadMeta ? (Number(oldBox[K_SYNC_META].chunks) || 0) : 0;

  const payload = { [K_SYNC_META]: { chunks: chunks.length, bytes: bytes, at: Date.now() } };
  chunks.forEach((c, i) => { payload[K_SYNC_CHUNK + i] = c; });
  await chrome.storage.sync.set(payload);

  // 片数变少时要清掉多余的老片；首次迁移顺手删掉 v1.0.0 的旧单键
  const stale = [];
  for (let i = chunks.length; i < oldCount; i++) stale.push(K_SYNC_CHUNK + i);
  if (!hadMeta) stale.push(K_INDEX_SYNC);
  if (stale.length) await chrome.storage.sync.remove(stale).catch(() => {});

  return { count: count, chunks: chunks.length, bytes: bytes };
}

/** 上一次云备份的结果，给设置页显示用 */
export async function getSyncState() {
  const o = await chrome.storage.local.get(K_SYNC_STATE);
  return o[K_SYNC_STATE] || null;
}

let syncTimer = null;
let syncBackoffUntil = 0;

async function flushSyncIndex(index) {
  try {
    const info = await writeSyncIndex(index);
    syncBackoffUntil = 0;
    await chrome.storage.local.set({
      [K_SYNC_STATE]: {
        ok: true, count: info.count, chunks: info.chunks, bytes: info.bytes, at: Date.now()
      }
    });
  } catch (e) {
    syncBackoffUntil = Date.now() + SYNC_BACKOFF_MS;
    await chrome.storage.local.set({
      [K_SYNC_STATE]: {
        ok: false, reason: String((e && e.message) || e),
        count: Object.keys(compactIndex(index)).length, at: Date.now()
      }
    }).catch(() => {});
  }
}

export async function setIndex(idx) {
  await chrome.storage.local.set({ [K_INDEX]: idx });

  // 同步存储有写入频率限制，所以做 10 秒防抖。
  // 失败不再无声无息：写进 K_SYNC_STATE，设置页会如实显示出来。
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (Date.now() < syncBackoffUntil) return;
    flushSyncIndex(idx).catch(() => {});
  }, 10000);
}

/* ------------------------------------------------------------------ 书签 */

async function safeChildren(id) {
  try {
    return await chrome.bookmarks.getChildren(id);
  } catch (e) {
    return [];
  }
}

/** rootParent 常量 -> 真实节点 id */
function parentNodeId(settings) {
  return String(settings.rootParent || '2') === '1' ? '1' : '2';
}

/**
 * 求「容器目录」的 id（也就是两个评论目录的父目录）。
 * create=false 时找不到就返回 null。
 */
async function resolveContainerId(settings, create) {
  const parentId = parentNodeId(settings);
  const name = String(settings.containerFolder || '').trim();
  if (!name) return parentId;

  const children = await safeChildren(parentId);
  const hit = children.find(n => !n.url && n.title === name);
  if (hit) return hit.id;
  if (!create) return null;

  try {
    const node = await chrome.bookmarks.create({ parentId, title: name });
    return node.id;
  } catch (e) {
    return parentId;
  }
}

/**
 * 把旧版本建在「书签栏 / 其他收藏夹」顶层的同名目录，整个搬进容器。
 * 移动目录会连带里面的所有书签、并且保留它们的节点 id，所以索引不会失效。
 */
async function adoptLegacyFolder(title, containerId) {
  for (const pid of ['1', '2']) {
    if (pid === containerId) continue;
    const children = await safeChildren(pid);
    const hit = children.find(n => !n.url && n.title === title);
    if (hit) {
      try {
        await chrome.bookmarks.move(hit.id, { parentId: containerId });
      } catch (e) { /* 搬不动就算了，后面会在容器里新建一个 */ }
      return hit;
    }
  }
  return null;
}

/** 查找目录（不会创建）；找不到返回 null */
export async function findFolder(title) {
  const settings = await getSettings();

  const containerId = await resolveContainerId(settings, false);
  if (containerId) {
    const children = await safeChildren(containerId);
    const hit = children.find(n => !n.url && n.title === title);
    if (hit) return hit.id;
  }

  // 兜底：用户可能自己把它挪到别处了
  const found = await chrome.bookmarks.search({ title });
  const hit = found.find(n => !n.url && n.title === title);
  return hit ? hit.id : null;
}

/**
 * 查找目录，找不到就按设置创建 —— 需要的话连容器目录一起建，
 * 并把旧位置上的同名目录整体搬过来。
 */
export async function ensureFolder(title) {
  const settings = await getSettings();
  const containerId = await resolveContainerId(settings, true);

  let children = await safeChildren(containerId);
  let hit = children.find(n => !n.url && n.title === title);

  if (!hit) {
    // 老版本（或用户手动）把它建在了顶层，搬进容器里
    hit = await adoptLegacyFolder(title, containerId);
  }
  if (hit) return hit.id;

  try {
    const node = await chrome.bookmarks.create({ parentId: containerId, title });
    return node.id;
  } catch (e) {
    const node = await chrome.bookmarks.create({ parentId: parentNodeId(settings), title });
    return node.id;
  }
}

/** 拼一个给人看的路径，例如：其他收藏夹 / 评论管家 / B站我的评论 */
export function folderPath(settings, folderName) {
  const parent = parentNodeId(settings) === '1' ? '书签栏' : '其他收藏夹';
  const container = String(settings.containerFolder || '').trim();
  return [parent, container, folderName].filter(Boolean).join(' / ');
}

/** 递归列出一个目录下的全部书签（最多下钻 3 层） */
export async function listBookmarks(folderId) {
  const out = [];
  async function walk(id, depth) {
    let children = [];
    try {
      children = await chrome.bookmarks.getChildren(id);
    } catch (e) {
      return;
    }
    for (const c of children) {
      if (c.url) out.push(c);
      else if (depth < 3) await walk(c.id, depth + 1);
    }
  }
  await walk(folderId, 0);
  return out;
}

/** 只挑出「评论链接」书签，并按标题倒序（新的在前） */
export async function listComments(folderId) {
  const all = await listBookmarks(folderId);
  const out = [];
  for (const b of all) {
    const parsed = parseCommentUrl(b.url);
    if (parsed) out.push(Object.assign({}, b, { parsed: parsed }));
  }
  out.sort((a, b) => String(b.title || '').localeCompare(String(a.title || '')));
  return out;
}

/* -------------------------------------------------------- 评论链接的解析 */

/** 判断是不是 B 站域名 */
export function isBiliUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)bilibili\.com$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * 解析「复制评论链接」格式的 URL：
 *   一级评论 https://www.bilibili.com/video/BVxxx?comment_on=1&comment_root_id=123456789012&share_tag=s_i#reply123456789012
 *   楼中楼   ...&comment_root_id=123456789013&comment_secondary_id=123456789014...#reply123456789014
 * 返回 null 表示这不是一条评论链接。
 */
export function parseCommentUrl(url) {
  if (!isBiliUrl(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }

  const rootId = u.searchParams.get('comment_root_id') || '';
  const secondaryId = u.searchParams.get('comment_secondary_id') || '';
  const hashMatch = /#reply(\d+)/.exec(u.hash || '');

  // 删除时用的 rpid：楼中楼就是二级评论自己的 id
  const rpid = secondaryId || (hashMatch ? hashMatch[1] : '') || rootId;
  if (!rpid) return null;

  const bvMatch = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);

  return {
    url,
    rpid,
    rootId: rootId || rpid,
    secondaryId,
    isSecondary: !!secondaryId,
    bvid: bvMatch ? bvMatch[1] : '',
    pageUrl: u.origin + u.pathname.replace(/\/+$/, '')
  };
}

/** 书签标题里的来源标识，例如 BV1xx411c7mD / cv123456 / 动态789 */
export function sourceLabel(pageUrl) {
  try {
    const u = new URL(pageUrl);
    let m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);
    if (m) return m[1];
    m = /\/read\/cv(\d+)/i.exec(u.pathname);
    if (m) return 'cv' + m[1];
    m = /\/opus\/(\d+)/.exec(u.pathname);
    if (m) return '动态' + m[1];
    m = /\/bangumi\/play\/([A-Za-z]+[0-9]+)/.exec(u.pathname);
    if (m) return m[1];
    m = /\/audio\/au(\d+)/i.exec(u.pathname);
    if (m) return 'au' + m[1];
    return (u.hostname.replace(/^www\./, '') + u.pathname).slice(0, 24);
  } catch (e) {
    return 'B站';
  }
}

/** 统一格式：[2026-01-30 12:34] BV1xx411c7mD · 评论前20字 */
export function buildTitle(info) {
  const ts = info.ctime ? Number(info.ctime) * 1000 : Date.now();
  const label = sourceLabel(info.pageUrl || info.url || '');
  const text = String(info.message || '').replace(/\s+/g, ' ').trim();
  let excerpt;
  if (text) excerpt = text.length > 20 ? text.slice(0, 20) + '…' : text;
  else excerpt = info.isSecondary ? '楼中楼回复' : '评论';
  return `[${fmtTime(ts)}] ${label} · ${excerpt}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 杂项 */

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function randInt(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(a, Number(max) || a);
  return Math.floor(a + Math.random() * (b - a));
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 把接口错误码翻译成人话 */
export function explainCode(code, message) {
  const map = {
    0: '成功',
    '-101': '账号未登录（请先在浏览器里登录 B 站）',
    '-102': '账号被封停',
    '-111': 'csrf 校验失败（登录态异常，建议重新登录）',
    '-400': '请求错误',
    '-403': '权限不足',
    '-404': '无此页',
    '-509': '请求过于频繁（触发了风控限流）',
    12002: '评论区已关闭',
    12004: '禁止操作（已被拉黑或评论被锁）',
    12006: '没有该评论',
    12009: '评论主体的 type 不合法',
    12022: '该评论已经被删除了'
  };
  const key = String(code);
  if (map[key]) return map[key];
  return message ? String(message) : ('未知错误 code=' + key);
}
