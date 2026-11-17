/**
 * free-providers.mjs — 免 Key 通道（从 Free AI Studio bundle 逆向还原）
 *
 * 三个上游，全部无需 API Key：
 *   · pollinations  文本 + 图片（OpenAI 兼容文本口 / GET 出图口）
 *   · imagefree.net 文生图（提交→轮询→下载，带浏览器 UA/Origin/Referer）
 *   · Veda Studio   文生视频（设备额度制：默认 20 点/天，5s=1 点、10s=2 点、15s=3 点）
 *
 * 协议来源：engine/vendor/main.js 反混淆提取，详见 docs/free-ai-studio/ENGINE-MAP.md
 * 设计原则：只做客户端，不缓存、不转发，失败抛明确错误让上层回落。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const ENDPOINTS = {
    pollinationsText: 'https://text.pollinations.ai/openai',
    pollinationsImage: 'https://image.pollinations.ai/prompt',
    imagefree: 'https://imagefree.net',
    veda: 'https://veda.hanxiao.run',
};

export const VEDA_DEFAULTS = {
    durationsSec: [5, 10, 15],
    aspectRatios: ['16:9', '9:16', '4:3', '1:1'],
    creditCosts: { 5: 1, 10: 2, 15: 3 },
    promptMaxLen: 2000,
    promptMinLen: 32,
    dailyLimit: 20,
};

/**
 * 设备标识持久化（Veda 的 veda_did）
 *
 * ⚠️ 2026-11-17 实测修正：旧注释「换 id = 换额度池」已失效。
 * 真实机制（见 docs/VEDA-UNLIMITED-ANALYSIS.md）：
 *   · 服务端在响应里下发 `set-cookie: veda_did=<deviceId>.<签名段>` 和 `x-device-id` 头，
 *     客户端只负责保存/回传，不自己生成；
 *   · quota 计数**不信任**客户端自报的身份——随机 DID、伪造 cookie、伪造
 *     X-Device-Id、伪造 X-Forwarded-For 全部返回同一个池；
 *   · 交叉验证：AMS(直连IPv6) 与 LAX(代理IPv4) 两个不同真实出口，
 *     从一侧提交任务后另一侧立刻读到相同 used → 额度是服务端全局池。
 * 因此固定 DID 仍有价值（保持会话一致），但**不能**靠换 DID 刷额度。
 */
export function makeDeviceStore(file) {
    return {
        async load() {
            try {
                const j = JSON.parse(fs.readFileSync(file, 'utf8'));
                return typeof j.id === 'string' && j.id ? j.id : null;
            } catch {
                return null;
            }
        },
        async save(id) {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify({ id, updatedAt: Date.now() }, null, 2));
            } catch {
                /* 落盘失败不影响本次调用 */
            }
        },
    };
}

const j = async (r) => {
    const t = await r.text();
    try {
        return JSON.parse(t);
    } catch {
        return { _raw: t };
    }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pollinations 免费额度真实规则（实测 2026-11-16）：
 *   文本 1 次回复 / 45 秒 / IP；图片同样按 IP 限流，超了返回 402 FREE_LIMIT，
 *   响应体里带「Retry after 18s」。
 * 所以这里做两件事：串行最小间隔 + 读到 retry after 就等够再重试一次。
 */
const POLLINATIONS_MIN_INTERVAL_MS = Number(process.env.POLLINATIONS_INTERVAL_MS || 7000);
let _pollinationsLastAt = 0;
let _pollinationsCooldownUntil = 0;
let _pollinationsLastReason = '';

async function pollinationsGate() {
    for (;;) {
        const now = Date.now();
        const wait = Math.max(
            _pollinationsLastAt + POLLINATIONS_MIN_INTERVAL_MS - now,
            _pollinationsCooldownUntil - now
        );
        if (wait <= 0) break;
        await sleep(Math.min(wait, 60000));
    }
    _pollinationsLastAt = Date.now();
}

function notePollinationsLimit(msg) {
    const m = /retry after (\d+)\s*s/i.exec(String(msg || ''));
    const sec = m ? Math.min(120, Number(m[1])) : 20;
    _pollinationsCooldownUntil = Date.now() + sec * 1000;
    _pollinationsLastReason = `FREE_LIMIT ${sec}s`;
    return sec;
}

export function pollinationsStatus() {
    const left = Math.max(0, Math.round((_pollinationsCooldownUntil - Date.now()) / 1000));
    return {
        limited: left > 0,
        cooldown_sec: left,
        reason: _pollinationsLastReason,
        min_interval_ms: POLLINATIONS_MIN_INTERVAL_MS,
    };
}

/** 带限流的 Pollinations 请求：闸门 → 命中 402 就等 retry after 再试一次 */
async function pollinationsFetch(url, init) {
    let lastText = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        await pollinationsGate();
        const r = await fetchRetry(url, init);
        if (r.status !== 402 && r.status !== 429) return r;
        lastText = await r.text().catch(() => '');
        if (attempt === 2) {
            notePollinationsLimit(lastText);
            return new Response(lastText, { status: r.status, headers: r.headers });
        }
        const sec = notePollinationsLimit(lastText);
        await sleep((sec + 1) * 1000);
    }
    return new Response(lastText, { status: 429 });
}

