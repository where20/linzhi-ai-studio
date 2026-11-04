/* ===== 合剪（✂️ 合剪 标签页）=====
 * Pexels 免费素材 + FFmpeg 特效合成
 * 独立文件，主页面用 <script src="/static/hejian.js"></script> 引入，
 * 避免 index.html 继续膨胀（codevideo 已有 1 万+ 行的教训）。
 */
(function () {
    'use strict';

    var HJ = {
        inited: false,
        effects: [],
        transitions: [],
        canvases: [],
        assets: [],
        segments: [],      // 时间轴：{asset_id, name, kind, duration, start, effect, text, thumb}
        bgm: null,         // {path, name}
        voice: null,       // {path, name, duration}
        pexels: { configured: false },
        sources: [],
        nodeOk: false,
        taskId: '',
        timer: null,
        searchResults: [],
    };

    var previewAudio = null;     // 当前播放的 Audio 对象（V1.8.373 试听）
    var previewScope = '';       // 当前播放属于哪个面板（用于「再点一次=停止」）

    window.HJ_STATE = HJ;

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function toast(msg, kind) {
        if (typeof showToast === 'function') return showToast(msg, kind);
        alert(msg);
    }

    // ============================ 初始化 ============================
    async function init() {
        if (HJ.inited) return;
        HJ.inited = true;
        try {
            const cfg = await (await fetch('/api/hejian/config')).json();
            // 门禁未过 / 未登录：/api/hejian/config 返回 {success:false, account_required:true}。
            // 必须把 inited 复位，否则这一次失败会被永久记住 —— 用户登录后再切回来
            // 画幅/音色/语速下拉框永远是空的，看着像「合剪坏了」。
            if (cfg && cfg.success === false) { HJ.inited = false; return; }
            HJ.effects = cfg.effects || [];
            HJ.transitions = cfg.transitions || [];
            HJ.canvases = cfg.canvases || [];
            // V1.8.354：先把**纯本地**渲染做完（画幅/特效/转场/音色/记录），
            // 再去跑要发网络请求的 loadAssets / checkPexels。
            // 原来顺序反了 —— pexels 探测卡住时，面板开半天画幅和音色下拉还是空的。
            renderCanvases();
            renderEffects();
            renderTransitions();
            applyCfg(cfg.config || {});
            renderAiCanvases();
            hjAiLoadModels();          // V1.8.365：AI 面板的模型下拉
            loadVoices();
            hjLoadRecords();
            await loadAssets();
            await checkPexels();
        } catch (e) {
            HJ.inited = false;   // 网络抖动同样允许下次重试
            console.error('合剪初始化失败', e);
        }
    }
    window.hjInit = init;

    function applyCfg(c) {
        var cv = $('hjCanvas');
        if (cv && c.canvas) cv.value = c.canvas;
        var tr = $('hjTransition');
        if (tr && c.transition) tr.value = c.transition;
        var td = $('hjTransDur');
        if (td && c.transition_duration != null) td.value = c.transition_duration;
        var ef = $('hjGlobalEffect');
        if (ef && c.effect) ef.value = c.effect;
        var bg = $('hjBgmGain');
        if (bg && c.bgm_gain != null) bg.value = c.bgm_gain;
        var vg = $('hjVoiceGain');
        if (vg && c.voice_gain != null) vg.value = c.voice_gain;
        var dk = $('hjDuck');
        if (dk) dk.checked = !!c.duck_bgm;
        var ss = $('hjSubSize');
        if (ss && c.subtitle_size) ss.value = c.subtitle_size;
    }

    async function saveCfg() {
        var body = {
            canvas: $('hjCanvas') ? $('hjCanvas').value : '16:9',
            fps: $('hjFps') ? parseInt($('hjFps').value, 10) || 30 : 30,
            transition: $('hjTransition') ? $('hjTransition').value : 'fade',
            transition_duration: $('hjTransDur') ? parseFloat($('hjTransDur').value) || 0.6 : 0.6,
            effect: $('hjGlobalEffect') ? $('hjGlobalEffect').value : 'none',
            bgm_gain: $('hjBgmGain') ? parseFloat($('hjBgmGain').value) : 0.18,
            voice_gain: $('hjVoiceGain') ? parseFloat($('hjVoiceGain').value) : 1.0,
            duck_bgm: $('hjDuck') ? $('hjDuck').checked : true,
            subtitle_size: $('hjSubSize') ? parseInt($('hjSubSize').value, 10) || 42 : 42,
        };
        await fetch('/api/hejian/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    // ============================ 滑块数值联动 ============================
    function syncGain(sliderId, labelId) {
        var s = $(sliderId), l = $(labelId);
        if (!s || !l) return;
        l.textContent = (parseFloat(s.value) || 0).toFixed(2);
    }
    window.hjSyncGain = syncGain;

    // ============================ 画幅 / 特效 ============================
    function renderCanvases() {
        var el = $('hjCanvas');
        if (!el) return;
        el.innerHTML = HJ.canvases.map(function (c) {
            return '<option value="' + c.id + '">' + esc(c.label) + '</option>';
        }).join('');
    }
    function renderEffects() {
        var el = $('hjGlobalEffect');
        if (el) {
            el.innerHTML = HJ.effects.map(function (e) {
                return '<option value="' + e.id + '">' + esc(e.name) + ' · ' + esc(e.desc) + '</option>';
            }).join('');
        }
        var se = $('hjSegEffect');
        if (se) {
            se.innerHTML = '<option value="">（跟随全局）</option>' + HJ.effects.map(function (e) {
                return '<option value="' + e.id + '">' + esc(e.name) + '</option>';
            }).join('');
        }
    }
    function renderTransitions() {
        var el = $('hjTransition');
        if (!el) return;
        el.innerHTML = HJ.transitions.map(function (t) {
            return '<option value="' + t.id + '">' + esc(t.name) + '</option>';
        }).join('');
    }

    // ============================ 素材来源（Pexels / Mixkit / Pixabay）============================
    async function checkPexels() {
        var d = await (await fetch('/api/hejian/sources')).json();
        HJ.sources = d.sources || [];
        HJ.nodeOk = !!d.node_ok;
        // 填充来源下拉
        var ss = $('hjSource');
        if (ss && HJ.sources.length) {
            var cur = ss.value || 'pexels';
            ss.innerHTML = HJ.sources.map(function (s) {
                return '<option value="' + s.id + '"' + (s.id === cur ? ' selected' : '') + '>'
                    + esc(s.name) + ' · ' + esc(s.desc) + '</option>';
            }).join('');
        }
    }

    function currentSource() {
        var s = $('hjSource');
        return s ? s.value : 'pexels';
    }

    async function searchPexels() {
        var q = $('hjSearchQuery') ? $('hjSearchQuery').value.trim() : '';
        if (!q) { toast('请输入搜索关键词', 'error'); return; }
        if (!HJ.nodeOk) { toast('未找到 Node.js，无法抓取网页素材', 'error'); return; }
        var kind = $('hjSearchKind') ? $('hjSearchKind').value : 'video';
        var orient = $('hjSearchOrient') ? $('hjSearchOrient').value : '';
        var src = currentSource();
        var box = $('hjSearchResults');
        box.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:16px;">'
            + '搜索中…（首次较慢，浏览器需启动）</div>';
        var url = '/api/hejian/pexels/search?source=' + encodeURIComponent(src)
            + '&query=' + encodeURIComponent(q)
            + '&kind=' + kind + '&per_page=12';
        if (orient) url += '&orientation=' + orient;
        var d = await (await fetch(url)).json();
        if (!d.success) {
            box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:16px;">'
                + esc(d.error || '搜索失败') + '</div>';
            return;
        }
        HJ.searchResults = d.items || [];
        if (!HJ.searchResults.length) {
            box.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:16px;">没有找到素材，换个关键词试试</div>';
            return;
        }
        box.innerHTML = HJ.searchResults.map(function (it, i) {
            var dur = it.duration ? Math.round(it.duration) + 's' : '图片';
            var res = it.width ? it.width + '×' + it.height : '';
            var srcName = it.source === 'mixkit' ? 'Mixkit' : 'Pexels';
            return '<div class="hj-src-card" data-i="' + i + '" onclick="hjPickResult(' + i + ')">'
                + '<div class="hj-src-thumb"><img src="' + esc(it.thumb) + '" loading="lazy" '
                + 'onerror="this.style.opacity=.25"></div>'
                + '<div class="hj-src-meta">'
                + '<div class="hj-src-title">' + esc(it.title || it.id) + '</div>'
                + '<div class="hj-src-sub">' + esc(dur) + (res ? ' · ' + res : '') + '</div>'
                + '<div class="hj-src-by">' + esc(srcName) + '</div>'
                + '</div></div>';
        }).join('');
    }
    window.hjSearchPexels = searchPexels;

    async function hjPickResult(i) {
        var it = HJ.searchResults[i];
        if (!it) return;
        var btn = document.querySelector('.hj-src-card[data-i="' + i + '"]');
        if (btn) btn.style.opacity = '.5';
        var endpoint = it.kind === 'photo' ? '/api/hejian/pexels/photo' : '/api/hejian/pexels/video';
        var r = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: it.id,
                source: it.source || currentSource(),
                page_url: it.page_url || '',
                thumb: it.thumb || '',
                title: it.title || '',
                width: it.width || 0,
                height: it.height || 0,
                download: it.download || '',
            }),
        });
        var d = await r.json();
        if (btn) btn.style.opacity = '';
        if (!d.success) { toast('下载失败：' + (d.error || ''), 'error'); return; }
        toast('已加入素材库', 'success');
        await loadAssets();
        addToTimeline(d.asset);
    }
    window.hjPickResult = hjPickResult;

    // ============================ 素材库 ============================
    async function loadAssets() {
        var d = await (await fetch('/api/hejian/assets')).json();
        HJ.assets = d.assets || [];
        renderAssets();
    }

    function renderAssets() {
        var box = $('hjAssetGrid');
        if (!box) return;
        if (!HJ.assets.length) {
            box.innerHTML = '<div style="color:var(--text2);font-size:12px;grid-column:1/-1;padding:14px;">'
                + '素材库为空 —— 去 Pexels 搜索下载，或上传本地素材</div>';
            return;
        }
        box.innerHTML = HJ.assets.map(function (a) {
            var isImg = a.kind === 'image';
            var preview = isImg
                ? '<img src="/api/hejian/assets/' + encodeURIComponent(a.id) + '/preview" loading="lazy" '
                + 'onerror="this.parentNode.innerHTML=\'<div class="hj-audio-ico">🖼</div>\'">'
                : (a.kind === 'video'
                    ? '<video src="/api/hejian/assets/' + encodeURIComponent(a.id) + '/preview" muted preload="metadata"></video>'
                    : '<div class="hj-audio-ico">♪</div>');
            var dur = a.duration ? Math.round(a.duration) + 's' : '';
            return '<div class="hj-asset-card" data-id="' + esc(a.id) + '">'
                + '<div class="hj-asset-thumb">' + preview
                + '<button class="hj-asset-del" onclick="hjDeleteAsset(\'' + esc(a.id) + '\')" title="删除">✕</button>'
                + '</div>'
                + '<div class="hj-asset-info">'
                + '<div class="hj-asset-name" title="' + esc(a.name) + '">' + esc(a.name) + '</div>'
                + '<div class="hj-asset-sub">' + (dur ? dur + ' · ' : '')
                + (a.width ? a.width + '×' + a.height : '') + '</div>'
                + '</div>'
                + '<div class="hj-asset-acts">'
                + (a.kind === 'audio' ? '' : '<button class="btn btn-sm" onclick="hjAddAsset(\'' + esc(a.id) + '\')">+ 时间轴</button>')
                + '</div></div>';
        }).join('');
    }

    async function hjDeleteAsset(id) {
        if (!confirm('删除该素材？')) return;
        await fetch('/api/hejian/assets/' + encodeURIComponent(id), { method: 'DELETE' });
        HJ.segments = HJ.segments.filter(function (s) { return s.asset_id !== id; });
        renderTimeline();
        await loadAssets();
    }
    window.hjDeleteAsset = hjDeleteAsset;

    async function hjUpload(input) {
        var f = input.files && input.files[0];
        if (!f) return;
        var fd = new FormData();
        fd.append('file', f);
        var r = await fetch('/api/hejian/upload', { method: 'POST', body: fd });
        var d = await r.json();
        if (!d.success) { toast('上传失败：' + (d.error || ''), 'error'); return; }
        toast('上传成功', 'success');
        await loadAssets();
        if (d.asset.kind !== 'audio') addToTimeline(d.asset);
        input.value = '';
    }
    window.hjUpload = hjUpload;

    // ============================ 时间轴 ============================
    function addToTimeline(asset) {
        if (!asset) return;
        if (asset.kind === 'audio') {
            setBgm(asset);
            // 🔴 V1.8.371：从素材库挑的音频同样能剪切
            mountBgmEditor('hjBgmEditorBox', asset, function (na) { setBgm(na); });
            return;
        }
        HJ.segments.push({
            asset_id: asset.id,
            name: asset.name,
            kind: asset.kind,
            duration: asset.kind === 'image' ? 3 : (asset.duration || 3),
            start: 0,
            effect: '',
            text: '',
            thumb: asset.kind === 'image'
                ? '/api/hejian/assets/' + encodeURIComponent(asset.id) + '/preview'
                : (asset.photographer ? '📷 ' + asset.photographer : ''),
        });
        renderTimeline();
    }
    window.hjAddAsset = function (id) {
        var a = HJ.assets.filter(function (x) { return x.id === id; })[0];
        if (a) addToTimeline(a);
    };

    function renderTimeline() {
        var box = $('hjTimeline');
        if (!box) return;
        if (!HJ.segments.length) {
            box.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:20px;text-align:center;">'
                + '时间轴为空 —— 从素材库点「+ 时间轴」或从 Pexels 搜索添加</div>';
            updateTotal();
            return;
        }
        box.innerHTML = HJ.segments.map(function (s, i) {
            return '<div class="hj-seg" data-i="' + i + '">'
                + '<div class="hj-seg-idx">' + (i + 1) + '</div>'
                + '<div class="hj-seg-body">'
                + '<div class="hj-seg-row">'
                + '<input class="form-input hj-seg-dur" type="number" min="0.5" step="0.5" '
                + 'value="' + (s.duration || 3) + '" onchange="hjSetDur(' + i + ',this.value)">'
                + '<span style="font-size:11px;color:var(--text2);">秒</span>'
                + '<select class="form-select hj-seg-fx" onchange="hjSetEffect(' + i + ',this.value)">'
                + '<option value="">跟随全局</option>'
                + HJ.effects.map(function (e) {
                    return '<option value="' + e.id + '"' + (s.effect === e.id ? ' selected' : '') + '>'
                        + esc(e.name) + '</option>';
                }).join('')
                + '</select>'
                + '<input class="form-input hj-seg-text" placeholder="字幕（可选）" value="' + esc(s.text || '') + '" '
                + 'oninput="hjSetText(' + i + ',this.value)">'
                + '<button class="btn btn-sm" onclick="hjMoveSeg(' + i + ',-1)">↑</button>'
                + '<button class="btn btn-sm" onclick="hjMoveSeg(' + i + ',1)">↓</button>'
                + '<button class="btn btn-sm" onclick="hjRemoveSeg(' + i + ')">✕</button>'
                + '</div>'
                + '<div class="hj-seg-name">' + esc(s.name) + '</div>'
                + '</div></div>';
        }).join('');
        updateTotal();
    }

    function updateTotal() {
        var total = HJ.segments.reduce(function (a, s) { return a + (parseFloat(s.duration) || 0); }, 0);
        var el = $('hjTotalDur');
        if (el) el.textContent = total.toFixed(1) + ' 秒';
    }

    window.hjSetDur = function (i, v) {
        HJ.segments[i].duration = Math.max(0.5, parseFloat(v) || 3);
        updateTotal();
    };
    window.hjSetEffect = function (i, v) { HJ.segments[i].effect = v; };
    window.hjSetText = function (i, v) { HJ.segments[i].text = v; };
    window.hjRemoveSeg = function (i) { HJ.segments.splice(i, 1); renderTimeline(); };
    window.hjMoveSeg = function (i, d) {
        var j = i + d;
        if (j < 0 || j >= HJ.segments.length) return;
        var tmp = HJ.segments[i]; HJ.segments[i] = HJ.segments[j]; HJ.segments[j] = tmp;
        renderTimeline();
    };

    // ============================ BGM / 配音 ============================
    function setBgm(asset) {
        HJ.bgm = { id: asset.id, name: asset.name };
        var el = $('hjBgmName');
        if (el) el.innerHTML = '🎵 ' + esc(asset.name) + ' <button class="btn btn-sm" onclick="hjClearBgm()">清除</button>';
    }
    window.hjClearBgm = function () {
        HJ.bgm = null;
        var box = $('hjBgmEditorBox');
        if (box) box.innerHTML = '';          // V1.8.371：清 BGM 时也收起编辑器
        var el = $('hjBgmName');
        if (el) el.textContent = '未设置';
    };

    async function hjUploadBgm(input) {
        var f = input.files && input.files[0];
        if (!f) return;
        var fd = new FormData();
        fd.append('file', f);
        var r = await fetch('/api/hejian/upload', { method: 'POST', body: fd });
        var d = await r.json();
        if (!d.success) { toast('上传失败：' + (d.error || ''), 'error'); return; }
        setBgm(d.asset);
        // 🔴 V1.8.371：挂上波形 + 播放条 + 剪切编辑器
        mountBgmEditor('hjBgmEditorBox', d.asset, function (na) {
            setBgm(na);
        });
        await loadAssets();
        input.value = '';
    }
    window.hjUploadBgm = hjUploadBgm;

    /* ================================================================
     * BGM 音频编辑器（波形 + 播放条 + 剪切）  V1.8.371
     * ---------------------------------------------------------------
     * 用户需求：「上传背景音乐 有要剪切功能，播放条功能」
     *   · 播放条：波形图上显示播放游标 + 时间，可点波形跳转、可拖动选区
     *   · 剪切：拖选一段区间 → 后端 ffmpeg 重编码裁出**新素材**（不覆盖原文件）
     *
     * 为什么剪切结果另存为新素材：
     *   覆盖原文件的话用户就没法「再换个区间试试」，也不方便对比。
     *   新素材沿用同一套 assets.json / preview / 渲染挂载链路，零改动复用。
     *
     * 选区怎么定：canvas 上按下拖动 = 新建选区；拖动靠近选区左右边缘 = 改边界；
     *   纯单击（没拖动）= 跳转播放位置；双击 = 恢复全选。
     * ================================================================ */
    var BGMS = {};        // containerId → 编辑器实例

    function fmtTime(sec) {
        sec = Math.max(0, parseFloat(sec) || 0);
        var m = Math.floor(sec / 60);
        var s = sec - m * 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    function BgmEditor(container, opts) {
        this.el = container;
        this.opts = opts || {};
        this.asset = null;
        this.peaks = [];
        this.duration = 0;
        this.selStart = 0;
        this.selEnd = 0;
        this.audio = null;
        this.drag = null;
        this._build();
    }

    BgmEditor.prototype._build = function () {
        var self = this;
        this.el.innerHTML =
            '<div style="margin-top:8px;">'
            + '<canvas class="hj-bgm-wave" style="width:100%;height:64px;display:block;'
            + 'background:var(--surface2);border:1px solid var(--border);border-radius:6px;'
            + 'cursor:pointer;"></canvas>'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;">'
            + '<button class="btn btn-sm hj-bgm-play" type="button">▶ 播放</button>'
            + '<button class="btn btn-sm hj-bgm-restart" type="button" title="回到开头">⟲</button>'
            + '<span class="hj-bgm-time" style="font-size:11px;color:var(--text2);'
            + 'font-variant-numeric:tabular-nums;">00:00.0 / 00:00.0</span>'
            + '<span style="flex:1;"></span>'
            + '<span class="hj-bgm-sel" style="font-size:11px;color:var(--text2);">选区：全长</span>'
            + '<button class="btn btn-sm hj-bgm-all" type="button">全选</button>'
            + '<button class="btn btn-sm hj-bgm-trim" type="button" disabled>✂ 剪切选中段</button>'
            + '</div></div>';

        this.canvas = this.el.querySelector('canvas.hj-bgm-wave');
        this.btnPlay = this.el.querySelector('.hj-bgm-play');
        this.btnRestart = this.el.querySelector('.hj-bgm-restart');
        this.btnAll = this.el.querySelector('.hj-bgm-all');
        this.btnTrim = this.el.querySelector('.hj-bgm-trim');
        this.elTime = this.el.querySelector('.hj-bgm-time');
        this.elSel = this.el.querySelector('.hj-bgm-sel');

        this.btnPlay.onclick = function () { self.togglePlay(); };
        this.btnRestart.onclick = function () {
            if (self.audio) { self.audio.currentTime = 0; self.play(); }
        };
        this.btnAll.onclick = function () {
            self.selStart = 0; self.selEnd = self.duration; self._syncSel();
        };
        this.btnTrim.onclick = function () { self.applyTrim(); };

        this._bindCanvas();

        var ro = window.ResizeObserver ? new ResizeObserver(function () { self.draw(); }) : null;
        if (ro) { try { ro.observe(this.el); } catch (e) { /* 老浏览器没有就靠 window.resize */ } }
        var self2 = this;
        window.addEventListener('resize', function () { self2.draw(); });
    };

    BgmEditor.prototype._bindCanvas = function () {
        var self = this;
        var cv = this.canvas;

        function tAt(ev) {
            var r = cv.getBoundingClientRect();
            var x = (ev.clientX - r.left) / (r.width || 1);
            x = Math.max(0, Math.min(1, x));
            return x * self.duration;
        }

        cv.addEventListener('mousedown', function (ev) {
            if (!self.duration) return;
            var t = tAt(ev);
            var edge = Math.max(0.6, self.duration * 0.03);
            var mode;
            if (Math.abs(t - self.selStart) <= edge) mode = 'left';
            else if (Math.abs(t - self.selEnd) <= edge) mode = 'right';
            else mode = 'new';
            self.drag = { mode: mode, anchor: t, moved: false, start: self.selStart, end: self.selEnd };
            ev.preventDefault();
        });

        window.addEventListener('mousemove', function (ev) {
            if (!self.drag || !self.duration) return;
            var t = tAt(ev);
            if (Math.abs(t - self.drag.anchor) > 0.05) self.drag.moved = true;
            if (self.drag.mode === 'left') {
                self.selStart = Math.min(t, self.selEnd - 0.1);
            } else if (self.drag.mode === 'right') {
                self.selEnd = Math.max(t, self.selStart + 0.1);
            } else if (self.drag.mode === 'new') {
                var a = Math.min(self.drag.anchor, t);
                var b = Math.max(self.drag.anchor, t);
                self.selStart = a;
                self.selEnd = b;
            }
            self._syncSel();
        });

        window.addEventListener('mouseup', function () {
            if (!self.drag) return;
            var d = self.drag;
            self.drag = null;
            if (d.mode === 'new' && !d.moved) {
                // 单击 = 跳转播放位置（不动选区）
                if (self.audio) { self.audio.currentTime = d.anchor; self.play(); }
                return;
            }
            if (self.selEnd - self.selStart < 0.1) {
                self.selStart = 0; self.selEnd = self.duration;
            }
            self._syncSel();
        });

        cv.addEventListener('dblclick', function () {
            self.selStart = 0; self.selEnd = self.duration; self._syncSel();
        });
    };

    /** 换素材（上传成功 / 剪切成功后） */
    BgmEditor.prototype.setAsset = function (asset) {
        var self = this;
        this.asset = asset;
        this.peaks = [];
        this.duration = Math.max(0, parseFloat(asset && asset.duration) || 0);
        this.selStart = 0;
        this.selEnd = this.duration;
        this._makeAudio();
        this._syncSel();
        this.draw();
        // 波形要后端算（ffmpeg 解码），慢一点；期间画条形占位
        fetch('/api/hejian/assets/' + encodeURIComponent(asset.id) + '/waveform')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success) return;
                self.peaks = d.peaks || [];
                if (d.duration) {
                    self.duration = d.duration;
                    self.selStart = 0;
                    self.selEnd = self.duration;
                    self._syncSel();
                }
                self.draw();
            })
            .catch(function () { /* 波形拿不到就只留播放条，不影响剪切 */ });
    };

    BgmEditor.prototype._makeAudio = function () {
        var self = this;
        try {
            if (this.audio) { this.audio.pause(); this.audio.src = ''; }
            this.audio = new Audio('/api/hejian/assets/' + encodeURIComponent(this.asset.id) + '/preview');
            this.audio.preload = 'auto';
            this.audio.addEventListener('timeupdate', function () { self._syncTime(); });
            this.audio.addEventListener('ended', function () {
                self.btnPlay.textContent = '▶ 播放';
                self._syncTime();
            });
            this.audio.addEventListener('loadedmetadata', function () {
                if (self.audio.duration && isFinite(self.audio.duration) && self.audio.duration > 0) {
                    self.duration = self.audio.duration;
                    self.selStart = 0; self.selEnd = self.duration;
                    self._syncSel();
                }
            });
            this.audio.addEventListener('error', function () {
                if (self.elTime) self.elTime.textContent = '音频无法播放（格式不支持？）';
            });
        } catch (e) {
            this.audio = null;
        }
    };

    BgmEditor.prototype.play = function () {
        if (!this.audio) return;
        var self0 = this;
        var p = this.audio.play();
        if (p && p.catch) {
            p.catch(function () {
                if (self0.elTime) self0.elTime.textContent = '播放被浏览器拦截，请再点一次';
            });
        }
        this.btnPlay.textContent = '⏸ 暂停';
    };

    BgmEditor.prototype.togglePlay = function () {
        if (!this.audio) return;
        if (this.audio.paused) { this.play(); }
        else { this.audio.pause(); this.btnPlay.textContent = '▶ 播放'; }
    };

    BgmEditor.prototype._syncTime = function () {
        if (!this.audio) return;
        if (this.elTime) {
            this.elTime.textContent = fmtTime(this.audio.currentTime)
                + ' / ' + fmtTime(this.duration);
        }
        this.draw();
    };

    BgmEditor.prototype._syncSel = function () {
        var d = this.duration;
        this.selStart = Math.max(0, Math.min(this.selStart, d));
        this.selEnd = Math.max(this.selStart, Math.min(this.selEnd, d));
        if (this.elSel) {
            if (d > 0 && (this.selEnd - this.selStart) < d - 0.05) {
                this.elSel.textContent = '选区：' + fmtTime(this.selStart)
                    + ' ~ ' + fmtTime(this.selEnd)
                    + '（' + (this.selEnd - this.selStart).toFixed(1) + 's）';
            } else {
                this.elSel.textContent = '选区：全长';
            }
        }
        if (this.btnTrim) {
            var can = !!(this.asset && d > 0 && (this.selEnd - this.selStart) >= 0.1
                && (this.selEnd - this.selStart) < d - 0.05);
            this.btnTrim.disabled = !can;
        }
        this.draw();
    };

    /** 画波形 + 选区 + 播放游标 */
    BgmEditor.prototype.draw = function () {
        var cv = this.canvas;
        if (!cv) return;
        var dpr = window.devicePixelRatio || 1;
        var cssW = cv.clientWidth || 600;
        var cssH = 64;
        var w = Math.max(200, Math.round(cssW));
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(cssH * dpr);
        var g = cv.getContext('2d');
        if (!g) return;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, cssH);

        var d = this.duration;
        var selA = d > 0 ? (this.selStart / d) * w : 0;
        var selB = d > 0 ? (this.selEnd / d) * w : w;

        // 选区外的部分压暗
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.fillRect(0, 0, selA, cssH);
        g.fillRect(selB, 0, w - selB, cssH);

        // 波形
        var peaks = this.peaks;
        var mid = cssH / 2;
        g.fillStyle = 'rgba(255,255,255,0.16)';
        if (peaks && peaks.length) {
            var bw = Math.max(1, w / peaks.length);
            for (var i = 0; i < peaks.length; i++) {
                var x = i * bw;
                var h = Math.max(1, peaks[i] * (cssH - 6));
                g.fillRect(x, mid - h / 2, Math.max(1, bw - 0.5), h);
            }
        } else {
            // 波形还没算出来 → 画条占位（别让人以为是空白坏了）
            for (var k = 0; k < 60; k++) {
                var x2 = (k / 60) * w;
                g.fillRect(x2, mid - 1, Math.max(1, w / 60 - 2), 2);
            }
        }

        // 选区边框
        if (d > 0 && (this.selEnd - this.selStart) < d - 0.05) {
            g.strokeStyle = 'rgba(120,200,255,0.9)';
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(selA, 0); g.lineTo(selA, cssH);
            g.moveTo(selB, 0); g.lineTo(selB, cssH);
            g.stroke();
            g.fillStyle = 'rgba(120,200,255,0.9)';
            g.fillRect(selA - 2, 0, 4, cssH);
            g.fillRect(selB - 2, 0, 4, cssH);
        }

        // 播放游标
        if (this.audio && d > 0 && !this.audio.paused) {
            var px = (this.audio.currentTime / d) * w;
            g.strokeStyle = '#ff6b6b';
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(px, 0); g.lineTo(px, cssH);
            g.stroke();
        }
    };

    /** 执行剪切 → 后端生成新素材 → 回调替换当前 BGM */
    BgmEditor.prototype.applyTrim = function () {
        var self = this;
        if (!this.asset) return;
        var a = this.selStart, b = this.selEnd;
        if (b - a < 0.1) return;
        var old = this.btnTrim.textContent;
        this.btnTrim.disabled = true;
        this.btnTrim.textContent = '剪切中…';
        fetch('/api/hejian/assets/' + encodeURIComponent(this.asset.id) + '/trim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: a, end: b }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success) {
                    toast('剪切失败：' + ((d && d.error) || '未知错误'), 'error');
                    self.btnTrim.textContent = old;
                    self._syncSel();
                    return;
                }
                toast('已剪切 ' + (b - a).toFixed(1) + ' 秒', 'success');
                self.btnTrim.textContent = '✂ 剪切选中段';
                self.setAsset(d.asset);
                if (typeof self.opts.onTrimmed === 'function') self.opts.onTrimmed(d.asset);
            })
            .catch(function (e) {
                toast('剪切异常：' + (e.message || ''), 'error');
                self.btnTrim.textContent = old;
                self._syncSel();
            });
    };

    /** 挂载一个编辑器到容器（同一容器重复调用 = 复用） */
    function mountBgmEditor(containerId, asset, onTrimmed) {
        var box = $(containerId);
        if (!box) return null;
        var ed = BGMS[containerId];
        if (!ed) {
            ed = new BgmEditor(box, { onTrimmed: onTrimmed });
            BGMS[containerId] = ed;
        } else {
            ed.opts.onTrimmed = onTrimmed;
        }
        ed.setAsset(asset);
        return ed;
    }
    window.hjMountBgmEditor = mountBgmEditor;

    async function loadVoices() {
        try {
            var d = await (await fetch('/api/hejian/voices')).json();
            HJ.engines = d.engines || [];
            // V1.8.369：后端给的默认音色（MOSS 优先）
            HJ.defaultVoice = d.default_voice || '';
            renderVoiceSelects();
            // 情感 / 语速下拉（AI 面板 + 手动面板各一套）
            [['hjAiStyle', 'hjVoiceStyle'], ['hjAiSpeed', 'hjVoiceSpeed']].forEach(function (pair) {
                var src = pair[0], dst = pair[1];
                var el = $(src);
                if (!el) return;
                var list = (src === 'hjAiStyle') ? d.styles : d.speeds;
                if (!list) return;
                var cur = el.value || list[0].id;
                el.innerHTML = list.map(function (s) {
                    return '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>'
                        + esc(s.name) + '</option>';
                }).join('');
            });
        } catch (e) { /* 音色不可用不阻塞 */ }
    }

    /**
     * 渲染音色下拉（按引擎分 optgroup）。
     * 引擎未配置 Key 的置灰并标注「需配置 Key」；当前引擎不可用时自动回落第一个可用引擎。
     */
    function renderVoiceSelects() {
        var engines = HJ.engines || [];
        var groups = '';
        var firstAvailable = null;
        engines.forEach(function (e) {
            if (!e.voices || !e.voices.length) return;
            var opts = e.voices.map(function (v) {
                return '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>';
            }).join('');
            var label = e.name + (e.available ? '' : '（需配置 Key）');
            groups += '<optgroup label="' + esc(label) + '"' +
                (e.available ? '' : ' disabled') + '>' + opts + '</optgroup>';
            if (e.available && !firstAvailable) firstAvailable = e.id;
        });
        if (!groups) return;

        ['hjAiVoice', 'hjVoice'].forEach(function (sid) {
            var el = $(sid);
            if (!el) return;
            var cur = el.value;
            el.innerHTML = groups;
            // 保持原选中（若还在）；否则优先后端默认音色（MOSS）；再否则第一个可用引擎的第一个音色
            if (cur && Array.from(el.options).some(function (o) { return o.value === cur && !o.disabled; })) {
                el.value = cur;
            } else if (HJ.defaultVoice && Array.from(el.options).some(function (o) { return o.value === HJ.defaultVoice && !o.disabled; })) {
                el.value = HJ.defaultVoice;
            } else if (firstAvailable) {
                var want = firstAvailable + ':';
                var opt = Array.from(el.options).find(function (o) {
                    return o.value.indexOf(want) === 0 && !o.disabled;
                });
                if (opt) el.value = opt.value;
            }
        });
    }
    window.hjRenderVoiceSelects = renderVoiceSelects;

    async function hjGenVoice() {
        var text = $('hjVoiceText') ? $('hjVoiceText').value.trim() : '';
        if (!text) { toast('请输入配音文本', 'error'); return; }
        var btn = $('hjTtsBtn');
        if (btn) { btn.disabled = true; btn.textContent = '合成中…'; }
        try {
            var r = await fetch('/api/hejian/tts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    voice: $('hjVoice') ? $('hjVoice').value : '',
                    style: $('hjVoiceStyle') ? $('hjVoiceStyle').value : 'natural',
                    speed: $('hjVoiceSpeed') ? $('hjVoiceSpeed').value : 'normal',
                }),
            });
            var d = await r.json();
            if (!d.success) { toast('配音失败：' + (d.error || ''), 'error'); return; }
            HJ.voice = { path: d.path, name: '配音 ' + (d.duration || '') + 's', duration: d.duration };
            var el = $('hjVoiceName');
            if (el) el.innerHTML = '🎙 ' + esc(HJ.voice.name) + ' <button class="btn btn-sm" onclick="hjClearVoice()">清除</button>';
            toast('配音已生成', 'success');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🎙 合成配音'; }
        }
    }
    window.hjGenVoice = hjGenVoice;

    /* ===== 音色试听（V1.8.373）=====
     * 两个面板各一个入口：
     *   'manual' → 手动面板「文本配音」区：文本框有内容就试听它，否则用内置试听文本
     *   'ai'     → AI 面板「配音音色」旁：用内置试听文本
     * 🔴 走独立接口 /api/hejian/tts/preview（带缓存），**不污染**配音素材，
     *    也不会把「试听」当成成片用的配音轨。
     */
    async function hjPreviewVoice(scope) {
        var ids = scope === 'ai'
            ? { v: 'hjAiVoice', s: 'hjAiStyle', p: 'hjAiSpeed', b: 'hjAiVoicePrevBtn' }
            : { v: 'hjVoice', s: 'hjVoiceStyle', p: 'hjVoiceSpeed', b: 'hjVoicePrevBtn' };

        // 正在试听 → 再点一次就是停止（别又合成一遍）
        if (previewAudio && previewScope === scope) {
            window.hjStopPreview();
            return;
        }

        // 手动面板：优先试听用户自己写的文本
        var text = '';
        if (scope !== 'ai' && $('hjVoiceText')) text = $('hjVoiceText').value.trim();

        var btn = $(ids.b);
        if (btn) { btn.disabled = true; btn.textContent = '合成中…'; }
        try {
            var r = await fetch('/api/hejian/tts/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    voice: $(ids.v) ? $(ids.v).value : '',
                    style: $(ids.s) ? $(ids.s).value : 'natural',
                    speed: $(ids.p) ? $(ids.p).value : 'normal',
                }),
            });
            var d = await r.json();
            if (!d.success) { toast('试听失败：' + (d.error || ''), 'error'); return; }
            if (!d.url) { toast('试听失败：没有拿到音频', 'error'); return; }

            // 停掉上一次试听（连续点不同音色不会叠音）
            if (previewAudio) {
                try { previewAudio.pause(); } catch (e) { /* ignore */ }
                previewAudio = null;
            }
            var a = new Audio(d.url);
            previewAudio = a;
            previewScope = scope;
            if (btn) btn.textContent = '⏹ 停止';
            a.onended = function () {
                if (btn) { btn.disabled = false; btn.textContent = '🔊 试听'; }
                if (previewAudio === a) { previewAudio = null; previewScope = ''; }
            };
            try {
                await a.play();
            } catch (e) {
                // 浏览器自动播放策略拦了 → 提示用户手动点一下
                toast('浏览器拦截了自动播放，请再点一次试听键', 'error');
                if (btn) { btn.disabled = false; btn.textContent = '🔊 试听'; }
            }
        } catch (e) {
            toast('试听失败：' + (e && e.message ? e.message : e), 'error');
        } finally {
            if (btn && btn.textContent === '合成中…') {
                btn.disabled = false; btn.textContent = '🔊 试听';
            }
        }
    }
    window.hjPreviewVoice = hjPreviewVoice;

    // 试听中再点一次 = 停止
    window.hjStopPreview = function () {
        if (previewAudio) {
            try { previewAudio.pause(); } catch (e) { /* ignore */ }
            previewAudio = null;
        }
        previewScope = '';
        ['hjAiVoicePrevBtn', 'hjVoicePrevBtn'].forEach(function (id) {
            var b = $(id);
            if (b) { b.disabled = false; b.textContent = '🔊 试听'; }
        });
    };

    window.hjClearVoice = function () {
        HJ.voice = null;
        var el = $('hjVoiceName');
        if (el) el.textContent = '未设置';
    };

    // ============================ 渲染 ============================
    async function hjRender() {
        if (!HJ.segments.length) { toast('请先添加片段', 'error'); return; }
        await saveCfg();
        var body = {
            canvas: $('hjCanvas') ? $('hjCanvas').value : '16:9',
            fps: $('hjFps') ? parseInt($('hjFps').value, 10) || 30 : 30,
            transition: $('hjTransition') ? $('hjTransition').value : 'fade',
            transition_duration: $('hjTransDur') ? parseFloat($('hjTransDur').value) : 0.6,
            effect: $('hjGlobalEffect') ? $('hjGlobalEffect').value : 'none',
            segments: HJ.segments.map(function (s) {
                return {
                    asset_id: s.asset_id, duration: s.duration,
                    effect: s.effect, text: s.text,
                };
            }),
            auto_subtitle: true,
            bgm_asset_id: HJ.bgm ? HJ.bgm.id : '',
            bgm_gain: $('hjBgmGain') ? parseFloat($('hjBgmGain').value) : 0.18,
            voice_path: HJ.voice ? HJ.voice.path : '',
            voice_gain: $('hjVoiceGain') ? parseFloat($('hjVoiceGain').value) : 1.0,
            duck_bgm: $('hjDuck') ? $('hjDuck').checked : true,
            subtitle_size: $('hjSubSize') ? parseInt($('hjSubSize').value, 10) || 42 : 42,
        };
        var r = await fetch('/api/hejian/render', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        var d = await r.json();
        if (!d.success) { toast('提交失败：' + (d.error || ''), 'error'); return; }
        HJ.taskId = d.task_id;
        pollTask();
        var el = $('hjProgress');
        if (el) { el.style.display = 'block'; el.innerHTML = '<div style="font-size:12px;color:var(--text2);">渲染中…</div>'; }
    }
    window.hjRender = hjRender;

    function pollTask() {
        if (HJ.timer) clearInterval(HJ.timer);
        HJ.timer = setInterval(async function () {
            if (!HJ.taskId) return;
            var d;
            try {
                d = await (await fetch('/api/hejian/tasks/' + HJ.taskId)).json();
            } catch (e) { return; }
            var t = d.task || {};
            var el = $('hjProgress');
            var pct = t.percent || 0;
            if (el) {
                el.style.display = 'block';
                if (t.status === 'completed') {
                    el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
                        + '<span style="color:var(--success);font-size:13px;">✓ 渲染完成</span>'
                        + '<video src="' + t.video_url + '" controls style="max-width:520px;border-radius:10px;background:#000;"></video>'
                        + '<a class="btn btn-sm" href="' + t.video_url + '" download>⬇ 下载 MP4</a>'
                        + '</div>';
                    clearInterval(HJ.timer); HJ.timer = null; HJ.taskId = '';
                    hjLoadRecords();          // 成片已归档 → 刷新生成记录栏
                    return;
                }
                if (t.status === 'failed') {
                    el.innerHTML = '<div style="color:var(--danger);font-size:13px;">✗ ' + esc(t.message || '渲染失败')
                        + '</div><pre style="font-size:11px;color:var(--text2);white-space:pre-wrap;max-height:200px;overflow:auto;">'
                        + esc((t.error || '').slice(-1200)) + '</pre>';
                    clearInterval(HJ.timer); HJ.timer = null; HJ.taskId = '';
                    return;
                }
                el.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:6px;">'
                    + esc(t.message || '处理中…') + ' (' + pct + '%)</div>'
                    + '<div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;">'
                    + '<div style="height:100%;width:' + pct + '%;background:var(--primary);transition:width .3s;"></div></div>';
            }
        }, 1200);
    }
    window.hjPollTask = pollTask;

/* ========================================================================
 * AI 一键成片 —— 说需求 → AI 写脚本 → 三家选材 → 配音字幕 → 成片
 * ======================================================================== */
HJ.aiTaskId = '';
HJ.aiTimer = null;

    /* ===== 分镜编辑 + 「继续出片」 ===== */
    /** 编辑某个分镜的字段（关键词 / 时长 / 台词） */
    function hjEditShot(idx, field, value) {
        if (!HJ.script || !HJ.script.shots || !HJ.script.shots[idx]) return;
        var sh = HJ.script.shots[idx];
        if (field === 'duration') {
            sh.duration = Math.max(1, parseFloat(value) || 1);
        } else {
            sh[field] = value;
        }
        // 实时更新预估（台词字数 ÷ 3.2 ≈ 秒）
        var chars = HJ.script.shots.reduce(function (a, x) {
            return a + ((x.narration || '').length);
        }, 0);
        HJ.script.narration_chars = chars;
        var est = Math.round(chars / 3.2 * 10) / 10;
        HJ.script.total_duration = est;
        var meta = $('hjAiScriptMeta');
        if (meta) {
            var t = $('hjAiDuration') ? parseFloat($('hjAiDuration').value) || 0 : 0;
            var txt = (HJ.script.title || '') + ' · ' + HJ.script.shots.length + ' 镜'
                + ' · 预估 ' + est + ' 秒（台词 ' + chars + ' 字）';
            if (t) txt += ' · 目标 ' + t + ' 秒';
            txt += ' · 可直接编辑';
            meta.textContent = txt;
        }
    }
    window.hjEditShot = hjEditShot;

    /** 继续出片：沿用（可能已编辑的）脚本，走完选材 → 配音 → 渲染 */
    async function hjAiContinue() {
        if (!HJ.script || !HJ.script.shots || !HJ.script.shots.length) {
            toast('请先点「只生成脚本」', 'error');
            return;
        }
        setContBtn('出片中…', true);
        // 清掉上一次的进度显示
        var prog = $('hjAiProgress');
        if (prog) { prog.style.display = 'block'; prog.innerHTML = '<div style="font-size:12px;color:var(--text2);">沿用你的脚本，开始选材…</div>'; }
        var res = $('hjAiResult');
        if (res) res.style.display = 'none';

        try {
            var body = aiParams();
            body.script = HJ.script;        // 传脚本（可能已被用户编辑）
            var r = await fetch('/api/hejian/ai/continue', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            var d = await r.json();
            if (!d.success) { toast('提交失败：' + (d.error || ''), 'error'); return; }
            HJ.aiTaskId = d.task_id;
            pollAiTask();
        } catch (e) {
            toast('提交异常：' + e.message, 'error');
        } finally {
            setContBtn(null, false);
        }
    }
    window.hjAiContinue = hjAiContinue;

    /** 「继续合成影片」有两个入口（操作行 + 脚本区底部），文案/禁用状态必须一致 */
    var CONT_BTN_LABEL = { 'hjAiContinueBtn': '▶ 继续合成影片',
                           'hjAiContinueBtn2': '▶ 继续合成影片（按这份脚本出片）' };
    function setContBtn(text, disabled) {
        Object.keys(CONT_BTN_LABEL).forEach(function (id) {
            var b = $(id);
            if (!b) return;
            b.disabled = !!disabled;
            b.textContent = text || CONT_BTN_LABEL[id];
        });
    }

    /* ===== 音频来源三分支（配音 / 上传BGM / 在线曲库）—— 互斥 ===== */
    HJ.audioSource = 'voice';
    HJ.bgmUpload = null;        // {path, name}
    HJ.musicPick = null;        // {title, source, mp3, local_path, reason}
    HJ.musicAutoTried = false;  // V1.8.355：曲库分支是否已自动跑过一次 AI 匹配
    HJ.musicList = [];

    /**
     * 切换音频来源。
     *
     * ⚠️ 分支语义（用户明确要求）：
     *   voice        配音合成 —— 只有解说，无 BGM
     *   bgm_upload   上传背景音乐 —— 换掉素材原声（可保留原声），无解说
     *   bgm_library  在线免版权曲库 —— **曲库只当背景音乐，解说（配音）必须保留**
     *                 → 这一分支下配音控件**不可禁用**
     */
    function hjAiAudioSourceChange() {
        HJ.audioSource = ($('hjAiAudioSource') ? $('hjAiAudioSource').value : 'voice') || 'voice';
        var isVoice = HJ.audioSource === 'voice';
        var isUpload = HJ.audioSource === 'bgm_upload';
        var isLib = HJ.audioSource === 'bgm_library';

        // 配音控件：voice 与 bgm_library 可用；bgm_upload 禁用（该分支是纯音乐形态）
        var voiceEnabled = isVoice || isLib;
        ['hjAiVoice', 'hjAiStyle', 'hjAiSpeed'].forEach(function (id) {
            var el = $(id);
            if (el) el.disabled = !voiceEnabled;
            if (el) el.style.opacity = voiceEnabled ? '' : '.45';
        });
        // V1.8.373：试听键跟着音色一起禁用（音色不可用就没试听意义）
        var pv = $('hjAiVoicePrevBtn');
        if (pv) {
            pv.disabled = !voiceEnabled;
            pv.style.opacity = voiceEnabled ? '' : '.45';
            if (!voiceEnabled) {
                try {
                    if (previewAudio) { previewAudio.pause(); previewAudio = null; previewScope = ''; }
                } catch (e) { /* ignore */ }
                pv.textContent = '🔊 试听';
            }
        }

        // BGM 面板显隐
        var up = $('hjAiBgmUpload'), lb = $('hjAiBgmLibrary');
        if (up) up.style.display = isUpload ? '' : 'none';
        if (lb) lb.style.display = isLib ? '' : 'none';

        // 互斥清理：只保留当前分支的音频来源
        if (isVoice) {
            HJ.bgmUpload = null;
            HJ.musicPick = null;
        }
        if (isUpload) {
            HJ.musicPick = null;
        }
        if (isLib) {
            HJ.bgmUpload = null;
            // V1.8.355：切到「在线免版权曲库」就先把 AI 匹配跑起来 ——
            // 用户要的是「曲库自动匹配背景音效」，不是让他先点一下「AI 选曲」。
            // 每轮只自动跑一次（用户手动换过就尊重他的选择）。
            if (!HJ.musicPick && !HJ.musicAutoTried && typeof hjAiPickMusic === 'function') {
                HJ.musicAutoTried = true;
                setTimeout(function () { hjAiPickMusic(true); }, 60);
            }
        }
    }
    window.hjAiAudioSourceChange = hjAiAudioSourceChange;

    /** 「原片静音」开关同步（两处复选框共享同一状态） */
    function hjSyncMuteOrig(checked) {
        HJ.muteOriginal = !!checked;
        ['hjAiMuteOrig', 'hjAiMuteOrig2'].forEach(function (id) {
            var el = $(id);
            if (el) el.checked = !!checked;
        });
    }
    window.hjSyncMuteOrig = hjSyncMuteOrig;

    /** 上传 BGM（AI 模式） */
    async function hjAiUploadBgm(input) {
        var f = input.files && input.files[0];
        if (!f) return;
        var fd = new FormData();
        fd.append('file', f);
        var r = await fetch('/api/hejian/upload', { method: 'POST', body: fd });
        var d = await r.json();
        if (!d.success) { toast('上传失败：' + (d.error || ''), 'error'); return; }
        HJ.bgmUpload = { id: d.asset.id, name: d.asset.name, path: '' };
        var el = $('hjAiBgmName');
        if (el) el.textContent = d.asset.name;
        // 🔴 V1.8.371：挂上波形 + 播放条 + 剪切编辑器
        mountBgmEditor('hjAiBgmEditorBox', d.asset, function (na) {
            // 剪切后换用新素材（HJ.bgmUpload.id 才是真正进渲染的）
            HJ.bgmUpload = { id: na.id, name: na.name, path: '' };
            var e2 = $('hjAiBgmName');
            if (e2) e2.textContent = na.name;
        });
        toast('背景音乐已就绪', 'success');
        input.value = '';
    }
    window.hjAiUploadBgm = hjAiUploadBgm;

    /** AI 选曲（auto=true 表示切到曲库分支时自动触发，不打扰用户） */
    async function hjAiPickMusic(auto) {
        var btn = $('hjAiPickBtn');
        var box = $('hjAiMusicBox');
        if (btn) { btn.disabled = true; btn.textContent = '选曲中…'; }
        if (box) box.innerHTML = '正在从免版权曲库检索，并按成片情绪匹配…';
        try {
            var r = await fetch('/api/hejian/music/pick', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requirement: $('hjAiReq') ? $('hjAiReq').value.trim() : '',
                    style: $('hjAiStyle') ? $('hjAiStyle').value : '',
                }),
            });
            var d = await r.json();
            if (!d.success) {
                if (box) box.innerHTML = '<span style="color:var(--danger);">选曲失败：'
                    + esc(d.error || '未知错误') + '</span>';
                return;
            }
            HJ.musicList = d.picks || [];
            if (!HJ.musicList.length) {
                if (box) box.innerHTML = '<span style="color:var(--text2);">没有找到合适的曲子</span>';
                return;
            }
            // 展示 top3（含理由），第一首为默认选中
            HJ.musicPick = HJ.musicList[0];
            if (box) {
                box.innerHTML = '<div style="font-size:11px;color:var(--text2);margin-bottom:6px;">'
                    + '情绪判定：' + esc((d.moods || []).join('、')) + '</div>'
                    + HJ.musicList.map(function (p, i) {
                        return '<div class="hj-music-pick' + (i === 0 ? ' cur' : '') + '" '
                            + 'onclick="hjAiChooseMusic(' + i + ')">'
                            + '<span class="hj-music-no">' + (i + 1) + '</span>'
                            + '<span class="hj-music-title">' + esc(p.title || '') + '</span>'
                            + '<span class="hj-music-src">' + esc(p.source || '') + '</span>'
                            + '<span class="hj-music-reason">' + esc(p.reason || '') + '</span>'
                            + '</div>';
                    }).join('');
            }
            // 候选列表（可手动换）
            var sel = $('hjAiMusicList');
            if (sel) {
                sel.style.display = '';
                sel.innerHTML = '<option value="">— 换一首（候选手动选择）—</option>'
                    + HJ.musicList.map((p, i) => '<option value="' + i + '">'
                        + esc(p.title || '') + ' · ' + esc(p.source || '') + '</option>').join('');
            }
            toast('已为你匹配 ' + HJ.musicList.length + ' 首背景音乐', 'success');
        } catch (e) {
            if (box) box.innerHTML = '<span style="color:var(--danger);">选曲异常：'
                + esc(e.message) + '</span>';
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🤖 重新匹配'; }
        }
    }
    window.hjAiPickMusic = hjAiPickMusic;

    /** 手动换曲 */
    function hjAiChooseMusic(idx) {
        var p = HJ.musicList[idx];
        if (!p) return;
        HJ.musicPick = p;
        var boxes = document.querySelectorAll('.hj-music-pick');
        boxes.forEach(function (b, i) { b.classList.toggle('cur', i === idx); });
        var sel = $('hjAiMusicList');
        if (sel) sel.value = String(idx);
        toast('已选：' + (p.title || ''), 'success');
    }
    window.hjAiChooseMusic = hjAiChooseMusic;

    /** 🌐 免版权曲库（Tunetank 2297 首）搜索 —— V1.8.350 */
    async function hjTtSearch() {
        var q = ($('hjTtQ') ? $('hjTtQ').value.trim() : '') || 'background';
        var box = $('hjTtList');
        if (box) box.innerHTML = '<div style="font-size:11px;color:var(--text2);">检索中…</div>';
        try {
            var r = await fetch('/api/tunetank/search?limit=20&q=' + encodeURIComponent(q));
            var d = await r.json();
            if (!d.success) {
                if (box) box.innerHTML = '<div style="color:var(--danger);font-size:11px;">' + esc(d.error || '检索失败') + '</div>';
                return;
            }
            var items = d.items || [];
            if (!items.length) {
                if (box) box.innerHTML = '<div style="font-size:11px;color:var(--text2);">没有匹配的曲目</div>';
                return;
            }
            if (box) {
                box.innerHTML = items.map(function (it) {
                    return '<div class="hj-music-pick" onclick="hjTtPick(' + it.id + ',this)">'
                        + '<span class="hj-music-no">' + (it.duration ? Math.round(it.duration) + 's' : '') + '</span>'
                        + '<span class="hj-music-title">' + esc(it.name || '') + '</span>'
                        + '<span class="hj-music-src">' + esc(it.artist || '') + '</span>'
                        + '<span class="hj-music-reason"><audio controls preload="none" src="/api/tunetank/preview/' + it.id + '" style="height:26px;"></audio></span>'
                        + '</div>';
                }).join('');
            }
        } catch (e) {
            if (box) box.innerHTML = '<div style="color:var(--danger);font-size:11px;">检索异常：' + esc(e.message) + '</div>';
        }
    }
    window.hjTtSearch = hjTtSearch;

    /** 🌐 选用 Tunetank 曲目（下载到本地 → 作为 bgm_music） */
    async function hjTtPick(trackId, el) {
        var name = el ? ((el.querySelector('.hj-music-title') || {}).textContent || '') : '';
        var tip = $('hjTtPicked');
        if (tip) tip.textContent = '下载中…';
        try {
            var r = await fetch('/api/hejian/music/tunetank', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_id: trackId }),
            });
            var d = await r.json();
            if (!d.success) {
                if (tip) tip.textContent = '失败：' + (d.error || '');
                toast('选用失败：' + (d.error || ''), 'error');
                return;
            }
            HJ.musicPick = d.track;
            if (tip) tip.textContent = '已选：' + (d.track.title || name || '');
            toast('已选背景音乐：' + (d.track.title || name || ''), 'success');
        } catch (e) {
            if (tip) tip.textContent = '异常：' + e.message;
        }
    }
    window.hjTtPick = hjTtPick;

    function hjAiChangeMusic(v) {
        if (v === '') return;
        hjAiChooseMusic(parseInt(v, 10));
    }
    window.hjAiChangeMusic = hjAiChangeMusic;

    /* ===== 创作需求「优化」按钮 ===== */
    /* 🔴 V1.8.366：后端异步化 + 前端安全解析
       旧实现 =「同步 POST + 裸 r.json()」。该调用实测 **142.5 秒**，
       云端网关 60 秒必切 504 → 前端拿到网关 HTML，报出天书
       「优化异常：Unexpected token '<', "<html><h"... is not valid JSON」。
       现在：POST 立刻回 job_id，前端轮询 /status；
       且所有响应一律过 hjReadJson —— HTML 翻成人话（带 HTTP 状态），不再抛 JSON 解析错。 */
    function hjReadJson(resp, what) {
        return resp.text().then(function (t) {
            var s = String(t || '').replace(/^\s+/, '');
            if (s.charAt(0) === '{' || s.charAt(0) === '[') {
                try { return JSON.parse(s); }
                catch (e) {
                    throw new Error((what || '接口') + '返回的内容不是合法 JSON');
                }
            }
            if (/^\s*<(!doctype\s+)?html/i.test(s)) {
                throw new Error('云端网关超时或中断（HTTP ' + resp.status + '）。'
                    + '任务大概率还在后台跑，稍等几秒再看，别反复点。');
            }
            throw new Error((what || '接口') + '返回异常：' + s.slice(0, 120));
        });
    }

    function hjApplyOptimized(d, fallback) {
        if ($('hjAiReq')) $('hjAiReq').value = d.requirement || fallback || '';
        if (d.warning) toast('已优化（' + d.warning + '）', 'warn');
        else toast('需求已优化', 'success');
    }

    async function hjAiOptimize() {
        var req = $('hjAiReq') ? $('hjAiReq').value.trim() : '';
        if (!req) { toast('先写一句你的创作想法', 'error'); return; }
        var btn = $('hjAiOptBtn');
        if (btn) { btn.disabled = true; btn.textContent = '优化中…'; }
        var t0 = Date.now();
        try {
            var r = await fetch('/api/hejian/ai/optimize', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requirement: req,
                    canvas: $('hjAiCanvas') ? $('hjAiCanvas').value : '16:9',
                    duration: $('hjAiDuration') ? parseFloat($('hjAiDuration').value) || 0 : 0,
                }),
            });
            var d = await hjReadJson(r, '需求优化');
            if (!d.success) { toast('优化失败：' + (d.error || ''), 'error'); return; }
            if (d.sync) { hjApplyOptimized(d, req); return; }   // 同步分支（本机测试）
            var jobId = d.job_id;
            if (!jobId) { toast('优化失败：后端没返回作业号', 'error'); return; }
            for (;;) {
                await new Promise(function (res) { setTimeout(res, 3000); });
                var sr = await fetch('/api/hejian/ai/optimize/status?job_id='
                    + encodeURIComponent(jobId));
                if (sr.status === 404) { toast('优化作业已过期，请重试', 'error'); return; }
                var sd = await hjReadJson(sr, '优化进度');
                if (sd.status === 'done') { hjApplyOptimized(sd, req); return; }
                if (sd.status === 'failed') {
                    toast('优化失败：' + (sd.error || ''), 'error');
                    return;
                }
                var waited = Math.round((Date.now() - t0) / 1000);
                if (btn) btn.textContent = '优化中… ' + waited + 's';
                if (waited > 300) {
                    toast('优化等了 5 分钟仍未完成，请稍后重试', 'error');
                    return;
                }
            }
        } catch (e) {
            toast('优化异常：' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✨ 优化'; }
        }
    }
    window.hjAiOptimize = hjAiOptimize;

