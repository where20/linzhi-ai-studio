/**
 * SiftQ MiniMax-H3 免账号通道（siftq.com）
 *
 * 2026-11-17 实测跑通：showcase/video-generation 提交 → queued → succeeded → 下载 MP4。
 *
 * 上游协议要点（全部来自官方前端 bundle + 实测，非猜测）：
 *   · 提交端点：POST /api/minimax-trial/showcase/video-generation   ← 必须走 showcase 通道
 *     （直连 /api/minimax-trial/video-generation 返回 400，prompt 不生效）
 *   · 必须是 multipart/form-data，不是 JSON
 *   · 必填表单字段：showcase_id / ratio / duration / client_id / image(文件) / prompt
 *                  + visitorId / channelCode / sourceHost（遥测，不影响额度）
 *   · 必填请求头：Idempotency-Key（缺了直接 400）、X-MiniMax-Trial-Client（= client_id）
 *   · resolution=768P（免费档唯一档位）、max_credits=0（明确走免费额度）
 *
 * 额度事实（2026-11-17 实测）：
 *   · 匿名 2 条/天、登录后 4 条/天；客户端身份（client_id）不是额度键
 *   · 额度按「服务端识别的出口 IP」分池：同出口换 client_id 仍见同一 used；
 *     换真实出口 IP → 另一个池
 *   · max_concurrent=5（并发槽位与额度独立）
 *   · 队列较长（实测 queue_position 最高 13），需轮询
 *
 * 边界（刻意不做）：
 *   · 不伪造 X-Forwarded-For 来重置额度（那是规避访问控制）
 *   · 不轮换 client_id 试图绕过额度（同出口无效，且无意义）
 *   · POST 失败不重试（可能已扣额度）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ORIGIN = "https://siftq.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export const SIFTQ_DEFAULTS = {
    showcaseId: process.env.SIFTQ_SHOWCASE_ID || "case-mtqzygu8",
    resolution: "768P",
    ratio: "9:16",
    duration: 6,
    dailyLimit: 2,
    maxConcurrent: 5,
    imageMaxBytes: 20 * 1024 * 1024,
    defaultPrompt:
        "Animate the scene in the image with natural, faithful motion. " +
        "Keep the subject and setting consistent with the input image.",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SiftqError extends Error {
    constructor(message, { code = "error", status = 0, body = null } = {}) {
        super(message);
        this.name = "SiftqError";
        this.code = code;
        this.status = status;
        this.body = body;
    }
}

/** 本地匿名会话标识：等价于真实浏览器首次访问写入 localStorage，只铸一次后固定复用 */
export function makeSiftqDeviceStore(file) {
    let cached = null;
    let loading = null;

    const load = async () => {
        if (cached) return cached;
        if (loading) return loading;
        loading = (async () => {
            try {
                const raw = JSON.parse(await fs.readFile(file, "utf8"));
                cached = {
                    clientId: raw.clientId || `mmtrial_${randomUUID()}`,
                    visitorId: raw.visitorId || `mmguest_${randomUUID()}`,
                };
            } catch {
                cached = {
                    clientId: `mmtrial_${randomUUID()}`,
                    visitorId: `mmguest_${randomUUID()}`,
                };
                await save().catch(() => {});
            }
            return cached;
        })();
        return loading;
    };

    const save = async () => {
        if (!cached) return;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(cached, null, 1), { mode: 0o600 });
    };

    return { load, save, ensure: load };
}

