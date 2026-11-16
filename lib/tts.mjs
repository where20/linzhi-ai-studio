/**
 * tts.mjs — 免费 TTS 适配层（多后端 + 自动降级）
 *
 * 后端按优先级：
 *   1. edge（微软 edge-tts，免费无 Key，中文 14 音色，约 1.4s/句）  ← 质量最好、最快
 *   2. voxcpm（本机 VoiceCraft，完全离线零 Key，**支持克隆音色**；首合成要加载 1.9GB 权重）
 *   3. matrix（本机 mcode-tools 账号，免 Key，间歇限流要重试）
 *   4. say（macOS 内置，完全离线，零依赖，音色机械但可用）
 *   5. custom（任意 OpenAI 兼容 /audio/speech，填 baseUrl + key 即可接豆包/MiniMax/自建）
 *
 * 为什么 edge 也走 Python：Sec-MS-GEC 签名只有官方 pip 包跟得紧（插件当年是逆向重实现的）。
 * 实测 2026-11：edge_tts 7.2.8 报 403（v1 签名被废），升到 7.3.1（v2 签名）即恢复。
 *
 * ⚠ 为什么不把豆包当默认：火山引擎过了 2 万字符免费额度就要按量付费
 *   （公版音色 6.5 元/万字符、复刻音色 8 元/万字符、音色年费 150 元/个），
 *   而 edge / voxcpm / matrix / say 全部免费且无需任何 Key。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    probeVoxCpm, resolveVoxCpmRuntime, speakViaVoxCpm, listVoxCpmVoices,
} from './tts_voxcpm.mjs';
import {
    matrixAvailable, speakViaMatrix, speakBatchViaMatrix, listMatrixVoices,
} from './tts_matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDGE_SCRIPT = path.join(HERE, 'tts_edge.py');

export const EDGE_VOICES = [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 女声（通用）', gender: 'female', tag: '推荐' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 女声（年轻）', gender: 'female' },
    { id: 'zh-CN-YunxiNeural', name: '云希 · 男声（青年）', gender: 'male' },
    { id: 'zh-CN-YunjianNeural', name: '云健 · 男声（浑厚）', gender: 'male' },
    { id: 'zh-CN-YunyangNeural', name: '云扬 · 男声（播报）', gender: 'male' },
    { id: 'zh-CN-YunxiaNeural', name: '云夏 · 男声（少年）', gender: 'male' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 东北女声', gender: 'female' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西女声', gender: 'female' },
    { id: 'zh-HK-HiuMaanNeural', name: '曉曼 · 粤语女声', gender: 'female' },
    { id: 'zh-TW-HsiaoChenNeural', name: '曉臻 · 台湾女声', gender: 'female' },
];

const cache = { edge: null, say: null, voxcpm: null, matrix: null };

const pyBin = () => process.env.PYTHON_BIN || 'python3';

/** 探测各后端可用性（缓存 5 分钟） */
export function probeTts({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache.edge && now - cache.edge.at < 300000) {
        return { edge: cache.edge.data, say: cache.say, voxcpm: cache.voxcpm?.data, matrix: cache.matrix?.data };
    }

    // edge：能 import 就算可用（真跑一次太贵）
    let edge = { available: false, version: '', reason: '' };
    const r = spawnSync(pyBin(), [
        '-c', 'import edge_tts, json; print(json.dumps({"v": getattr(edge_tts, "__version__", ""), "gec": __import__("edge_tts.constants", fromlist=["x"]).SEC_MS_GEC_VERSION}))',
    ], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) {
        try {
            const j = JSON.parse((r.stdout || '').trim());
            const v2 = String(j.gec || '').startsWith('2-');
            edge = {
                available: true, version: j.v || '', gec: j.gec || '',
                reason: v2 ? '' : '签名版本为 v1，微软已废弃 → python3 -m pip install -U edge-tts',
                ready: v2,
            };
        } catch {
            edge = { available: true, version: '', reason: '', ready: true };
        }
    } else {
        edge.reason = (r.stderr || 'edge_tts 未安装').split('\n')[0].slice(0, 120);
    }
    cache.edge = { at: now, data: edge };

    // say：macOS 内置
    let say = { available: false, voices: [] };
    if (process.platform === 'darwin') {
        const s = spawnSync('say', ['-v', '?'], { encoding: 'utf8', timeout: 8000 });
        if (s.status === 0) {
            const voices = (s.stdout || '').split('\n')
                .map((l) => l.trim())
                .filter((l) => /zh_CN|zh_TW|zh_HK/.test(l))
                .map((l) => {
                    const m = /^(.+?)\s+\(([^)]+)\)\s+(zh_\w+)/.exec(l);
                    return m ? { id: m[1], name: `${m[1]}（${m[2]}）`, locale: m[3] } : null;
                })
                .filter(Boolean);
            say = { available: voices.length > 0, voices };
        }
    }
    cache.say = say;

    // voxcpm：本机 VoxCPM（离线零 Key，支持克隆音色）
    let voxcpm = { available: false, reason: '', runtime: null, checks: [] };
    try {
        const probe = probeVoxCpm();
        voxcpm = {
            available: !!probe.runtime,
            reason: probe.runtime ? '' : probe.summary,
            runtime: probe.runtime ? { python: probe.runtime.python, modelDir: probe.runtime.modelDir } : null,
            checks: probe.checks,
        };
    } catch (e) {
        voxcpm.reason = (e && e.message) || String(e);
    }
    cache.voxcpm = { at: now, data: voxcpm };

    // matrix：本机 mcode-tools 账号（免 Key）
    let matrix = { available: false, reason: '', path: '' };
    try {
        const ok = matrixAvailable();
        matrix = { available: ok, reason: ok ? '走本机已登录账号，无需 Key' : '本机找不到 mcode-tools', path: ok ? 'mcode-tools' : '' };
    } catch (e) {
        matrix.reason = (e && e.message) || String(e);
    }
    cache.matrix = { at: now, data: matrix };

    return { edge, say, voxcpm, matrix };
}

