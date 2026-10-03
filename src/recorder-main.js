/**
 * recorder-main.js —— 运行在网页「主世界」(MAIN world)
 *
 * 作用：不干扰页面，只在旁边偷听两件事——
 *   1) 发评论请求 POST /x/v2/reply/add 的成功响应，里面有 rpid / root / parent；
 *   2) 用户手动点「复制评论链接」时的剪贴板内容（兜底，防止接口漏抓）。
 *
 * 抓到之后通过 window.postMessage 交给同页面的 content.js（隔离世界），
 * 再由它转发给扩展后台去写书签。
 */
(function () {
  'use strict';

  if (window.__bcRecorderInstalled) return;
  window.__bcRecorderInstalled = true;

  var ADD_RE = /\/x\/v2\/reply\/add(\?|$)/;
  var DEL_RE = /\/x\/v2\/reply\/del(\?|$)/;
  var LINK_RE = /https?:\/\/[\w.-]*bilibili\.com\/[^\s"'<>]*comment_root_id=\d+/;

  function post(payload) {
    try {
      window.postMessage({ __bcRecorder: true, payload: payload }, '*');
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------- 参数解析 */

  function parseBody(body) {
    var out = {};
    try {
      if (!body) return out;

      if (typeof body === 'string') {
        var s = body.trim();
        if (s.charAt(0) === '{') {
          var j = JSON.parse(s);
          for (var k in j) if (Object.prototype.hasOwnProperty.call(j, k)) out[k] = String(j[k]);
          return out;
        }
        new URLSearchParams(s).forEach(function (v, key) { out[key] = v; });
        return out;
      }

      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        body.forEach(function (v, key) { out[key] = v; });
        return out;
      }

      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        body.forEach(function (v, key) { if (typeof v === 'string') out[key] = v; });
        return out;
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  function parseQuery(url) {
    var out = {};
    try {
      var i = String(url).indexOf('?');
      if (i < 0) return out;
      new URLSearchParams(String(url).slice(i + 1)).forEach(function (v, k) { out[k] = v; });
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /* ------------------------------------------------------ 组装评论链接 */

  function buildCommentUrl(info) {
    var base = location.origin + location.pathname.replace(/\/+$/, '');
    var u = new URL(base);
    u.searchParams.set('comment_on', '1');
    u.searchParams.set('comment_root_id', info.isSecondary ? info.root : info.rpid);
    if (info.isSecondary) u.searchParams.set('comment_secondary_id', info.rpid);
    // 多 P 视频的链接要带上分 P，否则会落到 P1
    try {
      var p = new URLSearchParams(location.search).get('p');
      if (p && p !== '1') u.searchParams.set('p', p);
    } catch (e) { /* 忽略 */ }
    u.searchParams.set('share_tag', 's_i');
    u.hash = 'reply' + info.rpid;
    return u.toString();
  }

  /** 解析响应 JSON；code 不在白名单里就返回 null */
  function readJson(resText, okCodes) {
    var json;
    try { json = JSON.parse(resText); } catch (e) { return null; }
    if (!json || okCodes.indexOf(json.code) < 0) return null;
    return json;
  }

  /** 把「URL 查询串 + 请求体」合成一个取值函数 */
  function picker(url, body) {
    var req = parseBody(body);
    var qry = parseQuery(url);
    return function (name) {
      if (req[name] !== undefined && req[name] !== '') return String(req[name]);
      if (qry[name] !== undefined && qry[name] !== '') return String(qry[name]);
      return '';
    };
  }

  /**
   * 处理 /x/v2/reply/add 的响应
   * 响应结构（文档）：
   *   data.rpid / rpid_str       本条评论 id
   *   data.root  / root_str      根评论 id（一级评论为 0）
   *   data.parent/ parent_str    被回复的评论 id
   *   data.reply                 完整评论对象（含 oid / type / ctime / content.message）
   */
  function handleAdd(url, body, resText) {
    var json = readJson(resText, [0]);
    if (!json || !json.data) return;

    var d = json.data;
    var reply = d.reply || {};
    var param = picker(url, body);

    var rpid = String(d.rpid_str || d.rpid || reply.rpid_str || reply.rpid || '');
    if (!rpid || rpid === '0') return;

    var rootRaw = param('root') || d.root_str || d.root || '0';
    var root = String(rootRaw || '0');
    var isSecondary = root !== '0' && root !== '';

    var payload = {
      source: 'network',
      url: buildCommentUrl({ rpid: rpid, root: root, isSecondary: isSecondary }),
      rpid: rpid,
      root: isSecondary ? root : '0',
      parent: String(param('parent') || d.parent_str || d.parent || '0'),
      type: reply.type != null ? reply.type : (param('type') || null),
      oid: reply.oid != null ? String(reply.oid) : (param('oid') || null),
      message: (reply.content && reply.content.message) || param('message') || '',
      ctime: Number(reply.ctime) || Math.floor(Date.now() / 1000),
      pageUrl: location.origin + location.pathname.replace(/\/+$/, ''),
      isSecondary: isSecondary
    };
    post(payload);
  }

  /**
   * 处理 /x/v2/reply/del 的响应
   * 你在 B 站网页上自己点了「删除」时，扩展也得知道，
   * 这样才能把对应书签同步归档到「已删除」目录，避免留下漏网之鱼。
   */
  function handleDel(url, body, resText) {
    // 0 = 删除成功；12022 = 这条本来就已经被删掉了
    if (!readJson(resText, [0, 12022])) return;

    var param = picker(url, body);
    var rpid = param('rpid');
    if (!/^\d+$/.test(rpid)) return;

    try {
      window.postMessage({
        __bcRecorder: true,
        payload: {
          kind: 'deleted',
          source: 'manual-delete',
          rpid: rpid,
          type: param('type') || null,
          oid: param('oid') || null,
          pageUrl: location.origin + location.pathname.replace(/\/+$/, '')
        }
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 挂钩 fetch */
  var origFetch = window.fetch;

  // 把「页面自己的脚本还没跑、我们也没包过」的原生 fetch 抢存一份。
  //
  // 为什么必须抢：B 站自己的 API 层会包装 window.fetch，我们下面也会再包一层。
  // 从主世界发出去的请求因此会依次穿过这些包装，行为变得不可预期 ——
  // 存活探测「一条都问不出来」就是这么来的。扩展自己发的请求改用这份原生版本，
  // 路径就短到底了。（内容脚本在 document_start 跑，此时 B 站的脚本还没执行。）
  try {
    if (typeof origFetch === 'function') window.__bcNativeFetch = origFetch.bind(window);
  } catch (e) { /* 忽略 */ }

  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (e) { /* 忽略 */ }

      // 用 window 当 this：页面如果是 bare fetch() 调用，严格模式下 this 是 undefined
      var p = origFetch.apply(window, arguments);

      try {
        var isAdd = method === 'POST' && ADD_RE.test(url);
        var isDel = method === 'POST' && DEL_RE.test(url);
        if (isAdd || isDel) {
          var body = init && init.body;
          p.then(function (res) {
            try {
              res.clone().text().then(function (text) {
                try {
                  if (isAdd) handleAdd(url, body, text);
                  else handleDel(url, body, text);
                } catch (e) { /* 忽略 */ }
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
      try {
        this.__bcMethod = String(method || '').toUpperCase();
        this.__bcUrl = url;
      } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        var method = String(this.__bcMethod || '');
        var reqUrl = String(this.__bcUrl || '');
        var isAdd = method === 'POST' && ADD_RE.test(reqUrl);
        var isDel = method === 'POST' && DEL_RE.test(reqUrl);

        if (isAdd || isDel) {
          this.addEventListener('load', function () {
            var text = '';
            try {
              text = this.responseText;
            } catch (e) {
              try { text = JSON.stringify(this.response); } catch (e2) { text = ''; }
            }
            if (!text) return;
            try {
              if (isAdd) handleAdd(reqUrl, body, text);
              else handleDel(reqUrl, body, text);
            } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* 忽略 */ }

  /* -------------------------------------------- 兜底：监听「复制评论链接」 */

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      var origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (text) {
        try {
          var s = String(text || '');
          var m = LINK_RE.exec(s);
          if (m) {
            var found = m[0];
            try {
              var u = new URL(found);
              var rootId = u.searchParams.get('comment_root_id') || '';
              var secId = u.searchParams.get('comment_secondary_id') || '';
              var hashM = /#reply(\d+)/.exec(u.hash || '');
              var rpid = secId || (hashM ? hashM[1] : '') || rootId;
              if (rpid) {
                post({
                  source: 'clipboard',
                  url: found,
                  rpid: rpid,
                  root: secId ? rootId : '0',
                  parent: '0',
                  type: null,
                  oid: null,
                  message: '',
                  ctime: Math.floor(Date.now() / 1000),
                  pageUrl: location.origin + location.pathname.replace(/\/+$/, ''),
                  isSecondary: !!secId
                });
              }
            } catch (e) { /* 忽略 */ }
          }
        } catch (e) { /* 忽略 */ }
        return origWrite(text);
      };
    }
  } catch (e) { /* 忽略 */ }
})();
