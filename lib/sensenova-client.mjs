/**
 * 商汤 SenseNova 轻量生图客户端（线上融合 · 双模型第二轨）
 * OpenAI 兼容端点：POST {base}/images/generations
 * 返回统一成 {url, b64, width, height, model, elapsedMs, provider:'sensenova'}
 * 纯 JS，无 TS 语法。
 */
const DEFAULT_BASE = 'https://token.sensenova.cn/v1';

export class SenseNovaClient {
    constructor({ apiKey = '', baseUrl = DEFAULT_BASE, timeoutMs = 300000 } = {}) {
        this.apiKey = apiKey;
        this.baseUrl = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
    }
    configure({ apiKey, baseUrl } = {}) {
        if (typeof apiKey === 'string') this.apiKey = apiKey.trim();
        if (baseUrl) this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    }
    get enabled() { return !!this.apiKey; }

    async generateImage(
        { prompt, model = 'sensenova-u1.5-lite', size = '1024x1024', n = 1 } = {},
        { timeoutMs = this.timeoutMs } = {}
    ) {
        if (!this.enabled) throw new Error('未配置商汤 SenseNova KEY');
        const started = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const resp = await fetch(`${this.baseUrl}/images/generations`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({ model, prompt, n, size, response_format: 'url' }),
                signal: ctrl.signal,
            });
            const text = await resp.text();
            if (!resp.ok) {
                let msg = text.slice(0, 300);
                try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch { /* 非 JSON */ }
                throw new Error(`商汤生图 HTTP ${resp.status}: ${msg}`);
            }
            let out;
            try { out = JSON.parse(text); } catch { throw new Error('商汤生图响应非 JSON'); }
            const item = out?.data?.[0];
            if (!item) throw new Error('商汤生图返回空 data');
            const [width, height] = String(size).split('x').map(Number);
            return {
                url: item.url || null,
                b64: item.b64_json || null,
                width: width || 1024,
                height: height || 1024,
                model,
                elapsedMs: Date.now() - started,
                provider: 'sensenova',
            };
        } finally {
            clearTimeout(timer);
        }
    }
}