function renderAiCanvases() {
    var el = $('hjAiCanvas');
    if (el && HJ.canvases.length) {
        el.innerHTML = HJ.canvases.map(function (c) {
            return '<option value="' + c.id + '">' + esc(c.label) + '</option>';
        }).join('');
    }
}

window.hjToggleManual = function () {
    var p = $('hjManualPanel');
    var b = $('hjManualToggle');
    if (!p) return;
    var show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    if (b) b.textContent = show ? '↑ 收起手动模式' : '↓ 手动模式';
};

/** 只生成脚本（不选材不渲染）
 *  🔴 V1.8.357：后端已改异步（云端网关 60s 切 504）→ 这里提交后轮询 status。
 */
async function hjAiScript() {
    var req = $('hjAiReq') ? $('hjAiReq').value.trim() : '';
    if (!req) { toast('请先描述你的创作需求', 'error'); return; }
    var btn = $('hjAiScriptBtn');
    var box = $('hjAiProgress');
    if (btn) { btn.disabled = true; btn.textContent = 'AI 推演中…'; }
    if (box) {
        box.style.display = '';
        box.innerHTML = '<div style="font-size:12px;color:var(--text2);">'
            + 'AI 正在推演分镜脚本…（通常 30~90 秒，页面可以放着不管）</div>';
    }
    try {
        var r = await fetch('/api/hejian/ai/script', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(aiParams()),
        });
        var d = await r.json();
        if (!d.success) { toast('脚本生成失败：' + (d.error || ''), 'error'); return; }
        // 同步分支（本机调试带 sync:true）
        if (d.sync || d.script) {
            renderAiScript(d.script);
            toast('脚本已生成', 'success');
            return;
        }
        var script = await hjPollScriptJob(d.job_id, box);
        if (script) {
            renderAiScript(script);
            toast('脚本已生成', 'success');
        }
    } catch (e) {
        toast('脚本生成异常：' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📝 只生成脚本'; }
    }
}
window.hjAiScript = hjAiScript;

