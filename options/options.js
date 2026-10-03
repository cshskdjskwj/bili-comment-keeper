/**
 * options.js —— 设置页
 */

import {
  getSettings, setSettings, ensureFolder, libraryStats, fmtTime
} from '../src/shared.js';

const $ = id => document.getElementById(id);

async function render() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;
  $('clipboardFallback').checked = s.clipboardFallback;
  $('useBookmarks').checked = s.useBookmarks;
  $('rootParent').value = String(s.rootParent) === '1' ? '1' : '2';
  $('containerFolder').value = s.containerFolder || '';
  $('folderActive').value = s.folderActive;
  $('minDelay').value = s.minDelay;
  $('maxDelay').value = s.maxDelay;
  $('badgeMode').value = ['off', 'live', 'pending'].indexOf(s.badgeMode) >= 0 ? s.badgeMode : 'off';

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const st = await libraryStats();
  $('index-info').textContent =
    `本地评论库：${st.total} 条（还在 ${st.live}　已没了 ${st.gone}　已删除 ${st.deleted}` +
    `　查不到 ${st.unreachable}　未检查 ${st.unknown}）` +
    (st.probedAt ? `　·　上次巡检 ${fmtTime(st.probedAt)}` : '') +
    '　·　数据存在扩展自己的本地存储里；要备份请在控制台里「导出 JSON」。';
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
    const containerFolder = $('containerFolder').value.trim();
    const folderActive = $('folderActive').value.trim() || 'B站我的评论';
    const rootParent = $('rootParent').value === '1' ? '1' : '2';
    const useBookmarks = $('useBookmarks').checked;

    if (containerFolder && containerFolder === folderActive) {
      flash('外层文件夹名不能和里面那个目录重名 ✗');
      return;
    }

    let minDelay = parseInt($('minDelay').value, 10);
    let maxDelay = parseInt($('maxDelay').value, 10);
    if (!Number.isFinite(minDelay) || minDelay < 300) minDelay = 1500;
    if (!Number.isFinite(maxDelay) || maxDelay < minDelay) maxDelay = Math.max(minDelay, 4000);

    await setSettings({
      enabled: $('enabled').checked,
      clipboardFallback: $('clipboardFallback').checked,
      useBookmarks: useBookmarks,
      rootParent: rootParent,
      containerFolder: containerFolder,
      folderActive: folderActive,
      minDelay: minDelay,
      maxDelay: maxDelay,
      badgeMode: ['off', 'live', 'pending'].indexOf($('badgeMode').value) >= 0
        ? $('badgeMode').value : 'off'
    });

    // 只有打开了收藏夹镜像才需要建目录
    if (useBookmarks) await ensureFolder(folderActive);

    flash('已保存 ✓');
    renderSafe();
  } catch (e) {
    flash('保存失败：' + ((e && e.message) || e) + ' ✗');
  }
});

$('btn-reset').addEventListener('click', async function () {
  try {
    await setSettings(Object.assign({}, DEFAULT_SETTINGS));
    if (DEFAULT_SETTINGS.useBookmarks) await ensureFolder(DEFAULT_SETTINGS.folderActive);    flash('已恢复默认 ✓');
    renderSafe();
  } catch (e) {
    flash('恢复默认失败：' + ((e && e.message) || e) + ' ✗');
  }
});

renderSafe();