/** 用 ffprobe 取时长 */
export function probeDuration(file) {
    try {
        const bin = process.env.FFPROBE_PATH || 'ffprobe';
        const r = execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', timeout: 15000 });
        const d = Number((r || '').trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    } catch {
        return null;
    }
}

/**
 * 合成
 * @param {object} o
 * @param {string} o.text
 * @param {'edge'|'voxcpm'|'matrix'|'say'|'custom'|'auto'} [o.provider]
 * @param {string} [o.voice]
 * @param {string} [o.rate]  例 '+10%' / '-10%'
 * @param {string} [o.pitch] 例 '+0Hz'
 * @param {string} o.outFile 输出 mp3 绝对路径
 * @param {object} [o.custom] {baseUrl, apiKey, model, voice}  —— OpenAI 兼容 /audio/speech
 * @param {string} [o.voicesDir] voxcpm 克隆音色目录
 */
export async function synthesize(o) {
    const provider = o.provider && o.provider !== 'auto' ? o.provider : pickProvider();
    if (!provider) throw new Error('没有可用的 TTS 后端：装 edge-tts（推荐）或改用 macOS say');

    if (provider === 'edge') return synthEdge(o);
    if (provider === 'voxcpm') return synthVoxCpm(o);
    if (provider === 'matrix') return synthMatrix(o);
    if (provider === 'say') return synthSay(o);
    if (provider === 'custom') return synthCustom(o);
    throw new Error(`未知 TTS 后端：${provider}`);
}

/**
 * 自动选后端。
 *
 * 优先级：edge（快、质量好）→ voxcpm（离线、可克隆）→ matrix → say。
 * ⚠ edge 排第一不是因为它最好，而是因为它**最快**（1.4s/句）。
 *   要克隆音色或要完全离线，显式传 provider:'voxcpm'。
 */
function pickProvider() {
    const p = probeTts();
    if (p.edge?.available && p.edge.ready !== false) return 'edge';
    if (p.voxcpm?.available) return 'voxcpm';
    if (p.matrix?.available) return 'matrix';
    if (p.say?.available) return 'say';
    if (p.edge?.available) return 'edge';
    return null;
}

function synthEdge({ text, voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%', pitch = '+0Hz', outFile }) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const payload = JSON.stringify({ text, voice, rate, pitch, out: outFile });
    const r = spawnSync(pyBin(), [EDGE_SCRIPT], { input: payload, encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').trim().split('\n').pop() || '';
    let j = null;
    try { j = JSON.parse(line); } catch { /* 下面统一报错 */ }
    if (!j || !j.ok) {
        const why = j?.error || (r.stderr || '').split('\n').slice(-2).join(' ').slice(0, 200) || 'edge-tts 失败';
        throw new Error(`edge-tts：${why}`);
    }
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) throw new Error('edge-tts 未产出音频');
    return { file: outFile, provider: 'edge', voice, duration: probeDuration(outFile) };
}

/**
 * 本机 VoxCPM（离线零 Key，支持克隆音色）。
 *
 * ⚠ worker 返回的是 wav，要转成 mp3 —— 后面拼配音轨的 ffmpeg 滤镜链
 *   （atrim/apad/concat）对 mp3 兼容性最好。
 */
async function synthVoxCpm({ text, voice = 'default', outFile, voicesDir = '' }) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const r = await speakViaVoxCpm(text, voice, voicesDir);
    const wav = r.path;
    try {
        const ff = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg',
            ['-y', '-v', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '4', outFile],
            { encoding: 'utf8', timeout: 120000 });
        if (ff.status !== 0) {
            throw new Error(`ffmpeg 转码失败：${(ff.stderr || '').slice(0, 160)}`);
        }
    } finally {
        try { fs.rmSync(wav, { force: true }); } catch { /* 忽略 */ }
    }
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) throw new Error('VoxCPM 未产出音频');
    return { file: outFile, provider: 'voxcpm', voice, duration: probeDuration(outFile) };
}

