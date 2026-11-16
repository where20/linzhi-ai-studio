/**
 * 临智AI 本地适配层（Local API Adapter）
 * ----------------------------------------------------------------
 * 目标：本地完整网站，无需登录、无需原站会员。
 *   1. 门禁/账号/会员接口 → 本地放行桩（bootGate 直接 unlocked）
 *   2. /api/config       → config.json 本地配置中心（Key 落盘、掩码回显）
 *   3. AI 能力直连       → /api/ai/chat、/api/image/*、/api/video/* 走 Agnes AI
 *   4. 热点新闻          → /api/news/* 聚合公开 RSS（36kr/IT之家/少数派/极客公园/量子位）
 *   5. 作品墙            → /api/gallery/* 本地 JSON 存储
 *   6. 上传              → /api/upload/image 本地落盘 output/uploads
 *
 * 未覆盖的 /api/* 端点继续走原站代理（server.js 兜底），互不影响。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// BYOK 解析（线上融合）：三轨 KEY —— 请求头 > config 内置 > 免 Key 回落
let _byok = null;
async function getByok() {
    if (!_byok) _byok = await import('./lib/byok.mjs');
    return _byok;
}

const OUTPUT_DIR = path.join(__dirname, 'output');
const PICTURES_DIR = path.join(OUTPUT_DIR, 'pictures');
const VIDEOS_DIR = path.join(OUTPUT_DIR, 'videos');
const UPLOADS_DIR = path.join(OUTPUT_DIR, 'uploads');
const GALLERY_DB = path.join(OUTPUT_DIR, 'gallery.json');
for (const d of [PICTURES_DIR, VIDEOS_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true });

// ===== Agnes 客户端（复用 image-studio 验证过的实现，ESM 动态加载）=====
let _agnes = null;
/** ctx 由 BYOK 解析给出：{api_key, baseUrl}；传入则用自带 KEY 覆盖 config 内置 */
async function getAgnes(cfg, ctx) {
    if (!_agnes) {
        const mod = await import('./lib/agnes-client.mjs');
        _agnes = new mod.AgnesClient({
            apiKey: '',
            baseUrl: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
            timeoutMs: 120000,
        });
    }
    const key = (ctx && ctx.api_key) || (cfg.ai && cfg.ai.api_key) || process.env.AGNES_API_KEY || '';
    const base = (ctx && ctx.baseUrl) || (cfg.ai && cfg.ai.agnes_base_url) || process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
    _agnes.configure({ apiKey: key, baseUrl: base });
    return _agnes;
}

/** 从请求解析本次调用的 AI 上下文（BYOK 优先） */
async function ctxFor(req) {
    const byok = await getByok();
    return byok.resolveAiContext(req, _getConfig ? _getConfig() : {});
}

// ===== 免 Key 通道（Pollinations / imagefree / Veda，从 Free AI Studio bundle 逆向还原）=====
// 无 AGNES Key 或显式 provider=free 时使用：文本 / 生图 / 视频 全部零 Key 可用
let _free = null;
async function getFree() {
    if (!_free) {
        const mod = await import('./lib/free-providers.mjs');
        _free = Object.assign({}, mod, {
            veda: mod.makeVeda(
                (process.env.VEDA_BASE_URL || mod.ENDPOINTS.veda),
                mod.makeDeviceStore(path.join(OUTPUT_DIR, '.free-device.json'))
            ),
        });
    }
    return _free;
}

// ===== 本地分镜工作台（替掉走源站的 dramapro）=====
let _sb = null;
let _getConfig = null;   // 由 install() 注入

/** 统一的文本模型调用：Agnes 直连优先，Key 失效/缺失自动回落免 Key */
async function callTextModel({ system, user, model, provider, maxTokens, timeoutMs }) {
        const cfg = _getConfig ? _getConfig() : {};
        const ai = readAi(cfg);
        const wantFree = ['free', 'pollinations'].includes(String(provider || '').toLowerCase());
        const useFree = wantFree || !ai.api_key || !!cfg.ai?.prefer_free;
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

        if (!useFree) {
            try {
                const agnes = await getAgnes(cfg);
                const usedModel = model || ai.default_text_model || 'agnes-2.5-flash';
                let text = '';
                let think = '';
                await agnes.chatStream(
                    { model: usedModel, messages, temperature: 0.7, maxTokens, thinking: false },
                    { onDelta: (c) => { text += c; }, onReasoning: (c) => { think += c; } }
                );
                const out = text.trim() ? text : (think.trim() || '');
                if (!out) throw new Error('模型返回为空');
                return { text: out, provider: 'agnes', model: usedModel };
            } catch (e) {
                if (!isKeyError(e && e.message)) throw e;
                // Key 失效 → 落到下面的免 Key
            }
        }
        const free = await getFree();
        const r = await free.pollinationsText({
            messages, model: 'openai-fast', maxTokens: Math.min(maxTokens || 8192, 8192),
        });
        return { text: r.content || r.reasoning, provider: useFree ? 'pollinations' : 'pollinations(fallback)', model: 'openai-fast' };
}

async function getStoryboard() {
    if (!_sb) {
        const mod = await import('./lib/storyboard.mjs');
        _sb = mod.createStoryboardEngine({ storeDir: OUTPUT_DIR, callModel: callTextModel });
    }
    return _sb;
}

// ===== 本地配置读写（挂在 config.json 的 ai 字段下，与后端代理配置共存）=====
const AI_FIELDS = ['api_key', 'sensenova_api_key', 'deepseek_api_key', 'doubao_api_key',
    'qwen_api_key', 'minimax_api_key', 'dots_api_key',
    'default_text_model', 'default_image_model', 'default_video_model',
    'tts_base_url', 'tts_api_key', 'tts_model', 'tts_voice'];

function readAi(cfg) {
    return Object.assign({
        api_key: '',
        sensenova_api_key: '',
        deepseek_api_key: '',
        doubao_api_key: '',
        qwen_api_key: '',
        minimax_api_key: '',
        dots_api_key: '',
        default_text_model: 'agnes-2.5-flash',
        default_image_model: 'agnes-image-2.5-flash',
        default_video_model: 'agnes-video-2.5-flash',
    }, (cfg && cfg.ai) || {});
}
function writeAi(cfg, patch) {
    cfg.ai = Object.assign(readAi(cfg), patch || {});
    return cfg.ai;
}
function mask(k) { return k ? k.substring(0, 6) + '****' + k.slice(-4) : ''; }

// ===== 异步任务存储（对话 job / 视频 task）=====
const jobs = new Map();     // chat job_id -> {status, reply, error, model, mode, started}
const videoTasks = new Map(); // task_id -> {id, status, model, prompt, provider, agnesVideoId|jobId, started, local_file, error}

// 视频任务落盘：服务重启不丢任务（免 Key 任务尤其重要 —— 提交时额度已扣，丢了就白扣）
const VIDEO_TASKS_DB = path.join(OUTPUT_DIR, '.video-tasks.json');
(function restoreVideoTasks() {
    try {
        const arr = JSON.parse(fs.readFileSync(VIDEO_TASKS_DB, 'utf8'));
        if (Array.isArray(arr)) for (const t of arr) if (t && t.id) videoTasks.set(t.id, t);
    } catch { /* 首次运行无文件 */ }
})();
function saveVideoTasks() {
    try {
        fs.writeFileSync(VIDEO_TASKS_DB, JSON.stringify([...videoTasks.values()].slice(-200), null, 2));
    } catch { /* 落盘失败不影响主流程 */ }
}