/** 轮询脚本推演作业；成功返回 script，失败返回 null（已 toast/写进度框）。 */
function hjPollScriptJob(jobId, box) {
    return new Promise(function (resolve) {
        if (!jobId) { toast('脚本生成失败：没拿到作业号', 'error'); resolve(null); return; }
        var started = Date.now();
        var tick = 0;
        var timer = setInterval(async function () {
            if (Date.now() - started > 15 * 60 * 1000) {
                clearInterval(timer);
                if (box) box.innerHTML = '<div style="color:var(--danger);font-size:13px;">✗ 推演超过 15 分钟仍未返回，请重试</div>';
                resolve(null);
                return;
            }
            tick++;
            var res, j;
            try {
                res = await fetch('/api/hejian/ai/script/status?job_id=' + encodeURIComponent(jobId));
                j = await res.json();
            } catch (e) {
                return;                       // 网关抖动：当成瞬时错误，下一轮再问
            }
            if (j.status === 'done' && j.script) {
                clearInterval(timer);
                if (box) box.style.display = 'none';
                resolve(j.script);
                return;
            }
            if (!j.success) {                 // failed / gone（404）→ 立即停，别白等
                clearInterval(timer);
                if (box) {
                    box.innerHTML = '<div style="color:var(--danger);font-size:13px;">✗ 脚本生成失败：'
                        + esc(j.error || '') + '</div>';
                }
                toast('脚本生成失败：' + (j.error || ''), 'error');
                resolve(null);
                return;
            }
            if (box) {
                var secs = Math.round((Date.now() - started) / 1000);
                box.innerHTML = '<div style="font-size:12px;color:var(--text2);">'
                    + 'AI 正在推演分镜脚本… 已 ' + secs + ' 秒'
                    + (tick > 12 ? '（模型较忙，再耐心等等）' : '') + '</div>';
            }
        }, 1500);
    });
}
window.hjPollScriptJob = hjPollScriptJob;

