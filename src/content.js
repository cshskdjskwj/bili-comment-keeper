/**
 * content.js —— 运行在网页「隔离世界」(ISOLATED world)
 *
 * 只做一件事：把主世界 recorder-main.js / 删除器 通过 window.postMessage
 * 发出来的消息，转发给扩展后台（或清除面板）。
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
