#!/usr/bin/env node
/**
 * extract-prompts.mjs — 从插件 bundle 里抽出「剧本 / 分镜」10 种模式的提示词
 *
 * 为什么用提取器而不是手抄：
 *   · 6 个 system prompt 共 1.6 万字，手抄必错
 *   · 上游升级后重跑即可同步，不用人肉 diff
 *
 * 输出：lib/storyboard-prompts.mjs（自动生成，勿手改）
 * 用法：node scripts/extract-prompts.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'engine', 'vendor', 'main.js');
const OUT = path.join(ROOT, 'lib', 'storyboard-prompts.mjs');
const CHECK_ONLY = process.argv.includes('--check');

if (!fs.existsSync(SRC)) {
    console.error(`✘ 缺少上游产物：${SRC}`);
    process.exit(1);
}
const s = fs.readFileSync(SRC, 'utf8');

/** 从 startIdx 处的引号/反引号开始，扫到配对的结束符（反引号内处理转义与 ${} 嵌套） */
function readQuoted(from) {
    const q = s[from];
    let i = from + 1;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (q === '`' && c === '$' && s[i + 1] === '{') {
            // 跳过 ${ ... }（内部可能再有反引号）
            let d = 1;
            i += 2;
            while (i < s.length && d > 0) {
                if (s[i] === '\\') { i += 2; continue; }
                if (s[i] === '{') d++;
                else if (s[i] === '}') d--;
                i++;
            }
            continue;
        }
        if (c === q) return { body: s.slice(from + 1, i), end: i };
        i++;
    }
    return null;
}

/** 取 `name=` 之后紧跟的字符串/模板字面量 */
function takeLiteral(name) {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${name}\\s*=\\s*([\`"'])`);
    const m = re.exec(s);
    if (!m) return null;
    const r = readQuoted(m.index + m[0].length - 1);
    return r ? r.body : null;
}

/** 按名取函数源码（从 params 后的 { 开始做花括号配对，跳过字符串/模板/注释） */
function takeFunction(name) {
    const head = new RegExp(`function ${name}\\(`);
    const m = head.exec(s);
    if (!m) return null;
    // 找到参数列表结束
    let i = m.index + m[0].length - 1;
    let depth = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
        i++;
    }
    while (i < s.length && s[i] !== '{') i++;
    const start = i;
    depth = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
            const r = readQuoted(i);
            if (!r) break;
            i = r.end + 1;
            continue;
        }
        if (c === '"' || c === "'") {
            i++;
            while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return s.slice(m.index, i + 1); }
        i++;
    }
    return null;
}

const SYSTEMS = {
    check: takeLiteral('gA'),
    rewrite: takeLiteral('mA'),
    split: takeLiteral('bA'),
    lockcode: takeLiteral('yA'),
    storyboard8: takeLiteral('wA'),
    frame: takeLiteral('EA'),
};
const FUNCS = {
    pA: takeFunction('pA'),
    hA: takeFunction('hA'),
    fA: takeFunction('fA'),
    vA: takeFunction('vA'),
    SA: takeFunction('SA'),
    xA: takeFunction('xA'),
    PA: takeFunction('PA'),
};

const missing = [
    ...Object.entries(SYSTEMS).filter(([, v]) => !v).map(([k]) => `system:${k}`),
    ...Object.entries(FUNCS).filter(([, v]) => !v).map(([k]) => `func:${k}`),
];
if (missing.length) {
    console.error(`✘ 提取失败：${missing.join(', ')} —— 上游结构可能已变`);
    process.exit(1);
}

const pickStr = (re, dflt) => (re.exec(s) || [])[1] || dflt;
const frameSpec = pickStr(/(?<![A-Za-z0-9_$])uA\s*=\s*"([^"]{0,40})"/, '1280×720');
const maxConsecutive = pickStr(/(?<![A-Za-z0-9_$])cA\s*=\s*(\d+)/, '2');
const sameSceneLimit = pickStr(/(?<![A-Za-z0-9_$])dA\s*=\s*(\d+)/, '3');
const portraitSpec = pickStr(/(?<![A-Za-z0-9_$])fH\s*=\s*"([^"]{0,20})"/, '768x1024');
const landscapeSpec = pickStr(/(?<![A-Za-z0-9_$])bH\s*=\s*"([^"]{0,20})"/, '1024x768');
const ratioSpec = pickStr(/(?<![A-Za-z0-9_$])vH\s*=\s*"([^"]{0,12})"/, '9:16');
const codePrefix = (/(?<![A-Za-z0-9_$])ci=\{\s*character:"([^"]+)",\s*weapon:"([^"]+)",\s*mount:"([^"]+)"/.exec(s) || [null, 'P', 'W', 'M']).slice(1);