/** 素材来源：V1.8.367 三家全搜、内置写死（界面不再出现勾选）。
    少勾一家只会少一半候选，没有任何好处 —— 一律三家同时搜，由打分选最优。 */
function hjAiSources() {
    return ['pexels', 'mixkit', 'pixabay'];
}
window.hjAiSources = hjAiSources;

/** 模型下拉：填主程序的文本模型清单（失败就只留「跟随主程序默认」）。 */
async function hjAiLoadModels() {
    var el = $('hjAiModel');
    if (!el || el.getAttribute('data-filled') === '1') return;
    try {
        var d = await (await fetch('/api/drama/models')).json();
        var tm = (d && d.text_models) || {};
        var pairs = [];
        if (Array.isArray(tm)) {
            tm.forEach(function (x) {
                if (x && x.id) pairs.push([x.id, x.name || x.id]);
            });
        } else {
            Object.keys(tm).forEach(function (k) { pairs.push([k, tm[k] || k]); });
        }
        if (!pairs.length) return;
        var html = '<option value="">跟随主程序默认</option>';
        pairs.forEach(function (p) {
            html += '<option value="' + esc(p[0]) + '">' + esc(p[1]) + '</option>';
        });
        el.innerHTML = html;
        el.setAttribute('data-filled', '1');
    } catch (e) {
        // 静默降级：下拉只有「跟随主程序默认」也能正常出片
    }
}
window.hjAiLoadModels = hjAiLoadModels;

