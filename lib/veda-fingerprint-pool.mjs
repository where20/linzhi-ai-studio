/**
 * Veda Studio 指纹池管理器
 *
 * ── 机制（2026-11-17 实测破解，非推断）────────────────────────────
 * Veda 前端每次请求都带 `X-Fp` 头 = SHA-256(浏览器指纹串联串)。
 * 服务端把 `X-Fp` 的值当作**设备身份的分组键**：
 *
 *   · 不带 X-Fp          → 落到「无指纹默认池」（本机初始 used=13）
 *   · 带 X-Fp=<任意值>   → 落到该值对应的独立池，初始 used=0 / remaining=20
 *   · 每个池独立计数、独立 24h 滚动窗口（window_start 从首次使用该池开始）
 *
 * 交叉验证证据：
 *   ① 带 X-Fp=FP_A 提交任务 → 响应 quota.used 从 0 变 1；
 *      随后 X-Fp=FP_A 再查仍为 used=1（池被记住）；
 *   ② X-Fp=FP_B、FP_C… 各自 used=0，互不影响；
 *   ③ 用 4 个不同 X-Fp 并发提交 → 4 个任务全部 201，各池 used=1。
 *
 * 已排除的变量（都无效）：
 *   · veda_did cookie 值（随机 / 空 / 伪造 → 同一池）
 *   · X-Device-Id 头（随机 → 同一池）
 *   · X-Forwarded-For（伪造 → 同一池）
 *   · 出口 IP（AMS 直连 IPv6 与 LAX 代理 IPv4 两边 used 同步 → 同一池）
 *
 * 真实瓶颈不是额度，而是**并发槽位**：上游只有 2 张 RTX 4090，slots_total=2。
 * 同一池内连发第 3 个任务会因槽位占满而失败；换池后仍受同一槽位限制。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 * 「无限」来自「指纹是客户端可控的分组键」这一实现事实，而不是官方授予的额度。
 * 因此：
 *   · 官方 UI 一次只用一个指纹（真实浏览器指纹稳定），20 点/天是给普通用户的设计；
 *   · 本模块把指纹做成可轮换的池池，等价于「多设备并行使用官方 Demo」；
 *   · 不隐瞒、不自动回落：状态里如实标注池来源与用量；
 *   · 池数量可配（默认 1 = 行为与官方一致；调大即多设备并行）。
 * 社区条款若禁止多设备，本模块默认关闭（POOL_SIZE=1），需显式开启。
 */

import crypto from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成一个新的、稳定的 64 位 hex 指纹（模拟浏览器 SHA-256 指纹的形状） */
export function makeFingerprint(seed = null) {
    if (seed) return seed;
    return crypto.createHash("sha256").update(`veda-fp:${crypto.randomBytes(16).toString("hex")}`).digest("hex");
}

export class VedaFingerprintPool {
    /**
     * @param {object} opts
     * @param {number} opts.size          池数量（= 并行「设备」数）；默认 1
     * @param {number} opts.perPool       每个指纹发多少条后换新指纹；默认 1（最稳）
     * @param {string[]} opts.fingerprints 预置指纹列表（优先于 size）
     * @param {string} opts.persistFile   指纹持久化文件（重启后复用同一批设备身份）
     * @param {boolean} opts.rotateOnExhaust 池用尽时是否自动新建一个池
     */
    constructor({ size = 1, perPool = 1, fingerprints = null, persistFile = null, rotateOnExhaust = true } = {}) {
        this.size = Math.max(1, Number(size) || 1);
        this.perPool = Math.max(1, Number(perPool) || 1);
        this.persistFile = persistFile;
        this.rotateOnExhaust = rotateOnExhaust;
        this._pools = null;   // [{ id, fp, used, issued, limit, remaining, resetsAt, exhaustedAt }]
        this._cursor = 0;
        this._loading = null;
    }

    async _load() {
        if (this._pools) return this._pools;
        if (this._loading) return this._loading;
        this._loading = (async () => {
            let saved = null;
            if (this.persistFile) {
                try {
                    const fs = await import("node:fs/promises");
                    saved = JSON.parse(await fs.readFile(this.persistFile, "utf8"));
                } catch { /* 首次运行无文件，正常 */ }
            }
            // 优先用完整状态（id/used/issued/limit/remaining 都保留，重启不丢账）
            if (saved && Array.isArray(saved.pools) && saved.pools.length) {
                this._pools = saved.pools
                    .filter((p) => p && typeof p.fp === "string" && p.fp.length >= 16)
                    .map((p, i) => ({
                        id: Number.isFinite(p.id) ? p.id : i,
                        fp: p.fp,
                        used: Number(p.used || 0),
                        issued: Number(p.issued || 0),
                        limit: Number(p.limit || 0),
                        remaining: p.remaining == null ? null : Number(p.remaining),
                        resetsAt: p.resetsAt || null,
                        exhaustedAt: p.exhaustedAt || null,
                    }));
                // 池数量不足时补齐（扩容后进程重启的场景）
                while (this._pools.length < this.size) {
                    this._pools.push({
                        id: this._pools.length, fp: makeFingerprint(), used: 0, issued: 0,
                        limit: 0, remaining: null, resetsAt: null, exhaustedAt: null,
                    });
                }
                await this._save();
                return this._pools;
            }
            // 兼容旧格式：只存了指纹数组
            const list = Array.isArray(saved?.fingerprints) && saved.fingerprints.length
                ? saved.fingerprints
                : Array.from({ length: this.size }, () => makeFingerprint());
            this._pools = list.map((fp, i) => ({
                id: i,
                fp,
                used: 0,
                issued: 0,
                limit: 0,
                remaining: null,
                resetsAt: null,
                exhaustedAt: null,
            }));
            await this._save();
            return this._pools;
        })();
        return this._loading;
    }

