/**
 * aicu-auto.js —— 运行在 aicu.cc 的网页「主世界」(MAIN world)
 *
 * 手动一页页翻太累：几千条评论就是上百页。这里代劳 ——
 * **就是替你去点页面上那个「下一页」按钮**，然后等 aicu-main.js 抓到新数据，再点下一张。
 *
 * 为什么是「点按钮」而不是自己发请求：aicu 的接口要排队凭据、站点还挂着 Cloudflare 挑战。
 * 点它自己的按钮，走的就是它自己那套完整流程 —— 请求量和你手动翻页一模一样，
 * 扩展不额外发一个请求，也不绕过任何东西。
 *
 * 控制协议（都由 content.js 在隔离世界转发）：
 *   收：window.postMessage({ __bcAicuCmd: { action: 'autopage-start' | 'autopage-stop', maxPages, gapMs } })
 *   发：window.postMessage({ __bcAicuAuto: { kind: 'progress' | 'done', pages, note, reason } })
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

  /* 数 aicu-main.js 抓回来的数据，用来判断「点了下一页之后新数据到了没」 */
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
   * 注意不能复用 waitCapture：用户点开始时，页面通常**早就把第一页加载好了**，
   * 那时候如果还傻等「下一份新数据」，就会白等到超时、然后误报「没等到数据」。
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
    // 两个等待上限都可调：首屏要等排队，之后的每一页只要等它取数
    var firstWaitMs = Math.max(1500, Number(opts && opts.firstWaitMs) || 30000);
    var waitMs = Math.max(1500, Number(opts && opts.waitMs) || 25000);
    var pages = 0;

    report({ kind: 'progress', pages: pages, note: '正在等页面把当前页加载出来…' });

    // 页面通常已经加载好第一页了；没有的话（还在排队）就等一等
    if (!(await waitFirst(firstWaitMs))) {
      report({
        kind: 'done', pages: pages,
        reason: '等了 ' + Math.round(firstWaitMs / 1000) + ' 秒也没等到数据。页面可能还卡在排队，或者列表本身就是空的。'
      });
      return;
    }

    while (!stopped && pages < maxPages) {
      var btn = findNext();
      if (!btn) {
        report({ kind: 'done', pages: pages, reason: '找不到「下一页」按钮 —— 可能已经翻到最后，或者 aicu 改了页面结构。' });
        return;
      }
      if (isDisabled(btn)) {
        report({ kind: 'done', pages: pages, reason: '已经翻到最后一页。' });
        return;
      }

      try {
        btn.click();
      } catch (e) {
        report({ kind: 'done', pages: pages, reason: '点击「下一页」失败：' + ((e && e.message) || e) });
        return;
      }
      pages++;

      if (!(await waitCapture(waitMs))) {
        report({
          kind: 'done', pages: pages,
          reason: '点了下一页，但 ' + Math.round(waitMs / 1000) + ' 秒都没等到新数据（多半卡在排队），先停下。'
        });
        return;
      }

      report({ kind: 'progress', pages: pages, note: '已翻 ' + pages + ' 页' });
      await sleep(gapMs);
    }

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

    if (cmd.action === 'autopage-ping') {
      report({ kind: 'pong', running: running, pages: captureSeq });
    }
  }, false);
})();