function aiParams() {
    // 音频来源三分支：voice（配音）/ bgm_upload（上传BGM）/ bgm_library（在线曲库）
    var src = HJ.audioSource || 'voice';
    var p = {
        requirement: $('hjAiReq') ? $('hjAiReq').value.trim() : '',
        duration: $('hjAiDuration') ? parseFloat($('hjAiDuration').value) || 30 : 30,
        canvas: $('hjAiCanvas') ? $('hjAiCanvas').value : '16:9',
        audio_source: src,
        // 音色 id 形如 'moss:Junhao' / 'edge:zh-CN-XiaoxiaoNeural'（引擎:音色）
        voice: ($('hjAiVoice') && $('hjAiVoice').value) || HJ.defaultVoice || 'moss:Zhiming',
        voice_speed: $('hjAiSpeed') ? $('hjAiSpeed').value : '1.0',
        voice_style: $('hjAiStyle') ? $('hjAiStyle').value : 'natural',
        // BGM 音量：默认 60%（50~70% 区间中值），保证人声清晰
        bgm_gain: $('hjAiBgmGain') ? parseFloat($('hjAiBgmGain').value) || 0.6 : 0.6,
        duck_bgm: true,
        // 原片静音（默认 true）：控制素材自带的声音是否保留
        mute_original: HJ.muteOriginal !== false,
        // V1.8.365：面板上的模型 / 温度 / 思考 / 素材来源
        model: $('hjAiModel') ? $('hjAiModel').value : '',
        temperature: $('hjAiTemp') ? (parseFloat($('hjAiTemp').value) || 1.2) : 1.2,
        thinking: $('hjAiThink') ? ($('hjAiThink').value === '1') : false,
        sources: hjAiSources(),
    };
    // 上传 BGM 分支
    if (src === 'bgm_upload' && HJ.bgmUpload) {
        p.bgm_asset_id = HJ.bgmUpload.id;
    }
    // 在线曲库分支
    if (src === 'bgm_library' && HJ.musicPick) {
        p.bgm_music = {
            title: HJ.musicPick.title, source: HJ.musicPick.source,
            mp3: HJ.musicPick.mp3, local_path: HJ.musicPick.local_path || '',
        };
    }
    return p;
}

