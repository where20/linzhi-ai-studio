/**
 * storyboard.mjs — 本地分镜工作台引擎（替掉走源站的 dramapro）
 *
 * 打通的链路：10 种模式（4 轻 + 6 重）→ 本地模型 → 结构化结果 → 落盘
 * 模型通道：Agnes 直连优先，失败自动回落免 Key（Pollinations）
 *
 * 产物：output/storyboards/<jobId>.json（含 prompt、原文、解析出的 JSON、耗时）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODES, MODE_MAP, lineBudget } from './storyboard-prompts.mjs';

export { MODES, MODE_MAP, lineBudget };

const MAX_INPUT = 60000;

/** 从模型输出里抠出 JSON（容忍 ```json 包裹 / 前后废话） */
export function extractJson(text) {
    if (!text) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidates = [fenced && fenced[1], text].filter(Boolean);
    for (const raw of candidates) {
        const t = raw.trim();
        for (const [open, close] of [['{', '}'], ['[', ']']]) {
            const i = t.indexOf(open);
            if (i < 0) continue;
            // 从最后一个可能的收尾往回找，尽量拿到完整结构
            const j = t.lastIndexOf(close);
            if (j <= i) continue;
            try {
                return JSON.parse(t.slice(i, j + 1));
            } catch { /* 继续尝试 */ }
        }
        try {
            return JSON.parse(t);
        } catch { /* 不是纯 JSON */ }
    }
    return null;
}

export function createStoryboardEngine({ storeDir, callModel }) {
    const dir = path.join(storeDir, 'storyboards');
    fs.mkdirSync(dir, { recursive: true });
    const jobs = new Map();

    const fileOf = (id) => path.join(dir, `${id}.json`);
    const persist = (job) => {
        try {
            fs.writeFileSync(fileOf(job.id), JSON.stringify(job, null, 2));
        } catch { /* 落盘失败不影响返回 */ }
    };

    // 恢复历史（只留最近 100 条）
    try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const f of files.slice(-100)) {
            try {
                const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                if (j && j.id) jobs.set(j.id, j);
            } catch { /* 跳过坏文件 */ }
        }
    } catch { /* 首次运行 */ }

    return {
        modes() {
            return MODES.map((m) => ({
                id: m.id,
                name: m.name,
                // 按 system prompt 体量分档：>1000 字算重模式（耗时长、要长输入）
                weight: (m.system || '').length > 1000 ? 'heavy' : 'light',
                needsExtra: !!m.needsExtra,
                extraLabel: m.extraLabel || '',
                systemChars: (m.system || '').length,
            }));
        },

        list(limit = 30) {
            return [...jobs.values()]
                .sort((a, b) => b.started - a.started)
                .slice(0, limit)
                .map((j) => ({
                    id: j.id, mode: j.mode, modeName: j.modeName, status: j.status,
                    started: j.started, elapsed: j.elapsed, provider: j.provider,
                    inputChars: j.inputChars, hasJson: !!j.json,
                }));
        },

        get(id) {
            return jobs.get(id) || null;
        },

        /** 同步执行（短输入时用）；runAsync 走后台 */
        async run({ mode, input, extra = '', model, provider, maxTokens = 8192, timeoutMs = 180000 }) {
            const def = MODE_MAP[mode];
            if (!def) throw new Error(`未知模式：${mode}（可用：${MODES.map((m) => m.id).join(', ')}）`);
            const text = String(input || '').trim();
            if (!text) throw new Error('输入不能为空');
            if (text.length > MAX_INPUT) throw new Error(`输入过长（${text.length} 字符，上限 ${MAX_INPUT}）`);
            if (def.needsExtra && !String(extra || '').trim()) {
                throw new Error(`「${def.name}」需要额外输入：${def.extraLabel || '附加内容'}`);
            }

            const userMessage = def.build(text, String(extra || '').trim());
            const started = Date.now();
            const out = await callModel({
                system: def.system,
                user: userMessage,
                model,
                provider,
                maxTokens,
                timeoutMs,
            });

            const job = {
                id: 'sb' + crypto.randomBytes(6).toString('hex'),
                mode,
                modeName: def.name,
                status: 'completed',
                provider: out.provider,
                model: out.model,
                started,
                elapsed: Math.round((Date.now() - started) / 1000),
                inputChars: text.length,
                extraChars: String(extra || '').length,
                prompt: { systemChars: (def.system || '').length, user: userMessage },
                text: out.text,
                json: extractJson(out.text),
                error: null,
            };
            jobs.set(job.id, job);
            persist(job);
            return job;
        },

        /** 异步执行：立刻返回 jobId，前端轮询 */
        runAsync(opts) {
            const id = 'sb' + crypto.randomBytes(6).toString('hex');
            const def = MODE_MAP[opts.mode];
            const job = {
                id, mode: opts.mode, modeName: def ? def.name : opts.mode,
                status: 'running', started: Date.now(), inputChars: String(opts.input || '').length,
            };
            jobs.set(id, job);
            persist(job);
            this._run(id, opts);
            return job;
        },

        async _run(id, opts) {
            const job = jobs.get(id);
            try {
                const done = await this.run(opts);
                // 复用同一个 id，让前端从一开始就拿这一个
                jobs.delete(done.id);
                const merged = { ...done, id };
                jobs.set(id, merged);
                persist(merged);
                try { fs.rmSync(fileOf(done.id), { force: true }); } catch { /* 忽略 */ }
            } catch (e) {
                job.status = 'failed';
                job.error = (e && e.message) || String(e);
                job.elapsed = Math.round((Date.now() - job.started) / 1000);
                persist(job);
            }
        },
    };
}
