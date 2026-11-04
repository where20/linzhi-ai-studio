/* ============================================================
   临智AI · 顶层导航条「彩色方格」动态背景
   ------------------------------------------------------------
   平时：彩格缓慢流转、低饱和微光（有生命感但不抢戏）
   生成中：格子随节奏「跳动」（波浪式跳起 + 颜色变亮变艳），
           并按真实进度点亮已完成的区域（进度扫到哪里，哪里亮）
   结束后：平滑回落到待机微光

   用法（任何页面都可以调用，因为顶栏是全站共用的）：
     window.TopbarBreath.start()        // 开始生成（引用计数）
     window.TopbarBreath.stop()         // 生成结束
     window.TopbarBreath.setBusy(bool)  // 幂等开关（轮询场景）
     window.TopbarBreath.setProgress(p) // 0~1，真实进度；不传/超界=未知

   设计：
     · 纯 canvas 绘制，不新增 DOM 结构，不干扰导航点击
     · 方格 12px、2px 间隙；色相取自一组柔和彩板，逐格随机
     · 跳动 = 每格按波浪相位垂直起跳 + 亮度饱和度抬升
     · 尊重 prefers-reduced-motion：不跑动画，只画静态彩格
   ============================================================ */
(function () {
  'use strict';

  var topbar = document.querySelector('.topbar');
  if (!topbar) return;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var canvas = document.createElement('canvas');
  canvas.className = 'topbar__breath';
  canvas.setAttribute('aria-hidden', 'true');

  var ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (e) {}
  if (!ctx) return; // 不支持 canvas 时静默跳过，顶栏保持原样

  topbar.insertBefore(canvas, topbar.firstChild);

  var W = 0, H = 0, DPR = 1;
  var raf = 0;
  var lastTs = 0;

  /* 呼吸/跳动状态 */
  var amp = 0.16;        // 0.16 待机微光 → 1 全力跳动
  var active = false;
  var activeSince = 0;   // 已生成多久（毫秒），用于「越等越起劲」
  var count = 0;         // 进行中的任务数（引用计数）
  var progress = -1;     // 0~1 真实进度；-1 = 未知（只按时间起劲）

  var IDLE_AMP = 0.16;
  var DEEP_AMP = 1;

  /* ---- 方格矩阵 ---- */
  var CELL = 12;   // 单格边长（css px）
  var GAP = 2;     // 格间缝隙
  /* 柔和彩板：红/橙/黄/绿/青/蓝/紫/品红，跳起来才「彩色」而不刺眼 */
  var HUES = [4, 24, 46, 96, 150, 182, 212, 256, 292, 322];

  var cols = 0, rows = 0, n = 0;
  var cHue, cPhase, cSpeed, cCol, cRow;

  function buildGrid() {
    cols = Math.max(1, Math.ceil(W / CELL));
    rows = Math.max(1, Math.ceil(H / CELL));
    n = cols * rows;
    cHue = new Float32Array(n);
    cPhase = new Float32Array(n);
    cSpeed = new Float32Array(n);
    cCol = new Int16Array(n);
    cRow = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      cHue[i] = HUES[(Math.random() * HUES.length) | 0];
      cPhase[i] = Math.random();
      cSpeed[i] = 0.65 + Math.random() * 0.7;   // 每格快慢略不同，避免整齐划一的机械感
      cCol[i] = i % cols;
      cRow[i] = (i / cols) | 0;
    }
  }

  function resize() {
    var r = topbar.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    if (w === W && h === H) return;

    W = w;
    H = h;
    DPR = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildGrid();
    if (reduceMotion) draw(16);
  }

  /* 全站节拍：待机慢（约 5.5s 一轮），越忙越快（最快约 1.4s 一轮） */
  var beat = 0;

  function draw(dt) {
    if (!W || !H || !n) return;
    ctx.clearRect(0, 0, W, H);

    /* 幅度目标：生成中从 0.28 逐渐爬到 1，结束后回落到待机 */
    var target = IDLE_AMP;
    if (active) {
      target = Math.min(DEEP_AMP, 0.28 + activeSince * 0.00030);
      if (progress >= 0) target = Math.max(target, 0.55); // 有进度驱动就别太懒
    }
    var k = Math.min(1, dt * 0.0032);
    amp += (target - amp) * k;

    var tempo = 0.18 + amp * 0.55; // 每秒节拍数
    beat += (dt / 1000) * tempo;

    /* ① 底边一层极淡的暖光垫底，让格子浮起来 */
    var g1 = ctx.createLinearGradient(0, H, 0, H * 0.3);
    g1.addColorStop(0, 'rgba(220, 230, 245, ' + (0.025 + amp * 0.05).toFixed(3) + ')');
    g1.addColorStop(1, 'rgba(220, 230, 245, 0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);

    /* ② 彩色方格 */
    var size = CELL - GAP;
    var front = progress >= 0 ? progress * (cols - 1) : -1;

    for (var i = 0; i < n; i++) {
      var s = Math.sin((beat * (0.5 + cSpeed[i] * 0.5) + cPhase[i]) * Math.PI * 2 + cCol[i] * 0.35 - cRow[i] * 0.55);
      s = (s + 1) * 0.5; // 0~1 波动

      /* 待机：低饱和微光流转 */
      var a = 0.05 + 0.10 * s;                     // 0.05 ~ 0.15
      var sat = 38 + 14 * s;
      var lig = 46 + 12 * s;

      /* 跳动：按波浪相位起跳，越忙跳得越高、颜色越艳 */
      if (amp > 0.2) {
        var kk = (amp - 0.2) / 0.8;
        var hop = Math.sin((beat * (0.9 + cSpeed[i] * 0.6) + cPhase[i]) * Math.PI * 2 - cCol[i] * 0.30);
        hop = Math.max(0, hop);                    // 只往上跳，不往下沉
        hop = hop * hop;                           // 起跳利落、落地缓冲
        var lift = hop * (1.5 + 4.5 * kk) * (0.55 + 0.45 * s);
        sat = Math.min(92, sat + 46 * kk * (0.35 + hop));
        lig = Math.min(72, lig + 20 * kk * (0.3 + hop));
        a = Math.min(0.62, a + (0.10 + 0.38 * hop) * kk);

        /* 进度点亮：扫过的区域常亮，最前一列最亮（进度前沿） */
        if (front >= 0) {
          if (cCol[i] < front - 1) {
            a = Math.min(0.68, a + 0.14 * kk);
            lig = Math.min(78, lig + 10);
          } else if (cCol[i] <= front) {
            a = Math.min(0.85, a + 0.30 * kk);
            lig = Math.min(85, lig + 22);
            sat = 95;
          }
        }

        var y = cRow[i] * CELL - lift;
        if (y + size < 0) continue;
        ctx.fillStyle = 'hsla(' + (cHue[i] | 0) + ',' + (sat | 0) + '%,' + (lig | 0) + '%,' + a.toFixed(3) + ')';
        ctx.fillRect(cCol[i] * CELL, y, size, size);
      } else {
        ctx.fillStyle = 'hsla(' + (cHue[i] | 0) + ',' + (sat | 0) + '%,' + (lig | 0) + '%,' + a.toFixed(3) + ')';
        ctx.fillRect(cCol[i] * CELL, cRow[i] * CELL, size, size);
      }
    }
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) {
      lastTs = ts;
      return;
    }
    if (!lastTs) lastTs = ts;
    var dt = Math.min(64, ts - lastTs);
    lastTs = ts;

    if (active) activeSince += dt;
    draw(dt);
  }

  function startLoop() {
    if (raf) return;
    lastTs = 0;
    raf = requestAnimationFrame(loop);
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(topbar);
  } else {
    window.addEventListener('resize', resize);
  }

  resize();

  window.TopbarBreath = {
    /* 配对使用：start() / stop()，内部引用计数，嵌套任务安全 */
    start: function () {
      count++;
      applyActive();
    },
    stop: function () {
      count = Math.max(0, count - 1);
      if (count === 0) progress = -1; // 任务结束，进度灯收回
      applyActive();
    },
    /* 绝对设置：适合「轮询」这类反复调用的场景（幂等，不会累加） */
    setBusy: function (busy) {
      count = busy ? Math.max(1, count) : 0;
      if (!busy) progress = -1;
      applyActive();
    },
    /* 真实进度 0~1；由首页 paintGen 喂入。未知时传负数或不传 */
    setProgress: function (p) {
      progress = (typeof p === 'number' && p >= 0 && p <= 1) ? p : -1;
    },
    isActive: function () { return active; },
    /* 调试用：读取当前幅度 */
    _amp: function () { return amp; }
  };

  function applyActive() {
    var next = count > 0;
    if (next && !active) activeSince = 0; // 从浅开始，重新爬升到深
    active = next;
    if (!reduceMotion) startLoop();
    if (reduceMotion) draw(16);
  }

  /* 待机也保持微光流转；关掉动效偏好则只画一帧静态彩格 */
  if (reduceMotion) {
    amp = IDLE_AMP;
    draw(16);
  } else {
    startLoop();
  }
})();