function renderAiScript(script) {
    var box = $('hjAiScriptBox');
    var list = $('hjAiShots');
    if (!box || !list || !script) return;
    box.style.display = '';
    HJ.script = script;                 // 存一份，供「继续出片」提交
    var meta = $('hjAiScriptMeta');
    var target = $('hjAiDuration') ? parseFloat($('hjAiDuration').value) || 0 : 0;
    var chars = script.narration_chars || 0;
    var txt = script.title + ' · ' + (script.shots || []).length + ' 镜'
        + ' · 预估 ' + script.total_duration + ' 秒';
    if (chars) txt += '（台词 ' + chars + ' 字）';
    if (target) {
        var diff = script.total_duration - target;
        txt += ' · 目标 ' + target + ' 秒';
        if (Math.abs(diff) > Math.max(2, target * 0.15)) {
            txt += '（' + (diff > 0 ? '偏长' : '偏短') + '，配音时会自动校准）';
        }
    }
    if (script.trimmed) txt += ' · 台词已按预算截断';
    if (script.model_fallback) txt += ' · 默认模型超时，本次用快档推演';
    txt += ' · 可直接编辑';
    if (meta) meta.textContent = txt;

    // 分镜可编辑：关键词 / 时长 / 台词（改完点「继续出片」生效）
    list.innerHTML = (script.shots || []).map(function (s, i) {
        return '<div class="hj-ai-shot">'
            + '<div class="hj-ai-no">' + (s.shot || (i + 1)) + '</div>'
            + '<div class="hj-ai-body">'
            + '<div class="hj-ai-line1">'
            + '<input class="hj-ai-edit-kw" value="' + esc(s.keyword || '') + '" '
            + 'placeholder="搜索关键词（英文）" oninput="hjEditShot(' + i + ',\'keyword\',this.value)">'
            + '<input class="hj-ai-edit-dur" type="number" min="1" step="0.5" value="'
            + (s.duration || 3) + '" oninput="hjEditShot(' + i + ',\'duration\',this.value)">'
            + '<span class="hj-ai-dur">秒</span>'
            + (s.effect && s.effect !== 'none' ? '<span class="hj-ai-fx">' + esc(s.effect) + '</span>' : '')
            + '</div>'
            + '<div class="hj-ai-visual">' + esc(s.visual || '') + '</div>'
            + '<input class="hj-ai-edit-narr" value="' + esc(s.narration || '') + '" '
            + 'placeholder="配音台词 / 字幕（留空则无旁白）" oninput="hjEditShot(' + i + ',\'narration\',this.value)">'
            + '</div></div>';
    }).join('');

    // 出现「继续合成影片」按钮（操作行 + 脚本区底部两个入口一起亮）
    var cont = $('hjAiContinueBtn');
    if (cont) cont.style.display = '';
    var contRow = $('hjAiContinueRow');
    if (contRow) contRow.style.display = '';
    // 脚本可能很长 —— 把「继续合成影片」滚进视野，别让用户以为没按钮
    try {
        if (contRow && contRow.scrollIntoView) {
            contRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    } catch (e) { /* 老浏览器忽略 */ }
}

window.hjPollAiTask = pollAiTask;

/* ========================================================================
 * 分镜素材预览 + 重搜（V1.8.372）
 * --------------------------------------------------------------------
 * 用户诉求：「搜索下载的分镜，要有预览的功能，不满意的可以选择重搜」。
 *   · 每镜一张缩略图卡片（能看标题/来源/时长），点缩略图可放大预览；
 *   · 每张卡片有「🔄 重搜」→ 弹出候选列表 → 点一条即采纳（立刻下载替换）。
 * ======================================================================== */
HJ.materials = [];          // 当前任务的素材列表
HJ.researchIdx = -1;        // 正在重搜的分镜序号

function hjMaterialsBox() {
    var box = $('hjAiMaterials');
    return box;
}

/** 渲染素材预览网格 */
function renderAiMaterials(list) {
    var box = hjMaterialsBox();
    if (!box) return;
    HJ.materials = list || [];
    if (!HJ.materials.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<div style="font-size:12px;color:var(--text2);margin:10px 0 6px;">'
        + '🎞 分镜素材预览（不满意可点「重搜」换一条）</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;">'
        + HJ.materials.map(function (m, i) {
            var thumb = m.thumb
                ? '<img src="' + esc(m.thumb) + '" loading="lazy" '
                + 'style="width:100%;height:88px;object-fit:cover;border-radius:6px;background:var(--surface2);'
                + 'cursor:pointer;" onclick="hjPreviewMaterial(' + i + ')" title="点击放大">'
                : '<div style="width:100%;height:88px;border-radius:6px;background:var(--surface2);'
                + 'display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text2);">无缩略图</div>';
            return '<div class="hj-mat-card" style="border:1px solid var(--border);border-radius:8px;padding:6px;">'
                + thumb
                + '<div style="font-size:11px;color:var(--text2);margin-top:4px;line-height:1.3;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(m.title || '') + '">'
                + esc(m.title || '（无标题）') + '</div>'
                + '<div style="font-size:10px;color:var(--text3);margin-top:2px;">'
                + esc(m.source || '') + ' · ' + (m.duration ? Math.round(m.duration) + 's' : '—')
                + (m.cached ? ' · 已下载' : '') + '</div>'
                + '<button class="btn btn-sm" style="width:100%;margin-top:5px;" '
                + 'onclick="hjResearchMaterial(' + i + ')">🔄 重搜</button>'
                + '</div>';
        }).join('')
        + '</div>'
        + '<div id="hjMatCandidates" style="margin-top:10px;"></div>';
}
window.hjRenderAiMaterials = renderAiMaterials;

/** 放大预览素材（用大图 + 链接到原站） */
function hjPreviewMaterial(i) {
    var m = (HJ.materials || [])[i];
    if (!m) return;
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;'
        + 'display:flex;align-items:center;justify-content:center;" onclick="this.remove()">'
        + '<div style="max-width:80vw;max-height:80vh;background:var(--surface);border-radius:10px;'
        + 'padding:14px;overflow:auto;" onclick="event.stopPropagation()">'
        + '<div style="font-size:13px;margin-bottom:8px;">第 ' + (i + 1) + ' 镜 · '
        + esc(m.title || '') + '</div>'
        + (m.thumb ? '<img src="' + esc(m.thumb) + '" style="max-width:100%;max-height:60vh;border-radius:8px;">' : '')
        + '<div style="margin-top:8px;font-size:11px;color:var(--text2);">'
        + esc(m.source || '') + ' · ' + esc(m.keyword || '')
        + (m.page_url ? ' · <a href="' + esc(m.page_url) + '" target="_blank" rel="noopener">看原站</a>' : '')
        + '</div></div></div>';
    var d = document.createElement('div');
    d.innerHTML = html;
    document.body.appendChild(d);
}
window.hjPreviewMaterial = hjPreviewMaterial;

/** 重搜某一镜 → 拉候选列表 */
async function hjResearchMaterial(i) {
    var box = $('hjMatCandidates');
    if (!box) return;
    var tid = HJ.aiTaskId;
    if (!tid) { toast('任务已结束，无法重搜', 'error'); return; }
    HJ.researchIdx = i;
    box.innerHTML = '<div style="font-size:12px;color:var(--text2);">正在重搜第 ' + (i + 1) + ' 镜…</div>';
    try {
        var r = await fetch('/api/hejian/ai/tasks/' + tid + '/materials/' + i + '/research',
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ per_platform: 6 }) });
        var d = await r.json();
        if (!d.success) {
            box.innerHTML = '<div style="color:var(--danger);font-size:12px;">重搜失败：'
                + esc(d.error || '未知错误') + '</div>';
            return;
        }
        var cands = d.candidates || [];
        box.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:6px;">'
            + '第 ' + (i + 1) + ' 镜「' + esc(d.keyword || '') + '」的候选（点一条采纳）：</div>'
            + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;">'
            + cands.map(function (c, ci) {
                return '<div style="border:1px solid var(--border);border-radius:8px;padding:6px;cursor:pointer;" '
                    + 'onclick="hjPickMaterial(' + i + ',' + ci + ')">'
                    + (c.thumb ? '<img src="' + esc(c.thumb) + '" loading="lazy" style="width:100%;height:80px;'
                        + 'object-fit:cover;border-radius:6px;background:var(--surface2);">' : '')
                    + '<div style="font-size:11px;color:var(--text2);margin-top:4px;overflow:hidden;'
                    + 'text-overflow:ellipsis;white-space:nowrap;" title="' + esc(c.title || '') + '">'
                    + esc(c.title || '') + '</div>'
                    + '<div style="font-size:10px;color:var(--text3);">' + esc(c.source || '') + '</div>'
                    + '</div>';
            }).join('') + '</div>';
        HJ.researchCands = cands;
    } catch (e) {
        box.innerHTML = '<div style="color:var(--danger);font-size:12px;">重搜异常：' + esc(e.message) + '</div>';
    }
}
window.hjResearchMaterial = hjResearchMaterial;

