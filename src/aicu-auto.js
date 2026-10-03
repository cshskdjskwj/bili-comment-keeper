/**
 * aicu-auto.js —— 运行在 aicu.cc 的网页「主世界」(MAIN world)
 *
 * 两件事：
 *   1) **自动翻页**：手动一页页翻太累（几千条就是上百页），这里替你去点页面上那个
 *      「下一页」按钮，然后等新数据出来再点下一张。走的是 aicu 自己的完整流程
 *      （含排队与验证），请求量和你手动翻页一模一样，扩展不额外发一个请求。
 *   2) **第二条采集路**：直接从**已经渲染出来的 DOM** 里把评论抠出来。
 *
 * 为什么要有第二条路：主通道（aicu-main.js 挂钩页面自己的 fetch/XHR）有失灵的可能 ——
 * 页面换了请求方式、请求走了 worker、或者标签页是装/更新扩展之前开的导致钩子压根没装上。
 * 这时候页面上**评论明明已经显示出来了**，导入却是 0 条，而且没有任何报错。
 * 渲染结果就在 DOM 里，最不容易骗人，所以拿它兜底。
 *
 * 控制协议（由 content.js 在隔离世界转发）：
 *   收：window.postMessage({ __bcAicuCmd: { action: 'autopage-start' | 'autopage-stop', ... } })
 *   发：window.postMessage({ __bcAicuAuto: { kind: 'progress' | 'done', ... } })   进度
 *       window.postMessage({ __bcAicuDom: { items: [...] } })                     从 DOM 抠到的评论
 */
