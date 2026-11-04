// agnes-client.mjs
// Thin, dependency-free client for the Agnes AI API (https://apihub.agnes-ai.com/v1).
// Implements the three capability families documented at
//   https://www.agnes-ai.com/zh-Hans/docs/overview
//   - Text  : POST /v1/chat/completions         (OpenAI-compatible, SSE streaming)
//   - Image : POST /v1/images/generations       (size tier + ratio, text2img / img2img)
//   - Video : POST /v1/videos  →  GET /agnesapi?video_id=..&model_name=..  (async polling)
//
// Everything is server-side only: the API key never leaves this process.

const DEFAULT_BASE = "https://apihub.agnes-ai.com/v1";
const DEFAULT_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Static catalog (from the docs). Live availability is confirmed via /v1/models.
// ---------------------------------------------------------------------------

export const CHAT_MODELS = [
  {
    id: "agnes-3.0-flash",
    name: "Agnes 3.0 Flash",
    tag: "新一代 · Agent/Code · 512K 上下文",
    free: true,
  },
  {
    id: "agnes-3.0-pro",
    name: "Agnes 3.0 Pro",
    tag: "Pro 新一代（即将上线）",
    free: false,
  },
  {
    id: "agnes-2.5-flash",
    name: "Agnes 2.5 Flash",
    tag: "通用 · 多模态理解 · 免费",
    free: true,
  },
  {
    id: "agnes-2.5-pro",
    name: "Agnes 2.5 Pro",
    tag: "长上下文 · 科学推理",
    free: false,
  },
  {
    id: "agnes-2.5-pro-beta",
    name: "Agnes 2.5 Pro Beta",
    tag: "Beta · 高级编码 / Agent 工作流",
    free: false,
  },
];

export const IMAGE_MODELS = [
  {
    id: "agnes-image-2.5-flash",
    name: "Agnes Image 2.5",
    tag: "最新 · 高信息密度 · 1K–4K · 当前免费",
  },
  {
    id: "agnes-image-2.1-flash",
    name: "Agnes Image 2.1",
    tag: "上一代 · 高密度视觉",
  },
  {
    id: "agnes-image-2.0-flash",
    name: "Agnes Image 2.0",
    tag: "稳定版 · ELO 1184",
  },
];

export const VIDEO_MODELS = [
  {
    id: "agnes-video-2.5-flash",
    name: "Agnes Video 2.5 Flash",
    tag: "仅 720P · 当前 $0/秒",
    sizes: ["720P"],
    maxRefImages: 5,
    supportsVideoRef: false,
  },
  {
    id: "agnes-video-2.5",
    name: "Agnes Video 2.5",
    tag: "720P / 1080P / 1K / 2K · $0.025–0.055/秒",
    sizes: ["720P", "1080P", "1K", "2K"],
    maxRefImages: 8,
    supportsVideoRef: true,
  },
];

// Output dimensions per size tier × ratio (docs: "输出尺寸参考").
const TIER_DIMS = {
  "1K": {
    "1:1": [1024, 1024],
    "3:4": [864, 1152],
    "4:3": [1152, 864],
    "16:9": [1312, 736],
    "9:16": [736, 1312],
    "2:3": [832, 1248],
    "3:2": [1248, 832],
    "21:9": [1568, 672],
  },
  "2K": {
    "1:1": [2048, 2048],
    "3:4": [1728, 2304],
    "4:3": [2304, 1728],
    "16:9": [2624, 1472],
    "9:16": [1472, 2624],
    "2:3": [1664, 2496],
    "3:2": [2496, 1664],
    "21:9": [3136, 1344],
  },
  "3K": {
    "1:1": [3072, 3072],
    "3:4": [2592, 3456],
    "4:3": [3456, 2592],
    "16:9": [3936, 2208],
    "9:16": [2208, 3936],
    "2:3": [2496, 3744],
    "3:2": [3744, 2496],
    "21:9": [4704, 2016],
  },
  "4K": {
    "1:1": [4096, 4096],
    "3:4": [3456, 4608],
    "4:3": [4608, 3456],
    "16:9": [5248, 2944],
    "9:16": [2944, 5248],
    "2:3": [3328, 4992],
    "3:2": [4992, 3328],
    "21:9": [6272, 2688],
  },
};

