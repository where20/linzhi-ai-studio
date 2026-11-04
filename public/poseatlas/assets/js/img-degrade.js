/* ===== 图鉴图片库降级（云端未部署大图库时的兜底）=====
   背景：8461 张图鉴图共 271MB，超出云端部署体积红线，图片不入包上云。
   于是云端打开图鉴页会出现一堆碎图。本脚本做两件事：
     1) 监听图片加载失败 → 换成占位图（不再显示碎图标）；
     2) 失败数量超过阈值 → 顶部弹一条说明，告诉用户图库未部署、如何补齐。
   本地（图片齐全）时不会有任何失败 → 脚本静默，不打扰。 */
(function () {
  'use strict';

  var IMG_RE = /(thumbs|img|costume)\/.*\.(jpg|jpeg|png|webp|gif)$/i;
  var THRESHOLD = 3;          // 失败超过这个数才认为是「图库整体缺失」
  var failed = 0;
  var bannerShown = false;

  var PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">' +
    '<rect width="400" height="560" fill="#1b1d23"/>' +
    '<g fill="none" stroke="#4a4f5c" stroke-width="6" stroke-linecap="round">' +
    '<rect x="120" y="180" width="160" height="150" rx="10"/>' +
    '<circle cx="168" cy="235" r="16"/><path d="M140 310l52-58 40 40 28-26 44 44"/>' +
    '</g><text x="200" y="380" fill="#8a91a3" font-size="20" text-anchor="middle" ' +
    'font-family="sans-serif">图库未部署</text></svg>'
  );

  function isGalleryImg(el) {
    if (!el || el.tagName !== 'IMG') return false;
    var s = el.getAttribute('src') || el.getAttribute('data-src') || '';
    return IMG_RE.test(s);
  }

  function markMissing(el) {
    if (el.getAttribute('data-pa-missing') === '1') return;
    el.setAttribute('data-pa-missing', '1');
    el.removeAttribute('srcset');
    el.src = PLACEHOLDER;
    el.style.background = '#1b1d23';
    el.style.objectFit = 'contain';
    el.title = '图鉴图片库未部署到云端';
  }

  function showBanner() {
    if (bannerShown) return;
    bannerShown = true;
    var bar = document.createElement('div');
    bar.setAttribute('data-pa-banner', '1');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
      'z-index:99999', 'max-width:min(560px,92vw)', 'padding:10px 14px',
      'border-radius:10px', 'font-size:13px', 'line-height:1.7',
      'background:#2a2118', 'color:#f3d9a8',
      'border:1px solid #6b5330', 'box-shadow:0 8px 28px rgba(0,0,0,.45)',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif'
    ].join(';');
    var txt = document.createElement('span');
    txt.textContent = '云端未部署图鉴图片库（图集共 271MB，超出部署体积限制），当前为占位图。'
                    + '本地运行 tools/fetch_poseatlas_images.py 抓齐后即可完整显示。';
    var btn = document.createElement('button');
    btn.textContent = '知道了';
    btn.style.cssText = 'margin-left:10px;padding:3px 10px;border-radius:6px;'
                       + 'border:1px solid #6b5330;background:#3a2c1c;color:#f3d9a8;cursor:pointer;font-size:12px';
    btn.onclick = function () { if (bar.parentNode) bar.parentNode.removeChild(bar); };
    bar.appendChild(txt);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  /* 用捕获阶段监听 error：图片资源错误不冒泡，但捕获阶段仍能在 window 上收到 */
  window.addEventListener('error', function (e) {
    var el = e.target;
    if (!isGalleryImg(el)) return;
    failed += 1;
    markMissing(el);
    if (failed >= THRESHOLD) showBanner();
  }, true);

  /* DOM 里已有的 <img> 也补一次：若已加载失败，src 为空 */
  function sweep(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.querySelectorAll('img');
    for (var i = 0; i < list.length; i++) {
      var im = list[i];
      if (im.getAttribute('data-pa-missing') === '1') continue;
      if (im.complete && im.naturalWidth === 0 && isGalleryImg(im)) {
        failed += 1;
        markMissing(im);
        if (failed >= THRESHOLD) showBanner();
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { sweep(document); });
  } else {
    sweep(document);
  }
})();