/** fetch 带一次重试：长驻进程偶尔会复用到已被上游关闭的 socket（fetch failed） */
async function fetchRetry(url, init, attempts = 2, backoffMs = 500) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fetch(url, init);
        } catch (e) {
            last = e;
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
    throw last;
}


/* ------------------------------------------------------------------ *
 * 1. Pollinations
 * ------------------------------------------------------------------ */

export async function pollinationsText({ messages, model = 'openai-fast', maxTokens = 1024, temperature = 0.7, timeoutMs = 90000 }) {
    const r = await pollinationsFetch(ENDPOINTS.pollinationsText, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await j(r);
    if (!r.ok) {
        const why = data?.error?.message || data?.error?.code || JSON.stringify(data).slice(0, 160);
        throw new Error(`Pollinations 文本 HTTP ${r.status}：${why}`);
    }
    const msg = data?.choices?.[0]?.message || {};
    const content = String(msg.content || '').trim();
    if (!content) throw new Error('Pollinations 文本返回为空');
    return { content, reasoning: msg.reasoning || '', model, provider: 'pollinations' };
}

/**
 * 裁掉底部水印带（Pollinations 即使 nologo=true 也可能带角标）
 * Pollinations 会把请求尺寸吸附到模型友好尺寸（768×818 → 744×792），所以不能按目标尺寸裁，
 * 用相对表达式裁掉底部 6%：crop=iw:trunc(ih*0.94/2)*2:0:0（高度取偶数，h264/jpeg 都友好）
 * 依赖本机 ffmpeg；没有就原样返回并标记 cropped:false。
 */
export function cropWatermarkBand(bytes, ext, targetW, targetH) {
    if (process.env.FREE_IMAGE_CROP === '0') return { bytes, cropped: false };
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeimg-'));
    const inFile = path.join(dir, `in.${ext || 'jpg'}`);
    const outFile = path.join(dir, `out.${ext || 'jpg'}`);
    try {
        fs.writeFileSync(inFile, bytes);
        execFileSync(bin, [
            '-y', '-v', 'error', '-i', inFile,
            '-vf', 'crop=iw:trunc(ih*0.94/2)*2:0:0',
            ...(ext === 'png' ? [] : ['-q:v', '2']),
            outFile,
        ], { stdio: 'ignore', timeout: 30000 });
        const out = fs.readFileSync(outFile);
        return out.length > 1024 ? { bytes: out, cropped: true } : { bytes, cropped: false };
    } catch {
        return { bytes, cropped: false };
    } finally {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* 忽略 */ }
    }
}

