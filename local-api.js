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

const OUTPUT_DIR = path.join(__dirname, 'output');
const PICTURES_DIR = path.join(OUTPUT_DIR, 'pictures');
const VIDEOS_DIR = path.join(OUTPUT_DIR, 'videos');
const UPLOADS_DIR = path.join(OUTPUT_DIR, 'uploads');
const GALLERY_DB = path.join(OUTPUT_DIR, 'gallery.json');
for (const d of [PICTURES_DIR, VIDEOS_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true });

// ===== Agnes 客户端（复用 image-studio 验证过的实现，ESM 动态加载）=====
let _agnes = null;
async function getAgnes(cfg) {
    if (!_agnes) {
        const mod = await import('./lib/agnes-client.mjs');
        _agnes = new mod.AgnesClient({
            apiKey: '',
            baseUrl: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
            timeoutMs: 120000,
        });
    }
    _agnes.configure({ apiKey: cfg.ai && cfg.ai.api_key || process.env.AGNES_API_KEY || '' });
    return _agnes;
}

// ===== 本地配置读写（挂在 config.json 的 ai 字段下，与后端代理配置共存）=====
const AI_FIELDS = ['api_key', 'sensenova_api_key', 'deepseek_api_key', 'doubao_api_key',
    'qwen_api_key', 'minimax_api_key', 'dots_api_key',
    'default_text_model', 'default_image_model', 'default_video_model'];

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
const videoTasks = new Map(); // task_id -> {id, status, model, prompt, agnesVideoId, started, local_file, error}

