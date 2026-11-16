/* entry.js — 主站 → 本地工具入口浮标（由 server.js 注入） */
(function () {
    'use strict';
    if (location.pathname.indexOf('/studio') === 0) return;   // 工具页自己不加
    if (window.__localStudioEntry) return;
    window.__localStudioEntry = true;

    function mount() {
        if (document.getElementById('localStudioEntry')) return;
        var wrap = document.createElement('div');
        wrap.id = 'localStudioEntry';
        wrap.innerHTML = [
            '<a href="/studio/storyboard.html" title="本地分镜工作台：10 种模式 + 逐镜出图（免 Key）"',
            '   style="display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:999px;',
            '   background:#fff;border:1px solid #e3e6eb;box-shadow:0 6px 18px rgba(16,24,40,.10);',
            '   color:#1f2329;font:13px/1 -apple-system,PingFang SC,system-ui,sans-serif;text-decoration:none;">',
            '  <span style="font-size:15px;line-height:1">🎬</span><span>本地分镜</span>',
            '</a>',
            '<button id="localStudioEntryClose" title="隐藏"',
            '  style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;',
            '  border:1px solid #e3e6eb;background:#fff;color:#6b7280;font:11px/16px sans-serif;',
            '  cursor:pointer;padding:0;">×</button>'
        ].join('');

        wrap.style.cssText = [
            'position:fixed', 'right:18px', 'bottom:18px', 'z-index:9998',
            'display:flex', 'align-items:center'
        ].join(';');
        document.body.appendChild(wrap);

        wrap.querySelector('a').addEventListener('mouseenter', function () {
            this.style.borderColor = '#d9483b';
            this.style.color = '#d9483b';
        });
        wrap.querySelector('a').addEventListener('mouseleave', function () {
            this.style.borderColor = '#e3e6eb';
            this.style.color = '#1f2329';
        });
        wrap.querySelector('#localStudioEntryClose').addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            wrap.remove();
            try { sessionStorage.setItem('hideLocalStudioEntry', '1'); } catch (err) { /* 忽略 */ }
        });
    }

    try {
        if (sessionStorage.getItem('hideLocalStudioEntry') === '1') return;
    } catch (err) { /* 隐私模式 */ }

    // ===== 「剧本分镜」版块内嵌提示 =====
    // 源站这个版块走会员后端（点生成会报需要会员），本地点一下就能用
    function injectPanelHint() {
        var panel = document.getElementById('tab-fjgzt');
        if (!panel || panel.querySelector('#localFjgztHint')) return;
        if (panel.offsetParent === null) return;   // 还没显示

        var bar = document.createElement('div');
        bar.id = 'localFjgztHint';
        bar.style.cssText = [
            'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap',
            'margin:0 0 12px', 'padding:10px 14px', 'border-radius:10px',
            'border:1px dashed rgba(217,72,59,.55)', 'background:rgba(217,72,59,.08)',
            'font-size:13px', 'line-height:1.6', 'color:inherit'
        ].join(';');
        bar.innerHTML = [
            '<span style="font-size:15px">🎬</span>',
            '<span><b>下方已换成本地工作台</b>（原源站工作台在本地是 404 / 未开通会员会报错）。',
            '同一套 10 种模式：剧本体检 / 按报告改写 / 70 集拆分 / 锁定码定妆 / 分镜八步 / 首尾帧继承，免 Key 可用，还能逐镜出图与合成视频。</span>',
            '<a href="/studio/storyboard.html" target="_blank" rel="noopener"',
            '   style="margin-left:auto;flex:none;padding:6px 14px;border-radius:8px;',
            '   background:#d9483b;color:#fff;text-decoration:none;font-weight:600;font-size:13px">',
            '去本地工作台 →</a>'
        ].join('');
        panel.insertBefore(bar, panel.firstChild);
    }

    // 包一层 switchTab：进到剧本分镜就注入
    function hookSwitchTab() {
        if (typeof window.switchTab !== 'function' || window.switchTab.__localHooked) return;
        var orig = window.switchTab;
        var wrapped = function (name) {
            var r = orig.apply(this, arguments);
            try {
                if (name === 'fjgzt' || name === 'fjgzt1' || name === 'fjgzt2' || name === 'h3prompt') {
                    setTimeout(injectPanelHint, 80);
                }
            } catch (err) { /* 忽略 */ }
            return r;
        };
        wrapped.__localHooked = true;
        window.switchTab = wrapped;
    }

    function bootPanelHint() {
        hookSwitchTab();
        // 支持深链：/?tab=fjgzt 直达剧本分镜（也方便自动化截图核验）
        try {
            var want = new URLSearchParams(location.search).get('tab');
            if (want && typeof window.switchTab === 'function') {
                window.switchTab(want);
                setTimeout(injectPanelHint, 120);
            }
        } catch (err) { /* 忽略 */ }
        injectPanelHint();
        // SPA 可能异步渲染面板，低频兜底（2s 一次，命中即停）
        var tries = 0;
        var timer = setInterval(function () {
            tries += 1;
            hookSwitchTab();
            injectPanelHint();
            var panel = document.getElementById('tab-fjgzt');
            if ((panel && panel.querySelector('#localFjgztHint')) || tries > 30) clearInterval(timer);
        }, 2000);
    }

    // 主站是 SPA，DOM 可能在脚本执行后才就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { mount(); bootPanelHint(); });
    } else {
        mount();
        bootPanelHint();
    }
})();
