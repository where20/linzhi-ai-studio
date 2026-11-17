/* =====================================================================
 * fusion/patch.js — 线上分享站 → 本地 融合增量脚本（由 server.js 注入）
 * ---------------------------------------------------------------------
 * 零改业务代码：以 defer 脚本包在 app.js 之后，按需 patch window.fetch 注入 BYOK 头、
 * 挂载 KEY 抽屉 / 模型下拉增强 / UX 套件 / 状态徽标 / 内容面板。
 * 全程幂等（window.__fusionPatch 标记），可被重复注入而不叠加。
 * KEY 存储：sessionStorage（默认，关标签即失效）或 localStorage（勾选「记住」），用户可切。
 * ===================================================================== */
(function () {
    'use strict';
    if (window.__fusionPatch) return;
    window.__fusionPatch = true;

    // ---------- KEY 存储层 ----------
    var LS_KEYS = {
        cn: 'lz_ak_cn',       // Agnes 国内
        com: 'lz_ak_com',     // Agnes 国际
        sn: 'lz_ak_ch',       // 商汤（对齐线上 x-lz-ak-ch）
        chan: 'lz_chan',      // 当前通道 cn|com
        remember: 'lz_byok_remember',  // '1' = localStorage 持久
        voice: 'lz_tts_voice'
    };
    function store() {
        var remember = false;
        try { remember = localStorage.getItem(LS_KEYS.remember) === '1'; } catch (e) { }
        return remember ? localStorage : sessionStorage;
    }
    function getKey(name) {
        try { return store().getItem(LS_KEYS[name]) || ''; } catch (e) { return ''; }
    }
    function setKey(name, val) {
        try {
            var s = store();
            if (val) s.setItem(LS_KEYS[name], val); else s.removeItem(LS_KEYS[name]);
        } catch (e) { }
    }
    function getRemember() {
        try { return localStorage.getItem(LS_KEYS.remember) === '1'; } catch (e) { return false; }
    }
    function setRemember(on) {
        try {
            // 切换时把现有 KEY 从旧 store 迁到新 store
            var from = store();
            var vals = {};
            ['cn', 'com', 'sn', 'chan'].forEach(function (k) { vals[k] = from.getItem(LS_KEYS[k]); });
            if (on) localStorage.setItem(LS_KEYS.remember, '1'); else localStorage.removeItem(LS_KEYS.remember);
            var to = store();
            Object.keys(vals).forEach(function (k) {
                if (vals[k]) to.setItem(LS_KEYS[k], vals[k]);
                from.removeItem(LS_KEYS[k]);
            });
        } catch (e) { }
    }
    function currentChannel() { return getKey('chan') === 'cn' ? 'cn' : 'com'; }
    function currentAgnesKey() { return getKey(currentChannel() === 'cn' ? 'cn' : 'com'); }

    // ---------- P0-1: patch fetch 注入 BYOK 请求头 ----------
    // 注意：app.js 有多个 fetch patch，部分在 DOMContentLoaded 后才包装。
    // 用标记 + 定期 ensure，确保本 patch 始终处于最外层，不被后续 patch 挤到内层。
    function makeFetchWrapper(orig) {
        var wrapper = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0) {
                    var opts = init || {};
                    // 用普通对象而非 Headers 实例：app.js 内层 patch 用 Object.assign 展开 headers，
                    // Headers 实例属性不可枚举会被展开成 {} 导致我们的头丢失
                    var headers = {};
                    if (opts.headers && typeof opts.headers.forEach === 'function') {
                        opts.headers.forEach(function (v, k) { headers[k] = v; });
                    } else if (opts.headers) {
                        headers = Object.assign({}, opts.headers);
                    }
                    var ak = currentAgnesKey();
                    var sn = getKey('sn');
                    if (ak) {
                        headers['x-lz-ak'] = ak;
                        headers[currentChannel() === 'cn' ? 'x-lz-ak-cn' : 'x-lz-ak-com'] = ak;
                    }
                    if (sn) headers['x-lz-ak-ch'] = sn;
                    headers['x-lz-chan'] = currentChannel();
                    opts.headers = headers;
                    arguments[1] = opts;              // 写回 arguments，保证 apply 传下去
                }
            } catch (e) { /* 注入失败不阻断请求 */ }
            return orig.apply(this, arguments);
        };
        wrapper.__fusionFetch = true;
        return wrapper;
    }
    function installFetchPatch() {
        if (!window.fetch.__fusionFetch) {
            window.fetch = makeFetchWrapper(window.fetch);
        }
        window.__fusionFetchPatched = true;
    }
    // app.js 的 DOMContentLoaded patch 可能在我们之后再次包装；定期把自己顶回最外层
    function ensureFetchPatch() {
        if (!window.fetch.__fusionFetch) {
            window.fetch = makeFetchWrapper(window.fetch);
        }
    }

    // ---------- 工具：DOM 就绪后执行 ----------
    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    // ---------- 样式（内联，避免动 CSS 文件） ----------
    function injectStyles() {
        if (document.getElementById('fusionStyles')) return;
        var css = [
            '#fusionKeyBtn{position:relative}',
            '.fusion-panel{position:fixed;top:0;right:0;width:min(420px,94vw);height:100vh;z-index:10002;',
            '  background:var(--bg,#fff);color:var(--text,#1f2329);box-shadow:-8px 0 32px rgba(0,0,0,.14);',
            '  transform:translateX(105%);transition:transform .22s ease;overflow-y:auto;padding:22px 22px 40px;',
            '  font:14px/1.6 -apple-system,PingFang SC,system-ui,sans-serif;border-left:1px solid var(--border,#e5e7eb)}',
            '.fusion-panel.open{transform:none}',
            '.fusion-mask{position:fixed;inset:0;z-index:10001;background:rgba(15,23,42,.32);display:none}',
            '.fusion-mask.open{display:block}',
            '.fusion-panel h3{margin:0 0 4px;font-size:16px;font-weight:600}',
            '.fusion-panel .sub{color:var(--text2,#6b7280);font-size:12px;margin-bottom:18px}',
            '.fusion-field{margin:0 0 16px}',
            '.fusion-field label{display:block;font-weight:500;margin-bottom:6px}',
            '.fusion-field input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,#d1d5db);',
            '  border-radius:8px;background:var(--bg,#fff);color:var(--text,#1f2329);font:13px/1.4 ui-monospace,monospace}',
            '.fusion-row{display:flex;gap:8px;align-items:center}',
            '.fusion-row input{flex:1}',
            '.fusion-btn{padding:8px 14px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--bg2,#f8fafc);',
            '  color:var(--text,#1f2329);cursor:pointer;font-size:13px;white-space:nowrap}',
            '.fusion-btn:hover{border-color:#378ADD}',
            '.fusion-btn.primary{background:#185FA5;color:#fff;border-color:#185FA5}',
            '.fusion-seg{display:inline-flex;border:1px solid var(--border,#d1d5db);border-radius:8px;overflow:hidden;margin-bottom:14px}',
            '.fusion-seg button{border:0;background:var(--bg2,#f8fafc);color:var(--text2,#6b7280);padding:7px 16px;cursor:pointer;font-size:13px}',
            '.fusion-seg button.active{background:#185FA5;color:#fff}',
            '.fusion-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:3px 9px;border-radius:999px;',
            '  background:rgba(24,95,165,.1);color:#185FA5;cursor:pointer}',
            '.fusion-status .dot{width:7px;height:7px;border-radius:50%;background:#1D9E75}',
            '.fusion-status .dot.none{background:#888780}',
            '.fusion-status .dot.byok{background:#BA7517}',
            '.fusion-hint{font-size:12px;color:var(--text2,#6b7280);margin:6px 0 0}',
            '.fusion-ok{color:#0F6E56}.fusion-err{color:#A32D2D}',
            '.fusion-opt{margin-left:6px}',
            '.fusion-quota{margin:0 0 18px;padding:12px 13px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--bg2,#f8fafc)}',
            '.fusion-quota .q-title{font-size:13px;font-weight:600;margin-bottom:8px}',
            '.fusion-quota .q-row{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;padding:3px 0;color:var(--text2,#6b7280)}',
            '.fusion-quota .q-row b{color:var(--text,#1f2329);font-weight:600}',
            '.fusion-quota .q-hi{color:#0F6E56;font-weight:700}',
            '.fusion-quota .q-err{color:#A32D2D}',
            '.fusion-quota .q-pools{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px}',
            '.fusion-quota .q-pool{font:11px/1 ui-monospace,monospace;padding:4px 7px;border-radius:6px;background:rgba(24,95,165,.1);color:#185FA5}',
            '.fusion-quota .q-tools{gap:6px;margin-top:8px}',
            '.fusion-quota .q-tools select{padding:4px 7px;border:1px solid var(--border,#d1d5db);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1f2329);font-size:12px}',
            '.fusion-quota .q-btn{padding:4px 10px;border:1px solid var(--border,#d1d5db);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1f2329);cursor:pointer;font-size:12px}',
            '.fusion-quota .q-btn:hover{border-color:#378ADD;color:#185FA5}',
            '.fusion-quota .q-hint{font-size:11px;color:var(--text2,#6b7280)}'
        ].join('\n');
        var el = document.createElement('style');
        el.id = 'fusionStyles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ---------- P0-2 + P1-4: 顶栏 KEY 状态徽标 + KEY 抽屉 ----------
    function buildKeyPanel() {
        if (document.getElementById('fusionMask')) return;
        var mask = document.createElement('div');
        mask.id = 'fusionMask';
        mask.className = 'fusion-mask';
        mask.addEventListener('click', closeKeyPanel);
        document.body.appendChild(mask);

        var panel = document.createElement('div');
        panel.id = 'fusionPanel';
        panel.className = 'fusion-panel';
        panel.innerHTML = [
            '<div style="display:flex;justify-content:space-between;align-items:flex-start">',
            '  <div><h3>🔑 本地 KEY 设置</h3><div class="sub">自带 KEY 优先 · 留空自动走内置 / 免 Key 通道</div></div>',
            '  <button class="fusion-btn" id="fusionClose" style="padding:4px 10px">✕</button>',
            '</div>',
            '<div class="fusion-seg" id="fusionChanSeg">',
            '  <button data-chan="com">国际 · apihub.agnes-ai.com</button>',
            '  <button data-chan="cn">国内 · api.agnes-ai.cn</button>',
            '</div>',
            '<div class="fusion-field">',
            '  <label id="fusionAgnesLabel">Agnes KEY（国际通道）</label>',
            '  <div class="fusion-row"><input type="password" id="fusionAgnesKey" placeholder="sk-… 粘贴你自己的 Agnes KEY">',
            '    <button class="fusion-btn" id="fusionTestAgnes">测</button></div>',
            '  <div class="fusion-hint" id="fusionAgnesMsg"></div>',
            '</div>',
            '<div class="fusion-field">',
            '  <label>商汤 SenseNova KEY（生图双模型第二轨）</label>',
            '  <div class="fusion-row"><input type="password" id="fusionSnKey" placeholder="粘贴你的商汤 KEY">',
            '    <button class="fusion-btn" id="fusionTestSn">测</button></div>',
            '  <div class="fusion-hint" id="fusionSnMsg"></div>',
            '</div>',
            '<div class="fusion-field">',
            '  <label style="display:flex;gap:8px;align-items:center;cursor:pointer">',
            '    <input type="checkbox" id="fusionRemember"> 记住 KEY（存浏览器 localStorage；不勾则关标签即失效）',
            '  </label>',
            '</div>',
            '<div class="fusion-row" style="margin-top:8px">',
            '  <button class="fusion-btn primary" id="fusionSave">保存并关闭</button>',
            '  <button class="fusion-btn" id="fusionClear">清空全部 KEY</button>',
            '</div>',
            '<div class="fusion-hint" style="margin-top:20px;line-height:1.8">',
            '  · KEY 只存在你自己的浏览器，随请求单次上送，服务端不保存。<br>',
            '  · 留空 = 用服务端内置 KEY（若失效会自动回落免 Key 通道）。<br>',
            '  · 双模型生图需要商汤 KEY；没有则自动只走 Agnes。<br>',
            '  · 还没有 KEY？去 platform.agnes-ai.com / platform.sensenova.cn 免费申请。',
            '</div>'
        ].join('');
        document.body.appendChild(panel);

        // 事件绑定
        document.getElementById('fusionClose').onclick = closeKeyPanel;
        document.getElementById('fusionSave').onclick = function () {
            setKey('cn', document.getElementById('fusionAgnesKey').value.trim());
            setKey('com', document.getElementById('fusionAgnesKey').value.trim());
            setKey('sn', document.getElementById('fusionSnKey').value.trim());
            setRemember(document.getElementById('fusionRemember').checked);
            // 当前通道保存到实际 store
            setKey('chan', currentChannel());
            closeKeyPanel();
            refreshBadge();
        };
        document.getElementById('fusionClear').onclick = function () {
            ['cn', 'com', 'sn'].forEach(function (k) { setKey(k, ''); });
            document.getElementById('fusionAgnesKey').value = '';
            document.getElementById('fusionSnKey').value = '';
            refreshBadge();
        };
        document.getElementById('fusionRemember').onchange = function () { setRemember(this.checked); };
        // 通道切换
        var seg = document.getElementById('fusionChanSeg');
        seg.querySelectorAll('button').forEach(function (b) {
            b.onclick = function () {
                setKey('chan', b.getAttribute('data-chan'));
                renderChan();
            };
        });
        // 测 KEY
        document.getElementById('fusionTestAgnes').onclick = function () {
            testKey('agnes', document.getElementById('fusionAgnesKey').value.trim(), currentChannel(), 'fusionAgnesMsg');
        };
        document.getElementById('fusionTestSn').onclick = function () {
            testKey('sensenova', document.getElementById('fusionSnKey').value.trim(), '', 'fusionSnMsg');
        };

        function renderChan() {
            var ch = currentChannel();
            seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-chan') === ch); });
            // 输入框显示当前通道的 KEY
            document.getElementById('fusionAgnesLabel').textContent = 'Agnes KEY（' + (ch === 'cn' ? '国内通道' : '国际通道') + '）';
            document.getElementById('fusionAgnesKey').value = getKey(ch === 'cn' ? 'cn' : 'com');
        }
        renderChan();
        document.getElementById('fusionSnKey').value = getKey('sn');
        document.getElementById('fusionRemember').checked = getRemember();
    }
    function openKeyPanel() {
        buildKeyPanel();
        document.getElementById('fusionMask').classList.add('open');
        document.getElementById('fusionPanel').classList.add('open');
    }
    function closeKeyPanel() {
        var m = document.getElementById('fusionMask'), p = document.getElementById('fusionPanel');
        if (m) m.classList.remove('open');
        if (p) p.classList.remove('open');
    }
    function testKey(vendor, key, channel, msgId) {
        var msg = document.getElementById(msgId);
        if (!msg) return;
        if (!key) { msg.className = 'fusion-hint fusion-err'; msg.textContent = '请先粘贴 KEY'; return; }
        msg.className = 'fusion-hint'; msg.textContent = '测试中…';
        fetch('/api/config/test-key', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vendor: vendor, api_key: key, channel: channel })
        }).then(function (r) { return r.json(); }).then(function (d) {
            msg.className = 'fusion-hint ' + (d.success ? 'fusion-ok' : 'fusion-err');
            msg.textContent = d.success ? '✓ ' + d.message : '✕ ' + d.error;
        }).catch(function (e) { msg.className = 'fusion-hint fusion-err'; msg.textContent = '测试失败：' + e.message; });
    }
    function refreshBadge() {
        var el = document.getElementById('fusionKeyBadge');
        if (!el) return;
        var ak = currentAgnesKey(), sn = getKey('sn');
        var mode = ak ? 'BYOK' : '内置/免Key';
        el.querySelector('.dot').className = 'dot ' + (ak ? 'byok' : 'none');
        el.querySelector('.txt').textContent = 'KEY · ' + mode + (sn ? ' +商汤' : '');
    }
    function mountBadge() {
        if (document.getElementById('fusionKeyBadge')) return refreshBadge();
        var header = document.querySelector('.header-right') || document.querySelector('header');
        if (!header) return;
        var badge = document.createElement('span');
        badge.id = 'fusionKeyBadge';
        badge.className = 'fusion-status';
        badge.title = '点击配置你自己的 Agnes / 商汤 KEY（本地不保存）';
        badge.innerHTML = '<span class="dot"></span><span class="txt">KEY</span>';
        badge.onclick = openKeyPanel;
        header.insertBefore(badge, header.firstChild);
        refreshBadge();
        // 在设置按钮旁加一个显式入口
        var settings = document.getElementById('btnHeaderSettings');
        if (settings && !document.getElementById('fusionKeyBtn')) {
            var btn = document.createElement('button');
            btn.id = 'fusionKeyBtn';
            btn.className = btn.className || '';
            btn.textContent = '🔑 KEY';
            btn.title = '自带 KEY 设置（BYOK）';
            btn.onclick = openKeyPanel;
            settings.parentNode.insertBefore(btn, settings);
        }
    }

    // ---------- P0-3: 模型下拉增强 ----------
    function enhanceModels() {
        // 对话模型：补 DeepSeek V4 / Agnes 3.0 / Agnes 2.5
        var sel = document.getElementById('hcModelSel');
        if (sel && !sel.querySelector('[data-fusion]')) {
            var models = [
                ['agnes-3-flash', 'Agnes 3.0 Flash（最新）'],
                ['deepseek-v4-flash', 'DeepSeek V4 Flash（快速）'],
                ['deepseek-v4-pro', 'DeepSeek V4 Pro（强推理）'],
                ['agnes-2.5-flash', 'Agnes 2.5 Flash（稳定）']
            ];
            models.forEach(function (m, i) {
                var o = document.createElement('option');
                o.value = m[0]; o.textContent = m[1]; o.setAttribute('data-fusion', '1');
                sel.insertBefore(o, sel.children[i] || null);
            });
            sel.value = 'agnes-3-flash';
        }
        // 生图双模型：在生图面板加「双模型 / 仅商汤 / 仅Agnes」下拉（若源站没有）
        addImageModeSelect();
    }
    function addImageModeSelect() {
        // 找到生图 prompt 区域附近，挂一个模式选择；用数据属性幂等
        var anchor = document.querySelector('#tab-image .form-select') || document.getElementById('dualModelLeft');
        if (!anchor || document.getElementById('fusionImageMode')) return;
        var wrap = document.createElement('span');
        wrap.className = 'fusion-opt';
        wrap.innerHTML = '<select id="fusionImageMode" class="form-select" title="生图模型来源（融合线上双模型）">' +
            '<option value="both">双模型（商汤+Agnes 同时出）</option>' +
            '<option value="sn">仅商汤</option>' +
            '<option value="agnes">仅 Agnes</option></select>';
        // 尽量插到生图面板顶部工具区
        var panel = document.getElementById('tab-image') || anchor.closest('.tab-content');
        if (panel) panel.insertBefore(wrap, panel.firstChild);
    }

    // ---------- 免 Key 视频通道额度面板 ----------
    // Veda：服务端以 X-Fp 指纹作为设备分组键，每个指纹 = 独立 20 点/天额度池
    // SiftQ：免账号 MiniMax-H3，图生视频，匿名 2 条/天（按出口 IP 分池）
    function fetchFreeQuota() {
        return fetch('/api/free/video/quota', { headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.json(); })
            .catch(function () { return null; });
    }
    function setVedaPool(size) {
        return fetch('/api/free/video/veda-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: size })
        }).then(function (r) { return r.json(); });
    }
    function renderQuotaInto(el, data) {
        if (!data) {
            el.innerHTML = '<div class="q-title">免 Key 视频额度</div>' +
                '<div class="q-body"><span class="q-err">额度读取失败</span></div>';
            return;
        }
        var v = data.veda || {}, s = data.siftq || {};
        var html = '';
        if (v.error) {
            html += '<div class="q-row"><b>Veda</b><span class="q-err">' + v.error + '</span></div>';
        } else {
            html += '<div class="q-row"><b>Veda Studio</b><span>' +
                '剩余 <b class="q-hi">' + (v.remaining != null ? v.remaining : '?') + '</b> / ' +
                (v.limit != null ? v.limit : '?') + ' 点 · ' + (v.poolCount || 1) + ' 个池</span></div>';
            if (v.pools && v.pools.length) {
                html += '<div class="q-pools">' + v.pools.map(function (p) {
                    return '<span class="q-pool" title="' + (p.fp || '') + '">#' + p.id + ' ' +
                        (p.remaining != null ? p.remaining : '?') + '</span>';
                }).join('') + '</div>';
            }
            html += '<div class="q-row q-tools">池大小 <select id="fusionVedaPool">' +
                [1, 2, 3, 4, 5].map(function (n) {
                    return '<option value="' + n + '"' + ((v.poolCount || 1) === n ? ' selected' : '') + '>' + n + '</option>';
                }).join('') +
                '</select><button id="fusionPoolApply" class="q-btn">应用</button>' +
                '<span class="q-hint">每池 20 点/天（上游以浏览器指纹分组）</span></div>';
        }
        if (s.error) {
            html += '<div class="q-row"><b>SiftQ</b><span class="q-err">' + s.error + '</span></div>';
        } else {
            html += '<div class="q-row"><b>SiftQ H3</b><span>剩余 <b class="q-hi">' +
                (s.remaining != null ? s.remaining : '?') + '</b> / ' + (s.limit != null ? s.limit : '?') +
                ' 条' + (s.authenticated ? '（已登录）' : '（匿名）') + '</span></div>';
        }
        el.innerHTML = '<div class="q-title">免 Key 视频额度</div><div class="q-body">' + html + '</div>';

        var sel = el.querySelector('#fusionVedaPool');
        var btn = el.querySelector('#fusionPoolApply');
        if (sel && btn) {
            btn.onclick = function () {
                btn.disabled = true; btn.textContent = '应用中…';
                setVedaPool(+sel.value).then(function (r) {
                    btn.disabled = false; btn.textContent = '应用';
                    if (r && r.success) refreshQuotaPanel();
                    else refreshQuotaPanel();
                }).catch(function () {
                    btn.disabled = false; btn.textContent = '应用';
                });
            };
        }
    }
    function refreshQuotaPanel() {
        var el = document.getElementById('fusionQuotaPanel');
        if (!el) return;
        var body = el.querySelector('.q-body');
        if (body) body.innerHTML = '读取中…';
        // 上游额度查询偶发慢/空响应，加超时兜底，别让面板一直卡在「读取中」
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            var b = el.querySelector('.q-body');
            if (b && /读取中/.test(b.textContent)) {
                b.innerHTML = '<span class="q-err">额度读取超时，点下方按钮重试</span>';
            }
        }, 20000);
        fetchFreeQuota().then(function (d) {
            if (done) return;
            done = true; clearTimeout(timer);
            renderQuotaInto(el, d);
        }).catch(function () {
            if (done) return;
            done = true; clearTimeout(timer);
            renderQuotaInto(el, null);
        });
    }
    function mountQuotaPanel() {
        if (document.getElementById('fusionQuotaPanel')) return refreshQuotaPanel();
        var host = document.getElementById('fusionPanel');
        if (!host) {
            // 抽屉还没建（buildKeyPanel 晚于本函数），退到顶栏
            host = document.querySelector('.header-right');
            if (!host) return;
        }
        var wrap = document.createElement('div');
        wrap.id = 'fusionQuotaPanel';
        wrap.className = 'fusion-quota';
        wrap.innerHTML = '<div class="q-title">免 Key 视频额度</div><div class="q-body">读取中…</div>';
        host.insertBefore(wrap, host.firstChild);
        refreshQuotaPanel();
    }
    function installDraft() {
        if (window.__fusionDraftOn) return;
        window.__fusionDraftOn = true;
        var DRAFT_KEY = 'lz_draft_v1';
        var FIELDS = ['hcInput', 'imagePrompt', 'videoPrompt'];
        function save() {
            try {
                var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
                d.v = 1; d.at = Date.now(); d.fields = {};
                FIELDS.forEach(function (id) { var el = document.getElementById(id); if (el) d.fields[id] = el.value; });
                localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
            } catch (e) { }
        }
        var timer = null;
        document.addEventListener('input', function (e) {
            if (e.target && FIELDS.indexOf(e.target.id) >= 0) {
                clearTimeout(timer); timer = setTimeout(save, 500);
            }
        }, true);
        window.addEventListener('beforeunload', save);
        onReady(function () {
            try {
                var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
                if (d.fields) FIELDS.forEach(function (id) {
                    var el = document.getElementById(id);
                    if (el && !el.value && d.fields[id]) el.value = d.fields[id];
                });
            } catch (e) { }
        });
    }

    // ---------- P1-2: 圆标 / 方标切换 ----------
    function installShapeToggle() {
        if (document.getElementById('fusionShapeBtn')) return;
        var header = document.querySelector('.header-right') || document.querySelector('header');
        if (!header) return;
        var btn = document.createElement('button');
        btn.id = 'fusionShapeBtn';
        btn.textContent = '◻ 圆标';
        btn.title = '一键切换 方标 / 圆标';
        var shape = 'round';
        try { shape = localStorage.getItem('lz_ui_shape') || 'round'; } catch (e) { }
        function apply() {
            document.documentElement.setAttribute('data-fusion-shape', shape);
            btn.textContent = shape === 'round' ? '◻ 圆标' : '▢ 方标';
            try { localStorage.setItem('lz_ui_shape', shape); } catch (e) { }
        }
        btn.onclick = function () { shape = shape === 'round' ? 'square' : 'round'; apply(); };
        header.insertBefore(btn, header.firstChild);
        apply();
    }
    function injectShapeCss() {
        var el = document.createElement('style');
        el.id = 'fusionShapeCss';
        el.textContent = 'html[data-fusion-shape="square"] .brand-logo{border-radius:0 !important}html[data-fusion-shape="round"] .brand-logo{border-radius:50% !important}';
        document.head.appendChild(el);
    }

    // ---------- P1-3: 朗读兜底（speechSynthesis） ----------
    function installSpeechFallback() {
        if (window.__fusionSpeech) return;
        window.__fusionSpeech = true;
        window.fusionSpeak = function (text) {
            if (!('speechSynthesis' in window)) return false;
            try {
                window.speechSynthesis.cancel();
                var u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
                u.lang = 'zh-CN'; u.rate = 1;
                var voice = getKey('voice');
                if (voice) {
                    var found = speechSynthesis.getVoices().find(function (v) { return v.name.indexOf(voice) >= 0; });
                    if (found) u.voice = found;
                }
                speechSynthesis.speak(u);
                return true;
            } catch (e) { return false; }
        };
    }

    // ---------- P2-2: 内容面板（小说 / 散文 / 剧本） ----------
    function installContentTabs() {
        if (document.getElementById('fusionContentTabs')) return;
        var tabsBar = document.querySelector('.tabs') || document.getElementById('sideNav');
        if (!tabsBar) return;
        var defs = [
            ['novel', '小说', '写一个短篇小说的开头，2000 字以内，有人物、冲突和悬念'],
            ['prose', '散文', '写一篇关于秋天的散文，800 字，语言优美'],
            ['script', '剧本', '写一个三幕短剧剧本大纲，场景清晰，含人物对白']
        ];
        var holder = document.createElement('span');
        holder.id = 'fusionContentTabs';
        defs.forEach(function (d) {
            var b = document.createElement('button');
            b.className = 'tab';
            b.textContent = d[1];
            b.setAttribute('data-fusion-tab', d[0]);
            b.onclick = function () { openContentPanel(d); };
            holder.appendChild(b);
        });
        tabsBar.appendChild(holder);

        // 面板容器
        var panel = document.createElement('div');
        panel.id = 'fusionContentPanel';
        panel.className = 'tab-content fusion-panel';
        panel.style.cssText = 'left:0;right:auto;transform:translateX(-105%);width:min(720px,96vw)';
        panel.innerHTML = [
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">',
            '  <h3 id="fusionContentTitle" style="margin:0">内容创作</h3>',
            '  <button class="fusion-btn" id="fusionContentClose">✕ 关闭</button>',
            '</div>',
            '<textarea id="fusionContentInput" class="form-textarea" rows="4" style="width:100%;box-sizing:border-box" placeholder="输入你的创作要求…"></textarea>',
            '<div style="margin:12px 0"><button class="fusion-btn primary" id="fusionContentRun">生成</button></div>',
            '<div id="fusionContentOut" style="white-space:pre-wrap;line-height:1.8;font-size:14px;min-height:120px"></div>'
        ].join('');
        document.body.appendChild(panel);
        document.getElementById('fusionContentClose').onclick = function () {
            panel.classList.remove('open'); document.getElementById('fusionMask').classList.remove('open');
        };
        document.getElementById('fusionContentRun').onclick = function () {
            var type = panel.getAttribute('data-type') || 'novel';
            var req = document.getElementById('fusionContentInput').value.trim();
            var out = document.getElementById('fusionContentOut');
            out.textContent = '生成中…';
            var presets = { novel: defs[0][2], prose: defs[1][2], script: defs[2][2] };
            fetch('/api/ai/chat', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: (presets[type] || '') + '\n\n用户要求：' + req, async: false })
            }).then(function (r) { return r.json(); }).then(function (d) {
                out.textContent = d.success ? (d.reply || '（空响应）') : ('生成失败：' + d.error);
            }).catch(function (e) { out.textContent = '请求失败：' + e.message; });
        };
    }
    function openContentPanel(def) {
        buildKeyPanel(); // 确保 mask 存在
        var panel = document.getElementById('fusionContentPanel');
        if (!panel) return;
        panel.setAttribute('data-type', def[0]);
        document.getElementById('fusionContentTitle').textContent = def[1] + ' · 内容创作';
        document.getElementById('fusionContentInput').value = def[2];
        panel.classList.add('open');
        document.getElementById('fusionMask').classList.add('open');
    }

    // ---------- 启动 ----------
    installFetchPatch();
    installDraft();
    installSpeechFallback();
    // DOMContentLoaded 后很快再 ensure 一次（app.js 的 initGenProgress 常在此时包装）
    onReady(function () {
        setTimeout(ensureFetchPatch, 50);
        setTimeout(ensureFetchPatch, 300);
        setTimeout(ensureFetchPatch, 1000);
    });
    onReady(function () {
        injectStyles();
        injectShapeCss();
        mountBadge();
        enhanceModels();
        installShapeToggle();
        installContentTabs();
        buildKeyPanel();
        mountQuotaPanel();
        // 低频兜底：SPA 异步渲染时补挂
        var tries = 0;
        var t = setInterval(function () {
            tries++;
            ensureFetchPatch();
            mountBadge(); enhanceModels(); installShapeToggle(); installContentTabs();
            refreshBadge();   // KEY 状态随 session/localStorage 变化实时刷新
            if (tries > 40) clearInterval(t);   // 60s 兜底，覆盖 app.js 的延迟 initGenProgress
        }, 1500);
    });
})();
