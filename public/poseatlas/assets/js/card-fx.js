/* ============================================================
   临智AI · 首页功能卡片「动态背景」引擎
   ------------------------------------------------------------
   给 .feature[data-fx] 卡片内部注入一层 canvas 粒子背景：
     data-fx="converge"  星尘向中心呼吸汇聚  （我要试装：人像+形体+服装=新图）
     data-fx="orbit"     星尘缓慢漂浮        （收集时装：衣物环绕入橱）
     data-fx="network"   节点连线推演网络    （推演穿搭）
   设计约束：
     · 粒子在矩形内均匀撒点 + 自由漂浮 + 边界反弹 → 真正铺满整卡
     · 纯灰白冷调，与灰底浮雕玻璃风一致，绝不抢文字
     · 卡片不可见 / 页面切到后台时自动停止绘制，省电省 CPU
     · 尊重 prefers-reduced-motion，只渲染一帧静态图
     · 手机端自动减少粒子数量
   ============================================================ */
(function () {
  'use strict';

  var cards = Array.prototype.slice.call(
    document.querySelectorAll('.feature[data-fx]')
  );
  if (!cards.length) return;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var TAU = Math.PI * 2;
  var instances = [];

  /* ---------- 单个卡片的粒子系统 ---------- */
  function createFx(card) {
    var mode = card.getAttribute('data-fx') || 'orbit';

    var canvas = document.createElement('canvas');
    canvas.className = 'feature__fx';
    canvas.setAttribute('aria-hidden', 'true');

    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) {}
    if (!ctx) return; // 无 canvas 支持时静默降级为纯 CSS 背景

    card.insertBefore(canvas, card.firstChild);

    var W = 0, H = 0, DPR = 1;
    var parts = [];
    var rafId = 0;
    var inView = true;
    var lastTs = 0;
    var clock = 0;
    var running = false;

    /* 粒子数量：按卡片面积自适应 */
    function particleCount(area) {
      var n = Math.round(area / (mode === 'network' ? 1700 : 700));
      var max = mode === 'network' ? 48 : 140;
      var min = mode === 'network' ? 22 : 36;
      return Math.max(min, Math.min(max, n));
    }

    function build() {
      parts = [];
      var n = particleCount(W * H);
      var speed = mode === 'network' ? 0.34 : 0.22;
      var i, p;
      for (i = 0; i < n; i++) {
        p = {
          /* 初始在矩形内均匀撒点 */
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * speed,
          vy: (Math.random() - 0.5) * speed,
          r: 0.90 + Math.random() * 2.2,
          a: 0.28 + Math.random() * 0.50,
          ph: Math.random() * TAU
        };
        parts.push(p);
      }
    }

    function resize() {
      var rect = card.getBoundingClientRect();
      var w = Math.max(1, Math.round(rect.width));
      var h = Math.max(1, Math.round(rect.height));
      if (w === W && h === H) return;

      W = w;
      H = h;
      DPR = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      build();
      if (reduceMotion) draw(0);
    }

    /* 单颗粒子：外层柔光 + 内核亮点 */
    function drawDot(x, y, r, alpha) {
      ctx.fillStyle = 'rgba(224, 235, 249, ' + (alpha * 0.22).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r * 2.9, 0, TAU);
      ctx.fill();

      ctx.fillStyle = 'rgba(241, 247, 254, ' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }

    /* ---------- 绘制 ---------- */
    function draw(dt) {
      ctx.clearRect(0, 0, W, H);
      clock += dt;

      var cx = W / 2;
      var cy = H / 2;
      var i, j, p, q, x, y, alpha, dx, dy, d2, o;

      /* 统一的位置更新：自由漂浮 + 边界反弹（保证整卡覆盖不塌缩） */
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx); }
        else if (p.x > W) { p.x = W; p.vx = -Math.abs(p.vx); }
        if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy); }
        else if (p.y > H) { p.y = H; p.vy = -Math.abs(p.vy); }
      }

      /* ===== 推演卡：节点 + 近邻连线 ===== */
      if (mode === 'network') {
        var LINK = Math.min(118, (W + H) * 0.34);
        var LINK2 = LINK * LINK;

        ctx.lineWidth = 0.7;
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          for (j = i + 1; j < parts.length; j++) {
            q = parts[j];
            dx = p.x - q.x;
            dy = p.y - q.y;
            d2 = dx * dx + dy * dy;
            if (d2 < LINK2) {
              o = (1 - d2 / LINK2) * 0.17;
              ctx.strokeStyle = 'rgba(206, 218, 232, ' + o.toFixed(3) + ')';
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(q.x, q.y);
              ctx.stroke();
            }
          }
        }

        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          drawDot(p.x, p.y, p.r, p.a);
        }

        /* 中心柔光 */
        var gn = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.6);
        gn.addColorStop(0, 'rgba(216, 228, 243, 0.035)');
        gn.addColorStop(1, 'rgba(216, 228, 243, 0)');
        ctx.fillStyle = gn;
        ctx.fillRect(0, 0, W, H);
        return;
      }

      var base = Math.min(W, H);

      /* ===== 试装卡：三束流光汇入中心 ===== */
      if (mode === 'converge') {
        var beams = [
          [W * 0.04, H * 0.04, W * 0.30, H * 0.20, W * 0.40, H * 0.56, cx, cy],
          [W * 0.96, H * 0.04, W * 0.70, H * 0.20, W * 0.60, H * 0.56, cx, cy],
          [W * 0.50, H * 1.04, W * 0.50, H * 0.86, W * 0.50, H * 0.62, cx, cy]
        ];
        var bi, bm, t, mt, px2, py2, k2, fade2;

        ctx.lineWidth = 1.2;
        for (bi = 0; bi < beams.length; bi++) {
          bm = beams[bi];
          ctx.strokeStyle = 'rgba(224, 234, 248, 0.09)';
          ctx.beginPath();
          ctx.moveTo(bm[0], bm[1]);
          ctx.bezierCurveTo(bm[2], bm[3], bm[4], bm[5], bm[6], bm[7]);
          ctx.stroke();

          for (k2 = 0; k2 < 2; k2++) {
            t = (clock * 0.00055 + bi * 0.21 + k2 * 0.5) % 1;
            mt = 1 - t;
            px2 = mt * mt * mt * bm[0] + 3 * mt * mt * t * bm[2] + 3 * mt * t * t * bm[4] + t * t * t * bm[6];
            py2 = mt * mt * mt * bm[1] + 3 * mt * mt * t * bm[3] + 3 * mt * t * t * bm[5] + t * t * t * bm[7];
            fade2 = Math.sin(t * Math.PI);
            ctx.fillStyle = 'rgba(238, 245, 253, ' + (0.5 * fade2).toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(px2, py2, 1.7, 0, TAU);
            ctx.fill();
          }
        }
      }

      /* ===== 粒子主体 ===== */
      for (i = 0; i < parts.length; i++) {
        p = parts[i];

        if (mode === 'converge') {
          /* 呼吸缩放：整体向中心收拢再散开（缩放≤1，不会把粒子甩出卡片） */
          var breathe = 0.80 + 0.20 * Math.sin(clock * 0.0055 + p.ph);
          x = cx + (p.x - cx) * breathe;
          y = cy + (p.y - cy) * breathe;

          /* 越靠近中心越亮 */
          var distN = Math.sqrt(
            Math.pow((p.x - cx) / (cx || 1), 2) +
            Math.pow((p.y - cy) / (cy || 1), 2)
          );
          if (distN > 1) distN = 1;
          alpha = p.a * (0.34 + 0.66 * (1 - distN));
          drawDot(x, y, p.r * (0.85 + 0.4 * (1 - distN)), alpha);
        } else {
          /* orbit：原地缓慢漂浮，带一点呼吸明暗 */
          var tw = 0.72 + 0.28 * Math.sin(clock * 0.004 + p.ph);
          drawDot(p.x, p.y, p.r, p.a * tw);
        }
      }

      /* 中心柔光 */
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * 0.62);
      g.addColorStop(0, 'rgba(214, 226, 242, 0.045)');
      g.addColorStop(0.55, 'rgba(210, 222, 238, 0.018)');
      g.addColorStop(1, 'rgba(210, 222, 238, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    /* ---------- 主循环 ---------- */
    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!inView || document.hidden) {
        lastTs = ts;
        return;
      }
      if (!lastTs) lastTs = ts;
      var delta = Math.min(64, ts - lastTs);
      lastTs = ts;
      draw(delta / 16.667);
    }

    function start() {
      if (running || reduceMotion) return;
      running = true;
      lastTs = 0;
      rafId = requestAnimationFrame(loop);
    }

    function stop() {
      if (!running) return;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    /* ---------- 尺寸监听 ---------- */
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { resize(); }).observe(card);
    } else {
      window.addEventListener('resize', resize);
    }

    /* ---------- 可见性监听 ---------- */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          inView = entry.isIntersecting;
        });
      }, { threshold: 0.02 }).observe(card);
    }

    /* ---------- 桌面端鼠标柔光 ---------- */
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      card.addEventListener('pointermove', function (e) {
        var rect = card.getBoundingClientRect();
        var mx = ((e.clientX - rect.left) / rect.width) * 100;
        var my = ((e.clientY - rect.top) / rect.height) * 100;
        card.style.setProperty('--mx', mx.toFixed(2) + '%');
        card.style.setProperty('--my', my.toFixed(2) + '%');
      });
      card.addEventListener('pointerleave', function () {
        card.style.setProperty('--mx', '50%');
        card.style.setProperty('--my', '50%');
      });
    }

    resize();
    if (reduceMotion) {
      draw(0);
    } else {
      start();
    }

    instances.push({ start: start, stop: stop });
  }

  cards.forEach(createFx);

  /* 页面隐藏时统一暂停，回来时恢复 */
  document.addEventListener('visibilitychange', function () {
    instances.forEach(function (fx) {
      if (document.hidden) fx.stop();
      else fx.start();
    });
  });
})();