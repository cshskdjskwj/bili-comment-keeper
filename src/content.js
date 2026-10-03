/**
 * content.js —— 运行在网页「隔离世界」(ISOLATED world)
 *
 * 只做一件事：把主世界 recorder-main.js / aicu-main.js / 删除器 通过
 * window.postMessage 发出来的消息，转发给扩展后台（或清除面板）。
 */

function sendToExtension(msg) {
  try {
    var p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) {
    // 扩展被重新加载后旧页面会走到这里，属于正常现象，忽略
  }
}

window.addEventListener('message', function (ev) {
  if (ev.source !== window) return;
  var d = ev.data;
  if (!d || typeof d !== 'object') return;

  try {
    if (d.__bcRecorder && d.payload && typeof d.payload === 'object') {
      // kind === 'deleted' 表示用户是在 B 站网页上自己删了评论，
      // 这种情况要把对应书签同步归档，而不是新增记录。
      var type = d.payload.kind === 'deleted' ? 'COMMENT_DELETED' : 'RECORD_COMMENT';
      sendToExtension({ type: type, payload: d.payload });
      return;
    }
    if (d.__bcAicu && d.payload && typeof d.payload === 'object') {
      // aicu.cc 页面上顺手读到的历史评论，交给后台去重落盘
      sendToExtension({ type: 'AICU_REPLIES', payload: d.payload });
      return;
    }
    if (d.__bcAicuAuto && typeof d.__bcAicuAuto === 'object') {
      // 自动翻页抓取的进度/结束事件
      sendToExtension({ type: 'AICU_AUTOPAGE', payload: d.__bcAicuAuto });
      return;
    }
    if (d.__bcDeleterResult && typeof d.__bcDeleterResult === 'object') {
      var r = d.__bcDeleterResult;
      sendToExtension({
        type: 'DELETE_RESULT',
        requestId: r.requestId || '',
        ok: !!r.ok,
        code: (r.code === undefined ? null : r.code),
        message: r.message || ''
      });
    }
  } catch (e) {
    // 页面脚本可能伪造消息，出错就丢弃
  }
}, false);

/* aicu.cc 专用：把清除面板发来的「自动翻页」指令转交给主世界的 aicu-auto.js。
 * 主世界读不到 chrome.* API，所以这条反向通道只能由隔离世界来搭。 */
try {
  if (/(^|\.)aicu\.cc$/.test(location.hostname)) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.type !== 'AICU_AUTOPAGE_CMD') return;
      try {
        window.postMessage({ __bcAicuCmd: msg.payload }, '*');
      } catch (e) { /* 忽略 */ }
    });
  }
} catch (e) { /* 忽略 */ }
