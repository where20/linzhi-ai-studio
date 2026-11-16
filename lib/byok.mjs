/**
 * BYOK 三轨 KEY 解析（线上分享站 → 本地融合）
 * ----------------------------------------------------------------
 * 优先级：请求头 BYOK > config.json 内置 > 免 Key 回落（由调用方处理）
 * 请求头约定（与线上 x-lz-* 对齐 + 本地扩展）：
 *   x-lz-ak      当前生效的 Agnes KEY（前端按通道选好传这个）
 *   x-lz-ak-cn   Agnes 国内 KEY  (api.agnes-ai.cn)
 *   x-lz-ak-com  Agnes 国际 KEY  (apihub.agnes-ai.com)
 *   x-lz-ak-ch   商汤 KEY        (token.sensenova.cn) — 对齐线上 x-lz-ak-ch
 *   x-lz-chan    通道 cn | com
 *   x-lz-tk      session token（可选，本地不强制）
 * 纯 JS，无任何 TS 语法。
 */

export const AGNES_BASE = {
    cn: 'https://api.agnes-ai.cn/v1',
    com: 'https://apihub.agnes-ai.com/v1',
};
export const SN_BASE = 'https://token.sensenova.cn/v1';

function h(req, name) {
    const v = req && req.headers && req.headers[name];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * @returns {{api_key, sensenova_api_key, channel, baseUrl, snBaseUrl, source, byok}}
 */
export function resolveAiContext(req, cfg) {
    const ai = (cfg && cfg.ai) || {};
    const chan = (h(req, 'x-lz-chan') || 'com').toLowerCase() === 'cn' ? 'cn' : 'com';
    // 当前生效 KEY：显式 x-lz-ak 优先；否则按通道取对应头
    const explicit = h(req, 'x-lz-ak');
    const perChannel = chan === 'cn' ? h(req, 'x-lz-ak-cn') : h(req, 'x-lz-ak-com');
    const byokAgnes = explicit || perChannel;
    const byokSn = h(req, 'x-lz-ak-ch') || h(req, 'x-lz-sn');

    const apiKey = byokAgnes || ai.api_key || '';
    const snKey = byokSn || ai.sensenova_api_key || '';
    const source = byokAgnes ? 'byok' : (ai.api_key ? 'local' : 'none');

    return {
        api_key: apiKey,
        sensenova_api_key: snKey,
        channel: chan,
        baseUrl: chan === 'cn' ? AGNES_BASE.cn : (ai.agnes_base_url || AGNES_BASE.com),
        snBaseUrl: ai.sensenova_base_url || SN_BASE,
        source,
        byok: !!(byokAgnes || byokSn),
        has_agnes: !!apiKey,
        has_sn: !!snKey,
    };
}

/** 供 /api/config/status 用：只回显状态，绝不回传 KEY 明文 */
export function keyStatus(req, cfg) {
    const ctx = resolveAiContext(req, cfg);
    const ai = (cfg && cfg.ai) || {};
    const mask = (k) => k ? k.slice(0, 6) + '****' + k.slice(-4) : '';
    return {
        success: true,
        mode: 'local-full',
        agnes_configured: ctx.has_agnes,
        agnes_masked: mask(ctx.api_key),
        agnes_builtin: !!(ai.api_key && !ctx.byok),
        agnes_user_key_required: false,          // 本地：不强制，留空走免 Key 回落
        agnes_channels: ['cn', 'com'],
        agnes_channel: ctx.channel,
        agnes_source: ctx.source,
        sensenova_configured: ctx.has_sn,
        sensenova_masked: mask(ctx.sensenova_api_key),
        deepseek_configured: !!ai.deepseek_api_key,
        byok_active: ctx.byok,
        fallback: 'pollinations/veda/imagefree',
    };
}
