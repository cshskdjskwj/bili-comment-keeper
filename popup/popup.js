/**
 * popup.js —— 工具栏弹窗
 *
 * 重做之后它的职责只剩两件：**一眼看数** + **一个入口**。
 * 明细、筛选、删除操作都在控制台（侧边栏）里，弹窗不再重复一遍。
 */

import {
  getSettings, setSettings, libraryStats, fmtTime
} from '../src/shared.js';

const $ = id => document.getElementById(id);

async function render() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;

  const st = await libraryStats();

  // 这一格是「我目前还存在的评论」—— 也就是库里"还在"的数量。
  // 以前叫「待处理」，那是删除导向的叫法；定位改成管理器之后它不再合适。
  $('count').textContent = String(st.live);
  $('arc-count').textContent = String(st.deleted);

  const bits = [`库里共 ${st.total} 条`];
  if (st.gone) bits.push(`已没了 ${st.gone}`);
  if (st.unreachable) bits.push(`查不到 ${st.unreachable}`);
  if (st.unknown) bits.push(`未检查 ${st.unknown}`);
  if (st.recorded) bits.push(`自己记录 ${st.recorded}`);
  if (st.imported) bits.push(`导入 ${st.imported}`);
  $('aicu-line').textContent = bits.join('　·　') + (st.uid ? `（UID ${st.uid}）` : '');

  $('state-line').textContent = s.enabled
    ? (st.probedAt ? `自动记录已开启　·　上次巡检 ${fmtTime(st.probedAt)}` : '自动记录已开启')
    : '⚠️ 已关闭自动记录 —— 发评论不会再进库';
}

$('enabled').addEventListener('change', async function (e) {
  await setSettings({ enabled: e.target.checked });
  render().catch(function () {});
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
