/* ============================================================
   临智AI · 公众号二维码弹层
   用法：在任意页面 <body> 末尾引入本脚本即可。
   点击页面左上角「临智AI」Logo（brand 链接）→ 弹出公众号二维码；
   再次点击任意位置 / 右上角 ✕ / 按 Esc 关闭。
   提供 window.toggleQr() 供其它入口调用。
   ============================================================ */
(function () {
  var QR_IMG = 'assets/img/qrcode-gzh.jpg';

  function build() {
    if (document.getElementById('qrOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'qrOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="qr-overlay__mask"></div>' +
      '<div class="qr-overlay__card" role="dialog" aria-modal="true" aria-label="公众号二维码">' +
        '<button type="button" class="qr-overlay__close" id="qrCloseBtn" aria-label="关闭">✕</button>' +
        '<div class="qr-overlay__imgwrap">' +
          '<img src="' + QR_IMG + '" alt="公众号二维码" class="qr-overlay__img">' +
        '</div>' +
        '<div class="qr-overlay__title">👋 扫码关注公众号</div>' +
        '<div class="qr-overlay__sub">长按识别二维码 · 获取更多 AI 试装技巧与福利</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function () {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };
    var open = function () {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    };

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.classList.contains('qr-overlay__mask')) close();
    });
    var closeBtn = document.getElementById('qrCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    window.toggleQr = function () {
      if (overlay.classList.contains('open')) close();
      else open();
    };
    window.openQr = open;
    window.closeQr = close;

    /* 点 Logo 弹出（brand 链接）
       用户要求：点一下弹出公众号二维码，再点一下关掉。
       顶层 topbar 的 z-index 已提升到弹层之上，Logo 随时可再次点击关闭。 */
    var brand = document.querySelector('a.brand');
    if (brand) {
      brand.addEventListener('click', function (e) {
        e.preventDefault();
        if (overlay.classList.contains('open')) close();
        else open();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();