(function () {
  'use strict';

  if (window.__bcAicuAutoInstalled) return;
  window.__bcAicuAutoInstalled = true;

  var running = false;
  var stopped = false;
  var captureSeq = 0;   // 每收到一份 aicu-main 抓回来的数据就 +1

  function report(obj) {
    try { window.postMessage({ __bcAicuAuto: obj }, '*'); } catch (e) { /* 忽略 */ }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function uidFromUrl() {
    try { return new URLSearchParams(location.search).get('uid') || ''; } catch (e) { return ''; }
  }

  /* 数 aicu-main.js 抓回来的数据，用来判断「点了下一页之后新数据到了没」。
     注意只认 __bcAicu（网络钩子那条路），不认我们自己发的 __bcAicuDom，
     否则会把自己的兜底输出当成"页面来了新数据"。 */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (d && d.__bcAicu) captureSeq++;
  }, false);

  /** 等下一份数据；超时或收到停止指令就返回 false */
  async function waitCapture(timeoutMs) {
    var start = captureSeq;
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stopped) return false;
      if (captureSeq > start) return true;
      await sleep(200);
    }
    return false;
  }

  /**
   * 等「至少见过一份数据」。
   * 不能复用 waitCapture：用户点开始时，页面通常**早就把第一页加载好了**，
   * 那时候还傻等「下一份新数据」就会白等到超时、再误报"没等到数据"。
   */
  async function waitFirst(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stopped) return false;
      if (captureSeq > 0) return true;
      await sleep(200);
    }
    return false;
  }

  /* ------------------------------------------------ 第二条路：直接读页面 */

  /**
   * 从渲染出来的列表里抠评论。
   *
   * aicu 每条评论都带两个链接（页面上显示成「方式0」「方式2」）：
   *   方式0  .../video/av{oid}#reply{rpid}  或  t.bilibili.com/{oid}?type={n}#reply{rpid}
   *   方式2  .../h5/comment/sub?oid={oid}&pageType={type}&root={root}
   * 后者把 oid 和 type 直接写在参数里，前者带着 rpid —— 合起来正好是 B 站删除接口
   * 要的三个参数。
   */
  function scrapeRendered() {
    var out = [];
    var seen = {};
    var subs;
    try {
      subs = document.querySelectorAll('a[href*="h5/comment/sub"]');
    } catch (e) { return out; }

    for (var i = 0; i < subs.length; i++) {
      var href = '';
      try { href = subs[i].getAttribute('href') || ''; } catch (e) { continue; }

      var u;
      try { u = new URL(href, location.href); } catch (e) { continue; }

      var oid = u.searchParams.get('oid') || '';
      var pageType = Number(u.searchParams.get('pageType'));
      var root = u.searchParams.get('root') || '0';
      if (!/^\d+$/.test(oid) || !isFinite(pageType)) continue;

      // 在同一个卡片里往上找几层，拿带 #reply 的那个链接里的 rpid
      var rpid = '';
      var scope = subs[i].parentElement;
      for (var hop = 0; hop < 4 && scope && !rpid; hop++) {
        var hit = null;
        try { hit = scope.querySelector ? scope.querySelector('a[href*="#reply"]') : null; } catch (e) { hit = null; }
        if (hit) {
          var m = /#reply(\d+)/.exec(hit.getAttribute('href') || '');
          if (m) rpid = m[1];
        }
        scope = scope.parentElement;
      }
      if (!rpid || seen[rpid]) continue;
      seen[rpid] = 1;

      out.push({
        rpid: rpid,
        type: pageType,
        oid: oid,
        root: /^\d+$/.test(root) ? root : '0',
        // 方式2 的 root：一级评论就是它自己，楼中楼才是根评论 id
        rank: (root && root !== rpid) ? 2 : 1,
        message: '',
        ctime: 0
      });
    }
    return out;
  }

  /** 把从 DOM 抠到的评论发出去（走和网络钩子不同的消息名，别互相干扰计数） */
  function postDom(items) {
    if (!items || !items.length) return;
    try {
      window.postMessage({
        __bcAicuDom: true,
        payload: {
          source: 'aicu-dom',
          uid: uidFromUrl(),
          items: items,
          pageUrl: location.href
        }
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 抠一次并上报。返回**这次新出现的**条数。
   *
   * 注意别用「本页条数有没有变多」来判断翻页有没有生效 —— 每页条数通常一样
   * （都是 20 条），那样会误判成"没变化"然后提前收工。得看 rpid 集合里有没有新面孔。
   */
  var seenRpids = {};

  function harvestNew() {
    var items = scrapeRendered();
    var fresh = 0;
    for (var i = 0; i < items.length; i++) {
      if (!seenRpids[items[i].rpid]) { seenRpids[items[i].rpid] = 1; fresh++; }
    }
    // 全量发出去（后台按 rpid 去重），但「有没有新东西」按 fresh 算
    if (items.length) postDom(items);
    return fresh;
  }

  /* ------------------------------------------------------------ 翻页 */

  /** 找 MUI 分页组件的「下一页」按钮，优先取可见的那个 */
  function findNext() {
    var sel = 'button[aria-label="Go to next page"], button[aria-label="下一页"],' +
              'button[aria-label="Next page"], .MuiPaginationItem-next';
    var all;
    try { all = document.querySelectorAll(sel); } catch (e) { return null; }
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null) return all[i];   // 可见的优先
    }
    return all.length ? all[0] : null;
  }

  function isDisabled(el) {
    return !!(el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      (el.classList && el.classList.contains('Mui-disabled')));
  }

  async function run(opts) {
    var maxPages = Math.max(1, Math.min(2000, Number(opts && opts.maxPages) || 300));
    var gapMs = Math.max(300, Number(opts && opts.gapMs) || 1200);
    var firstWaitMs = Math.max(1500, Number(opts && opts.firstWaitMs) || 30000);
    var waitMs = Math.max(1500, Number(opts && opts.waitMs) || 25000);
    var pages = 0;

    report({ kind: 'progress', pages: pages, note: '正在看当前页…' });

    // 先看看当前页有没有东西。有就直接收，不用等网络钩子。
    var fromDom = harvestNew();
    if (fromDom) {
      report({ kind: 'progress', pages: pages, note: '当前页读到 ' + fromDom + ' 条，准备翻页' });
    } else if (!(await waitFirst(firstWaitMs))) {
      // 网络钩子和 DOM 都没东西 —— 再试一次 DOM，然后如实收场
      if (!harvestNew()) {
        report({
          kind: 'done', pages: pages,
          reason: '等了 ' + Math.round(firstWaitMs / 1000) + ' 秒也没读到评论。' +
            '页面可能还卡在排队、列表是空的，或者这个页面结构变了。'
        });
        return;
      }
    }

    while (!stopped && pages < maxPages) {
      var btn = findNext();
      if (!btn) {
        harvestNew();
        report({ kind: 'done', pages: pages, reason: '找不到「下一页」按钮 —— 可能已经翻到最后，或者 aicu 改了页面结构。' });
        return;
      }
      if (isDisabled(btn)) {
        harvestNew();
        report({ kind: 'done', pages: pages, reason: '已经翻到最后一页。' });
        return;
      }

      try {
        btn.click();
      } catch (e) {
        harvestNew();
        report({ kind: 'done', pages: pages, reason: '点击「下一页」失败：' + ((e && e.message) || e) });
        return;
      }
      pages++;

      // 等一下新数据。网络钩子没动静也不要紧 —— 页面里有了新评论就行。
      var got = await waitCapture(waitMs);
      var fresh = harvestNew();

      if (!got && fresh === 0) {
        report({
          kind: 'done', pages: pages,
          reason: '点了下一页，但 ' + Math.round(waitMs / 1000) + ' 秒内既没有新请求、页面里也没有出现新的评论。' +
            '多半卡在排队，或者已经到最后一页了。'
        });
        return;
      }

      report({ kind: 'progress', pages: pages, note: '已翻 ' + pages + ' 页，本页新增 ' + fresh + ' 条' });
      await sleep(gapMs);
    }

    harvestNew();
    report({
      kind: 'done',
      pages: pages,
      reason: stopped ? '已按你的要求停止。' : ('达到设定的页数上限（' + maxPages + ' 页）。')
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    var cmd = d && d.__bcAicuCmd;
    if (!cmd) return;

    if (cmd.action === 'autopage-start') {
      if (running) { report({ kind: 'progress', pages: 0, note: '已经在抓了，别急' }); return; }
      running = true;
      stopped = false;
      run(cmd)
        .catch(function (e) {
          report({ kind: 'done', pages: 0, reason: '抓取出错：' + ((e && e.message) || e) });
        })
        .then(function () { running = false; });
      return;
    }

    if (cmd.action === 'autopage-stop') {
      if (!running) { report({ kind: 'done', pages: 0, reason: '本来就没在抓。' }); return; }
      stopped = true;
      report({ kind: 'progress', pages: 0, note: '收到停止指令，当前这一页处理完就停…' });
      return;
    }

    // 只抓当前页、不翻页（面板上「读当前页」用）
    if (cmd.action === 'harvest-once') {
      var n = harvestNew();
      report({ kind: 'progress', pages: 0, note: n ? ('从当前页读到 ' + n + ' 条') : '当前页没读到评论' });
      return;
    }

    if (cmd.action === 'autopage-ping') {
      report({ kind: 'pong', running: running, pages: captureSeq });
    }
  }, false);
})();
