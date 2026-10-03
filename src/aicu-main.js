/**
 * aicu-main.js —— 运行在 aicu.cc 的网页「主世界」(MAIN world)
 *
 * 背景：aicu.cc 存着完整的历史评论（它只是索引，评论实体仍在 B 站），
 * 而本扩展只能记录「装好之后」发出的评论 —— 装之前发的、在手机 App 上发的都抓不到。
 * 把 aicu 的清单导进来，正好补上这个缺口。
 *
 * 为什么不直接调 aicu 的接口：它的 /api/v4/search/getreply 需要一个「排队凭据」，
 * 站点还挂着 Cloudflare 挑战。硬啃这套流程既脆弱又是在绕人家的防护。
 * 所以这里换个思路 —— 页面自己会去拉这个接口，我们只是**顺手把已经拉回来的响应读走**，
 * 和 recorder-main.js 偷听 B 站「发评论」请求是同一个手法：
 * 不额外发任何请求，不给 aicu.cc 增加一丁点负担。
 *
 * 读到的记录经 window.postMessage 交给同页面的 content.js（隔离世界），
 * 再由它转发给扩展后台落盘。
 *
 * 记下的三个字段 rpid / dyn.type / dyn.oid，正好就是 B 站删除接口要的参数。
 */
(function () {
  'use strict';

  if (window.__bcAicuInstalled) return;
  window.__bcAicuInstalled = true;

  var API_RE = /\/api\/v4\/search\/getreply(\?|$)/;

  function post(payload) {
    try {
      window.postMessage({ __bcAicu: true, payload: payload }, '*');
    } catch (e) { /* 忽略 */ }
  }

  /** 从一个地址里取 uid / pn / mode */
  function queryFrom(url) {
    var out = { uid: '', page: 0, mode: null };
    try {
      var u = new URL(String(url || ''), location.href).searchParams;
      out.uid = u.get('uid') || '';
      out.page = Number(u.get('pn')) || 0;
      var m = u.get('mode');
      out.mode = (m === null || m === '') ? null : Number(m);
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /**
   * 以**请求地址**为准取参数（它才是这批数据真正的来源），
   * 请求串里没带 uid 时再退回当前页面地址。
   */
  function currentQuery(reqUrl) {
    var q = queryFrom(reqUrl);
    if (q.uid) return q;
    return queryFrom(location.href);
  }

  /**
   * 把一条 aicu 记录压成删除需要的形状。
   * aicu 的字段：rpid / dyn.type / dyn.oid / parent.rootid / rank / message / time
   */
  function pick(item) {
    if (!item || typeof item !== 'object') return null;

    var dyn = item.dyn || {};

    var rpid = (item.rpid === undefined || item.rpid === null) ? '' : String(item.rpid);
    if (!/^\d+$/.test(rpid)) return null;

    var oid = (dyn.oid === undefined || dyn.oid === null) ? '' : String(dyn.oid);
    if (!/^\d+$/.test(oid)) return null;

    var type = Number(dyn.type);
    if (!isFinite(type)) return null;

    var parent = item.parent || {};
    var root = (parent.rootid === undefined || parent.rootid === null) ? '0' : String(parent.rootid);

    return {
      rpid: rpid,
      type: type,
      oid: oid,
      root: /^\d+$/.test(root) ? root : '0',
      rank: Number(item.rank) || 1,
      message: String(item.message || '').slice(0, 200),
      ctime: Number(item.time) || 0
    };
  }

  /** 解析 getreply 的响应体；结构不对就安静地放弃 */
  function handleReply(text, reqUrl) {
    var json;
    try { json = JSON.parse(text); } catch (e) { return; }
    if (!json || !json.data || !Array.isArray(json.data.replies)) return;

    var items = [];
    for (var i = 0; i < json.data.replies.length; i++) {
      var one = pick(json.data.replies[i]);
      if (one) items.push(one);
    }
    if (!items.length) return;

    var q = currentQuery(reqUrl);
    var cursor = json.data.cursor || {};

    post({
      source: 'aicu',
      uid: q.uid,
      page: q.page,
      mode: q.mode,
      total: Number(cursor.all_count) || 0,
      items: items,
      pageUrl: location.origin + location.pathname + location.search
    });
  }

  /* ------------------------------------------------------------ 挂钩 fetch */

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (e) { /* 忽略 */ }

      // 用 window 当 this：页面如果是 bare fetch() 调用，严格模式下 this 是 undefined
      var p = origFetch.apply(window, arguments);

      try {
        if (API_RE.test(url)) {
          p.then(function (res) {
            try {
              res.clone().text().then(function (text) {
                try { handleReply(text, url); } catch (e) { /* 忽略 */ }
              }).catch(function () {});
            } catch (e) { /* 忽略 */ }
          }).catch(function () {});
        }
      } catch (e) { /* 忽略 */ }

      return p;
    };
  }

  /* ------------------------------------------------------------- 挂钩 XHR */

  try {
    var XHR = window.XMLHttpRequest;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try { this.__bcAicuUrl = url; } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        var reqUrl = String(this.__bcAicuUrl || '');
        if (API_RE.test(reqUrl)) {
          this.addEventListener('load', function () {
            var text = '';
            try { text = this.responseText; } catch (e) { text = ''; }
            if (!text) return;
            try { handleReply(text, reqUrl); } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* 忽略 */ }
})();
