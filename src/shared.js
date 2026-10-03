/**
 * shared.js —— 公共工具
 * 被 background（service worker）与 popup / clean / options 三个页面共用。
 * 注意：这里不能引用任何 DOM，因为 service worker 里没有 document。
 *
 * v1.7 起数据只有**一份**：chrome.storage.local 里的评论库（bc_library）。
 * 老的「收藏夹 + 索引 + 云同步」那一整套已经拆掉了 —— 收藏夹只能存标题和 URL，
 * 几千条会把书签栏塞爆；备份改用导出 JSON。
 */

export const DEFAULT_SETTINGS = {
  enabled: true,                    // 是否开启自动记录
  minDelay: 1500,                   // 删除间隔下限（毫秒）
  maxDelay: 4000,                   // 删除间隔上限（毫秒）
  clipboardFallback: false,         // 手动「复制评论链接」时也记录（可能误记别人的评论，默认关）
  // 角标显示什么：off=不显示（默认，定位是管理器不是任务列表）/ live=库里的存活条数 / pending=待处理总数
  badgeMode: 'off',
  // 还要不要往浏览器收藏夹里写书签。默认关：数据以本地库为准。
  // 留这个开关只是给"想在浏览器书签里也能翻到"的人用。
  useBookmarks: false,
  // 收藏夹相关（只在 useBookmarks 打开时才有意义）
  rootParent: '2',                  // 放在哪：'1' = 书签栏，'2' = 其他收藏夹
  containerFolder: '评论管家',       // 上层容器目录名
  folderActive: 'B站我的评论'        // 评论链接目录
};

export const K_SETTINGS = 'bc_settings';


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

/* ------------------------------------------- aicu.cc 导入的历史评论清单
 * 本扩展只能记录「装好之后」发出的评论；装之前发的、在手机 App 上发的都抓不到。
 * aicu.cc 存着完整的历史评论（它只是索引，评论实体仍在 B 站），所以由
 * src/aicu-main.js 在页面上把列表读回来，这里负责去重落盘，
 * 最后交给清除面板走**同一套**删除流程。
 */

const AICU_MAX_ITEMS = 20000;   // 别把 storage.local 撑爆（上限 10MB，每条约 150 字节）

/** aicu 的 dyn.type -> 人能看懂的来源名 */
export function aicuTypeName(type) {
  const map = { 1: '视频', 11: '相册', 12: '专栏', 14: '音频', 17: '动态' };
  return map[Number(type)] || ('类型' + type);
}

/** 用 aicu 给的 dyn.type / dyn.oid 拼一个能点开核对的 B 站地址 */
export function aicuPageUrl(type, oid) {
  const id = String(oid || '');
  if (!id) return '';
  switch (Number(type)) {
    case 1: return 'https://www.bilibili.com/video/av' + id;
    case 12: return 'https://www.bilibili.com/read/cv' + id;
    default: return 'https://t.bilibili.com/' + id;
  }
}

/**
 * 用 aicu 记录的 type / oid / root / rank 拼一条**和扩展自己记录时完全同款**的评论地址。
 *
 * 这一点很关键：只要格式一致，parseCommentUrl 就能原样解析回来（含楼中楼），
 * 这些条目存进收藏夹之后，角标、归档、删除全都按同一套逻辑走，不用为它们开小灶。
 */
export function aicuCommentUrl(item) {
  if (!item) return '';
  const rpid = String(item.rpid || '');
  if (!/^\d+$/.test(rpid)) return '';

  const base = aicuPageUrl(item.type, item.oid);
  if (!base) return '';

  const root = String(item.root || '0');
  const isSecondary = Number(item.rank) === 2 || (root !== '0' && root !== rpid);

  let u;
  try { u = new URL(base); } catch (e) { return ''; }
  u.searchParams.set('comment_on', '1');
  // 一级评论：root 就是它自己；楼中楼：root 是所属会话的根，本人另写在 secondary 里
  u.searchParams.set('comment_root_id', root !== '0' ? root : rpid);
  if (isSecondary) u.searchParams.set('comment_secondary_id', rpid);
  u.searchParams.set('share_type', 's_i');

  return u.toString() + '#reply' + rpid;
}