/** 把本地路径 / http(s) URL / dataURL 解析成可上传的二进制 */
async function resolveImage(ref) {
    if (!ref) throw new SiftqError("SiftQ 是图生视频，必须提供输入图（image / imageUrl / firstFrame）", { code: "validation" });

    if (typeof ref === "string" && ref.startsWith("data:")) {
        const m = /^data:([^;]+);base64,(.+)$/s.exec(ref);
        if (!m) throw new SiftqError("dataURL 格式不合法", { code: "validation" });
        return { bytes: Buffer.from(m[2], "base64"), mime: m[1], filename: "input.png" };
    }

    if (/^https?:\/\//i.test(ref)) {
        const res = await fetch(ref, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new SiftqError(`下载输入图失败 HTTP ${res.status}`, { code: "network", status: res.status });
        const mime = res.headers.get("content-type") || "image/jpeg";
        const bytes = Buffer.from(await res.arrayBuffer());
        return { bytes, mime: mime.split(";")[0], filename: "input.jpg" };
    }

    const bytes = await fs.readFile(ref);
    const ext = path.extname(ref).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { bytes, mime, filename: path.basename(ref) };
}

export function makeSiftq({ origin = ORIGIN, deviceStore, showcaseId } = {}) {
    const root = String(origin).replace(/\/+$/, "");
    const sid = showcaseId || SIFTQ_DEFAULTS.showcaseId;

    const sessionHeaders = async () => {
        const dev = await deviceStore.ensure();
        return {
            accept: "application/json",
            "user-agent": UA,
            referer: `${root}/minimax-h3/try/zh`,
            "x-minimax-trial-client": dev.clientId,
        };
    };

    const call = async (pathname, { method = "GET", body = null, headers = {}, timeoutMs = 120_000 } = {}) => {
        const base = { ...(await sessionHeaders()), ...headers };
        if (body && !(body instanceof FormData)) base["content-type"] = "application/json";

        // GET 幂等可重试；POST 可能已扣额度，绝不重试
        const attempts = method === "GET" ? 3 : 1;
        let lastErr = null;
        for (let i = 1; i <= attempts; i++) {
            let res;
            try {
                res = await fetch(`${root}${pathname}`, {
                    method,
                    headers: base,
                    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (e) {
                lastErr = new SiftqError(`连不上 SiftQ：${e.cause?.code || e.message}`, { code: "network" });
                if (i < attempts) { await sleep(600 * i); continue; }
                throw lastErr;
            }

            const text = await res.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 500) }; }

            if (!res.ok) {
                const msg = data?.error?.message || data?.message || `上游返回 ${res.status}`;
                throw new SiftqError(msg, { code: data?.error?.type || `http_${res.status}`, status: res.status, body: data });
            }
            // 业务层错误：上游用 HTTP 200 + errCode 表达失败
            if (data && typeof data.errCode === "number" && data.errCode !== 0) {
                throw new SiftqError(data.errMsg || `上游业务错误 ${data.errCode}`, { code: `err_${data.errCode}`, status: res.status, body: data });
            }
            return data;
        }
        throw lastErr;
    };

    const client = {
        id: "siftq",
        label: "SiftQ MiniMax-H3",

        async usage() {
            try {
                const data = await call("/api/minimax-trial/usage", { method: "GET", timeoutMs: 20_000 });
                const limit = Number(data?.limit ?? SIFTQ_DEFAULTS.dailyLimit);
                const used = Number(data?.used ?? 0);
                return {
                    limit,
                    used,
                    remaining: Number(data?.remaining ?? limit - used),
                    bonusRemaining: Number(data?.bonus_remaining ?? 0),
                    authenticated: !!data?.authenticated,
                    maxConcurrent: Number(data?.max_concurrent ?? SIFTQ_DEFAULTS.maxConcurrent),
                    enabled: data?.enabled !== false,
                    raw: data,
                };
            } catch {
                return null;
            }
        },

        async capabilities() {
            try {
                const data = await call("/api/minimax-trial/config", { method: "GET", timeoutMs: 20_000 });
                return {
                    resolution: data?.free_resolution || SIFTQ_DEFAULTS.resolution,
                    anonymousDailyLimit: Number(data?.anonymous_daily_limit ?? SIFTQ_DEFAULTS.dailyLimit),
                    authenticatedDailyLimit: Number(data?.authenticated_daily_limit ?? 4),
                    maxConcurrent: Number(data?.max_concurrent ?? SIFTQ_DEFAULTS.maxConcurrent),
                    guestLlmDailyLimit: Number(data?.girlfriend_guest_llm_daily_limit ?? 0),
                    guestTtsDailyLimit: Number(data?.girlfriend_guest_tts_daily_limit ?? 0),
                };
            } catch {
                return { resolution: SIFTQ_DEFAULTS.resolution, anonymousDailyLimit: SIFTQ_DEFAULTS.dailyLimit };
            }
        },

        /**
         * 提交图生视频。实测可用格式（缺任一项会 400）：
         *   showcase_id / ratio / duration / client_id / image / prompt
         *   + 请求头 Idempotency-Key、X-MiniMax-Trial-Client
         *   + resolution=768P、max_credits=0
         */
        async submit({ prompt, image, imageUrl, firstFrame, ratio = SIFTQ_DEFAULTS.ratio, duration = SIFTQ_DEFAULTS.duration, resolution = SIFTQ_DEFAULTS.resolution, showcaseId: sidOverride, idempotencyKey } = {}) {
            const ref = image || imageUrl || firstFrame;
            if (!ref) throw new SiftqError("SiftQ 是图生视频，必须提供输入图（image / imageUrl / firstFrame）", { code: "validation" });
            const img = await resolveImage(ref);
            if (img.bytes.length > SIFTQ_DEFAULTS.imageMaxBytes) {
                throw new SiftqError(`输入图过大（${Math.round(img.bytes.length / 1024 / 1024)}MB），上限 20MB`, { code: "validation" });
            }

            const dev = await deviceStore.ensure();
            const text = String(prompt || "").trim() || SIFTQ_DEFAULTS.defaultPrompt;

            const form = new FormData();
            form.set("visitorId", dev.visitorId);
            form.set("channelCode", "direct");
            form.set("sourceHost", "siftq.com");
            form.set("showcase_id", sidOverride || sid);
            form.set("ratio", ratio);
            form.set("duration", String(duration));
            form.set("resolution", resolution);
            form.set("client_id", dev.clientId);
            form.set("max_credits", "0");
            form.set("prompt", text);
            form.set("image", new Blob([img.bytes], { type: img.mime }), img.filename);

            const key = idempotencyKey ? `wfs_${idempotencyKey}` : `mmtrial_${randomUUID()}`;
            const out = await call("/api/minimax-trial/showcase/video-generation", {
                method: "POST",
                body: form,
                headers: { "Idempotency-Key": key },
                timeoutMs: 120_000,
            });

            const taskId = String(out?.task_id ?? out?.taskId ?? "");
            if (!taskId) throw new SiftqError("上游没有返回 task_id", { code: "upstream_error", body: out });
            return {
                task_id: taskId,
                access_token: out?.access_token ?? out?.accessToken ?? null,
                status: out?.status || "queued",
                remaining: Number.isInteger(out?.remaining) ? out.remaining : null,
                bonusRemaining: Number.isInteger(out?.bonus_remaining) ? out.bonus_remaining : null,
                generationMode: out?.generation_mode || "free",
                resolution: out?.resolution || resolution,
                duration: Number(out?.duration ?? duration),
                _payload: { prompt: text, ratio, duration, imageBytes: img.bytes.length },
            };
        },

        async job(taskId, accessToken) {
            const q = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : "";
            const data = await call(`/api/minimax-trial/video-generation/${encodeURIComponent(taskId)}${q}`, { method: "GET", timeoutMs: 30_000 });
            return {
                status: data?.status || "unknown",
                queuePosition: Number.isInteger(data?.queue_position) ? data.queue_position : null,
                activeCount: Number.isInteger(data?.active_count) ? data.active_count : null,
                raw: data,
            };
        },

    /** 下载成片字节（上游 1–2 天后回收，出片即落盘） */
    async contentBytes(taskId, accessToken, { timeoutMs = 900_000 } = {}) {
        const dev = await deviceStore.ensure();
        const q = new URLSearchParams({ client_id: dev.clientId });
        if (accessToken) q.set("access_token", accessToken);
        const res = await fetch(`${root}/api/minimax-trial/video-generation/${encodeURIComponent(taskId)}/content?${q}`, {
            headers: { "user-agent": UA, accept: "*/*" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new SiftqError(`视频下载失败 HTTP ${res.status}`, { code: "http_error", status: res.status });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new SiftqError(`视频字节异常（${buf.length} 字节）`, { code: "upstream_error" });
        return buf;
    },

        /** 轮询到终态 */
        async waitFor(taskId, accessToken, { timeoutMs = 15 * 60_000, intervalMs = 8_000, onProgress } = {}) {
            const deadline = Date.now() + timeoutMs;
            let lastStatus = null;
            while (Date.now() < deadline) {
                const snap = await client.job(taskId, accessToken);
                if (snap.status !== lastStatus) {
                    lastStatus = snap.status;
                    onProgress?.(snap);
                }
                if (["succeeded", "failed", "canceled", "cancelled"].includes(snap.status)) return snap;
                await sleep(intervalMs);
            }
            throw new SiftqError(`等待超时（${Math.round(timeoutMs / 1000)}s），任务仍在 ${lastStatus}`, { code: "timeout" });
        },
    };

    return client;
}
