/**
 * storyboard-pipeline.mjs — 分镜文本 → 逐镜出图（本地全链路）
 *
 * 两种输入：
 *   1. 分镜文本（storyboard / storyboard8 的输出）→ 解析出镜头 → 逐镜生图
 *   2. 已有 shots 数组 → 直接生图
 *
 * 设计取舍：
 *   · 出图走免 Key（Pollinations → imagefree），不消耗 Agnes 额度
 *   · 并发 2（对齐插件里的 imagefree 并发闸门），避免 429
 *   · 每镜落盘 output/pictures，另存 pipeline 任务 JSON（含 prompt 与尺寸，可复现）
 */

const SHOT_KEYS = ['shot', '镜头', '镜号', 'index', 'no', 'id'];
const DESC_KEYS = ['desc', 'description', '画面描述', '画面', '内容', 'visual'];
const SIZE_KEYS = ['shot_size', '景别', 'size'];
const LINE_KEYS = ['line', '台词', '台词/旁白', '旁白', 'dialogue'];
const SEC_KEYS = ['seconds', '时长', 'duration', 'sec'];
const TRANS_KEYS = ['transition', '转场', '转场方式'];

const pick = (obj, keys) => {
    for (const k of keys) {
        const v = obj?.[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return '';
};

/** 从任意结构化结果里找镜头数组 */
function findShotArray(node, depth = 0) {
    if (!node || depth > 4) return null;
    if (Array.isArray(node)) {
        if (node.length && typeof node[0] === 'object' && node[0] !== null) {
            const keys = Object.keys(node[0]).map((k) => k.toLowerCase());
            if (keys.some((k) => DESC_KEYS.map((d) => d.toLowerCase()).includes(k))) return node;
        }
        for (const it of node) {
            const r = findShotArray(it, depth + 1);
            if (r) return r;
        }
        return null;
    }
    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (/shots?|分镜|storyboard|镜头/i.test(k)) {
                const r = findShotArray(v, depth + 1);
                if (r) return r;
            }
        }
        for (const v of Object.values(node)) {
            const r = findShotArray(v, depth + 1);
            if (r) return r;
        }
    }
    return null;
}

/**
 * 解析分镜：优先 JSON，退回文本分段
 * @returns {{index:number, shotSize:string, desc:string, line:string, seconds:number, transition:string, source:string}[]}
 */
export function parseShots(input) {
    if (Array.isArray(input)) return normalize(input);
    if (input && typeof input === 'object') {
        const arr = findShotArray(input);
        if (arr) return normalize(arr);
    }
    const text = String(input || '');
    if (!text.trim()) return [];

    // 先试 JSON 代码块
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    for (const raw of [fenced && fenced[1], text]) {
        if (!raw) continue;
        const i = raw.indexOf('[') >= 0 ? raw.indexOf('[') : raw.indexOf('{');
        if (i < 0) continue;
        const j = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
        if (j <= i) continue;
        try {
            const parsed = JSON.parse(raw.slice(i, j + 1));
            const arr = findShotArray(parsed);
            if (arr && arr.length) return normalize(arr);
        } catch { /* 退回文本解析 */ }
    }
    return parseTextShots(text);
}

function normalize(arr) {
    return arr.map((s, idx) => {
        const o = s || {};
        return {
            index: Number(pick(o, SHOT_KEYS)) || idx + 1,
            shotSize: pick(o, SIZE_KEYS),
            desc: pick(o, DESC_KEYS),
            line: pick(o, LINE_KEYS),
            seconds: Number(pick(o, SEC_KEYS)) || 0,
            transition: pick(o, TRANS_KEYS),
            source: 'json',
        };
    }).filter((s) => s.desc);
}

/** 文本解析：按「镜头 N / 第 N 镜」切块，再按「- 景别：xxx」取值 */
export function parseTextShots(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let cur = null;
    const headRe = /^\s*(?:\*\*)?\s*(?:镜头|第)\s*(\d+)\s*(?:镜)?\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$/;
    const headInline = /^\s*(?:\*\*)?\s*(?:镜头|第)\s*(\d+)\s*(?:镜)?\s*(?:\*\*)?\s*[:：]\s*(.+)$/;

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        let m = headRe.exec(line) || headInline.exec(line);
        if (m) {
            if (cur) blocks.push(cur);
            cur = { index: Number(m[1]), rows: [], inline: m[2] || '' };
            continue;
        }
        if (/^\s*(?:---+|===+)\s*$/.test(line)) continue;
        if (cur) cur.rows.push(line);
    }
    if (cur) blocks.push(cur);
    if (!blocks.length) return [];

    return blocks.map((b) => {
        const get = (names) => {
            for (const line of [b.inline, ...b.rows]) {
                for (const n of names) {
                    const re = new RegExp(`(?:^|[-*•\\s])${n}\\s*[:：]\\s*(.+)$`);
                    const mm = re.exec(line || '');
                    if (mm) return mm[1].trim();
                }
            }
            return '';
        };
        return {
            index: b.index,
            shotSize: get(['景别']),
            desc: get(['画面描述', '画面', '内容']),
            line: get(['台词/旁白', '台词', '旁白']),
            seconds: Number((get(['时长']) || '').replace(/[^\d.]/g, '')) || 0,
            transition: get(['转场方式', '转场']),
            source: 'text',
        };
    }).filter((s) => s.desc);
}

/** 镜头 → 生图 prompt（补镜头语言与画幅，不加 AI 味修饰词） */
export function toImagePrompt(shot, { style = '电影感，自然光，浅景深' } = {}) {
    const clean = (s) => String(s || '').trim().replace(/[。，、；;,.!！\s]+$/, '');
    const parts = [];
    if (shot.shotSize) parts.push(clean(shot.shotSize));
    parts.push(clean(shot.desc));
    if (style) parts.push(clean(style));
    parts.push('画面干净，无文字，无水印');
    return parts.filter(Boolean).join('，');
}