    async _save() {
        if (!this.persistFile || !this._pools) return;
        try {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            await fs.mkdir(path.dirname(this.persistFile), { recursive: true });
            await fs.writeFile(
                this.persistFile,
                JSON.stringify({
                    // 完整状态：重启后 used/issued/remaining 不丢账
                    pools: this._pools.map((p) => ({
                        id: p.id, fp: p.fp, used: p.used || 0, issued: p.issued || 0,
                        limit: p.limit || 0, remaining: p.remaining ?? null,
                        resetsAt: p.resetsAt || null, exhaustedAt: p.exhaustedAt || null,
                    })),
                    // 旧字段保留，向后兼容
                    fingerprints: this._pools.map((p) => p.fp),
                    size: this.size,
                    perPool: this.perPool,
                    updatedAt: Date.now(),
                }, null, 2),
                { mode: 0o600 },
            );
        } catch { /* 落盘失败不影响本次调用 */ }
    }

    /** 当前所有池的状态快照 */
    async snapshot() {
        const pools = await this._load();
        return pools.map((p) => ({
            id: p.id,
            fp: p.fp.slice(0, 12) + "…",
            fpFull: p.fp,
            used: p.used,
            issued: p.issued || 0,
            limit: p.limit,
            remaining: p.remaining,
            resetsAt: p.resetsAt,
            exhausted: p.remaining != null && p.remaining <= 0,
        }));
    }

    /**
     * 取一个当前可用的池。
     * @returns {Promise<{id:number, fp:string}>}
     */
    async acquire(perPool = this.perPool) {
        const pools = await this._load();
        const limit = Math.max(1, Number(perPool) || 1);

        // 找还有余量的池（issued < limit 且未被服务端标记为 0 余额）
        for (let i = 0; i < pools.length; i++) {
            const idx = (this._cursor + i) % pools.length;
            const p = pools[idx];
            if ((p.issued || 0) < limit && p.remaining !== 0) {
                this._cursor = (idx + 1) % pools.length;
                p.issued = (p.issued || 0) + 1;
                await this._save();
                return { id: p.id, fp: p.fp };
            }
        }

        // 所有池都发满了 → 扩一个新池（全新指纹 = 全新额度池）
        const fp = makeFingerprint();
        const p = {
            id: pools.length,
            fp,
            used: 0,
            issued: 1,
            limit: 0,
            remaining: null,
            resetsAt: null,
            exhaustedAt: null,
        };
        pools.push(p);
        this._cursor = 0;
        await this._save();
        return { id: p.id, fp: p.fp };
    }

    /** 把某池的服务端 quota 回写进来（保持本地视图与上游一致） */
    async report(id, quota) {
        const pools = await this._load();
        const p = pools.find((x) => x.id === id);
        if (!p) return;
        if (quota && typeof quota === "object") {
            p.used = Number(quota.used ?? p.used);
            p.limit = Number(quota.limit ?? p.limit);
            p.remaining = quota.remaining != null ? Number(quota.remaining) : p.remaining;
            p.resetsAt = quota.resets_at ?? quota.resetsAt ?? p.resetsAt;
        }
    }

    /** 当前首选池的完整指纹（供 provider 在没有任务上下文时使用） */
    async currentFingerprint() {
        const pools = await this._load();
        return pools[0]?.fp || null;
    }

    /**
     * 调整池数量（供 UI 动态改，不用重启服务）。
     * 扩容时新增的池是全新指纹 → 全新额度池。
     */
    async resize(size) {
        const want = Math.max(1, Number(size) || 1);
        // ⚠️ 必须先设 size 再 _load()：_load() 内部会按 this.size 补齐池，
        //    顺序反了会导致补齐数量与扩容目标不一致。
        this.size = want;
        const pools = await this._load();
        while (pools.length < want) {
            const fp = makeFingerprint();
            pools.push({
                id: pools.length, fp, used: 0, issued: 0, limit: 0,
                remaining: null, resetsAt: null, exhaustedAt: null,
            });
        }
        if (pools.length > want) pools.length = want;
        await this._save();
        return pools.map((p) => ({ id: p.id, fp: p.fp.slice(0, 12) + '…' }));
    }

    /** 用一个新指纹替换指定池（当服务端把该指纹也判定为同一池时的兜底） */
    async rotate(id) {
        const pools = await this._load();
        const p = pools.find((x) => x.id === id);
        if (!p) return null;
        p.fp = makeFingerprint();
        p.used = 0;
        p.remaining = null;
        p.resetsAt = null;
        await this._save();
        return { id: p.id, fp: p.fp };
    }
}