/**
 * 本机 matrix 配音（免 Key，走 mcode-tools 账号）。
 *
 * ⚠ matrix 返回的是 mp3，直接落盘即可，不需要转码。
 */
async function synthMatrix({ text, voice, outFile }) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const buf = await speakViaMatrix(text, voice);
    if (!buf || buf.length < 1024) throw new Error('matrix 未产出音频');
    fs.writeFileSync(outFile, buf);
    return { file: outFile, provider: 'matrix', voice: voice || '', duration: probeDuration(outFile) };
}

function synthSay({ text, voice = 'Tingting', rate = 0, outFile }) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const wav = outFile.replace(/\.mp3$/, '.aiff');
    const wordsPerMin = Number(process.env.SAY_WPM) || 190;
    const r = spawnSync('say', ['-v', voice, '-r', String(wordsPerMin), '-o', wav, '--', text], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) throw new Error(`say 失败：${(r.stderr || '').slice(0, 160)}`);
    // aiff → mp3
    const ff = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '4', outFile], { encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(wav, { force: true }); } catch { /* 忽略 */ }
    if (ff.status !== 0) throw new Error(`ffmpeg 转码失败：${(ff.stderr || '').slice(0, 160)}`);
    return { file: outFile, provider: 'say', voice, duration: probeDuration(outFile) };
}