export async function pollinationsImage({ prompt, width = 1024, height = 1024, seed, model = 'flux', timeoutMs = 180000 }) {
    // 多要 6% 高度，裁完正好是目标画幅（Pollinations 的角标在底部）
    const reqH = Math.ceil(height / 0.94);
    const q = new URLSearchParams({ width: String(width), height: String(reqH), nologo: 'true', model });
    if (seed != null) q.set('seed', String(seed));
    const url = `${ENDPOINTS.pollinationsImage}/${encodeURIComponent(prompt)}?${q}`;
    const r = await pollinationsFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 402 || r.status === 429) throw new Error(`Pollinations 出图限流（HTTP ${r.status}，等 ${pollinationsStatus().cooldown_sec}s 后可重试）`);
    if (!r.ok) throw new Error(`Pollinations 出图 HTTP ${r.status}`);
    const raw = Buffer.from(await r.arrayBuffer());
    if (raw.length < 1024) throw new Error(`Pollinations 出图返回异常（${raw.length} 字节）`);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : 'jpg';
    const cut = cropWatermarkBand(raw, ext, width, height);
    return { bytes: cut.bytes, ext, remoteUrl: url, provider: 'pollinations', watermark_cropped: cut.cropped };
}

/* ------------------------------------------------------------------ *
 * 2. imagefree.net
 * ------------------------------------------------------------------ */

const IMAGEFREE_HEADERS = () => ({
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: ENDPOINTS.imagefree,
    Referer: `${ENDPOINTS.imagefree}/`,
});

const IMAGEFREE_RATIOS = [
    { r: 1, v: '1:1' }, { r: 16 / 9, v: '16:9' }, { r: 9 / 16, v: '9:16' },
    { r: 4 / 3, v: '4:3' }, { r: 3 / 4, v: '3:4' },
];

/** "1024x1024" / "1024×1365" → 最接近的画幅 */
export function toAspectRatio(size) {
    const m = String(size || '1024x1024').toLowerCase().match(/^(\d+)\s*[x×]\s*(\d+)$/);
    const w = m ? Number(m[1]) : 1024;
    const h = m ? Number(m[2]) : 1024;
    if (!(w > 0) || !(h > 0)) return '1:1';
    const target = w / h;
    let best = IMAGEFREE_RATIOS[0];
    let delta = Infinity;
    for (const it of IMAGEFREE_RATIOS) {
        const d = Math.abs(it.r - target);
        if (d < delta) { delta = d; best = it; }
    }
    return best.v;
}

const IMAGEFREE_LIMIT_CODES = ['FREE_TASK_IP_ACTIVE', 'FREE_GENERATION_ACTIVE', 'FREE_TASK_BROWSER_ACTIVE'];

export async function imagefreeImage({ prompt, size = '1024x1024', aspectRatio, timeoutMs = 480000, onStatus }) {
    const aspect = aspectRatio || toAspectRatio(size);
    const say = onStatus || (() => {});
    let taskId = null;
    let lastErr = '';

    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const r = await fetchRetry(`${ENDPOINTS.imagefree}/api/generate`, {
                method: 'POST',
                headers: IMAGEFREE_HEADERS(),
                body: JSON.stringify({ prompt, aspect_ratio: aspect }),
                signal: AbortSignal.timeout(60000),
            });
            const data = await j(r);
            if (data?.taskId) { taskId = data.taskId; break; }
            lastErr = data?.error || data?._raw || `HTTP ${r.status}`;
            if (IMAGEFREE_LIMIT_CODES.includes(data?.errorCode)) {
                throw new Error(`imagefree 限流（${data.errorCode}）：${lastErr}`);
            }
        } catch (e) {
            if (/限流/.test(e.message)) throw e;
            lastErr = e.message;
        }
        if (attempt < 4) await sleep(6000 * attempt);
    }
    if (!taskId) throw new Error(`imagefree 提交失败：${lastErr}`);

    say(`已提交 taskId=${taskId}，排队中`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await fetchRetry(`${ENDPOINTS.imagefree}/api/generate/status?taskId=${encodeURIComponent(taskId)}`, {
            headers: IMAGEFREE_HEADERS(),
            signal: AbortSignal.timeout(60000),
        });
        const data = await j(r);
        if (data?.status === 'completed' && data.image) {
            const img = await fetch(data.image, { headers: IMAGEFREE_HEADERS(), signal: AbortSignal.timeout(120000) });
            if (!img.ok) throw new Error(`imagefree 下载失败 HTTP ${img.status}`);
            return {
                bytes: Buffer.from(await img.arrayBuffer()),
                ext: 'png',
                remoteUrl: data.image,
                provider: 'imagefree',
                taskId,
            };
        }
        if (data?.status === 'failed') throw new Error(`imagefree 生成失败：${data.error || 'unknown'}`);
        say(`生成中（${data?.status || 'pending'}${data?.progress ? ' ' + data.progress + '%' : ''}）`);
        await sleep(5000);
    }
    throw new Error('imagefree 超时（6 分钟）');
}