/** 采纳候选 → 后端下载替换 → 刷新预览 */
async function hjPickMaterial(i, ci) {
    var cand = (HJ.researchCands || [])[ci];
    if (!cand) return;
    var box = $('hjMatCandidates');
    if (box) box.innerHTML = '<div style="font-size:12px;color:var(--text2);">正在下载并替换第 '
        + (i + 1) + ' 镜素材…</div>';
    try {
        var r = await fetch('/api/hejian/ai/tasks/' + HJ.aiTaskId + '/materials/' + i + '/pick',
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ candidate: cand }) });
        var d = await r.json();
        if (!d.success) {
            if (box) box.innerHTML = '<div style="color:var(--danger);font-size:12px;">替换失败：'
                + esc(d.error || '未知错误') + '</div>';
            return;
        }
        toast('第 ' + (i + 1) + ' 镜素材已替换', 'success');
        await hjRefreshMaterials();
        if (box) box.innerHTML = '<div style="font-size:12px;color:var(--success);">已替换第 '
            + (i + 1) + ' 镜素材 ✓</div>';
    } catch (e) {
        if (box) box.innerHTML = '<div style="color:var(--danger);font-size:12px;">替换异常：'
            + esc(e.message) + '</div>';
    }
}
window.hjPickMaterial = hjPickMaterial;