/**
 * aicu 页面上每条评论右下角的「方式2」链接：B 站自己的楼中楼详情页。
 *
 * 点进去能直接看到这条会话，从而判断出「没有该评论 / UP主已关闭评论区 / 暂无评论」。
 * 注意 root 用的是**会话根**：一级评论就是它自己，楼中楼才是所属会话的根 ——
 * 这一点和 aicu 页面上的参数完全一致。
 */
export function aicuSubUrl(item) {
  if (!item) return '';
  const oid = String(item.oid || '');
  const rpid = String(item.rpid || '');
  const type = Number(item.type);
  if (!/^\d+$/.test(oid) || !/^\d+$/.test(rpid) || !Number.isFinite(type)) return '';

  const root = String(item.root || '0');
  let u;
  try { u = new URL('https://www.bilibili.com/h5/comment/sub'); } catch (e) { return ''; }
  u.searchParams.set('oid', oid);
  u.searchParams.set('pageType', String(type));
  u.searchParams.set('root', root !== '0' ? root : rpid);
  return u.toString();
}

/** 规整一条 aicu 记录；缺关键字段（rpid / type / oid）就返回 null */
export function normalizeAicuItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rpid = String(raw.rpid === undefined || raw.rpid === null ? '' : raw.rpid);
  if (!/^\d+$/.test(rpid)) return null;

  const type = Number(raw.type);
  const oid = String(raw.oid === undefined || raw.oid === null ? '' : raw.oid);
  if (!Number.isFinite(type) || !/^\d+$/.test(oid)) return null;

  const root = String(raw.root === undefined || raw.root === null ? '0' : raw.root);

  const out = {
    rpid: rpid,
    type: type,
    oid: oid,
    root: /^\d+$/.test(root) ? root : '0',
    rank: Number(raw.rank) || 1,
    message: String(raw.message || '').slice(0, 200),
    ctime: Number(raw.ctime) || 0
  };

  // 存活探测的结果：true=还在 / false=已经没了 / 不带=还没探过
  if (raw.alive === true || raw.alive === false) out.alive = raw.alive;
  return out;
}

/**
 * 确保「容器目录 / 目录名」存在，返回它的 id。
 *
 * 只在设置里打开了「同时写入浏览器收藏夹」时才会被调用 ——
 * 数据以本地库为准，收藏夹只是个可选的镜像。
 */
export async function ensureFolder(title) {
  const settings = await getSettings();
  const rootId = String(settings.rootParent || '2') === '1' ? '1' : '2';
  const name = String(title || '').trim() || '未命名';

  const pick = async function (parentId, want) {
    const children = await chrome.bookmarks.getChildren(parentId).catch(function () { return []; });
    const hit = children.find(n => !n.url && n.title === want);
    if (hit) return hit.id;
    const node = await chrome.bookmarks.create({ parentId: parentId, title: want });
    return node.id;
  };

  const container = String(settings.containerFolder || '').trim();
  const parent = container ? await pick(rootId, container) : rootId;
  return await pick(parent, name);
}

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
    m = /\/video\/av(\d+)/i.exec(u.pathname);
    if (m) return 'av' + m[1];
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


/* --------------------------------------------------- 评论库（权威数据源）
 *
 * 定位变了：这不再只是「批量删评论」，核心是**本地评论管理 + 备份**，删除只是库里
 * 众多操作之一。所以数据不能再寄居在收藏夹上 —— 那里只能存标题和 URL，字段贫瘠，
 * 几千条还会把书签栏塞爆。改为以 chrome.storage.local 里的一份「库」为权威：
 *
 *   { v, uid, total, updatedAt, probedAt,
 *     items:  { rpid: item },
 *     videos: { "type:oid": { title, bvid, owner, at } } }
 *
 * item = { rpid, type, oid, root, rank, message, ctime,
 *          state,            // live=还在 / gone=已经没了 / deleted=我们自己删的 / unknown=还没查过
 *          aliveCheckedAt,   // 上次检查存活的时间（毫秒）
 *          goneAt,           // 哪一刻发现它没了的
 *          firstSeen, lastSeen,
 *          bookmarkId }      // 同步到收藏夹时留下的书签 id
 *
 * 兼容：老数据存在 bc_aicu 里、只有 alive: true/false/undefined，
 * 第一次读库时自动迁移过来，不丢东西。
 */