async function synthCustom({ text, outFile, custom = {} }) {
    const base = String(custom.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('custom TTS 需要 custom.baseUrl（OpenAI 兼容 /audio/speech）');
    const r = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(custom.apiKey ? { Authorization: `Bearer ${custom.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: custom.model || 'tts-1',
            voice: custom.voice || 'alloy',
            input: text,
            response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`custom TTS HTTP ${r.status}：${(await r.text()).slice(0, 160)}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, buf);
    return { file: outFile, provider: 'custom', voice: custom.voice || 'alloy', duration: probeDuration(outFile) };
}

/** 静音片段（无台词镜头占位） */
export function makeSilence(outFile, seconds) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    const r = spawnSync(bin, [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
        '-t', String(Math.max(0.2, seconds)), '-c:a', 'libmp3lame', '-q:a', '6', outFile,
    ], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error(`生成静音失败：${(r.stderr || '').slice(0, 120)}`);
    return { file: outFile, provider: 'silence', duration: seconds };
}

/** 配音清单（给前端下拉用） */
export function voiceCatalog() {
    const p = probeTts();
    return {
        providers: [
            {
                id: 'edge', name: '微软 edge-tts（免费 · 无 Key）',
                available: !!p.edge?.available, ready: p.edge?.ready !== false,
                version: p.edge?.version || '', note: p.edge?.reason || '中文 14 音色，约 1.4s/句',
                voices: EDGE_VOICES,
            },
            {
                id: 'voxcpm', name: '本机 VoxCPM（离线 · 零 Key · 可克隆音色）',
                available: !!p.voxcpm?.available,
                note: p.voxcpm?.reason || '1.9GB 模型已装在本地，首合成约 30s，支持零样本克隆音色',
                runtime: p.voxcpm?.runtime || null,
                voices: [
                    { id: 'default', name: '默认音色（零样本）' },
                ],
                checks: p.voxcpm?.checks || [],
            },
            {
                id: 'matrix', name: '本机 matrix（免 Key · 走已登录账号）',
                available: !!p.matrix?.available,
                note: p.matrix?.reason || '走 mcode-tools 本机账号，间歇限流会自动重试',
                voices: [],
            },
            {
                id: 'say', name: 'macOS 内置（离线 · 零依赖）',
                available: !!p.say?.available, note: '机械音，但完全不用联网',
                voices: (p.say?.voices || []).map((v) => ({ id: v.id, name: v.name })),
            },
            {
                id: 'custom', name: '自定义（OpenAI 兼容 /audio/speech）',
                available: false, note: '配 baseUrl + apiKey 可接豆包 / MiniMax / 自建（豆包过 2 万字符后按量付费）',
                voices: [],
            },
        ],
    };
}

/**
 * 某个后端的完整音色表（部分后端要现场拉）。
 *
 * ⚠ 拉不到音色表**不能报错** —— 拉不到就该退回「只有默认音色」，
 *   不该让整个配音功能不可用。
 */
export async function voicesOf(providerId) {
    try {
        if (providerId === 'voxcpm') {
            return listVoxCpmVoices(process.env.VOXCPM_VOICES_DIR || '').map((v) => ({
                id: v, name: v === 'default' ? '默认音色（零样本）' : `克隆音色：${v}`,
            }));
        }
        if (providerId === 'matrix') {
            return (await listMatrixVoices()).map((v) => ({ id: v.id, name: v.name }));
        }
    } catch {
        /* 落到下面的兜底 */
    }
    const cat = voiceCatalog();
    const p = (cat.providers || []).find((x) => x.id === providerId);
    return p?.voices || [];
}

/**
 * 批量合成 —— 逐镜配音用。
 *
 * ⚠ matrix 走批量接口（一次 10 段，限流暴露从「每镜一次」降到「整批一次」）。
 * ⚠ 一段失败不能带崩整批 —— 返回值与输入等长，补不上的是 null，
 *   调用方跳过该段（片子照样出，只是那一镜没声音）。
 *
 * ⚠ **返回值统一是 Buffer**（不是 {file,...}）—— 调用方拿到就能直接落盘，
 *   不用关心后端是「返回路径」还是「返回字节」。
 */
export async function synthesizeBatch(texts, o = {}) {
    const provider = o.provider && o.provider !== 'auto' ? o.provider : pickProvider();
    if (provider === 'matrix') {
        const bufs = await speakBatchViaMatrix(texts, o.voice);
        const out = [];
        for (let i = 0; i < bufs.length; i++) {
            if (bufs[i]) { out.push(bufs[i]); continue; }
            // 批量里没拿到的段，逐条再试一次；仍失败就留 null
            try {
                out.push(await speakViaMatrix(texts[i], o.voice));
            } catch {
                out.push(null);
            }
        }
        return out;
    }

    // 其余后端逐条来 —— 落到临时文件再读回字节，读完即删（不留垃圾）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linzhi-tts-'));
    const out = [];
    try {
        for (let i = 0; i < texts.length; i++) {
            const f = path.join(tmpDir, `seg-${String(i + 1).padStart(3, '0')}.mp3`);
            try {
                const r = await synthesize({ ...o, text: texts[i], outFile: f });
                out.push(fs.readFileSync(r.file));
            } catch {
                out.push(null);
            }
        }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    return out;
}
