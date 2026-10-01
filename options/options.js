/**
 * options.js —— 设置页
 */

import {
  getSettings, setSettings, ensureFolder, getIndex, folderPath, DEFAULT_SETTINGS
} from '../src/shared.js';

const $ = id => document.getElementById(id);

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

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const idx = await getIndex();
  const n = Object.keys(idx).length;
  $('index-info').textContent =
    `当前结构：${folderPath(s, s.folderActive)}　→　${folderPath(s, s.folderDeleted)}` +
    `　｜　本地元数据索引 ${n} 条（用来定位评论属于哪个评论区；丢了也能靠 BV 号反查，只影响非视频页面）。`;
}

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

$('btn-save').addEventListener('click', async function () {
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
    maxDelay: maxDelay
  });

  // 立刻把目录建好；如果旧的两个目录还在书签栏顶层，这里会把它们整个搬进新位置
  await ensureFolder(folderActive);
  await ensureFolder(folderDeleted);

  flash('已保存并整理好目录 ✓');
  render();
});

$('btn-reset').addEventListener('click', async function () {
  await setSettings(Object.assign({}, DEFAULT_SETTINGS));
  await ensureFolder(DEFAULT_SETTINGS.folderActive);
  await ensureFolder(DEFAULT_SETTINGS.folderDeleted);
  flash('已恢复默认 ✓');
  render();
});

render();