export const K_LIBRARY = 'bc_library';

const LIB_VERSION = 2;
const LIB_MAX_ITEMS = 20000;

export const LIB_STATES = ['live', 'gone', 'deleted', 'unknown', 'unreachable'];

/**
 * 这条评论还值得为它发一次删除请求吗？
 *
 *   live        值得 —— 确认还在
 *   unknown     值得 —— 还没查过，删一次正好当探测
 *   unreachable 值得 —— 查不到（视频不可访问之类），但**不能因为查不到就当它没了**
 *   gone        **不值得** —— 已经没了，再问一次只会拿到 12022
 *   deleted     **不值得** —— 我们自己已经删过了
 *
 * 这是 v1.3 做存活探测的初衷：别为早就没了的评论浪费请求。
 * 所以任何"进删除队列"的入口都必须过这一关。
 */
export function isDeletable(state) {
  return state === 'live' || state === 'unknown' || state === 'unreachable';
}

/** 规整库里的一条记录；缺 rpid / type / oid 就返回 null */
export function normalizeLibItem(raw) {
  const base = normalizeAicuItem(raw);
  if (!base) return null;

  let state = String((raw && raw.state) || '').trim();
  if (LIB_STATES.indexOf(state) < 0) state = 'unknown';

  const out = {
    rpid: base.rpid,
    type: base.type,
    oid: base.oid,
    root: base.root,
    rank: base.rank,
    message: base.message,
    ctime: base.ctime,
    // 这条是哪儿来的：record=扩展自动记录下来的（你刚发的），aicu=从 aicu 导入的历史评论
    source: (raw && raw.source === 'record') ? 'record' : 'aicu',
    state: state
  };

  const ts = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  if (ts(raw.aliveCheckedAt)) out.aliveCheckedAt = ts(raw.aliveCheckedAt);
  if (ts(raw.goneAt)) out.goneAt = ts(raw.goneAt);
  if (ts(raw.deletedAt)) out.deletedAt = ts(raw.deletedAt);
  if (ts(raw.firstSeen)) out.firstSeen = ts(raw.firstSeen);
  if (ts(raw.lastSeen)) out.lastSeen = ts(raw.lastSeen);
  if (raw.bookmarkId) out.bookmarkId = String(raw.bookmarkId);
  // 上次检查的结论说明 —— 为什么是"查不到"、为什么判它没了，都记在这里给人看
  if (raw.note) out.note = String(raw.note).slice(0, 120);

  return out;
}

function normalizeLib(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = {};
  const inItems = src.items && typeof src.items === 'object' ? src.items : {};
  let count = 0;

  for (const k of Object.keys(inItems)) {
    if (count >= LIB_MAX_ITEMS) break;
    const it = normalizeLibItem(inItems[k]);
    if (!it) continue;
    items[it.rpid] = it;
    count++;
  }

  const videos = {};
  const inVideos = src.videos && typeof src.videos === 'object' ? src.videos : {};
  for (const k of Object.keys(inVideos)) {
    const v = inVideos[k];
    if (!v || typeof v !== 'object') continue;
    videos[k] = {
      title: String(v.title || '').slice(0, 200),
      bvid: String(v.bvid || '').slice(0, 20),
      owner: String(v.owner || '').slice(0, 60),
      at: Number(v.at) || 0
    };
  }

  return {
    v: LIB_VERSION,
    uid: String(src.uid || ''),
    mixed: !!src.mixed,
    total: Number(src.total) || 0,
    updatedAt: Number(src.updatedAt) || 0,
    probedAt: Number(src.probedAt) || 0,
    items: items,
    videos: videos
  };
}

function emptyLib() {
  return normalizeLib({});
}

/** 视频缓存的键 */
export function videoKey(type, oid) {
  return String(Number(type)) + ':' + String(oid);
}

/** 读整库。库里没有就返回一个空库。 */
export async function getLibrary() {
  const o = await chrome.storage.local.get(K_LIBRARY);
  const lib = o[K_LIBRARY];
  if (lib && typeof lib === 'object' && lib.items) return normalizeLib(lib);
  return emptyLib();
}