const banner = `// ⚠️ 自动生成，请勿手改 —— 由 scripts/extract-prompts.mjs 从 engine/vendor/main.js 提取
// 提取时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}
// 来源：Free AI Studio v0.18.0（MIT）文本面板的 10 种模式
//
// 短名对照（上游混淆名保持原样，便于与上游 diff）：
//   gA=剧本体检 system        hA=体检 user 模板
//   mA=按报告改写 system      fA=改写 user 模板
//   bA=70集拆分 system        vA=拆分 user 模板
//   yA=锁定码定妆 system      SA=定妆 user 模板
//   wA=分镜八步 system        xA=八步 user 模板
//   EA=首尾帧继承 system      PA=首尾帧 user 模板
//   pA=台词字数预算(镜数×秒数×4.05 字/秒，下限 90%)
//
// 台词预算这条最值得记：4.05 字/秒 是中文配音的实际语速上限，超出就"念不完"。

export const FRAME_SPEC = ${JSON.stringify(frameSpec)};
export const PORTRAIT_SPEC = ${JSON.stringify(portraitSpec)};
export const LANDSCAPE_SPEC = ${JSON.stringify(landscapeSpec)};
export const DEFAULT_RATIO = ${JSON.stringify(ratioSpec)};
export const CODE_PREFIX = ${JSON.stringify({ character: codePrefix[0], weapon: codePrefix[1], mount: codePrefix[2] })};

// 上游短名（prompt 里内联插值用）
const uA = FRAME_SPEC;
const cA = ${maxConsecutive};          // 同一个人最多连说几句
const dA = ${sameSceneLimit};          // 同质化判定：N 场以上同一套动作即"节奏单一"
const fH = PORTRAIT_SPEC;
const bH = LANDSCAPE_SPEC;
const vH = DEFAULT_RATIO;
const ci = CODE_PREFIX;                 // 定妆编号前缀：角色 P / 道具 W / 坐骑 M
`;

/** 四个短模式（上游是内联短字符串，长度可控，直接原样内联） */
const SIMPLE_MODES = [
    {
        id: 'free', name: '自由写作',
        system: '你是一个专业的中文内容创作者。直接输出结果，不要附加任何英文解说或寒暄。除非用户明确要求，否则不要使用 Markdown 代码块包裹。',
    },
    {
        id: 'story', name: '短剧大纲',
        system: `你是竖屏短剧编剧。输出结构：
1. 一句话故事（50字内）
2. 人物小传（每人 2-3 行，含外貌特征）
3. 分集大纲（每集 300 字内，必须包含钩子、冲突、反转）
只输出中文内容，不要英文解说。`,
    },
    {
        id: 'storyboard', name: '分镜脚本',
        system: `你是短剧分镜导演。对每个镜头输出：
- 景别（远/全/中/近/特写）
- 画面描述（客观、可视化，含人物动作与神态）
- 台词或旁白
- 时长（秒）
- 转场方式
只输出中文，不要英文解说。`,
    },
    {
        id: 'prompt', name: '提示词优化',
        system: `你是 AI 绘图提示词专家。把用户的描述改写为适合文生图模型的高质量提示词，
要求：主体明确、风格/镜头/光影/构图具体、包含负面提示词。
输出格式：
【正向提示词】...
【负面提示词】...
只输出中文，不要英文解说。`,
    },
];

const content = `${banner}
// ============== 上游原样保留的工具函数 ==============
${FUNCS.pA}
${FUNCS.hA}
${FUNCS.fA}
${FUNCS.vA}
${FUNCS.SA}
${FUNCS.xA}
${FUNCS.PA}

// ============== 6 个重模式 system prompt（原文，未删改） ==============
const SYS_CHECK = \`${SYSTEMS.check}\`;
const SYS_REWRITE = \`${SYSTEMS.rewrite}\`;
const SYS_SPLIT = \`${SYSTEMS.split}\`;
const SYS_LOCKCODE = \`${SYSTEMS.lockcode}\`;
const SYS_STORYBOARD8 = \`${SYSTEMS.storyboard8}\`;
const SYS_FRAME = \`${SYSTEMS.frame}\`;

/**
 * 10 种模式：4 轻 + 6 重
 *  - needsExtra: 需要第二块输入（体检报告 / 已定妆清单）
 *  - build(input, extra): 生成 user 消息
 */
export const MODES = [
${SIMPLE_MODES.map(m => `    { id: ${JSON.stringify(m.id)}, name: ${JSON.stringify(m.name)}, build: (input) => String(input || '') , system: ${JSON.stringify(m.system)} },`).join('\n')}
    { id: 'check', name: '剧本体检', system: SYS_CHECK, build: (input) => hA(input) },
    { id: 'rewrite', name: '按报告改写', system: SYS_REWRITE, build: (input, extra) => fA(input, extra || ''), needsExtra: true, extraLabel: '剧本体检报告' },
    { id: 'split', name: '70 集拆分', system: SYS_SPLIT, build: (input) => vA(input) },
    { id: 'lockcode', name: '锁定码定妆', system: SYS_LOCKCODE, build: (input, extra) => SA(input, { propsMax: Number(extra) || 6 }) },
    { id: 'storyboard8', name: '分镜八步', system: SYS_STORYBOARD8, build: (input) => xA(input, 10, 12) },
    { id: 'frame', name: '首尾帧继承', system: SYS_FRAME, build: (input, extra) => PA(input, extra || undefined), needsExtra: true, extraLabel: '已定妆清单' },
];

export const MODE_MAP = Object.fromEntries(MODES.map((m) => [m.id, m]));

/** 台词字数预算：镜数 × 每镜秒数 × 4.05 字/秒（下限 90%） */
export const lineBudget = (shots = 10, secondsPerShot = 12) => pA(shots, secondsPerShot);
`;

if (CHECK_ONLY) {
    const exists = fs.existsSync(OUT);
    const same = exists && fs.readFileSync(OUT, 'utf8').length > 5000;
    console.log(`${same ? '✅' : '✘'} 提示词产物${same ? '已存在' : '缺失'}（${Object.keys(SYSTEMS).length} 个 system + ${Object.keys(FUNCS).length} 个模板）`);
    process.exit(same ? 0 : 1);
}

fs.writeFileSync(OUT, content);
const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
console.log(`✅ 已生成 ${path.relative(ROOT, OUT)}（${kb} KB）`);
console.log(`   提取：6 个 system prompt + 6 个 user 模板 + 4 个轻模式`);
for (const [k, v] of Object.entries(SYSTEMS)) console.log(`   · ${k.padEnd(12)} ${v.length} 字`);