function hashName(prefix, ext) {
    return prefix + '_' + crypto.randomBytes(6).toString('hex') + '.' + ext;
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
        const { vendor, api_key: key } = req.body || {};
        const cfg = getConfig();
        if (vendor === 'agnes' || vendor === 'sensenova' || !vendor) {
            if (!key) return json(res, 200, { success: false, error: 'Key 为空' });
            if (vendor === 'agnes' && !/^sk-/.test(key)) {
                return json(res, 200, { success: false, error: 'AGNES Key 必须以 sk- 开头（国际站 Key）' });
            }
            try {
                const mod = await import('./lib/agnes-client.mjs');
                const tmp = new mod.AgnesClient({ apiKey: key, baseUrl: 'https://apihub.agnes-ai.com/v1', timeoutMs: 30000 });
                const probe = await tmp.verifyCredentials();
                return json(res, 200, probe.ok
                    ? { success: true, message: 'Key 有效' }
                    : { success: false, error: probe.reason || 'Key 验证未通过' });
            } catch (e) {
                // 网络异常按 soft 处理：允许保存
                return json(res, 200, { success: true, message: '网络波动，Key 已按原样保存（未实测）' });
            }
        }
        json(res, 200, { success: true, message: vendor + ' Key 已保存（本地模式不实测该通道）' });
    });

    // ---------- AI 对话（Agnes 直连，支持异步 job）----------
    app.post('/api/ai/chat', async (req, res) => {
        const body = req.body || {};
        const cfg = getConfig();
        const model = body.model || readAi(cfg).default_text_model || 'agnes-2.5-flash';
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
        const run = async () => {
            const agnes = await getAgnes(cfg);
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
        };

        if (body.async) {
            const jobId = 'job' + crypto.randomBytes(6).toString('hex');
            jobs.set(jobId, { status: 'running', stage: '模型思考中', started });
            run().then(reply => {
                jobs.set(jobId, {
                    status: 'done', reply, model, mode: body.think ? 'think' : 'quick',
                    web_used: 0, elapsed: Math.round((Date.now() - started) / 1000), sources: [],
                });
            }).catch(e => {
                jobs.set(jobId, { status: 'failed', error: e.message || String(e), model, elapsed: Math.round((Date.now() - started) / 1000) });
            });
            return json(res, 200, { success: true, job_id: jobId });
        }

        try {
            const reply = await run();
            json(res, 200, {
                success: true, reply, model, mode: body.think ? 'think' : 'quick',
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

    // ---------- 生图 / 图生图（Agnes 直连）----------
    async function handleImage(req, res, withRefs) {
        const body = req.body || {};
        const cfg = getConfig();
        const ai = readAi(cfg);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 200, { success: false, error: 'prompt 不能为空' });
        if (!ai.api_key) return json(res, 200, { success: false, error: '尚未配置 AGNES Key：请到 ⚙ 设置 → 平台 Key 填入 sk- 开头的 Key' });
        const { tier, ratio } = sizeToTierRatio(body.size);
        const model = body.model || ai.default_image_model || 'agnes-image-2.5-flash';
        const refs = withRefs ? (Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean).slice(0, 4) : []) : [];
        try {
            const agnes = await getAgnes(cfg);
            const out = await agnes.generateImage({ prompt, model, size: tier, ratio, images: refs }, { timeoutMs: 300000, retries: 1 });
            const saved = await saveImageFromResult(out);
            json(res, 200, { success: true, image_url: saved.url, local_file: saved.local_file, model, elapsed: out.elapsedMs });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || '生图失败' });
        }
    }
    app.post('/api/image/generate', (req, res) => handleImage(req, res, false));
    app.post('/api/image/img2img', (req, res) => handleImage(req, res, true));

    // ---------- 视频（Agnes 直连，任务轮询）----------
    app.post('/api/video/generate', async (req, res) => {
        const body = req.body || {};
        const cfg = getConfig();
        const ai = readAi(cfg);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 200, { success: false, error: 'prompt 不能为空' });
        if (!ai.api_key) return json(res, 200, { success: false, error: '尚未配置 AGNES Key：请到 ⚙ 设置 → 平台 Key 填入' });
        const w = +body.width || 1280, h = +body.height || 720;
        const r = w / h;
        const aspectRatio = Math.abs(r - 9 / 16) < 0.02 ? '9:16' : Math.abs(r - 3 / 4) < 0.02 ? '3:4' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : Math.abs(r - 1) < 0.02 ? '1:1' : '16:9';
        const model = body.model || ai.default_video_model || 'agnes-video-2.5-flash';
        const seconds = Math.min(12, Math.max(4, +body.seconds || 5));
        const refs = Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean).slice(0, 3) : [];
        try {
            const agnes = await getAgnes(cfg);
            const out = await agnes.createVideo({
                prompt, model, mode: refs.length ? 'reference' : 'text', seconds: String(seconds),
                aspectRatio, images: refs,
            }, { timeoutMs: 120000, retries: 1 });
            const taskId = out.videoId || ('v' + crypto.randomBytes(6).toString('hex'));
            videoTasks.set(taskId, {
                id: taskId, status: 'processing', model, prompt,
                agnesVideoId: out.videoId || null, agnesModelName: model, started: Date.now(),
            });
            json(res, 200, { success: true, task_id: taskId, deduped: false });
        } catch (e) {
            json(res, 200, { success: false, error: (e && e.message) || '视频任务提交失败' });
        }
    });

    app.get('/api/video/status/:id', async (req, res) => {
        const t = videoTasks.get(req.params.id);
        if (!t) return json(res, 200, { success: false, error: '任务不存在（服务可能重启过）' });
        if (t.status === 'completed' || t.status === 'failed') {
            return json(res, 200, { success: true, status: t.status, local_file: t.local_file, video_url: t.video_url, error: t.error });
        }
        try {
            const cfg = getConfig();
            const agnes = await getAgnes(cfg);
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
                return json(res, 200, { success: true, status: 'completed', local_file: t.local_file, video_url: t.video_url });
            }
            if (snap.status === 'failed') {
                t.status = 'failed'; t.error = snap.error || '上游生成失败';
                return json(res, 200, { success: true, status: 'failed', error: t.error });
            }
            json(res, 200, { success: true, status: snap.status === 'queued' ? 'submitting' : (snap.status || 'processing') });
        } catch (e) {
            // 轮询单次失败不终止：前端会重试
            json(res, 200, { success: true, status: 'processing' });
        }
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
