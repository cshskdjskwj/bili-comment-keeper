/**
 * popup.js —— 工具栏弹窗
 */

import {
  getSettings, setSettings, findFolder, listComments, escapeHtml, folderPath
} from '../src/shared.js';

const $ = id => document.getElementById(id);

async function render() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;

  const activeId = await findFolder(s.folderActive);
  const deletedId = await findFolder(s.folderDeleted);

  // 两个数字都只统计真正的评论链接
  const pending = activeId ? await listComments(activeId) : [];   // 还没删的
  const archived = deletedId ? await listComments(deletedId) : []; // 已删待清空（= 角标数字）

  $('count').textContent = String(pending.length);
  $('arc-count').textContent = String(archived.length);
  $('path-line').textContent =
    `待清理：${folderPath(s, s.folderActive)}　|　归档：${folderPath(s, s.folderDeleted)}`;

  const box = $('recent');
  if (!pending.length) {
    box.innerHTML = '<div class="empty">还没有记录，去 B 站发一条评论试试～</div>';
  } else {
    box.innerHTML = pending.slice(0, 6).map(function (b) {
      return `<a class="recent-item" href="${escapeHtml(b.url)}" target="_blank" title="${escapeHtml(b.title)}">
        <span class="dot">•</span>${escapeHtml(b.title)}</a>`;
    }).join('');
  }
}

$('enabled').addEventListener('change', async function (e) {
  await setSettings({ enabled: e.target.checked });
  $('path-line').textContent = e.target.checked
    ? '自动记录已开启 ✓'
    : '自动记录已关闭（发评论不会再写入书签）';
});

$('btn-clean').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('clean/clean.html') });
  window.close();
});

$('btn-settings').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
  window.close();
});

// 扩展在后台发现你「在 B 站网页上手动删了评论」并归档书签时，弹窗跟着刷新
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'SYNC_ARCHIVED') {
    render().catch(function () {});
  }
});

render().catch(function (e) {
  $('recent').innerHTML = '<div class="empty">读取失败：' + escapeHtml((e && e.message) || e) + '</div>';
});