/* ------------------------------------------------------------------ *
 * 3. Veda Studio（免 Key 文生视频）
 * ------------------------------------------------------------------ */

const VEDA_ERRORS = { turnstile: 'Veda 要求人机验证（Turnstile），当前无法自动通过', blocked: 'Veda 内容审核拦截' };

/** 就近取整时长（5/10/15） */
export function nearestVedaDuration(sec) {
    const opts = VEDA_DEFAULTS.durationsSec;
    let best = opts[0];
    let delta = Math.abs(sec - best);
    for (const v of opts) {
        const d = Math.abs(sec - v);
        if (d < delta) { delta = d; best = v; }
    }
    return best;
}

export function vedaChoiceNum(sec) {
    const d = nearestVedaDuration(sec);
    return d === 15 ? 3 : d === 10 ? 2 : 1;
}

export function makeVeda(baseUrl = ENDPOINTS.veda, deviceStore = null, { fingerprintPool = null } = {}) {
    const root = String(baseUrl || ENDPOINTS.veda).replace(/\/+$/, '');
    let cookieId = null;
    let deviceId = null;
    let fingerprint = null;
    /** 当前任务绑定的池（submit 时锁定，poll/download 沿用） */
    let activePool = null;
    /** jobId → 该任务所属的指纹（轮询/下载必须用同一个指纹，否则找不到任务） */
    const jobFpsMap = new Map();

    const loadDevice = async () => {
        if (cookieId) return cookieId;
        cookieId = (await deviceStore?.load?.()) || null;
        return cookieId;
    };
    /**
     * 浏览器指纹（X-Fp）。
     * 官方前端每次请求都带这个头，值 = SHA-256(canvas2d指纹 || WebGL渲染器 || UA ||
     * languages || screen || 时区 || 时区偏移 || 硬件并发 || deviceMemory || platform)。
     * 服务端在无 Turnstile 时主要用它做风控采样；不带也能跑，但带上更接近真实浏览器。
     * 这里用本机可稳定复现的近似值（canvas/webgl 在 Node 无 DOM，用固定占位）。
     */
    const screenFallback = () => ({ width: 1920, height: 1080, colorDepth: 24, dpr: 1 });
    const buildFingerprint = () => {
        if (fingerprint) return fingerprint;
        const parts = [
            'no2d',            // Node 无 canvas
            'nogl',            // Node 无 WebGL
            UA,
            'zh-CN,zh',
            `${screenFallback().width}x${screenFallback().height}x${screenFallback().colorDepth}@${screenFallback().dpr}`,
            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            String(new Date().getTimezoneOffset()),
            String(os.cpus()?.length || 8),
            '',
            process.platform === 'darwin' ? 'MacIntel' : process.platform,
        ].join('||');
        fingerprint = crypto.createHash('sha256').update(parts).digest('hex');
        return fingerprint;
    };
    /**
     * 池模式 = 全程 bare（不带 cookie / X-Device-Id）。
     * 身份优先级（2026-11-17 四步对照实验）：veda_did cookie > X-Fp > 默认池。
     * 任何一次带 cookie 的请求都会把该 X-Fp 池吸附回 cookie 身份的全局池 ——
     * 所以只要启用了指纹池，所有请求一律 bare，只靠 X-Fp 分池。
     * 无池（fingerprintPool=null）时保持旧行为：cookie 身份 = 全局池，单设备用法一致。
     */
    const BARE = Boolean(fingerprintPool);
    const headers = (fpOverride = null) => {
        const h = {};
        if (!BARE) {
            if (cookieId) h.Cookie = `veda_did=${cookieId}`;
            if (deviceId) h['X-Device-Id'] = deviceId;
        }
        // X-Fp 是服务端的设备分组键：带上它才会落到该指纹对应的独立额度池。
        // 优先级：显式传入 > 当前任务绑定的池 > 池管理器首选池 > 本机固定指纹。
        let fp = fpOverride || activePool?.fp || fingerprint;
        if (!fp && fingerprintPool) {
            const first = fingerprintPool._pools?.[0];
            if (first) fp = first.fp;
        }
        if (fp) h['X-Fp'] = fp;
        h['Accept'] = 'application/json';
        h['Origin'] = root;
        h['Referer'] = `${root}/`;
        return h;
    };
    const absorbCookie = (res, rawBody) => {
        // bare（池）模式不吸收设备态：池专属 cookie 存进来会污染下一个池的请求
        if (BARE) return;
        // 服务端下发 x-device-id 头（与 cookie 前半段同值）
        const did = res.headers.get?.('x-device-id');
        if (did) deviceId = did;
        const sc = res.headers.getSetCookie?.() || [];
        for (const c of sc) {
            const m = /veda_did=([^;,\s]+)/.exec(c);
            if (m) { cookieId = m[1]; deviceStore?.save?.(cookieId).catch?.(() => {}); return; }
        }
        // 兼容部分代理把 Set-Cookie 塞进 body 的情况
        const m2 = /veda_did=([^;,\s]+)/.exec(typeof rawBody === 'string' ? rawBody : '');
        if (m2) { cookieId = m2[1]; deviceStore?.save?.(cookieId).catch?.(() => {}); }
    };

    const api = async (p, init = {}, timeoutMs = 30000, fpOverride = null) => {
        await loadDevice();
        // 无任务上下文时（如 quota 查询）也要用池里的指纹，否则会落到「无指纹默认池」
        if (!fpOverride && !activePool?.fp && !fingerprint && fingerprintPool) {
            const fp = await fingerprintPool.currentFingerprint();
            if (fp) fingerprint = fp;
        }
        // Node 的 keep-alive 连接池偶尔会在复用被上游关掉的 socket 时报 fetch failed，
        // 对幂等的 GET 重试一次即可（POST 提交不重试，避免重复扣额度）
        const idempotent = !init.method || init.method === 'GET';
        const attempt = async () => {
            const r = await fetch(`${root}${p}`, { ...init, headers: { ...(init.headers || {}), ...headers(fpOverride) }, signal: AbortSignal.timeout(timeoutMs) });
            const text = await r.text();
            absorbCookie(r, text);
            let data = null;
            try { data = JSON.parse(text); } catch { data = { _raw: text }; }
            return { r, data };
        };
        try {
            return await attempt();
        } catch (e) {
            if (!idempotent) throw e;
            await sleep(400);
            return attempt();
        }
    };

    return {
        id: 'veda',
        label: 'Veda Studio',
        root,
        fingerprintPool,

        /** 池状态快照（供 UI 展示「还有多少可用额度」） */
        async poolStatus() {
            if (!fingerprintPool) return null;
            return fingerprintPool.snapshot();
        },

        /** 探活：队列、可用槽位、等待秒数 */
        async probe() {
            try {
                const { r, data } = await api('/api/health', { method: 'GET' }, 15000);
                if (!r.ok) return { online: false, note: `HTTP ${r.status}` };
                return {
                    online: !!data?.ok,
                    queueLen: Number(data?.queue_len ?? 0),
                    waitSec: Number(data?.wait_s ?? 0),
                    slotsFree: Number(data?.slots_free ?? 0),
                    backend: data?.backend || '',
                };
            } catch (e) {
                return { online: false, note: e.message };
            }
        },

        async capabilities() {
            try {
                const { r, data } = await api('/api/config', { method: 'GET' }, 15000);
                if (!r.ok) return { ...VEDA_DEFAULTS };
                return {
                    durationsSec: Array.isArray(data?.durations) ? data.durations.map((d) => Number(d.seconds ?? d.value ?? d)).filter((n) => n > 0) : VEDA_DEFAULTS.durationsSec,
                    aspectRatios: Array.isArray(data?.aspects) ? data.aspects.map((a) => String(a.value)) : VEDA_DEFAULTS.aspectRatios,
                    creditCosts: data?.credit_costs || VEDA_DEFAULTS.creditCosts,
                    dailyLimit: Number(data?.daily_limit || VEDA_DEFAULTS.dailyLimit),
                    promptMinLen: Number(data?.prompt_min_len ?? VEDA_DEFAULTS.promptMinLen),
                    promptMaxLen: Number(data?.prompt_max_len ?? VEDA_DEFAULTS.promptMaxLen),
                };
            } catch {
                return { ...VEDA_DEFAULTS };
            }
        },

        /**
         * 额度查询。
         * 有池时：轮询每个池，把「当前可用池」和「全部池汇总」一起返回，
         * 让上层能如实知道「共有多少额度可用」。
         */
        async quota() {
            const readOne = async (fp) => {
                try {
                    const { r, data } = await api('/api/quota', { method: 'GET' }, 15000, fp);
                    if (!r.ok) return null;
                    const limit = Number(data?.daily_limit ?? data?.limit ?? VEDA_DEFAULTS.dailyLimit);
                    const used = Number(data?.used ?? 0);
                    return {
                        limit,
                        used,
                        remaining: Number(data?.remaining ?? limit - used),
                        resetsAt: data?.resets_at || null,
                        scope: data?.scope || null,
                    };
                } catch {
                    return null;
                }
            };

            if (fingerprintPool) {
                const pools = await fingerprintPool.snapshot();
                let total = 0;
                let limit = 0;
                let resetsAt = null;
                let best = null;
                // 并行查各池（串行会随池数线性变慢，前端要等十几秒）
                const results = await Promise.all(
                    pools.map((p) => readOne(p.fpFull || p.fp).then((q) => ({ p, q }))),
                );
                const details = [];
                for (const { p, q } of results) {
                    if (!q) continue;
                    details.push({ id: p.id, ...q });
                    total += q.remaining;
                    limit += q.limit;
                    if (!best || q.remaining > best.remaining) best = q;
                    if (p.id != null) await fingerprintPool.report(p.id, q);
                }
                return {
                    limit,
                    used: limit - total,
                    remaining: total,
                    resetsAt: best?.resetsAt ?? resetsAt,
                    pools: details,
                    poolCount: details.length,
                };
            }

            const q = await readOne(fingerprint || null);
            return q;
        },

        /**
         * 提交前的槽位自检。
         * 上游只有 2 张 GPU（slots_total=2），并发满了会返回 429 too_many_active。
         * 这不是额度问题 —— 换池也没用，必须等槽位释放。
         * 提前探一次，把「等一下再试」变成明确提示，避免用户以为是额度耗尽。
         */
        async checkSlots() {
            try {
                const { r, data } = await api('/api/health', { method: 'GET' }, 12000);
                if (!r.ok) return { ok: true, note: '健康检查不可用，放行' };
                const free = Number(data?.slots_free ?? data?.slots ?? 0);
                const total = Number(data?.slots_total ?? data?.slots ?? 0);
                const queue = Number(data?.queue_len ?? 0);
                return {
                    ok: free > 0 || total === 0,
                    slotsFree: free,
                    slotsTotal: total,
                    queueLen: queue,
                    waitSec: Number(data?.wait_s ?? 0),
                };
            } catch {
                return { ok: true, note: '健康检查失败，放行' };
            }
        },

        /**
         * 等到有空闲槽位。
         * 上游 wait_s 会给预计等待秒数；这里按它轮询，最长等 maxWaitMs。
         * 目的：用户点一次「生成」就能排上队，而不是自己反复重试。
         */
        async waitForSlot(maxWaitMs = 180000, onWait = null) {
            const deadline = Date.now() + maxWaitMs;
            let last = null;
            while (Date.now() < deadline) {
                last = await this.checkSlots();
                if (last.ok) return last;
                const waitMs = Math.min(30000, Math.max(4000, (Number(last.waitSec) || 20) * 1000));
                onWait?.(last, waitMs);
                await sleep(waitMs);
            }
            return { ...(last || { ok: false }), timedOut: true };
        },

        async submit({ prompt, durationSec = 5, aspect = '16:9', seed = null, mode = 'enhance', refs = [], waitForSlot = false, onWait = null }) {
            const p = String(prompt || '').trim();
            if (p.length < VEDA_DEFAULTS.promptMinLen) {
                throw new Error(`Veda 提示词太短（至少 ${VEDA_DEFAULTS.promptMinLen} 字符，当前 ${p.length}）`);
            }
            // 槽位自检：满了就等（waitForSlot=true）或明确提示。
            // 上游只有 2 张 GPU，wait_s 是官方给的预计等待秒数。
            const slots = await this.checkSlots();
            if (slots.ok === false) {
                if (!waitForSlot) {
                    throw new Error(
                        `Veda 生成槽位已满（${slots.slotsFree}/${slots.slotsTotal} 可用，队列 ${slots.queueLen}，`
                        + `预计等待 ${Math.round((Number(slots.waitSec) || 30))}s）。这是上游 2 张 GPU 的并发上限，与额度无关 —— `
                        + `等前面的任务出片后重试即可。`,
                    );
                }
                // 自动排队等槽位
                const waited = await this.waitForSlot(300000, onWait);
                if (!waited.ok) {
                    throw new Error(
                        `Veda 等待槽位超时（${waited.slotsFree ?? '?'}/${waited.slotsTotal ?? '?'} 可用，队列 ${waited.queueLen ?? '?'}）。`
                        + `这是上游 2 张 GPU 的并发上限，与额度无关。`,
                    );
                }
            }
            // 取一个可用指纹池（无池时用本机固定指纹）
            let pool = null;
            if (fingerprintPool) {
                pool = await fingerprintPool.acquire();
            } else if (!fingerprint) {
                fingerprint = buildFingerprint();
            }
            const fp = pool?.fp || fingerprint;
            const { r, data } = await api('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, mode, duration: nearestVedaDuration(durationSec), aspect, seed, turnstile_token: null, refs }),
            }, 60000, fp);
            if (r.status === 403 || r.status === 429) {
                if (data?.turnstile_required === true || /turnstile|captcha|challenge|验证/i.test(JSON.stringify(data))) {
                    throw new Error(VEDA_ERRORS.turnstile);
                }
            }
            if (data?.error === 'content_blocked') throw new Error(`${VEDA_ERRORS.blocked}（${data.category || 'unknown'}）`);
            if (data?.error === 'too_many_active' || /too_many_active|already have \d+ videos in progress/i.test(JSON.stringify(data))) {
                throw new Error(
                    `Veda 生成槽位已满（上游 2 张 GPU 的并发上限），与额度无关。`
                    + `等前面的任务出片后再提交，或先在额度面板查看槽位状态。`,
                );
            }
            if (!r.ok) throw new Error(`Veda 提交失败 HTTP ${r.status}：${JSON.stringify(data).slice(0, 200)}`);
            const jobId = data?.job_id ?? data?.id ?? data?.task_id;
            if (!jobId) throw new Error(`Veda 未返回 job_id：${JSON.stringify(data).slice(0, 200)}`);
            // 记住该 job 属于哪个指纹池，轮询/下载时沿用
            const jobFps = String(jobId);
            if (fp) {
                jobFpsMap.set(jobFps, fp);
                if (pool && fingerprintPool) await fingerprintPool.report(pool.id, data?.quota || null);
            }
            return { jobId: String(jobId), poolId: pool?.id ?? null, quota: data?.quota || null };
        },

        /** 单次查询：{status:'queued|running|done|failed|cancelled', progress?, enhancedPrompt?} */
        async poll(jobId) {
            const fp = jobFpsMap.get(String(jobId)) || activePool?.fp || null;
            let r, data;
            try {
                ({ r, data } = await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, 20000, fp));
            } catch (e) {
                // 上游偶发空响应 / keep-alive 断连 —— 这是网络抖动，不是任务失败。
                // 返回 queued 让调用方继续等，绝不能误判成 failed。
                return { status: 'queued', transient: true, error: e.message };
            }
            // 空 body（上游限流抖动）→ 同样按「继续等」处理
            if (!r.ok && !data?.status) return { status: 'queued', transient: true, error: `HTTP ${r.status}` };
            if (!r.ok) return { status: 'failed', error: `HTTP ${r.status}` };
            const raw = String(data?.status || '').toLowerCase();
            const status = ['done', 'succeeded', 'completed', 'finished'].includes(raw) ? 'done'
                : ['failed', 'error', 'errored'].includes(raw) ? 'failed'
                : ['cancelled', 'canceled', 'aborted'].includes(raw) ? 'cancelled'
                : ['running', 'enhancing', 'denoising', 'processing', 'generating'].includes(raw) ? 'running'
                : 'queued';
            const out = { status };
            if (typeof data?.progress === 'number') out.progress = data.progress;
            if (typeof data?.enhanced_prompt === 'string') out.enhancedPrompt = data.enhanced_prompt;
            if (status === 'failed') out.error = data?.error || JSON.stringify(data).slice(0, 160);
            return out;
        },

        /**
         * 下载成片。
         * 上游出片后带宽很慢（8MB 的片子要几分钟），单次请求容易被中途掐断。
         * 策略：长超时 + Range 续传 + 多次重试，避免「传到一半就失败」。
         */
        async fetchVideoBytes(jobId, timeoutMs = 900000) {
            // 注意：不能用 api() —— 它会把 body 当文本读走，二进制就废了
            await loadDevice();
            const fp = jobFpsMap.get(String(jobId)) || activePool?.fp || null;
            const url = `${root}/api/jobs/${encodeURIComponent(jobId)}/video`;
            const parts = [];
            let total = 0;
            for (let attempt = 0; attempt < 4; attempt++) {
                const have = parts.reduce((n, b) => n + b.length, 0);
                const hs = { ...headers(fp) };
                if (have > 0) hs.Range = `bytes=${have}-`;
                try {
                    const r = await fetch(url, {
                        method: 'GET',
                        headers: hs,
                        signal: AbortSignal.timeout(timeoutMs),
                    });
                    absorbCookie(r, null);
                    if (!r.ok && r.status !== 206) {
                        throw new Error(`Veda 视频下载失败 HTTP ${r.status}`);
                    }
                    const buf = Buffer.from(await r.arrayBuffer());
                    if (buf.length < 1024) throw new Error(`Veda 视频字节异常（${buf.length} 字节）`);
                    parts.push(buf);
                    total = have + buf.length;
                    // 服务端没给 Content-Length 且本次已读完 → 认为下载完成
                    const len = Number(r.headers.get('content-length') || 0);
                    if (r.status === 206 && have + buf.length >= total) continue;
                    if (!len && buf.length < 1024 * 512) break;
                    if (r.status === 200) break;
                } catch (e) {
                    // 超时/网络中断：保留已下载的分片，下一轮带 Range 续传
                    if (attempt >= 3) throw e;
                    await sleep(1500);
                }
            }
            const out = Buffer.concat(parts);
            if (out.length < 1024) throw new Error(`Veda 视频字节异常（${out.length} 字节）`);
            return out;
        },
    };
}