/** 重新拉素材列表（替换后刷新） */
async function hjRefreshMaterials() {
    if (!HJ.aiTaskId) return;
    try {
        var r = await fetch('/api/hejian/ai/tasks/' + HJ.aiTaskId + '/materials');
        var d = await r.json();
        if (d.success) renderAiMaterials(d.materials || []);
    } catch (e) { /* 忽略 */ }
}
window.hjRefreshMaterials = hjRefreshMaterials;

/** AI 一键成片 */
async function hjAiStart() {
    var req = $('hjAiReq') ? $('hjAiReq').value.trim() : '';
    if (!req) { toast('请先描述你的创作需求', 'error'); return; }
    var btn = $('hjAiStartBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'AI 接管中…'; }
    try {
        var r = await fetch('/api/hejian/ai/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(aiParams()),
        });
        var d = await r.json();
        if (!d.success) { toast('提交失败：' + (d.error || ''), 'error'); return; }
        HJ.aiTaskId = d.task_id;
        pollAiTask();
    } catch (e) {
        toast('提交异常：' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🤖 AI 一键成片'; }
    }
}
window.hjAiStart = hjAiStart;

function pollAiTask() {
    if (HJ.aiTimer) clearInterval(HJ.aiTimer);
    HJ.aiTimer = setInterval(async function () {
        if (!HJ.aiTaskId) return;
        var d;
        try {
            d = await (await fetch('/api/hejian/ai/tasks/' + HJ.aiTaskId)).json();
        } catch (e) { return; }
        var t = d.task || {};
        var box = $('hjAiProgress');
        var pct = t.percent || 0;
        // 🔴 V1.8.372：选材完成后拉一次素材预览（供用户预览/重搜）
        if (t.stage === 'download' || t.stage === 'voice' || t.stage === 'render'
            || t.status === 'completed') {
            if (!HJ.materials.length) hjRefreshMaterials();
        }
        if (box) {
            box.style.display = '';
            if (t.script) renderAiScript(t.script);
            if (t.status === 'completed') {
                var segs = (t.segments || []).map(function (s) {
                    return '<div class="hj-ai-pick">'
                        + '<span class="hj-ai-no">' + (s.shot || '·') + '</span>'
                        + '<span class="hj-ai-src">' + esc(s.source || '') + '</span>'
                        + '<span class="hj-ai-title">' + esc(s.title || '') + '</span>'
                        + '<span class="hj-ai-score">' + (s.score != null ? Math.round(s.score) : '') + '</span>'
                        + '</div>';
                }).join('');
                box.innerHTML = '<div style="color:var(--success);font-size:13px;margin-bottom:8px;">✓ AI 成片完成</div>'
                    + '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">'
                    + 'AI 为每一镜从三家素材库中挑选的最佳素材：</div>'
                    + segs;
                var res = $('hjAiResult');
                if (res) {
                    res.style.display = '';
                    res.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
                        + '<video src="' + t.video_url + '" controls style="max-width:560px;border-radius:10px;background:#000;"></video>'
                        + '<div>'
                        + '<a class="btn btn-sm" href="' + t.video_url + '" download>⬇ 下载 MP4</a>'
                        + '<div style="font-size:11px;color:var(--text2);margin-top:5px;">'
                        + (t.size ? (t.size / 1048576).toFixed(2) + ' MB' : '') + '</div>'
                        + '</div></div>';
                }
                clearInterval(HJ.aiTimer); HJ.aiTimer = null; HJ.aiTaskId = '';
                hjLoadRecords();              // 成片已归档 → 刷新生成记录栏
                return;
            }
            if (t.status === 'failed') {
                box.innerHTML = '<div style="color:var(--danger);font-size:13px;">✗ ' + esc(t.message || 'AI 流水线失败')
                    + '</div><pre style="font-size:11px;color:var(--text2);white-space:pre-wrap;max-height:200px;overflow:auto;">'
                    + esc((t.error || '').slice(-1200)) + '</pre>';
                clearInterval(HJ.aiTimer); HJ.aiTimer = null; HJ.aiTaskId = '';
                return;
            }
            // 🔴 V1.8.370：素材下载阶段显示实时网速 + 已下载量
            var speedHtml = '';
            if (t.stage === 'download' && (t.speed_bps || t.downloaded_bytes)) {
                var sp = t.speed_text || '';
                if (!sp && t.speed_bps) {
                    sp = (t.speed_bps >= 1048576)
                        ? (t.speed_bps / 1048576).toFixed(1) + ' MB/s'
                        : Math.round(t.speed_bps / 1024) + ' KB/s';
                }
                var doneMB = t.downloaded_bytes ? (t.downloaded_bytes / 1048576).toFixed(1) + ' MB' : '';
                var totalMB = t.total_bytes ? (t.total_bytes / 1048576).toFixed(1) + ' MB' : '';
                var parts = [];
                if (sp) parts.push('↓ ' + sp);
                if (doneMB) parts.push('已下载 ' + doneMB + (totalMB ? ' / ' + totalMB : ''));
                if (parts.length) {
                    speedHtml = '<div style="font-size:11px;color:var(--text2);margin-top:4px;'
                        + 'display:flex;align-items:center;gap:8px;">'
                        + '<span style="font-variant-numeric:tabular-nums;">' + esc(parts.join('　')) + '</span>'
                        + '</div>';
                }
            }
            box.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:6px;">'
                + esc(t.message || 'AI 处理中…') + ' (' + pct + '%)</div>'
                + '<div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;">'
                + '<div style="height:100%;width:' + pct + '%;background:var(--primary);transition:width .3s;"></div></div>'
                + speedHtml;
        }
    }, 1500);
}
window.hjPollAiTask = pollAiTask;
/* ========================================================================
 * 生成记录 —— 展示归档到「合剪视频」目录的成片
 * ======================================================================== */
async function hjLoadRecords() {
    var box = $('hjRecordList');
    if (!box) return;
    try {
        var d = await (await fetch('/api/hejian/records')).json();
        var recs = d.records || [];
        var meta = $('hjRecordsMeta');
        if (meta) {
            meta.textContent = (d.output_dir && d.output_dir.count != null)
                ? ('共 ' + recs.length + ' 条 · 已归档 ' + d.output_dir.count + ' 个文件')
                : (recs.length + ' 条');
        }
        if (!recs.length) {
            box.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:14px;">'
                + '还没有生成记录 —— 合成完成后会自动归档到「合剪视频」目录</div>';
            return;
        }
        box.innerHTML = recs.map(function (r) {
            var sz = r.size ? (r.size / 1048576).toFixed(2) + ' MB' : '';
            var dur = r.duration ? Math.round(r.duration) + 's' : '';
            var tag = r.mode === 'ai'
                ? '<span class="hj-rec-tag hj-rec-ai">AI</span>'
                : '<span class="hj-rec-tag">手动</span>';
            var picks = (r.picks || []).slice(0, 3).map(function (p) {
                return '<span class="hj-rec-pick" title="' + esc(p.title || '') + '">'
                    + esc((p.source || '') + '·' + (p.title || '').slice(0, 16)) + '</span>';
            }).join('');
            return '<div class="hj-rec" data-id="' + esc(r.id) + '">'
                + '<div class="hj-rec-thumb" onclick="hjPlayRecord(\'' + esc(r.id) + '\')">'
                + '<video src="' + esc(r.url) + '" preload="metadata" muted></video>'
                + '<span class="hj-rec-play">▶</span></div>'
                + '<div class="hj-rec-body">'
                + '<div class="hj-rec-line1">'
                + tag
                + '<span class="hj-rec-title">' + esc(r.title || '合剪成片') + '</span>'
                + '<span class="hj-rec-time">' + esc(r.created || '') + '</span>'
                + '</div>'
                + (r.requirement ? '<div class="hj-rec-req">' + esc(r.requirement) + '</div>' : '')
                + '<div class="hj-rec-line2">'
                + '<span>' + esc(r.canvas || '') + '</span>'
                + (dur ? '<span>' + dur + '</span>' : '')
                + (sz ? '<span>' + sz + '</span>' : '')
                + (r.segments ? '<span>' + r.segments + ' 镜</span>' : '')
                + picks
                + '</div></div>'
                + '<div class="hj-rec-acts">'
                + '<a class="btn btn-sm" href="' + esc(r.url) + '" download title="下载">⬇</a>'
                + '<a class="btn btn-sm" href="' + esc(r.url) + '" target="_blank" title="新窗口打开">↗</a>'
                + '<button class="btn btn-sm" onclick="hjDeleteRecord(\'' + esc(r.id) + '\')" title="删除">✕</button>'
                + '</div></div>';
        }).join('');
    } catch (e) {
        box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:14px;">'
            + '记录加载失败：' + esc(e.message) + '</div>';
    }
}
window.hjLoadRecords = hjLoadRecords;

window.hjPlayRecord = function (id) {
    var el = document.querySelector('.hj-rec[data-id="' + id + '"] video');
    if (!el) return;
    if (el.paused) { el.play(); return; }
    el.pause();
};

window.hjDeleteRecord = async function (id) {
    if (!confirm('删除这条记录（同时删除归档文件）？')) return;
    var r = await fetch('/api/hejian/records/' + encodeURIComponent(id), { method: 'DELETE' });
    var d = await r.json();
    if (!d.success) { toast('删除失败：' + (d.error || ''), 'error'); return; }
    toast('已删除', 'success');
    await hjLoadRecords();
};

window.hjOpenOutputFolder = async function () {
    var r = await fetch('/api/hejian/records/open-folder', { method: 'POST' });
    var d = await r.json();
    if (d.success) toast('已打开：' + (d.path || ''), 'success');
    else toast('打开失败：' + (d.message || d.error || ''), 'error');
};

})();
