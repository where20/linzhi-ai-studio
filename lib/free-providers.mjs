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

/** 设备标识持久化（Veda 按 veda_did cookie 计额度，换 id 等于换额度池，别乱换） */
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

export function makeVeda(baseUrl = ENDPOINTS.veda, deviceStore = null) {
    const root = String(baseUrl || ENDPOINTS.veda).replace(/\/+$/, '');
    let cookieId = null;
    const loadDevice = async () => {
        if (cookieId) return cookieId;
        cookieId = (await deviceStore?.load?.()) || null;
        return cookieId;
    };
    const headers = () => (cookieId ? { Cookie: `veda_did=${cookieId}` } : {});
    const absorbCookie = (res, rawBody) => {
        const sc = res.headers.getSetCookie?.() || [];
        for (const c of sc) {
            const m = /veda_did=([^;,\s]+)/.exec(c);
            if (m) { cookieId = m[1]; deviceStore?.save?.(cookieId).catch?.(() => {}); return; }
        }
        // 兼容部分代理把 Set-Cookie 塞进 body 的情况
        const m2 = /veda_did=([^;,\s]+)/.exec(typeof rawBody === 'string' ? rawBody : '');
        if (m2) { cookieId = m2[1]; deviceStore?.save?.(cookieId).catch?.(() => {}); }
    };

    const api = async (p, init = {}, timeoutMs = 30000) => {
        await loadDevice();
        // Node 的 keep-alive 连接池偶尔会在复用被上游关掉的 socket 时报 fetch failed，
        // 对幂等的 GET 重试一次即可（POST 提交不重试，避免重复扣额度）
        const idempotent = !init.method || init.method === 'GET';
        const attempt = async () => {
            const r = await fetch(`${root}${p}`, { ...init, headers: { ...(init.headers || {}), ...headers() }, signal: AbortSignal.timeout(timeoutMs) });
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

        async quota() {
            try {
                const { r, data } = await api('/api/quota', { method: 'GET' }, 15000);
                if (!r.ok) return null;
                const limit = Number(data?.daily_limit ?? VEDA_DEFAULTS.dailyLimit);
                const used = Number(data?.used ?? 0);
                return { limit, used, remaining: Number(data?.remaining ?? limit - used), resetsAt: data?.resets_at || null };
            } catch {
                return null;
            }
        },

        async submit({ prompt, durationSec = 5, aspect = '16:9', seed = null, mode = 'enhance', refs = [] }) {
            const p = String(prompt || '').trim();
            if (p.length < VEDA_DEFAULTS.promptMinLen) {
                throw new Error(`Veda 提示词太短（至少 ${VEDA_DEFAULTS.promptMinLen} 字符，当前 ${p.length}）`);
            }
            const { r, data } = await api('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, mode, duration: nearestVedaDuration(durationSec), aspect, seed, turnstile_token: null, refs }),
            }, 60000);
            if (r.status === 403 || r.status === 429) {
                if (data?.turnstile_required === true || /turnstile|captcha|challenge|验证/i.test(JSON.stringify(data))) {
                    throw new Error(VEDA_ERRORS.turnstile);
                }
            }
            if (data?.error === 'content_blocked') throw new Error(`${VEDA_ERRORS.blocked}（${data.category || 'unknown'}）`);
            if (!r.ok) throw new Error(`Veda 提交失败 HTTP ${r.status}：${JSON.stringify(data).slice(0, 200)}`);
            const jobId = data?.job_id ?? data?.id ?? data?.task_id;
            if (!jobId) throw new Error(`Veda 未返回 job_id：${JSON.stringify(data).slice(0, 200)}`);
            return { jobId: String(jobId) };
        },

        /** 单次查询：{status:'queued|running|done|failed|cancelled', progress?, enhancedPrompt?} */
        async poll(jobId) {
            const { r, data } = await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, 20000);
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

        async fetchVideoBytes(jobId, timeoutMs = 300000) {
            // 注意：不能用 api() —— 它会把 body 当文本读走，二进制就废了
            await loadDevice();
            const r = await fetch(`${root}/api/jobs/${encodeURIComponent(jobId)}/video`, {
                method: 'GET',
                headers: { ...headers() },
                signal: AbortSignal.timeout(timeoutMs),
            });
            absorbCookie(r, null);
            if (!r.ok) throw new Error(`Veda 视频下载失败 HTTP ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 1024) throw new Error(`Veda 视频字节异常（${buf.length} 字节）`);
            return buf;
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