/** 限制并发的小工具 */
function semaphore(max) {
    let active = 0;
    const queue = [];
    const run = async (fn) => {
        if (active >= max) await new Promise((res) => queue.push(res));
        active += 1;
        try {
            return await fn();
        } finally {
            active -= 1;
            const next = queue.shift();
            if (next) next();
        }
    };
    return { run };
}

/**
 * 执行流水线
 * @param {object} opts
 * @param {string} opts.text 分镜文本或 JSON
 * @param {Array}  [opts.shots] 已解析的镜头（优先）
 * @param {(s:{stage:string,progress:number,detail?:string})=>void} [opts.onProgress]
 * @param {(img:{bytes:Buffer,ext:string})=>Promise<{url:string,file:string}>} opts.saveImage
 * @param {(args:object)=>Promise<{bytes:Buffer,ext:string,provider:string}>} opts.generateImage
 * @param {number} [opts.concurrency]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.limit] 只出前 N 镜
 */
export async function runPipeline({
    text, shots, onProgress = () => {}, saveImage, generateImage,
    concurrency = 2, width = 1024, height = 576, limit = 0, style,
}) {
    const list = (Array.isArray(shots) && shots.length ? shots : parseShots(text))
        .slice(0, limit > 0 ? limit : undefined);

    if (!list.length) throw new Error('没解析出镜头 —— 分镜文本里需要「镜头 1 / 第 1 镜」或 JSON 的 shots 数组');

    onProgress({ stage: 'parsed', progress: 0, detail: `解析出 ${list.length} 个镜头` });

    const sem = semaphore(Math.max(1, Math.min(4, concurrency)));
    const results = new Array(list.length);
    let done = 0;

    await Promise.all(list.map((shot, i) => sem.run(async () => {
        const prompt = shot.prompt || toImagePrompt(shot, { style });
        const item = { ...shot, prompt, image: null, error: null };
        try {
            const img = await generateImage({ prompt, width, height, seed: 1000 + shot.index });
            const saved = await saveImage(img);
            item.image = saved;
            item.provider = img.provider || '';
        } catch (e) {
            item.error = (e && e.message) || String(e);
        }
        results[i] = item;
        done += 1;
        onProgress({
            stage: 'images', progress: Math.round((done / list.length) * 100),
            detail: `出图 ${done}/${list.length}${item.error ? '（1 张失败）' : ''}`,
        });
    })));

    const ok = results.filter((r) => r.image).length;
    onProgress({ stage: 'done', progress: 100, detail: `完成 ${ok}/${results.length}` });
    return {
        shots: results,
        total: results.length,
        images: ok,
        failed: results.length - ok,
        size: { width, height },
    };
}


/**
 * 批量把中文分镜描述译成英文生图提示词
 *
 * 为什么必须译：免 Key 出图通道（Pollinations / imagefree）对中文提示词的理解很差，
 * 实测「雨夜办公楼外景」会出成「山谷河流」。中文只留给人看，进模型前统一转英文。
 *
 * @param {Array} shots parseShots 的结果
 * @param {(args)=>Promise<{text:string}>} callModel
 * @returns {Promise<Array>} 原地补上 prompt 字段的 shots
 */
export async function translateShotPrompts(shots, callModel, { chunk = 4 } = {}) {
    if (!shots.length) return shots;

    const system = [
        '你是电影分镜提示词翻译器。把每条中文镜头描述译成英文生图提示词。',
        '规则：',
        '1. 开头用景别英文（wide shot / full shot / medium shot / close-up / extreme close-up）。',
        '2. 只译画面可见内容：主体、动作、环境、光线、镜头；不译台词，不加评论。',
        '3. 每条 25-45 个英文单词，逗号分隔短语，不要完整句子，不要堆同义词。',
        '4. 结尾统一加：cinematic lighting, shallow depth of field, no text, no watermark',
        '5. 严格输出 JSON 字符串数组，顺序与输入一致，不要解释、不要 Markdown。',
    ].join('\n');

    const out = shots.slice();
    for (let i = 0; i < out.length; i += chunk) {
        const part = out.slice(i, i + chunk);
        const payload = part.map((s) => ({ i: s.index, size: s.shotSize || '', desc: s.desc }));
        let parsed = null;
        for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
            try {
                const r = await callModel({
                    system,
                    user: JSON.stringify(payload),
                    maxTokens: Math.min(4096, 220 * part.length + 600),
                });
                parsed = extractArray(r.text);
            } catch (e) {
                if (attempt === 2) parsed = null;
            }
        }
        part.forEach((s, k) => {
            const en = String((parsed && parsed[k]) || '').trim();
            out[i + k] = en.length > 8
                ? { ...s, prompt: en, translate: 'ok' }
                : { ...s, prompt: toImagePrompt(s), translate: parsed ? 'miss' : 'fallback' };
        });
    }
    return out;
}

function extractArray(text) {
    const t = String(text || '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    for (const raw of [fenced && fenced[1], t]) {
        if (!raw) continue;
        const i = raw.indexOf('[');
        const j = raw.lastIndexOf(']');
        if (i < 0 || j <= i) continue;
        try {
            const arr = JSON.parse(raw.slice(i, j + 1));
            if (Array.isArray(arr)) {
                return arr.map((x) => {
                    if (typeof x === 'string') return x;
                    if (x && typeof x === 'object') {
                        const v = x.prompt ?? x.en ?? x.english ?? x.text ?? '';
                        return typeof v === 'string' ? v : '';
                    }
                    return '';
                });
            }
        } catch { /* 继续 */ }
    }
    return null;
}