/* ------------------------------------------------------------------ *
 * 统一入口：免 Key 生图（pollinations → imagefree 依次尝试）
 * ------------------------------------------------------------------ */

export async function freeImage({ prompt, size = '1024x1024', width, height, seed, onStatus }) {
    const dims = (() => {
        const m = String(size || '').match(/^(\d+)\s*[x×]\s*(\d+)$/);
        if (!m) return { w: width || 1024, h: height || 1024 };
        return { w: Number(m[1]), h: Number(m[2]) };
    })();
    const errors = [];
    const ps = pollinationsStatus();
    if (ps.limited) {
        errors.push(`pollinations: 限流中（剩余 ${ps.cooldown_sec}s，${ps.reason || ''}）`);
    } else {
        try {
            const out = await pollinationsImage({ prompt, width: dims.w, height: dims.h, seed });
            return { ...out, failover_log: errors };
        } catch (e) {
            errors.push(`pollinations: ${e.message}`);
        }
    }
    try {
        onStatus?.('切 imagefree（这家单次请求要 10-20 秒，耐心等）');
        const out = await imagefreeImage({ prompt, size, onStatus });
        return { ...out, failover_log: errors };
    } catch (e) {
        errors.push(`imagefree: ${e.message}`);
    }
    throw new Error(`免 Key 生图全部失败 —— ${errors.join(' | ')}`);
}

export function deviceId() {
    return crypto.randomUUID();
}