/** 整个库清掉（数据页的「删除全部」用） */
export async function clearLibrary() {
  await chrome.storage.local.remove(K_LIBRARY);
}

export async function saveLibrary(lib) {
  const next = normalizeLib(lib);
  next.updatedAt = Date.now();
  await chrome.storage.local.set({ [K_LIBRARY]: next });
  return next;
}

/* ------------------------------------------------------------ 库：写操作 */

/**
 * 把一批评论并进库（已存在的不重复加，只补全缺失的字段）。
 * 这是导入 aicu 清单、以及从收藏夹回填时走的入口。
 */
export async function upsertLibItems(payload) {
  const list = Array.isArray(payload) ? payload : ((payload && payload.items) || []);
  const lib = await getLibrary();
  const now = Date.now();

  let added = 0;
  let enriched = 0;
  let count = Object.keys(lib.items).length;

  for (const raw of list) {
    const it = normalizeLibItem(raw);
    if (!it) continue;

    const prev = lib.items[it.rpid];
    if (prev) {
      const patch = {};
      if (!prev.message && it.message) patch.message = it.message;
      if (!prev.ctime && it.ctime) patch.ctime = it.ctime;
      if (!prev.type && it.type) patch.type = it.type;
      if (!prev.oid && it.oid) patch.oid = it.oid;
      if ((!prev.root || prev.root === '0') && it.root && it.root !== '0') patch.root = it.root;
      // 自己记录下来的条目比"从 aicu 导入的"更可信，优先级更高
      if (it.source === 'record' && prev.source !== 'record') patch.source = 'record';
      // 已经查过存活结论的，不要被一次重新导入冲掉
      patch.lastSeen = now;
      if (Object.keys(patch).length > 1) {
        lib.items[it.rpid] = Object.assign({}, prev, patch);
        enriched++;
      } else {
        lib.items[it.rpid] = Object.assign({}, prev, { lastSeen: now });
      }
      continue;
    }

    if (count >= LIB_MAX_ITEMS) break;
    it.firstSeen = it.firstSeen || now;
    it.lastSeen = now;
    lib.items[it.rpid] = it;
    count++;
    added++;
  }

  if (payload && payload.uid) {
    const u = String(payload.uid);
    if (lib.uid && lib.uid !== u) lib.mixed = true;
    lib.uid = u;          // 记最新的（老接口就是这个行为，保持一致）
  }
  if (payload && Number(payload.total)) lib.total = Number(payload.total);

  if (added || enriched) await saveLibrary(lib);
  return { added: added, enriched: enriched, total: count, store: lib };
}

const STATE_SET = { live: 1, gone: 1, deleted: 1, unknown: 1, unreachable: 1 };

/**
 * 记下一批存活结论。marks 形如
 *   { rpid: 'live' | 'gone' | 'unknown' | 'unreachable' }
 * 也接受 `{ rpid: { state, note } }` 和老的 true/false 写法。
 *
 * 会顺手记下检查时间；**第一次发现它没了的时候**记下 goneAt。
 * `note` 是"为什么得出这个结论"，会存下来给人看 —— 光显示"查不到"没法排查。
 */
export async function setLibStates(marks) {
  const lib = await getLibrary();
  const now = Date.now();
  let changed = 0;   // 结论真的变了的
  let touched = 0;   // 结论没变、只是刷新了"上次检查时间"的

  for (const rpid of Object.keys(marks || {})) {
    const it = lib.items[rpid];
    if (!it) continue;

    const raw = marks[rpid];
    const spec = (raw && typeof raw === 'object') ? raw : { state: raw };
    if (!STATE_SET[spec.state]) continue;          // 状态不认识就跳过，别瞎记
    const state = spec.state;
    const note = spec.note ? String(spec.note).slice(0, 120) : '';

    it.note = note;
    it.aliveCheckedAt = now;

    if (it.state === state) { touched++; continue; }

    if (state === 'live') {
      // 又活了（或者之前判错了），把"没了"的痕迹清掉
      delete it.goneAt;
    } else if (state === 'gone' && !it.goneAt) {
      it.goneAt = now;
    }
    it.state = state;
    changed++;
  }

  if (changed || touched) {
    lib.probedAt = now;
    await saveLibrary(lib);
  }
  return { changed: changed, touched: touched, probedAt: lib.probedAt };
}

