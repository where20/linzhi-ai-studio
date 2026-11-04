/* ============================================================
   临智AI · 分类导航条「锁死 + 与顶层对齐」
   ------------------------------------------------------------
   作用：
     1) 测量顶栏实际高度，写进 CSS 变量 --topbar-h
        —— 顶栏在桌面是单行、手机是两行（品牌行 + 七项网格），
           高度随内容变，写死数值会错位，所以必须实测。
     2) 分类导航条（.toolbar）吸附在顶栏正下方，滚动时不再被顶栏盖住。
     3) 顶栏与分类条共用同一水平内边距（--nav-pad），左右边缘完全对齐。

   加载：所有页面（跟 topbar-breath.js 一起挂在 </body> 前）
   ============================================================ */
(function () {
  var root = document.documentElement;
  var top = null;

  function measure() {
    if (!top) top = document.querySelector('.topbar');
    if (!top) return;
    var h = Math.round(top.getBoundingClientRect().height);
    root.style.setProperty('--topbar-h', h + 'px');
  }

  function boot() {
    measure();
    if (!top) return;
    if (window.ResizeObserver) {
      new ResizeObserver(measure).observe(top);
    }
    window.addEventListener('resize', measure, { passive: true });
    window.addEventListener('orientationchange', measure);
    /* 字体/图片加载完高度会变，再校一次 */
    window.addEventListener('load', measure);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure).catch(function () {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