function hashName(prefix, ext) {
    return prefix + '_' + crypto.randomBytes(6).toString('hex') + '.' + ext;
}

/** Key 失效类错误（额度用尽 / 被删 / 无效）：命中则回落免 Key 通道，而不是把错误丢给用户 */
function isKeyError(msg) {
    return /Key 无效|无效的.{0,4}Key|token status is unavailable|invalid[ _-]?api[ _-]?key|unauthorized|missing[ _-]?bearer|余额不足|quota|exceeded/i
        .test(String(msg || ''));
}

// ===== 上传 =====
const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => {
            const ext = (path.extname(file.originalname || '') || '.png').slice(0, 8);
            cb(null, hashName('up', ext.replace(/[^.a-z0-9]/gi, '') || '.png'));
        },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// ===== RSS 抓取与解析（无依赖，正则够用）=====
const RSS_CACHE = { news: { at: 0, data: null }, trending: { at: 0, data: null } };
const NEWS_TTL = 30 * 60 * 1000;

function fetchText(url, timeoutMs = 15000) {
    return fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LinzhiAI/1.0', 'Accept': '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
    }).then(r => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))));
}

function parseRss(xml, limit = 20) {
    const items = [];
    const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/g) || [];
    for (const b of blocks.slice(0, limit)) {
        const pick = (tag) => {
            const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
            if (!m) return '';
            return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        };
        const linkM = b.match(/<link[^>]*href="([^"]+)"/i);
        const title = pick('title');
        const url = pick('link') || (linkM && linkM[1]) || '';
        const pub = pick('pubDate') || pick('updated') || pick('published');
        if (title && url) items.push({ title, url, ts: pub ? new Date(pub).getTime() || 0 : Date.now() });
    }
    return items;
}

const RSS_SOURCES = [
    { name: '36氪', color: '#2b7cff', url: 'https://www.36kr.com/feed', category: '科技商业' },
    { name: 'IT之家', color: '#e8452c', url: 'https://www.ithome.com/rss/', category: '数码科技' },
    { name: '少数派', color: '#d71a18', url: 'https://sspai.com/feed', category: '效率工具' },
    { name: '极客公园', color: '#1a9d5c', url: 'https://www.geekpark.net/rss', category: '前沿创新' },
    { name: '量子位', color: '#8b5cf6', url: 'https://www.qbitai.com/feed', category: 'AI 资讯' },
];