export const IMAGE_RATIOS = Object.keys(TIER_DIMS["1K"]);
export const IMAGE_SIZE_TIERS = Object.keys(TIER_DIMS);

/** Pixel dimensions for a (tier, ratio) pair; falls back to 1K 1:1. */
export function tierDims(tier, ratio) {
  return TIER_DIMS[tier]?.[ratio] ?? TIER_DIMS["1K"]["1:1"];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS_HINTS = {
  400: "请求参数有误（检查必填字段 / size 档位 / seconds 需为字符串）",
  401: "API Key 无效、已删除或 Bearer 后缺少空格",
  402: "账户余额或订阅配额不足",
  404: "端点、模型或任务 ID 不存在",
  429: "触发限流（RPM 或配额超限）",
  503: "上游繁忙或任务队列已满",
};

export class AgnesError extends Error {
  constructor(message, { status = 0, code = null, detail = "", retryable = false } = {}) {
    super(message);
    this.name = "AgnesError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

function makeError(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  let code = null;
  let message = "";
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    code = parsed?.code ?? parsed?.error?.code ?? null;
    message = parsed?.message ?? parsed?.error?.message ?? parsed?.error ?? "";
  } catch {
    /* body wasn't JSON */
  }
  const hint = STATUS_HINTS[status] ?? `上游返回 HTTP ${status}`;
  const retryable = status === 429 || status >= 500;
  const full = [hint, message && String(message).slice(0, 240)].filter(Boolean).join(" · ");
  return new AgnesError(full, { status, code, detail: text.slice(0, 400), retryable });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgnesError("请求已取消"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AgnesError("请求已取消"));
      },
      { once: true }
    );
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AgnesClient {
  constructor({
    apiKey = process.env.AGNES_API_KEY || "",
    baseUrl = process.env.AGNES_BASE_URL || DEFAULT_BASE,
    timeoutMs = Number(process.env.AGNES_TIMEOUT_MS) || DEFAULT_TIMEOUT,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this._modelsCache = { at: 0, data: null };
    this.lastError = null;
  }

  /** Swap credentials at runtime (used by the settings UI). Invalidates caches. */
  configure({ apiKey, baseUrl, timeoutMs } = {}) {
    if (typeof apiKey === "string") this.apiKey = apiKey.trim();
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) this.timeoutMs = timeoutMs;
    this._modelsCache = { at: 0, data: null };
    this.lastError = null;
    return this.status();
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  status() {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      keyMasked: this.enabled ? maskKey(this.apiKey) : null,
      lastError: this.lastError,
    };
  }

  headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...extra,
    };
  }

  /** Low-level JSON request with timeout + bounded retry on 429/5xx. */
  async request(path, { method = "GET", body, timeoutMs, retries = 0, signal } = {}) {
    if (!this.enabled) {
      throw new AgnesError("未配置 AGNES_API_KEY", { status: 0 });
    }
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const timeout = timeoutMs ?? this.timeoutMs;
    let attempt = 0;
    let lastErr = null;

    while (attempt <= retries) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const resp = await fetch(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
          const err = makeError(resp.status, text);
          this.lastError = err.message;
          if (err.retryable && attempt < retries) {
            attempt += 1;
            await sleep(600 * 2 ** attempt, signal);
            continue;
          }
          throw err;
        }
        this.lastError = null;
        return text ? JSON.parse(text) : {};
      } catch (err) {
        if (err instanceof AgnesError) throw err;
        const aborted = err?.name === "AbortError";
        lastErr = new AgnesError(
          aborted ? `请求超时（${Math.round(timeout / 1000)}s）` : `网络错误：${err?.message ?? err}`,
          { retryable: true }
        );
        this.lastError = lastErr.message;
        if (attempt < retries) {
          attempt += 1;
          await sleep(600 * 2 ** attempt, signal);
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr ?? new AgnesError("未知上游错误");
  }

  /** GET /v1/models — cached for 60s. Returns [] when the key is missing. */
  async listModels({ force = false } = {}) {
    if (!this.enabled) return [];
    if (!force && this._modelsCache.data && Date.now() - this._modelsCache.at < 60_000) {
      return this._modelsCache.data;
    }
    const out = await this.request("/models", { timeoutMs: 15_000 });
    const data = (out?.data ?? []).map((m) => m.id).filter(Boolean);
    this._modelsCache = { at: Date.now(), data };
    return data;
  }

  /**
   * Probe whether the current credentials actually work.
   *
   * NOTE: `GET /v1/models` is NOT a valid auth probe — the gateway happily
   * returns 200 with the full catalogue for bogus keys. A one-token chat
   * completion is the cheapest request that reliably answers 401 vs 200, so
   * that is what we use before persisting a user-supplied key.
   */
  async verifyCredentials({ model = "agnes-2.5-flash" } = {}) {
    if (!this.enabled) return { ok: false, reason: "missing_key", latencyMs: 0, models: [] };
    const started = Date.now();
    try {
      await this.request("/chat/completions", {
        method: "POST",
        body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
        timeoutMs: 20_000,
        retries: 0,
      });
      let models = [];
      try {
        models = await this.listModels({ force: true });
      } catch {
        /* catalogue is a nice-to-have, auth already succeeded */
      }
      return { ok: true, latencyMs: Date.now() - started, models };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        models: [],
        status: err instanceof AgnesError ? err.status : undefined,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ------------------------------------------------------------------ text

  /**
   * Stream a chat completion. Calls `onDelta(text)` for each content fragment,
   * resolves with `{model, usage, finishReason}`.
   */
  async chatStream(
    { model = "agnes-2.5-flash", messages, temperature = 0.7, maxTokens, thinking = false, tools, toolChoice },
    { onDelta = () => {}, onReasoning, signal, timeoutMs = 180_000 } = {}
  ) {
    if (!this.enabled) throw new AgnesError("未配置 AGNES_API_KEY");
    const body = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    if (thinking) body.chat_template_kwargs = { thinking: true };
    if (tools) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        const err = makeError(resp.status, text);
        this.lastError = err.message;
        throw err;
      }
      this.lastError = null;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = null;
      let finishReason = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (obj.usage) usage = obj.usage;
          const choice = obj?.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.content) onDelta(delta.content);
          // Reasoning models may emit thinking fragments — route them to a
          // separate callback when the caller wants clean replies only.
          if (delta?.reasoning_content) (onReasoning || onDelta)(delta.reasoning_content);
        }
      }
      return { model, usage, finishReason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ----------------------------------------------------------------- image

  /**
   * Generate or edit an image.
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.model]      agnes-image-2.5-flash (default)
   * @param {string} [opts.size]       1K | 2K | 3K | 4K
   * @param {string} [opts.ratio]      1:1 | 3:4 | 4:3 | 16:9 | 9:16 | 2:3 | 3:2 | 21:9
   * @param {string[]} [opts.images]   reference images (public URL or data URI) → img2img
   * @param {boolean} [opts.base64]    ask for b64_json instead of a URL
   */
  async generateImage(
    {
      prompt,
      model = "agnes-image-2.5-flash",
      size = "1K",
      ratio = "1:1",
      images = [],
      base64 = false,
    },
    { signal, timeoutMs = 300_000, retries = 1 } = {}
  ) {
    if (!this.enabled) throw new AgnesError("未配置 AGNES_API_KEY");
    const started = Date.now();
    const extraBody = {};
    if (images.length) extraBody.image = images;
    // Docs: response_format must live inside extra_body — never at the top level.
    if (!base64) extraBody.response_format = "url";

    const body = { model, prompt, size, ratio, extra_body: extraBody };
    if (base64) body.return_base64 = true;

    const out = await this.request("/images/generations", {
      method: "POST",
      body,
      timeoutMs,
      retries,
      signal,
    });

    const item = out?.data?.[0];
    if (!item) throw new AgnesError("上游返回空 data");
    // Agnes returns "" (not null) for the unused field — test truthiness.
    const b64 = item.b64_json || null;
    const url = item.url || null;
    if (!b64 && !url) throw new AgnesError("响应中既无 b64_json 也无 url");

    const [width, height] = tierDims(size, ratio);
    return {
      url,
      b64,
      width,
      height,
      model,
      size,
      ratio,
      mode: images.length ? "img2img" : "text2img",
      taskId: out?.task_id ?? null,
      elapsedMs: Date.now() - started,
      provider: "agnes",
    };
  }

  // ----------------------------------------------------------------- video

  /** POST /v1/videos — creates an async task. Returns {videoId, taskId, status}. */
  async createVideo(
    {
      prompt,
      model = "agnes-video-2.5-flash",
      mode = "text",
      seconds = "5",
      size = "720P",
      aspectRatio = "16:9",
      seed,
      firstFrame,
      lastFrame,
      images = [],
      audios = [],
      videos = [],
    },
    { signal, timeoutMs = 90_000, retries = 2 } = {}
  ) {
    if (!this.enabled) throw new AgnesError("未配置 AGNES_API_KEY");
    const body = { model, prompt, mode, seconds: String(seconds), size, aspect_ratio: aspectRatio };
    if (Number.isInteger(seed)) body.seed = seed;
    if (mode === "keyframe") {
      if (firstFrame) body.first_frame = firstFrame;
      if (lastFrame) body.last_frame = lastFrame;
      if (!body.first_frame && !body.last_frame) {
        throw new AgnesError("keyframe 模式需要首帧或尾帧 URL");
      }
    }
    if (mode === "reference") {
      if (images.length) body.images = images;
      if (audios.length) body.audios = audios;
      if (videos.length) body.videos = videos;
      if (!images.length && !audios.length && !videos.length) {
        throw new AgnesError("reference 模式至少需要 1 个图片/音频/视频参考");
      }
    }
    const out = await this.request("/videos", { method: "POST", body, timeoutMs, retries, signal });
    const videoId = out?.video_id ?? out?.id ?? null;
    if (!videoId) throw new AgnesError("创建任务响应缺少 video_id");
    return {
      videoId,
      taskId: out?.task_id ?? out?.id ?? null,
      status: out?.status ?? "queued",
      progress: out?.progress ?? 0,
      model,
      seconds: out?.seconds ?? String(seconds),
      size: out?.size ?? size,
    };
  }

  /** GET /agnesapi?video_id=..&model_name=.. — single status check. */
  async getVideo(videoId, modelName) {
    const qs = new URLSearchParams({ video_id: videoId });
    if (modelName) qs.set("model_name", modelName);
    const out = await this.request(`/agnesapi?${qs.toString()}`, {
      timeoutMs: 30_000,
      retries: 1,
    });
    return normalizeVideo(out);
  }

  /** Poll until completed/failed. `onProgress({status, progress, elapsedMs})`. */
  async waitVideo(
    videoId,
    modelName,
    { intervalMs = 2000, timeoutMs = 900_000, onProgress = () => {}, signal } = {}
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(intervalMs, signal);
      const snap = await this.getVideo(videoId, modelName);
      onProgress({ ...snap, elapsedMs: Date.now() - start });
      if (snap.status === "completed" || snap.status === "failed") {
        return { ...snap, elapsedMs: Date.now() - start };
      }
    }
    throw new AgnesError(`视频生成超时（${Math.round(timeoutMs / 1000)}s）`, { retryable: false });
  }
}

function normalizeVideo(out) {
  return {
    id: out?.id ?? null,
    status: out?.status ?? "unknown",
    progress: out?.progress ?? 0,
    url: out?.url ?? null,
    error: out?.error ?? null,
    size: out?.size ?? null,
    seconds: out?.seconds ?? null,
    quality: out?.quality ?? null,
    createdAt: out?.created_at ?? null,
    completedAt: out?.completed_at ?? null,
  };
}

export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

/** Merge the static catalog with live /v1/models ids. */
export function mergeModelCatalog(liveIds) {
  const live = new Set(liveIds ?? []);
  const annotate = (list) =>
    list.map((m) => ({ ...m, available: live.size ? live.has(m.id) : undefined }));
  return {
    chat: annotate(CHAT_MODELS),
    image: annotate(IMAGE_MODELS),
    video: annotate(VIDEO_MODELS),
    live: [...live],
  };
}
