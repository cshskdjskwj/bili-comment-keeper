/**
 * options.js —— 设置页
 */

import {
  getSettings, setSettings, ensureFolder, getIndex, getSyncState,
  folderPath, fmtTime, DEFAULT_SETTINGS
} from '../src/shared.js';

const $ = id => document.getElementById(id);

/** 云备份到底成没成，如实写出来——v1.0.0 是静默失败的 */
function syncStateText(sync) {
  if (!sync) return '云同步备份：还没有写过（改一次设置或发一条评论后就会出现）';
  if (sync.ok) {
    return `云同步备份：正常（${sync.count} 条 / ${sync.chunks} 片 / 约 ${sync.bytes} 字节 / ${fmtTime(sync.at)}）`;
  }
  return `云同步备份：失败 —— ${sync.reason}。本地记录和书签都不受影响，只是换设备时这部分元数据同步不过去（视频评论仍可靠 BV 号反查救回来）。`;
}

async function render() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;
  $('recordContent').checked = s.recordContent;
  $('clipboardFallback').checked = s.clipboardFallback;
  $('rootParent').value = String(s.rootParent) === '1' ? '1' : '2';
  $('containerFolder').value = s.containerFolder || '';
  $('folderActive').value = s.folderActive;
  $('folderDeleted').value = s.folderDeleted;
  $('minDelay').value = s.minDelay;
  $('maxDelay').value = s.maxDelay;
  $('badgeMode').value = ['off', 'live', 'pending'].indexOf(s.badgeMode) >= 0 ? s.badgeMode : 'off';

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const idx = await getIndex();
  const n = Object.keys(idx).length;
  const sync = await getSyncState();

  $('index-info').textContent =
    `当前结构：${folderPath(s, s.folderActive)}　→　${folderPath(s, s.folderDeleted)}` +
    `　｜　本地元数据索引 ${n} 条（用来定位评论属于哪个评论区；丢了也能靠 BV 号反查，只影响非视频页面）。` +
    `　｜　${syncStateText(sync)}`;
}

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

/** 统一的失败出口，避免再出现没人接的 promise rejection */
function renderSafe() {
  render().catch(function (e) {
    const el = $('index-info');
    if (el) el.textContent = '读取设置失败：' + ((e && e.message) || e);
  });
}

$('btn-save').addEventListener('click', async function () {
  try {
    const folderActive = $('folderActive').value.trim() || DEFAULT_SETTINGS.folderActive;
    const folderDeleted = $('folderDeleted').value.trim() || DEFAULT_SETTINGS.folderDeleted;
    const containerFolder = $('containerFolder').value.trim();
    const rootParent = $('rootParent').value === '1' ? '1' : '2';

    if (folderActive === folderDeleted) {
      flash('两个目录名不能一样 ✗');
      return;
    }
    if (containerFolder && (containerFolder === folderActive || containerFolder === folderDeleted)) {
      flash('外层文件夹名不能和里面两个目录重名 ✗');
      return;
    }

    let minDelay = parseInt($('minDelay').value, 10);
    let maxDelay = parseInt($('maxDelay').value, 10);
    if (!Number.isFinite(minDelay) || minDelay < 300) minDelay = DEFAULT_SETTINGS.minDelay;
    if (!Number.isFinite(maxDelay) || maxDelay < minDelay) maxDelay = Math.max(minDelay, DEFAULT_SETTINGS.maxDelay);

    await setSettings({
      enabled: $('enabled').checked,
      recordContent: $('recordContent').checked,
      clipboardFallback: $('clipboardFallback').checked,
      rootParent: rootParent,
      containerFolder: containerFolder,
      folderActive: folderActive,
      folderDeleted: folderDeleted,
      minDelay: minDelay,
      maxDelay: maxDelay,
      badgeMode: ['off', 'live', 'pending'].indexOf($('badgeMode').value) >= 0
        ? $('badgeMode').value : 'off'
    });

    // 立刻把目录建好；如果旧的两个目录还在书签栏顶层，这里会把它们整个搬进新位置
    await ensureFolder(folderActive);
    await ensureFolder(folderDeleted);

    flash('已保存并整理好目录 ✓');
    renderSafe();
  } catch (e) {
    flash('保存失败：' + ((e && e.message) || e) + ' ✗');
  }
});

$('btn-reset').addEventListener('click', async function () {
  try {
    await setSettings(Object.assign({}, DEFAULT_SETTINGS));
    await ensureFolder(DEFAULT_SETTINGS.folderActive);
    await ensureFolder(DEFAULT_SETTINGS.folderDeleted);
    flash('已恢复默认 ✓');
    renderSafe();
  } catch (e) {
    flash('恢复默认失败：' + ((e && e.message) || e) + ' ✗');
  }
});

renderSafe();