/** 我们自己把它删掉了 */
export async function markLibDeleted(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return 0;

  const lib = await getLibrary();
  const now = Date.now();
  let changed = 0;
  for (const rpid of list) {
    const it = lib.items[rpid];
    if (!it) continue;
    it.state = 'deleted';
    it.deletedAt = now;
    it.aliveCheckedAt = now;
    changed++;
  }
  if (changed) await saveLibrary(lib);
  return changed;
}

export async function removeLibItems(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return 0;

  const lib = await getLibrary();
  let removed = 0;
  for (const rpid of list) {
    if (lib.items[rpid]) { delete lib.items[rpid]; removed++; }
  }
  if (removed) await saveLibrary(lib);
  return removed;
}

/** 按 rpid 精确取几条（勾选的条目往往不在当前页，不能靠翻页去找） */
export async function getLibItems(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return [];

  const lib = await getLibrary();
  const out = [];
  for (const rpid of list) {
    const it = lib.items[rpid];
    if (it) out.push(it);
  }
  return out;
}

/** 视频标题缓存 */
export async function saveVideoTitles(map) {
  const keys = Object.keys(map || {});
  if (!keys.length) return 0;

  const lib = await getLibrary();
  const now = Date.now();
  let n = 0;
  for (const k of keys) {
    const v = map[k];
    if (!v || !v.title) continue;
    lib.videos[k] = {
      title: String(v.title).slice(0, 200),
      bvid: String(v.bvid || '').slice(0, 20),
      owner: String(v.owner || '').slice(0, 60),
      at: now
    };
    n++;
  }
  if (n) await saveLibrary(lib);
  return n;
}

/* ------------------------------------------------------------ 库：读操作 */

/** 按时间倒序列出全部条目 */
export async function listLibItems() {
  const lib = await getLibrary();
  return Object.values(lib.items).sort((a, b) => (b.ctime - a.ctime) || (String(b.rpid) > String(a.rpid) ? 1 : -1));
}

export async function libraryStats() {
  const lib = await getLibrary();
  const s = { total: 0, live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0,
              recorded: 0, imported: 0, videos: 0, titled: 0 };
  const seenVideos = {};
  for (const k of Object.keys(lib.items)) {
    const it = lib.items[k];
    const st = it.state;
    s.total++;
    if (s[st] === undefined) s.unknown++; else s[st]++;
    if (it.source === 'record') s.recorded++; else s.imported++;
    seenVideos[videoKey(it.type, it.oid)] = 1;
  }
  s.videos = Object.keys(seenVideos).length;   // 库里涉及多少个视频
  s.titled = Object.keys(lib.videos).length;   // 其中多少个已经有标题
  s.uid = lib.uid;
  s.mixed = lib.mixed;
  s.totalOnSite = lib.total;
  s.probedAt = lib.probedAt;
  s.updatedAt = lib.updatedAt;
  return s;
}

/**
 * 查库：搜索 / 筛选 / 排序 / 分页。
 * 分页是必须的 —— 库里几千条，不可能一次塞进 DOM。
 */
export async function queryLib(opts) {
  const o = opts || {};
  const lib = await getLibrary();

  const q = String(o.q || '').trim().toLowerCase();
  const states = Array.isArray(o.states) && o.states.length ? o.states : null;
  const oid = o.oid ? String(o.oid) : '';
  const sort = o.sort || 'time-desc';

  let list = Object.values(lib.items);

  if (states) list = list.filter(it => states.indexOf(it.state) >= 0);
  if (oid) list = list.filter(it => String(it.oid) === oid);
  if (o.source === 'record' || o.source === 'aicu') {
    list = list.filter(it => it.source === o.source);
  }
  if (q) {
    list = list.filter(it =>
      String(it.message || '').toLowerCase().indexOf(q) >= 0 ||
      String(it.rpid).indexOf(q) >= 0 ||
      String(it.oid).indexOf(q) >= 0);
  }

  const cmp = {
    'time-desc': (a, b) => (b.ctime - a.ctime),
    'time-asc': (a, b) => (a.ctime - b.ctime),
    'video': (a, b) => (String(a.oid) === String(b.oid)
      ? (b.ctime - a.ctime)
      : (String(a.oid) < String(b.oid) ? -1 : 1))
  }[sort];
  if (cmp) list.sort(cmp);

  const total = list.length;
  const offset = Math.max(0, Number(o.offset) || 0);
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 50));
  const page = list.slice(offset, offset + limit);

  // 顺手把视频标题带上，省得调用方再查一次
  const withVideo = page.map(it => Object.assign({}, it, {
    video: lib.videos[videoKey(it.type, it.oid)] || null
  }));

  return { total: total, offset: offset, limit: limit, items: withVideo, videos: lib.videos };
}

