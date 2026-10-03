/**
 * popup.js —— 工具栏弹窗
 *
 * 重做之后它的职责只剩两件：**一眼看数** + **一个入口**。
 * 明细、筛选、删除操作都在控制台（侧边栏）里，弹窗不再重复一遍。
 */

import {
  getSettings, setSettings, findFolder, listComments, getAicuStore
} from '../src/shared.js';

const $ = id => document.getElementById(id);

async function render() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;

  const activeId = await findFolder(s.folderActive);
  const deletedId = await findFolder(s.folderDeleted);

  const pending = activeId ? await listComments(activeId) : [];
  const archived = deletedId ? await listComments(deletedId) : [];
  const aicu = await getAicuStore();
  const aicuN = Object.keys(aicu.items).length;

  // 待处理 = 待删书签 + aicu 导入里还没处理的，按 rpid 去重（两边可能指着同一条评论）
  const rpids = new Set(pending.map(b => b.parsed.rpid));
  for (const k of Object.keys(aicu.items)) rpids.add(k);

  $('count').textContent = String(rpids.size);
  $('arc-count').textContent = String(archived.length);

  $('aicu-line').textContent = aicuN
    ? `aicu.cc 导入 ${aicuN} 条待处理${aicu.uid ? `（UID ${aicu.uid}）` : ''}`
    : 'aicu.cc 导入：空';

  $('state-line').textContent = s.enabled
    ? '自动记录已开启'
    : '⚠️ 已关闭自动记录 —— 发评论不会再写入书签';
}

$('enabled').addEventListener('change', async function (e) {
  await setSettings({ enabled: e.target.checked });
  $('state-line').textContent = e.target.checked
    ? '自动记录已开启'
    : '⚠️ 已关闭自动记录 —— 发评论不会再写入书签';
});

/** 优先开侧边栏；打不开（旧版 Chrome / 企业策略）就退回开一个标签页 */
$('btn-console').addEventListener('click', async function () {
  const url = chrome.runtime.getURL('clean/clean.html');
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    }
  } catch (e) { /* 下面走标签页兜底 */ }

  try { await chrome.tabs.create({ url: url }); } catch (e) { /* 忽略 */ }
  window.close();
});

$('btn-settings').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
  window.close();
});

// 后台发现你「在 B 站网页上手动删了评论」并归档书签、或者 aicu 又抓到新数据时，弹窗跟着刷新
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && (msg.type === 'SYNC_ARCHIVED' || msg.type === 'AICU_UPDATED')) {
    render().catch(function () {});
  }
});

render().catch(function (e) {
  $('state-line').textContent = '读取失败：' + ((e && e.message) || e);
});
