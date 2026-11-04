/* ===== 全站链接脱敏：链接不暴露地址 =====
   浏览器对 <a href> 会在左下角/悬浮时显示目标地址，本脚本在 DOM 就绪后
   把所有 a[href] 的地址搬到 data-href 上并移除 href，
   点击/回车时再由脚本跳转 —— 这样任何链接都不会把 URL 露出来。
   注意：a[download] 会改为「点击时动态造一个临时 a」来下载，功能不受影响。 */
(function () {
  'use strict';

  var SEL = 'a[href]';

  function neutralize(a) {
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.indexOf('javascript:') === 0) return;

    a.setAttribute('data-href', href);
    if (a.getAttribute('target') === '_blank') a.setAttribute('data-blank', '1');
    if (a.hasAttribute('download')) {
      a.setAttribute('data-download', a.getAttribute('download') || '1');
    }

    a.removeAttribute('href');
    a.removeAttribute('target');
    a.removeAttribute('ping');
    if (!a.hasAttribute('role')) a.setAttribute('role', 'link');
    if (!a.hasAttribute('tabindex')) a.setAttribute('tabindex', '0');
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) neutralize(list[i]);
  }

  /* 换页时把分享码等参数带过去：
     线上靠 ?sharecode=xxx 才能调 /api/*，一旦跳转丢了它，新页面所有接口 403。 */
  var KEEP = ['sharecode', 'token', 'key', 'auth'];

  function withQuery(href) {
    try {
      var u = new URL(href, window.location.href);
      if (u.origin !== window.location.origin) return href;
      var cur = new URLSearchParams(window.location.search);
      for (var i = 0; i < KEEP.length; i++) {
        var k = KEEP[i];
        var v = cur.get(k);
        if (v && !u.searchParams.get(k)) u.searchParams.set(k, v);
      }
      return u.pathname + (u.search || '') + (u.hash || '');
    } catch (e) {
      return href;
    }
  }

  function run(a) {
    var raw = a.getAttribute('data-href');
    if (!raw) return;
    var href = withQuery(raw);

    var dl = a.getAttribute('data-download');
    if (dl) {                    // 下载：临时造一个 a，用户看不到、也悬停不到
      var t = document.createElement('a');
      t.href = href;
      t.download = dl === '1' ? '' : dl;
      t.style.display = 'none';
      document.body.appendChild(t);
      t.click();
      document.body.removeChild(t);
      return;
    }
    if (a.getAttribute('data-blank') === '1') {
      window.open(href, '_blank', 'noopener');
      return;
    }
    window.location.href = href;
  }

  function closestLink(el) {
    while (el && el !== document) {
      if (el.nodeType === 1 && el.hasAttribute && el.hasAttribute('data-href')) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    var a = closestLink(e.target);
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    run(a);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var a = closestLink(e.target);
    if (!a) return;
    e.preventDefault();
    run(a);
  }, true);

  scan(document);

  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') {
          neutralize(m.target);
          continue;
        }
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(SEL)) neutralize(n);
          scan(n);
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
  }
})();