/** 库里出现过、但还没拿到标题的那些视频 */
export async function missingVideoTitles(limit) {
  const lib = await getLibrary();
  const seen = {};
  for (const k of Object.keys(lib.items)) {
    const it = lib.items[k];
    const key = videoKey(it.type, it.oid);
    if (!lib.videos[key]) seen[key] = { type: it.type, oid: it.oid };
  }
  return Object.keys(seen).slice(0, Math.max(1, Number(limit) || 20)).map(k => seen[k]);
}



/* ------------------------------------------------------------------ 导出 */

const esc = s => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATE_TEXT = { live: '还在', gone: '已没了', deleted: '已删除', unknown: '未检查', unreachable: '查不到' };

export function stateText(state) {
  return STATE_TEXT[state] || STATE_TEXT.unknown;
}

/**
 * 导出成 JSON —— 完整、无损、能再导回来。
 * 故意把 videos 也带上：不然导出的库再导入就只剩 av 号了。
 */
export async function exportLibraryJSON() {
  const lib = await getLibrary();
  const items = Object.keys(lib.items).map(k => lib.items[k]);
  return JSON.stringify({
    format: 'bili-comment-keeper/library',
    version: LIB_VERSION,
    exportedAt: new Date().toISOString(),
    uid: lib.uid,
    mixed: lib.mixed,
    totalOnSite: lib.total,
    probedAt: lib.probedAt,
    count: items.length,
    videos: lib.videos,
    items: items
  }, null, 2);
}

/** 导出的条目按时间倒序，读起来顺一点 */
function sortedForExport(lib) {
  return Object.keys(lib.items)
    .map(k => lib.items[k])
    .sort((a, b) => (b.ctime - a.ctime));
}

function videoOf(lib, it) {
  return lib.videos[videoKey(it.type, it.oid)] || null;
}

/**
 * 导出成一份**能离线打开看**的 HTML。
 * 这是"定期查看"用的：双击就能在浏览器里翻，不依赖扩展、不联网。
 */