function fmtTs(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadRssAll() {
    const results = await Promise.allSettled(RSS_SOURCES.map(async s => {
        const xml = await fetchText(s.url, 15000);
        return { ...s, items: parseRss(xml, 25) };
    }));
    return results.filter(r => r.status === 'fulfilled' && r.value.items.length).map(r => r.value);
}

// ===== 图片尺寸 → Agnes tier/ratio 映射 =====
function sizeToTierRatio(size) {
    const m = String(size || '').match(/^(\d+)x(\d+)$/);
    if (!m) return { tier: '1K', ratio: '1:1' };
    const w = +m[1], h = +m[2];
    const r = w / h;
    const ratios = [[1, '1:1'], [3 / 4, '3:4'], [4 / 3, '4:3'], [16 / 9, '16:9'], [9 / 16, '9:16'], [2 / 3, '2:3'], [3 / 2, '3:2'], [21 / 9, '21:9']];
    let best = ratios[0], bd = Infinity;
    for (const [v, name] of ratios) { const d = Math.abs(r - v); if (d < bd) { bd = d; best = [v, name]; } }
    const long = Math.max(w, h);
    const tier = long >= 3500 ? '4K' : long >= 2500 ? '3K' : long >= 1800 ? '2K' : '1K';
    return { tier, ratio: best[1] };
}

async function saveImageFromResult(out) {
    // Agnes 返回 url 或 b64 —— 统一落盘到 output/pictures
    const name = hashName('img', 'png');
    const dest = path.join(PICTURES_DIR, name);
    try {
        if (out.b64) {
            fs.writeFileSync(dest, Buffer.from(out.b64, 'base64'));
        } else if (out.url) {
            const resp = await fetch(out.url, { signal: AbortSignal.timeout(120000) });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
        } else {
            throw new Error('无图片内容');
        }
        return { local_file: 'pictures/' + name, url: '/output/pictures/' + name };
    } catch (e) {
        // 落盘失败 → 直接给上游 URL，页面照样能显示
        if (out.url) return { local_file: '', url: out.url };
        throw e;
    }
}

function readGallery() {
    try { return JSON.parse(fs.readFileSync(GALLERY_DB, 'utf-8')); } catch { return []; }
}
function writeGallery(list) { fs.writeFileSync(GALLERY_DB, JSON.stringify(list, null, 2)); }

// =====================================================================
// 安装路由（必须在 /api 代理之前注册）
// =====================================================================
function install(app, { getConfig, saveConfig }) {
    _getConfig = getConfig;

    const json = (res, code, obj) => { res.status(code).json(obj); };

    // ---------- 门禁 / 账号 / 会员：全部本地放行 ----------
    app.get('/api/member/gate', (req, res) => json(res, 200, { success: true, unlocked: true, gate: 'none' }));
    app.get('/api/member/whoami', (req, res) => json(res, 200, {
        success: true, display_name: '本地用户', hint: '本地完整版 · 免登录', member: { id: 'local', email: 'local@localhost' },
    }));
    app.post('/api/member/logout', (req, res) => json(res, 200, { success: true, logged_out: false, message: '本地模式无需登出' }));
    app.get('/api/auth/ciam/status', (req, res) => json(res, 200, { success: true, enabled: false }));
    app.post('/api/account/send-code', (req, res) => json(res, 200, { success: true, message: '本地模式无需验证码，直接使用即可' }));
    app.post('/api/account/bind-card', (req, res) => json(res, 200, { success: true, message: '本地模式无需绑卡，全部功能已解锁' }));
    app.post('/api/account/login', (req, res) => json(res, 200, { success: true, message: '本地模式无需登录' }));
    app.post('/api/account/register', (req, res) => json(res, 200, { success: true, message: '本地模式无需注册' }));

    // ---------- 本地配置中心 ----------
    app.get('/api/config', (req, res) => {
        const cfg = getConfig();
        const ai = readAi(cfg);
        json(res, 200, {
            success: true,
            api_key_masked: mask(ai.api_key),
            sensenova_api_key_masked: mask(ai.sensenova_api_key),
            deepseek_api_key_masked: mask(ai.deepseek_api_key),
            doubao_api_key_masked: mask(ai.doubao_api_key),
            qwen_api_key_masked: mask(ai.qwen_api_key),
            minimax_api_key_masked: mask(ai.minimax_api_key),
            dots_api_key_masked: mask(ai.dots_api_key),
            sensenova_api_key_set: !!ai.sensenova_api_key,
            api_key_set: !!ai.api_key,
            default_text_model: ai.default_text_model,
            default_image_model: ai.default_image_model,
            default_video_model: ai.default_video_model,
            mode: 'local-full',
        });
    });

    // 线上融合契约：只回显 KEY 状态，不落盘、不回传明文（GET 走请求头 BYOK 判断）
    app.get('/api/config/status', async (req, res) => {
        const byok = await getByok();
        json(res, 200, byok.keyStatus(req, getConfig()));
    });

    app.post('/api/config', async (req, res) => {
        const body = req.body || {};
        const cfg = getConfig();
        const patch = {};
        for (const f of AI_FIELDS) if (typeof body[f] === 'string' && body[f].trim() !== '') patch[f] = body[f].trim();
        const ai = writeAi(cfg, patch);
        saveConfig();
        // 配了 agnes key 就顺带验证一次
        let verified = null;
        if (patch.api_key) {
            try {
                const agnes = await getAgnes(cfg);
                const probe = await agnes.verifyCredentials();
                verified = probe.ok;
            } catch (e) { verified = false; }
        }
        json(res, 200, { success: true, saved: Object.keys(patch), verified, api_key_masked: mask(ai.api_key) });
    });

    app.post('/api/config/test-key', async (req, res) => {
        const { vendor, api_key: key, channel } = req.body || {};
        const cfg = getConfig();
        const byok = await getByok();
        if (vendor === 'agnes' || vendor === 'sensenova' || !vendor) {
            if (!key) return json(res, 200, { success: false, error: 'Key 为空' });
            if (vendor === 'agnes' && !/^sk-/.test(key)) {
                return json(res, 200, { success: false, error: 'AGNES Key 必须以 sk- 开头' });
            }
            try {
                if (vendor === 'sensenova') {
                    // 商汤：发一张最小尺寸图探活
                    const mod = await import('./lib/sensenova-client.mjs');
                    const tmp = new mod.SenseNovaClient({ apiKey: key, timeoutMs: 60000 });
                    await tmp.generateImage({ prompt: 'test', model: 'sensenova-u1.5-lite', size: '512x512' }, { timeoutMs: 60000 });
                    return json(res, 200, { success: true, message: '商汤 Key 有效' });
                }
                const mod = await import('./lib/agnes-client.mjs');
                const baseUrl = channel === 'cn' ? byok.AGNES_BASE.cn : byok.AGNES_BASE.com;
                const tmp = new mod.AgnesClient({ apiKey: key, baseUrl, timeoutMs: 30000 });
                const probe = await tmp.verifyCredentials();
                return json(res, 200, probe.ok
                    ? { success: true, message: `Key 有效（${channel === 'cn' ? '国内' : '国际'}通道）`, channel: channel === 'cn' ? 'cn' : 'com' }
                    : { success: false, error: probe.reason || 'Key 验证未通过' });
            } catch (e) {
                return json(res, 200, { success: true, message: '网络波动，Key 未实测（按原样保留）' });
            }
        }
        json(res, 200, { success: true, message: vendor + ' Key 已保存（本地模式不实测该通道）' });
    });

    // ---------- AI 对话（Agnes 直连，支持异步 job）----------
    app.post('/api/ai/chat', async (req, res) => {
        const body = req.body || {};
        const cfg = getConfig();
        const ai = readAi(cfg);
        const ctx = await ctxFor(req);              // BYOK：请求头 KEY 优先
        const model = body.model || ai.default_text_model || 'agnes-2.5-flash';
        const wantFree = ['free', 'pollinations', 'blockrun'].includes(String(body.provider || '').toLowerCase());
        const useFree = wantFree || !ctx.api_key || !!cfg.ai?.prefer_free;
        const messages = [];
        for (const m of (Array.isArray(body.history) ? body.history : []).slice(-20)) {
            if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
        }
        // 多模态：带图时构造 content 数组（text + image_url）
        const images = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 5) : [];
        let userContent;
        if (images.length) {
            userContent = [{ type: 'text', text: body.message || '' }]
                .concat(images.map(u => ({ type: 'image_url', image_url: { url: u } })));
        } else {
            userContent = body.message || '';
        }
        messages.push({ role: 'user', content: userContent });

        const started = Date.now();
        let usedProvider = useFree ? 'pollinations' : 'agnes';
        const runFree = async () => {
            // 免 Key 文本：Pollinations（OpenAI 兼容），不支持多模态图，剔掉图片部分
            const free = await getFree();
            const plain = messages.map(m => ({
                role: m.role,
                content: Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : m.content,
            }));
            const out = await free.pollinationsText({ messages: plain, model: 'openai-fast', maxTokens: 2048 });
            return out.content || out.reasoning || '';
        };
        const run = async () => {
            if (useFree) return runFree();
            try {
                const agnes = await getAgnes(cfg, ctx);
                let reply = '';
                let thinking = '';
                await agnes.chatStream(
                    { model, messages, temperature: 0.7, thinking: !!body.think },
                    {
                        onDelta: (c) => { reply += c; },
                        onReasoning: (c) => { thinking += c; },
                        signal: undefined,
                    }
                );
                // 正文为空但思维链有内容时兜底展示
                return reply.trim() ? reply : (thinking.trim() || '');
            } catch (e) {
                // Key 失效 / 额度用尽 → 自动回落免 Key，而不是报错给用户
                if (!isKeyError(e && e.message)) throw e;
                usedProvider = 'pollinations(fallback)';
                return runFree();
            }
        };

        if (body.async) {
            const jobId = 'job' + crypto.randomBytes(6).toString('hex');
            jobs.set(jobId, { status: 'running', stage: '模型思考中', started });
            run().then(reply => {
                jobs.set(jobId, {
                    status: 'done', reply, model, mode: body.think ? 'think' : 'quick',
                    web_used: 0, elapsed: Math.round((Date.now() - started) / 1000), sources: [],
                    provider: usedProvider,
                });
            }).catch(e => {
                jobs.set(jobId, { status: 'failed', error: e.message || String(e), model, elapsed: Math.round((Date.now() - started) / 1000) });
            });
            return json(res, 200, { success: true, job_id: jobId });
        }

        try {
            const reply = await run();
            json(res, 200, {
                success: true, reply, model: useFree ? 'pollinations/openai-fast' : model,
                mode: body.think ? 'think' : 'quick', provider: usedProvider,
                web_used: 0, elapsed: Math.round((Date.now() - started) / 1000), sources: [],
            });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || '模型调用失败' });
        }
    });

    app.get('/api/ai/chat/status', (req, res) => {
        const j = jobs.get(req.query.job_id);
        if (!j) return json(res, 404, { success: false, error: '任务不存在或已过期' });
        json(res, 200, { success: true, ...j });
    });

    // ---------- 双模型生图：商汤 + Agnes 并行（线上「双模型同时出」融合）----------
    let _sn = null;
    async function getSenseNova() {
        if (!_sn) {
            const mod = await import('./lib/sensenova-client.mjs');
            _sn = new mod.SenseNovaClient({ apiKey: '' });
        }
        return _sn;
    }
    async function handleBothImage(req, res, { body, cfg, ai, ctx, prompt, refs, tier, ratio, size }) {
        const snModel = body.sn_model || ai.default_sn_image_model || 'sensenova-u1.5-lite';
        const agModel = body.agnes_model || ai.default_image_model || 'agnes-image-2.5-flash';
        const tasks = [];

        // Agnes 轨
        tasks.push((async () => {
            if (!ctx.api_key) return { provider: 'agnes', ok: false, error: '无 Agnes KEY（BYOK 与内置都空）' };
            try {
                const agnes = await getAgnes(cfg, ctx);
                const out = await agnes.generateImage({ prompt, model: agModel, size: tier, ratio, images: refs }, { timeoutMs: 300000, retries: 1 });
                const saved = await saveImageFromResult(out);
                return { provider: 'agnes', ok: true, image_url: saved.url, local_file: saved.local_file, model: agModel, elapsed: out.elapsedMs };
            } catch (e) { return { provider: 'agnes', ok: false, error: (e && e.message) || 'Agnes 生图失败' }; }
        })());

        // 商汤轨（参考图仅 Agnes 支持，有 refs 时商汤跳过）
        tasks.push((async () => {
            if (!ctx.sensenova_api_key) return { provider: 'sensenova', ok: false, error: '无商汤 KEY' };
            if (refs.length) return { provider: 'sensenova', ok: false, error: '参考图模式商汤不支持' };
            try {
                const sn = await getSenseNova();
                sn.configure({ apiKey: ctx.sensenova_api_key, baseUrl: ctx.snBaseUrl });
                const out = await sn.generateImage({ prompt, model: snModel, size });
                const saved = await saveImageFromResult(out);
                return { provider: 'sensenova', ok: true, image_url: saved.url, local_file: saved.local_file, model: snModel, elapsed: out.elapsedMs };
            } catch (e) { return { provider: 'sensenova', ok: false, error: (e && e.message) || '商汤生图失败' }; }
        })());

        const results = await Promise.all(tasks);
        const ok = results.filter(r => r.ok);
        const primary = ok.find(r => r.provider === 'agnes') || ok[0];
        if (!primary) {
            return json(res, 200, { success: false, error: '双模型均失败：' + results.map(r => `${r.provider}=${r.error}`).join('；') });
        }
        json(res, 200, {
            success: true,
            image_url: primary.image_url, local_file: primary.local_file,
            model: primary.model, provider: primary.provider, key_source: ctx.source,
            dual: true, results,                     // 两组结果都回，前端可择优
            degraded: ok.length === 1,
        });
    }

    // ---------- 生图 / 图生图（Agnes 直连；无 Key 或 provider=free 走免 Key 通道）----------
    async function handleImage(req, res, withRefs) {
        const body = req.body || {};
        const cfg = getConfig();
        const ai = readAi(cfg);
        const ctx = await ctxFor(req);              // BYOK：请求头 KEY 优先
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 200, { success: false, error: 'prompt 不能为空' });
        const refs = withRefs ? (Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean).slice(0, 4) : []) : [];
        const wantFree = ['free', 'pollinations', 'imagefree'].includes(String(body.provider || '').toLowerCase());
        const useFree = wantFree || !ctx.api_key || !!cfg.ai?.prefer_free;

        if (useFree) {
            if (refs.length) return json(res, 200, { success: false, error: '免 Key 通道不支持参考图（图生图）；请在 ⚙ 设置填入 AGNES Key' });
            try {
                const free = await getFree();
                const out = await free.freeImage({ prompt, size: body.size || '1024x1024', seed: body.seed });
                const name = hashName('img', out.ext || 'jpg');
                fs.writeFileSync(path.join(PICTURES_DIR, name), out.bytes);
                return json(res, 200, {
                    success: true,
                    image_url: '/output/pictures/' + name,
                    local_file: 'pictures/' + name,
                    model: out.provider + (out.provider === 'pollinations' ? '/flux' : ''),
                    provider: out.provider,
                    free_tier: true,
                    watermark_cropped: !!out.watermark_cropped,
                    failover_log: out.failover_log?.length ? out.failover_log : undefined,
                    elapsed: 0,
                });
            } catch (e) {
                return json(res, 200, { success: false, error: (e && e.message) || '免 Key 生图失败' });
            }
        }

        const { tier, ratio } = sizeToTierRatio(body.size);
        const model = body.model || ai.default_image_model || 'agnes-image-2.5-flash';
        try {
            // 双模型（both）：商汤 + Agnes 并行出图，任一成功即回；两把 KEY 都有才真正双出
            if (String(body.model || '').toLowerCase() === 'both') {
                return await handleBothImage(req, res, { body, cfg, ai, ctx, prompt, refs, tier, ratio, size: body.size || '1024x1024' });
            }
            const agnes = await getAgnes(cfg, ctx);
            const out = await agnes.generateImage({ prompt, model, size: tier, ratio, images: refs }, { timeoutMs: 300000, retries: 1 });
            const saved = await saveImageFromResult(out);
            json(res, 200, {
                success: true, image_url: saved.url, local_file: saved.local_file, model,
                provider: ctx.source === 'byok' ? 'agnes(byok)' : 'agnes', key_source: ctx.source,
                channel: ctx.channel, elapsed: out.elapsedMs,
            });
        } catch (e) {
            // Key 失效 / 额度用尽 → 回落免 Key 生图（有参考图时无法回落）
            if (isKeyError(e && e.message) && !refs.length) {
                try {
                    const free = await getFree();
                    const out = await free.freeImage({ prompt, size: body.size || '1024x1024', seed: body.seed });
                    const name = hashName('img', out.ext || 'jpg');
                    fs.writeFileSync(path.join(PICTURES_DIR, name), out.bytes);
                    return json(res, 200, {
                        success: true, image_url: '/output/pictures/' + name, local_file: 'pictures/' + name,
                        model: out.provider, provider: out.provider + '(fallback)', free_tier: true,
                        watermark_cropped: !!out.watermark_cropped,
                        failover_log: out.failover_log?.length ? out.failover_log : undefined,
                        note: 'AGNES Key 不可用，已自动走免 Key 通道',
                    });
                } catch (e2) {
                    return json(res, 200, { success: false, error: `AGNES Key 不可用（${e.message}），免 Key 通道也失败（${e2.message}）` });
                }
            }
            json(res, 200, { success: false, error: (e && e.message) || '生图失败' });
        }
    }
    app.post('/api/image/generate', (req, res) => handleImage(req, res, false));
    app.post('/api/image/img2img', (req, res) => handleImage(req, res, true));

    // ---------- 视频（Agnes 直连 / Veda 免 Key，任务轮询）----------
    app.post('/api/video/generate', async (req, res) => {
        const body = req.body || {};
        const cfg = getConfig();
        const ai = readAi(cfg);
        const ctx = await ctxFor(req);              // BYOK：请求头 KEY 优先
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 200, { success: false, error: 'prompt 不能为空' });
        const w = +body.width || 1280, h = +body.height || 720;
        const r = w / h;
        const aspectRatio = Math.abs(r - 9 / 16) < 0.02 ? '9:16' : Math.abs(r - 3 / 4) < 0.02 ? '3:4' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : Math.abs(r - 1) < 0.02 ? '1:1' : '16:9';
        const wantFree = ['free', 'veda'].includes(String(body.provider || '').toLowerCase());
        const useFree = wantFree || !ai.api_key || !!cfg.ai?.prefer_free;

        // 免 Key 通道：Veda Studio（设备额度 20 点/天，5s=1 · 10s=2 · 15s=3）
        const submitVeda = async (fallbackNote) => {
            const free = await getFree();
            let p = prompt;
            if (p.length < 32) p = `${p}，电影级光影，画面稳定，细节丰富，高清质感`;
            const sec = Math.min(15, Math.max(5, +body.seconds || 5));
            const aspect = ['16:9', '9:16', '4:3', '1:1'].includes(body.aspect) ? body.aspect : aspectRatio;
            const { jobId } = await free.veda.submit({
                prompt: p, durationSec: sec, aspect, seed: body.seed ?? null, mode: body.mode === 'raw' ? 'raw' : 'enhance',
            });
            const taskId = 'veda' + crypto.randomBytes(6).toString('hex');
            videoTasks.set(taskId, {
                id: taskId, provider: 'veda', status: 'processing', model: 'veda/minimax-h3',
                prompt: p, jobId, started: Date.now(),
            });
            saveVideoTasks();
            return json(res, 200, {
                success: true, task_id: taskId, deduped: false, provider: 'veda', free_tier: true,
                note: `免 Key 生成 · ${free.nearestVedaDuration(sec)}s · 消耗 ${free.vedaChoiceNum(sec)} 点（每日 20 点）${fallbackNote || ''}`,
            });
        };

        if (useFree) {
            try {
                return await submitVeda();
            } catch (e) {
                return json(res, 200, { success: false, error: (e && e.message) || '免 Key 视频提交失败' });
            }
        }

        const model = body.model || ai.default_video_model || 'agnes-video-2.5-flash';
        const seconds = Math.min(12, Math.max(4, +body.seconds || 5));
        const refs = Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean).slice(0, 3) : [];
        try {
            const agnes = await getAgnes(cfg, ctx);
            const out = await agnes.createVideo({
                prompt, model, mode: refs.length ? 'reference' : 'text', seconds: String(seconds),
                aspectRatio, images: refs,
            }, { timeoutMs: 120000, retries: 1 });
            const taskId = out.videoId || ('v' + crypto.randomBytes(6).toString('hex'));
            videoTasks.set(taskId, {
                id: taskId, provider: 'agnes', status: 'processing', model, prompt,
                agnesVideoId: out.videoId || null, agnesModelName: model, started: Date.now(),
                keyCtx: { api_key: ctx.api_key, baseUrl: ctx.baseUrl },   // BYOK：轮询沿用提交时 KEY
            });
            saveVideoTasks();
            json(res, 200, { success: true, task_id: taskId, deduped: false, provider: 'agnes' });
        } catch (e) {
            // Key 失效 / 额度用尽 → 回落免 Key 视频（有参考图时无法回落：Veda 只做文生视频）
            if (isKeyError(e && e.message) && !refs.length) {
                try {
                    return await submitVeda('（AGNES Key 不可用，已自动走免 Key）');
                } catch (e2) {
                    return json(res, 200, { success: false, error: `AGNES Key 不可用（${e.message}），免 Key 通道也失败（${e2.message}）` });
                }
            }
            json(res, 200, { success: false, error: (e && e.message) || '视频任务提交失败' });
        }
    });

    app.get('/api/video/status/:id', async (req, res) => {
        const t = videoTasks.get(req.params.id);
        if (!t) return json(res, 200, { success: false, error: '任务不存在（服务可能重启过）' });
        if (t.status === 'completed' || t.status === 'failed') {
            return json(res, 200, { success: true, status: t.status, local_file: t.local_file, video_url: t.video_url, error: t.error, provider: t.provider });
        }

        // ---- 免 Key：Veda 轮询 + 拉回本地 ----
        if (t.provider === 'veda') {
            try {
                const free = await getFree();
                const snap = await free.veda.poll(t.jobId);
                if (snap.status === 'done') {
                    const bytes = await free.veda.fetchVideoBytes(t.jobId);
                    const name = hashName('vid', 'mp4');
                    fs.writeFileSync(path.join(VIDEOS_DIR, name), bytes);
                    t.local_file = 'videos/' + name;
                    t.video_url = '/output/videos/' + name;
                    t.status = 'completed';
                    t.enhanced_prompt = snap.enhancedPrompt || null;
                    saveVideoTasks();
                    return json(res, 200, {
                        success: true, status: 'completed', local_file: t.local_file,
                        video_url: t.video_url, provider: 'veda', enhanced_prompt: t.enhanced_prompt,
                    });
                }
                if (snap.status === 'failed' || snap.status === 'cancelled') {
                    t.status = 'failed';
                    t.error = snap.error || 'Veda 生成失败';
                    saveVideoTasks();
                    return json(res, 200, { success: true, status: 'failed', error: t.error, provider: 'veda' });
                }
                return json(res, 200, {
                    success: true, status: snap.status === 'queued' ? 'submitting' : 'processing',
                    progress: snap.progress, provider: 'veda',
                });
            } catch (e) {
                // 单次查询/下载失败不终止任务，但记下原因便于排查
                t.last_error = (e && e.message) || String(e);
                saveVideoTasks();
                return json(res, 200, { success: true, status: 'processing', provider: 'veda', last_error: t.last_error });
            }
        }

        try {
            const cfg = getConfig();
            const agnes = await getAgnes(cfg, t.keyCtx || undefined);
            const snap = await agnes.getVideo(t.agnesVideoId, t.agnesModelName);
            if (snap.status === 'completed' || snap.url) {
                // 拉回本地
                const name = hashName('vid', 'mp4');
                const dest = path.join(VIDEOS_DIR, name);
                try {
                    const resp = await fetch(snap.url, { signal: AbortSignal.timeout(300000) });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
                    t.local_file = 'videos/' + name;
                    t.video_url = '/output/videos/' + name;
                } catch (e) {
                    t.video_url = snap.url;   // 下载失败给外链
                }
                t.status = 'completed';
                saveVideoTasks();
                return json(res, 200, { success: true, status: 'completed', local_file: t.local_file, video_url: t.video_url, provider: 'agnes' });
            }
            if (snap.status === 'failed') {
                t.status = 'failed'; t.error = snap.error || '上游生成失败';
                saveVideoTasks();
                return json(res, 200, { success: true, status: 'failed', error: t.error, provider: 'agnes' });
            }
            json(res, 200, { success: true, status: snap.status === 'queued' ? 'submitting' : (snap.status || 'processing'), provider: 'agnes' });
        } catch (e) {
            // 轮询单次失败不终止：前端会重试
            json(res, 200, { success: true, status: 'processing', provider: 'agnes' });
        }
    });

    // ---------- 本地分镜工作台（10 种模式，替掉走源站的 dramapro）----------
    app.get('/api/local/storyboard/modes', async (req, res) => {
        const sb = await getStoryboard();
        const mod = await import('./lib/storyboard-prompts.mjs');
        json(res, 200, {
            success: true,
            modes: sb.modes(),
            frame_spec: mod.FRAME_SPEC,
            defaults: { shots: 10, seconds_per_shot: 12, line_budget: mod.lineBudget(10, 12) },
            hint: '本地执行：Agnes 直连优先，Key 失效自动回落免 Key；产物落 output/storyboards/',
        });
    });

    app.post('/api/local/storyboard/run', async (req, res) => {
        const body = req.body || {};
        const sb = await getStoryboard();
        if (body.async === false) {
            try {
                const job = await sb.run(body);
                return json(res, 200, { success: true, ...job });
            } catch (e) {
                return json(res, 200, { success: false, error: (e && e.message) || '生成失败' });
            }
        }
        try {
            const job = sb.runAsync(body);
            json(res, 200, { success: true, job_id: job.id, mode: job.mode, mode_name: job.modeName, status: job.status });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || '提交失败' });
        }
    });

    app.get('/api/local/storyboard/status/:id', async (req, res) => {
        const sb = await getStoryboard();
        const job = sb.get(req.params.id);
        if (!job) return json(res, 404, { success: false, error: '任务不存在' });
        json(res, 200, {
            success: true, id: job.id, mode: job.mode, mode_name: job.modeName, status: job.status,
            elapsed: job.elapsed, provider: job.provider, error: job.error || null,
            text: job.status === 'completed' ? job.text : undefined,
            json_result: job.status === 'completed' ? job.json : undefined,
        });
    });

    app.get('/api/local/storyboard/list', async (req, res) => {
        const sb = await getStoryboard();
        json(res, 200, { success: true, items: sb.list(Number(req.query.limit) || 30) });
    });

    // ---------- 本地分镜出图流水线（分镜文本 → 逐镜免 Key 出图）----------
    const pipelines = new Map();
    const PIPE_DIR = path.join(OUTPUT_DIR, 'pipelines');
    const savePipeline = (job) => {
        try {
            fs.mkdirSync(PIPE_DIR, { recursive: true });
            fs.writeFileSync(path.join(PIPE_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
        } catch { /* 落盘失败不影响 */ }
    };
    (() => {   // 重启恢复最近任务
        try {
            fs.mkdirSync(PIPE_DIR, { recursive: true });
            for (const f of fs.readdirSync(PIPE_DIR).filter((x) => x.endsWith('.json')).slice(-50)) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(PIPE_DIR, f), 'utf8'));
                    if (j && j.id) pipelines.set(j.id, j);
                } catch { /* 跳过 */ }
            }
        } catch { /* 首次运行 */ }
    })();

    app.post('/api/local/pipeline/run', async (req, res) => {
        const body = req.body || {};
        const text = String(body.text || '').trim();
        const shotsIn = Array.isArray(body.shots) ? body.shots : null;
        if (!text && !shotsIn) return json(res, 200, { success: false, error: '需要 text（分镜文本）或 shots（镜头数组）' });

        const id = 'pl' + crypto.randomBytes(6).toString('hex');
        const job = {
            id, status: 'running', stage: 'parsing', progress: 0,
            started: Date.now(), total: 0, images: 0, failed: 0,
            width: +body.width || 1024, height: +body.height || 576,
            shots: [], error: null,
        };
        pipelines.set(id, job);
        savePipeline(job);

        (async () => {
            try {
                const mod = await import('./lib/storyboard-pipeline.mjs');
                const free = await getFree();

                // 先解析出镜头，再批量英译 —— 免 Key 出图通道读不懂中文，必须转英文（否则画面跑偏）
                const limitN = +body.limit || 0;
                let parsed = Array.isArray(shotsIn) && shotsIn.length
                    ? shotsIn
                    : mod.parseShots(text);
                if (limitN > 0) parsed = parsed.slice(0, limitN);
                if (!parsed.length) throw new Error('没解析出镜头 —— 分镜文本里需要「镜头 1 / 第 1 镜」或 JSON 的 shots 数组');
                job.stage = 'translating';
                job.detail = `英译 ${parsed.length} 条提示词`;
                savePipeline(job);
                const shots = await mod.translateShotPrompts(parsed, callTextModel);
                job.stage = 'images';
                savePipeline(job);

                const out = await mod.runPipeline({
                    text, shots,
                    width: job.width, height: job.height,
                    limit: +body.limit || 0,
                    concurrency: Math.min(3, Math.max(1, +body.concurrency || 2)),
                    style: body.style,
                    onProgress: (p) => {
                        job.stage = p.stage;
                        job.progress = p.progress;
                        job.detail = p.detail;
                        savePipeline(job);
                    },
                    generateImage: async ({ prompt, width, height, seed }) =>
                        free.freeImage({ prompt, size: `${width}x${height}`, seed }),
                    saveImage: async (img) => {
                        const name = hashName('shot', img.ext || 'jpg');
                        fs.writeFileSync(path.join(PICTURES_DIR, name), img.bytes);
                        return { url: '/output/pictures/' + name, file: 'pictures/' + name, provider: img.provider };
                    },
                });
                Object.assign(job, {
                    status: 'completed', stage: 'done', progress: 100,
                    total: out.total, images: out.images, failed: out.failed,
                    shots: out.shots, elapsed: Math.round((Date.now() - job.started) / 1000),
                });
            } catch (e) {
                job.status = 'failed';
                job.error = (e && e.message) || String(e);
                job.elapsed = Math.round((Date.now() - job.started) / 1000);
            }
            savePipeline(job);
        })();

        json(res, 200, { success: true, pipeline_id: id, hint: '轮询 GET /api/local/pipeline/status/:id' });
    });

    app.get('/api/local/pipeline/status/:id', (req, res) => {
        const job = pipelines.get(req.params.id);
        if (!job) return json(res, 404, { success: false, error: '任务不存在' });
        json(res, 200, { success: true, ...job });
    });

    app.get('/api/local/pipeline/list', (req, res) => {
        const items = [...pipelines.values()]
            .sort((a, b) => b.started - a.started)
            .slice(0, Number(req.query.limit) || 20)
            .map((j) => ({
                id: j.id, status: j.status, started: j.started, elapsed: j.elapsed,
                total: j.total, images: j.images, width: j.width, height: j.height,
            }));
        json(res, 200, { success: true, items });
    });

    // ---------- 免费 TTS（edge-tts / macOS say / 自定义 OpenAI 兼容）----------
    const AUDIO_DIR = path.join(OUTPUT_DIR, 'audio');
    fs.mkdirSync(AUDIO_DIR, { recursive: true });

    app.get('/api/local/tts/voices', async (req, res) => {
        const mod = await import('./lib/tts.mjs');
        json(res, 200, { success: true, ...mod.voiceCatalog() });
    });

    // 按后端拉完整音色表（部分后端的音色要现场查，不能塞进 catalog）
    app.get('/api/local/tts/voices/:provider', async (req, res) => {
        try {
            const mod = await import('./lib/tts.mjs');
            const voices = await mod.voicesOf(String(req.params.provider || ''));
            json(res, 200, { success: true, provider: req.params.provider, voices });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || '取音色表失败' });
        }
    });

    app.post('/api/local/tts/synthesize', async (req, res) => {
        const body = req.body || {};
        const text = String(body.text || '').trim();
        if (!text) return json(res, 200, { success: false, error: 'text 不能为空' });
        if (text.length > 5000) return json(res, 200, { success: false, error: '单次最多 5000 字，长文请分段' });
        try {
            const mod = await import('./lib/tts.mjs');
            const name = hashName('tts', 'mp3');
            const ai = readAi(getConfig());
            const r = await mod.synthesize({
                text,
                provider: body.provider,
                voice: body.voice,
                rate: body.rate || '+0%',
                pitch: body.pitch || '+0Hz',
                outFile: path.join(AUDIO_DIR, name),
                custom: ai.tts_base_url ? { baseUrl: ai.tts_base_url, apiKey: ai.tts_api_key, model: ai.tts_model, voice: body.voice } : {},
            });
            json(res, 200, {
                success: true, audio_url: '/output/audio/' + name, local_file: 'audio/' + name,
                duration: r.duration, provider: r.provider, voice: r.voice,
            });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || 'TTS 失败' });
        }
    });

    app.get('/api/local/tts/list', (req, res) => {
        try {
            const items = fs.readdirSync(AUDIO_DIR)
                .filter((f) => /\.(mp3|wav|m4a)$/i.test(f))
                .map((f) => {
                    const st = fs.statSync(path.join(AUDIO_DIR, f));
                    return { file: f, url: '/output/audio/' + f, size: st.size, at: st.mtimeMs };
                })
                .sort((a, b) => b.at - a.at)
                .slice(0, Number(req.query.limit) || 30);
            json(res, 200, { success: true, items });
        } catch (e) {
            json(res, 200, { success: false, error: e.message });
        }
    });

    // ---------- 分镜成片（Ken Burns + 硬字幕）----------
    const renders = new Map();
    const RENDER_DIR = path.join(OUTPUT_DIR, 'renders');
    const saveRender = (job) => {
        try {
            fs.mkdirSync(RENDER_DIR, { recursive: true });
            fs.writeFileSync(path.join(RENDER_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
        } catch { /* 忽略 */ }
    };
    (() => {
        try {
            fs.mkdirSync(RENDER_DIR, { recursive: true });
            for (const f of fs.readdirSync(RENDER_DIR).filter((x) => x.endsWith('.json')).slice(-30)) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(RENDER_DIR, f), 'utf8'));
                    if (j && j.id) renders.set(j.id, j);
                } catch { /* 跳过 */ }
            }
        } catch { /* 首次运行 */ }
    })();

    app.get('/api/local/storyboard/ffmpeg', async (req, res) => {
        const mod = await import('./lib/storyboard-video.mjs');
        json(res, 200, { success: true, ...mod.ffmpegCapabilities() });
    });

    app.post('/api/local/storyboard/render', async (req, res) => {
        const body = req.body || {};
        let shots = Array.isArray(body.shots) && body.shots.length ? body.shots : null;
        if (!shots && body.pipeline_id) {
            const pj = pipelines.get(body.pipeline_id);
            if (!pj) return json(res, 200, { success: false, error: '找不到该出图任务（pipeline_id 无效）' });
            if (pj.status !== 'completed') return json(res, 200, { success: false, error: '出图任务还没完成' });
            shots = pj.shots;
        }
        if (!shots || !shots.length) return json(res, 200, { success: false, error: '需要 shots 或 pipeline_id' });
        const withImg = shots.filter((x) => x.image);
        if (!withImg.length) return json(res, 200, { success: false, error: '这些镜头还没有图，先跑逐镜出图' });

        const id = 'rd' + crypto.randomBytes(6).toString('hex');
        const job = {
            id, status: 'running', stage: 'clips', progress: 0, started: Date.now(),
            shots: withImg.length, width: +body.width || 1280, height: +body.height || 720,
            subtitle: body.subtitle !== false, use_desc: !!body.use_desc, bgm: body.bgm || null,
        };
        renders.set(id, job);
        saveRender(job);

        (async () => {
            try {
                const mod = await import('./lib/storyboard-video.mjs');

                // 可选：逐镜配音（有台词的镜头才生成，其余补静音）
                let voiceMap = null;
                if (body.tts && (body.tts.provider || body.tts.voice)) {
                    job.stage = 'tts';
                    job.progress = 2;
                    saveRender(job);
                    try {
                        const tts = await import('./lib/tts.mjs');
                        voiceMap = {};
                        // 先把有台词的镜头挑出来
                        const speakShots = withImg.filter((sh) => {
                            const line = String(sh.line || '').trim();
                            return line && !/^[无—\-–]+$/.test(line);
                        });
                        // ⚠ 走批量接口 —— matrix 一次 10 段，限流暴露从「每镜一次」
                        //   降到「整批一次」。逐段失败不会带崩整批（补不上的是 null，
                        //   那一镜补静音，片子照出）。
                        const bufs = await tts.synthesizeBatch(
                            speakShots.map((sh) => String(sh.line || '').trim()),
                            {
                                provider: body.tts.provider, voice: body.tts.voice,
                                rate: body.tts.rate || '+0%',
                            },
                        );
                        let n = 0;
                        for (let i = 0; i < speakShots.length; i++) {
                            const buf = bufs[i];
                            if (!buf || !Buffer.isBuffer(buf)) continue;
                            const sh = speakShots[i];
                            const f = path.join(AUDIO_DIR, `${id}_${sh.index}.mp3`);
                            fs.writeFileSync(f, buf);
                            voiceMap[String(sh.index)] = f;
                            n += 1;
                            job.detail = `配音 ${n}/${speakShots.length} 条`;
                            saveRender(job);
                        }
                        job.tts_count = n;
                        job.tts_total = speakShots.length;
                    } catch (e) {
                        job.tts_error = (e && e.message) || String(e);
                    }
                }

                const name = hashName('storyboard', 'mp4');
                const outFile = path.join(VIDEOS_DIR, name);
                const r = await mod.renderStoryboardVideo({
                    shots: withImg, rootDir: __dirname, outFile,
                    width: job.width, height: job.height,
                    subtitle: job.subtitle, useDesc: job.use_desc, bgm: job.bgm, voiceMap,
                    onProgress: (p) => {
                        job.stage = p.stage;
                        job.progress = p.progress;
                        job.detail = p.detail;
                        saveRender(job);
                    },
                });
                Object.assign(job, {
                    status: 'completed', progress: 100, elapsed: Math.round((Date.now() - job.started) / 1000),
                    video_url: '/output/videos/' + name, local_file: 'videos/' + name,
                    duration: r.duration, subtitle_burned: r.subtitle, subtitle_reason: r.subtitle_reason,
                    voiced: r.voiced,
                });
            } catch (e) {
                job.status = 'failed';
                job.error = (e && e.message) || String(e);
                job.elapsed = Math.round((Date.now() - job.started) / 1000);
            }
            saveRender(job);
        })();

        json(res, 200, { success: true, render_id: id, hint: '轮询 GET /api/local/storyboard/render/status/:id' });
    });

    app.get('/api/local/storyboard/render/status/:id', (req, res) => {
        const job = renders.get(req.params.id);
        if (!job) return json(res, 404, { success: false, error: '任务不存在' });
        json(res, 200, { success: true, ...job });
    });

    app.get('/api/local/storyboard/render/list', (req, res) => {
        const items = [...renders.values()].sort((a, b) => b.started - a.started)
            .slice(0, Number(req.query.limit) || 20)
            .map((j) => ({
                id: j.id, status: j.status, started: j.started, elapsed: j.elapsed,
                video_url: j.video_url, duration: j.duration, shots: j.shots,
            }));
        json(res, 200, { success: true, items });
    });

    app.get('/api/local/storyboard/:id', async (req, res) => {
        const sb = await getStoryboard();
        const job = sb.get(req.params.id);
        if (!job) return json(res, 404, { success: false, error: '任务不存在' });
        json(res, 200, { success: true, ...job });
    });

    // ---------- 能力总览 / 免 Key 通道探活 ----------
    app.get('/api/providers', async (req, res) => {
        const cfg = getConfig();
        const ai = readAi(cfg);
        const free = await getFree();
        json(res, 200, {
            success: true,
            keyed: [{
                id: 'agnes', name: 'Agnes AI（直连）', kinds: ['text', 'image', 'video', 'img2img'],
                configured: !!ai.api_key, needs_key: true,
                base_url: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
            }],
            free: [
                { id: 'pollinations', name: 'Pollinations', kinds: ['text', 'image'], needs_key: false, base_url: free.ENDPOINTS.pollinationsText },
                { id: 'imagefree', name: 'imagefree.net', kinds: ['image'], needs_key: false, base_url: free.ENDPOINTS.imagefree },
                { id: 'veda', name: 'Veda Studio（文生视频）', kinds: ['video'], needs_key: false, base_url: free.veda.root, quota_daily: free.VEDA_DEFAULTS.dailyLimit },
            ],
            pollinations: free.pollinationsStatus ? free.pollinationsStatus() : null,
            usage: {
                chat: 'POST /api/ai/chat {message, provider:"free"}',
                image: 'POST /api/image/generate {prompt, provider:"free"}',
                video: 'POST /api/video/generate {prompt, provider:"free", seconds:5|10|15}',
            },
        });
    });

    app.post('/api/providers/probe', async (req, res) => {
        const free = await getFree();
        const t0 = Date.now();
        const [txt, img, vedaHealth, vedaQuota] = await Promise.allSettled([
            free.pollinationsText({ messages: [{ role: 'user', content: '只回复 OK' }], maxTokens: 8 }),
            free.pollinationsImage({ prompt: 'a small blue dot on white background', width: 256, height: 256 }),
            free.veda.probe(),
            free.veda.quota(),
        ]);
        const pick = (r, ok) => (r.status === 'fulfilled' ? { ok: true, ...ok(r.value) } : { ok: false, error: r.reason?.message || String(r.reason) });
        json(res, 200, {
            success: true,
            elapsed_ms: Date.now() - t0,
            pollinations_text: pick(txt, (v) => ({ sample: String(v.content).slice(0, 40) })),
            pollinations_image: pick(img, (v) => ({ bytes: v.bytes.length, ext: v.ext })),
            veda_health: pick(vedaHealth, (v) => v),
            veda_quota: pick(vedaQuota, (v) => v),
        });
    });

    // ---------- 新闻热点 / 全网热点（RSS 聚合，30 分钟缓存）----------
    app.get('/api/news/hot', async (req, res) => {
        const force = req.query.force === '1';
        const cache = RSS_CACHE.news;
        try {
            if (!cache.data || force || Date.now() - cache.at > NEWS_TTL) {
                const sources = await loadRssAll();
                const items = [];
                for (const s of sources) {
                    for (const it of s.items.slice(0, 12)) {
                        items.push({ title: it.title, url: it.url, source: s.name, category: s.category, ts: fmtTs(it.ts) });
                    }
                }
                items.sort((a, b) => b.ts - a.ts);
                cache.data = { items: items.slice(0, 30), updated_at: new Date().toLocaleString('zh-CN', { hour12: false }) };
                cache.at = Date.now();
            }
            json(res, 200, { success: true, ...cache.data, cached: Date.now() - cache.at > 60000 });
        } catch (e) {
            json(res, 200, { success: false, error: '热点抓取失败：' + (e.message || e) });
        }
    });

    app.get('/api/news/trending', async (req, res) => {
        const force = req.query.force === '1';
        const cache = RSS_CACHE.trending;
        try {
            if (!cache.data || force || Date.now() - cache.at > NEWS_TTL) {
                const sources = await loadRssAll();
                const boards = sources.map(s => ({
                    name: s.name, color: s.color,
                    items: s.items.slice(0, 15).map((it, i) => ({ title: it.title, url: it.url, rank: i + 1 })),
                }));
                // 混排：各榜交错取
                const mix = [];
                const maxLen = Math.max(0, ...boards.map(b => b.items.length));
                for (let i = 0; i < maxLen; i++) {
                    for (const b of boards) {
                        const it = b.items[i];
                        if (it) mix.push({ title: it.title, url: it.url, platform: b.name });
                    }
                }
                cache.data = {
                    boards, mix: mix.slice(0, 120),
                    updated_at: new Date().toLocaleString('zh-CN', { hour12: false }),
                };
                cache.at = Date.now();
            }
            json(res, 200, { success: true, ...cache.data, cached: Date.now() - cache.at > 60000 });
        } catch (e) {
            json(res, 200, { success: false, error: '全网热点抓取失败：' + (e.message || e) });
        }
    });

    // ---------- 作品墙（本地 JSON）----------
    app.get('/api/gallery/list', (req, res) => {
        const list = readGallery().filter(it => {
            if (!it.local_file) return true;
            const p = path.join(OUTPUT_DIR, it.local_file);
            return fs.existsSync(p) && fs.statSync(p).size > 0;
        });
        json(res, 200, { success: true, items: list });
    });
    app.get('/api/gallery/mine', (req, res) => json(res, 200, {
        success: true, items: readGallery().filter(it => it.author === '本地用户').map(it => ({
            folder: (it.local_file || '').split('/')[0], filename: (it.local_file || '').split('/')[1], id: it.id,
        })),
    }));
    app.post('/api/gallery/publish', (req, res) => {
        const { folder, filename, title, kind } = req.body || {};
        if (!folder || !filename) return json(res, 200, { success: false, error: '缺少 folder/filename' });
        const list = readGallery();
        const local_file = String(folder).replace(/\/+$/, '') + '/' + filename;
        const url = '/output/' + local_file;
        if (!list.some(it => it.local_file === local_file)) {
            list.unshift({ id: 'g' + crypto.randomBytes(4).toString('hex'), local_file, url, title: title || '', author: '本地用户', kind: kind || (/\.(mp4|webm|mov)$/i.test(filename) ? 'video' : 'image'), ts: Date.now() });
            writeGallery(list);
        }
        json(res, 200, { success: true });
    });
    app.post('/api/gallery/unpublish', (req, res) => {
        const { folder, filename } = req.body || {};
        const local_file = String(folder || '').replace(/\/+$/, '') + '/' + (filename || '');
        writeGallery(readGallery().filter(it => it.local_file !== local_file));
        json(res, 200, { success: true });
    });

    // ---------- 上传（随身空间 / 参照图）----------
    app.post('/api/upload/image', upload.single('file'), (req, res) => {
        if (!req.file) return json(res, 200, { success: false, error: '未收到文件' });
        json(res, 200, { success: true, url: '/output/uploads/' + req.file.filename, filename: req.file.filename });
    });
}

module.exports = { install };