export async function exportLibraryHTML(title) {
  const lib = await getLibrary();
  const items = sortedForExport(lib);
  const heading = String(title || ('B 站评论备份 · UID ' + (lib.uid || '未知')));

  const counts = { live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0 };
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

  const rows = items.map(it => {
    const v = videoOf(lib, it);
    const label = v && v.title ? v.title : (String(it.type) === '1' ? 'av' + it.oid : it.oid);
    const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
    const url = aicuCommentUrl(it);
    const sub = aicuSubUrl(it);
    return `<li class="s-${esc(it.state)}">
      <div class="meta"><span class="when">${esc(when)}</span>
        <span class="tag t-${esc(it.state)}">${esc(stateText(it.state))}</span>
        <span class="kind">${esc(aicuTypeName(it.type))}</span>
        ${it.rank === 2 ? '<span class="kind">楼中楼</span>' : ''}</div>
      <div class="body">${esc(it.message || '（没有正文）')}</div>
      <div class="meta"><span class="vid">${esc(label)}</span>
        ${v && v.owner ? `<span class="owner">UP：${esc(v.owner)}</span>` : ''}
        <span class="rid">rpid ${esc(it.rpid)}</span></div>
      <div class="links">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">方式0</a>` : ''}
        ${sub ? `<a href="${esc(sub)}" target="_blank" rel="noreferrer">方式2</a>` : ''}
      </div>
    </li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:24px; font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#faf9fb; color:#1c1c22; }
  @media (prefers-color-scheme: dark) { body { background:#16161a; color:#e6e6ea; } }
  h1 { font-size:20px; margin:0 0 6px; }
  .sum { color:#7a7a88; font-size:13px; margin-bottom:18px; }
  ul { list-style:none; margin:0; padding:0; }
  li { border:1px solid rgba(128,128,128,.24); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  li.s-gone, li.s-deleted { opacity:.55; }
  .meta { display:flex; flex-wrap:wrap; gap:10px; align-items:center; font-size:12.5px; color:#7a7a88; }
  .body { margin:6px 0; white-space:pre-wrap; word-break:break-word; }
  .tag { padding:0 6px; border-radius:4px; font-size:11.5px; border:1px solid currentColor; }
  .t-live { color:#1a9560; } .t-gone { color:#8a8a96; }
  .t-deleted { color:#c0392b; } .t-unknown { color:#b8860b; }
  .links a { margin-right:12px; font-size:13px; }
  footer { color:#7a7a88; font-size:12px; margin-top:22px; }
</style>
</head>
<body>
<h1>${esc(heading)}</h1>
<div class="sum">
  共 ${items.length} 条　·　还在 ${counts.live || 0}　·　已没了 ${counts.gone || 0}　·　
  已删除 ${counts.deleted || 0}　·　未检查 ${counts.unknown || 0}　·　
  查不到 ${counts.unreachable || 0}<br>
  导出时间 ${esc(fmtTime(Date.now()))}
</div>
<ul>
${rows}
</ul>
<footer>由 B站评论管家 导出。这份文件是自包含的，不联网也能看。</footer>
</body>
</html>`;
}

/** 导出成 Markdown —— 便于丢进笔记软件、或者拿去 diff */
export async function exportLibraryMarkdown(title) {
  const lib = await getLibrary();
  const items = sortedForExport(lib);
  const heading = String(title || ('B 站评论备份 · UID ' + (lib.uid || '未知')));

  const counts = { live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0 };
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

  const lines = [
    '# ' + heading,
    '',
    `共 ${items.length} 条　·　还在 ${counts.live || 0}　·　已没了 ${counts.gone || 0}　·　` +
      `已删除 ${counts.deleted || 0}　·　未检查 ${counts.unknown || 0}　·　查不到 ${counts.unreachable || 0}`,
    '',
    `导出时间：${fmtTime(Date.now())}`,
    ''
  ];

  for (const it of items) {
    const v = videoOf(lib, it);
    const label = v && v.title ? v.title : (String(it.type) === '1' ? 'av' + it.oid : it.oid);
    const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
    const url = aicuCommentUrl(it);
    const sub = aicuSubUrl(it);

    lines.push('## ' + when + '　' + stateText(it.state));
    lines.push('');
    lines.push('> ' + String(it.message || '（没有正文）').replace(/\n/g, '\n> '));
    lines.push('');
    lines.push(`- ${aicuTypeName(it.type)}${it.rank === 2 ? '（楼中楼）' : ''}：${label}` +
      (v && v.owner ? `　UP：${v.owner}` : ''));
    lines.push(`- rpid \`${it.rpid}\``);
    if (url) lines.push(`- [方式0](${url})`);
    if (sub) lines.push(`- [方式2](${sub})`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 把导出的 JSON 读回库。
 * 只认识我们自己导出的格式；条目走和导入一样的合并逻辑（不覆盖已有的存活结论）。
 */
export async function importLibraryJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, reason: '不是合法的 JSON' }; }
  if (!data || !Array.isArray(data.items)) return { ok: false, reason: '这不是评论库的备份文件（缺少 items）' };

  const r = await upsertLibItems({ uid: data.uid, total: data.totalOnSite, items: data.items });

  let videos = 0;
  if (data.videos && typeof data.videos === 'object') {
    videos = await saveVideoTitles(data.videos);
  }
  // 备份里的存活结论也要认，否则导回来全变成"未检查"
  const marks = {};
  for (const it of data.items) {
    if (it && it.rpid && it.state) marks[it.rpid] = it.state;
  }
  if (Object.keys(marks).length) await setLibStates(marks);

  return { ok: true, added: r.added, enriched: r.enriched, total: r.total, videos: videos };
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
