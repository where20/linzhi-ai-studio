/**
 * tts_voxcpm.mjs — 本机 VoxCPM（VoiceCraft）离线 TTS 后端
 *
 * 为什么接这个：
 *   - 完全离线、零 Key、零费用 —— 豆包/火山引擎过了 2 万字符免费额度就要按量付费
 *     （公版音色 6.5 元/万字符，复刻音色 8 元/万字符，音色年费 150 元/个）
 *   - **能克隆音色**（给一段参考 wav + 逐字稿，零样本复刻）—— edge-tts 做不到
 *   - 本机已经装好了：`~/DevSpace/VoiceCraft-voxCPM`（1.9GB 权重 + venv）
 *
 * 架构（跟 white-board 的 XA 白板工作台同一套）：
 *   Node 侧不监听任何端口，直接 spawn 一个 Python worker，
 *   用 stdin/stdout 的 JSON 行对话 —— 跟调 ffmpeg 一样是「起个子进程」。
 *
 * ⚠ 三个必须记住的点（都踩过）：
 *   1. **模型只加载一次** —— 1.9GB 权重加载要 28 秒，每段配音都重载是不能接受的。
 *      所以 worker 常驻，Node 侧持有它。
 *   2. **worker 崩了要能自愈** —— 进程退出时把在途请求全部 reject，下次调用重新拉起。
 *   3. **别留孤儿进程** —— Node 崩了 Python 会变孤儿，白占 1.9GB 内存。
 *      所以 worker 把 PID 写进 pid 文件，下次拉起前先把上一个杀掉。
 *
 * 协议（一行一个 JSON，UTF-8）：
 *   → {"op":"ping","id":1}
 *   ← {"ok":true,"ready":false,"device":"mps","id":1}
 *   → {"op":"voices","voicesDir":"/path","id":2}
 *   ← {"ok":true,"voices":["default"],"id":2}
 *   → {"op":"synth","text":"...","voice":"default","voicesDir":"/path","id":3}
 *   ← {"ok":true,"path":"/tmp/x.wav","duration":4.48,"sampleRate":32000,"id":3}
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** worker 脚本候选（项目内 vendor 优先，其次 white-board 仓库）。 */
function workerCandidates() {
    const list = [];
    if (process.env.VOXCPM_WORKER?.trim()) list.push(process.env.VOXCPM_WORKER.trim());
    list.push(join(HERE, '..', 'engine', 'vendor', 'voicecraft', 'worker.py'));
    list.push('/Users/xiaoan/Documents/AIGC/white-board/docker/voicecraft/worker.py');
    return list.filter((p) => existsSync(p));
}

/** 部署根目录候选 —— 装 VoiceCraft 的地方。 */
function homeCandidates() {
    const list = [];
    const env = process.env.VOXCPM_HOME?.trim();
    if (env) list.push(env);
    list.push(join(homedir(), 'DevSpace', 'VoiceCraft-voxCPM'));
    list.push(join(homedir(), 'VoiceCraft-voxCPM'));
    return list;
}

/** venv 里的 python（macOS/Linux 是 .venv/bin/python）。 */
function pythonCandidates(home) {
    return [
        join(home, '.venv', 'bin', 'python'),
        join(home, '.venv', 'bin', 'python3'),
        join(home, '.venv', 'Scripts', 'python.exe'),
    ];
}

/** 这个目录长得像 VoxCPM 模型目录吗（config.json + tokenizer.json + 权重）。 */
export function looksLikeModelDir(dir) {
    if (!dir || !existsSync(dir)) return false;
    let names = [];
    try { names = readdirSync(dir).map((n) => n.toLowerCase()); } catch { return false; }
    if (!names.includes('config.json')) return false;
    if (!names.includes('tokenizer.json')) return false;
    return names.some((n) => n.endsWith('.safetensors') || n.endsWith('.bin') || n.endsWith('.pth'));
}

/** 模型目录候选。 */
function modelCandidates(home) {
    const list = [
        join(home, 'models', 'voxcpm'),
        join(home, 'models', 'VoxCPM1.5'),
        join(home, 'models', 'openbmb--VoxCPM1.5'),
    ];
    try {
        for (const sub of readdirSync(join(home, 'models'))) {
            const abs = join(home, 'models', sub);
            if (looksLikeModelDir(abs)) list.push(abs);
        }
    } catch { /* 目录读不了就只留固定候选 */ }
    return list;
}

/**
 * 解析运行时。**找不到就返回 null** —— 调用方据此判定「这台机器没有本地 VoxCPM」，
 * 直接回落到别的引擎，不该报错。
 */
export function resolveVoxCpmRuntime() {
    const worker = workerCandidates()[0];
    if (!worker) return null;

    let home = '';
    let python = '';
    for (const h of homeCandidates()) {
        const p = pythonCandidates(h).find((x) => existsSync(x));
        if (p) { home = h; python = p; break; }
    }
    if (!home) return null;

    const explicit = process.env.VOXCPM_MODEL_DIR?.trim();
    let modelDir = '';
    if (explicit && existsSync(explicit)) {
        modelDir = explicit;
    } else {
        modelDir = modelCandidates(home).find(looksLikeModelDir) ?? '';
    }
    if (!modelDir) return null;

    return { python, worker, modelDir, home, pidFile: join(home, 'worker.pid') };
}

/** 完整探测报告（含每项候选的成败），给 doctor / 排障用。 */
export function probeVoxCpm() {
    const checks = [];

    const workers = workerCandidates();
    checks.push({
        label: 'worker 脚本',
        path: workers[0] ?? '(没找到 voicecraft/worker.py)',
        ok: workers.length > 0,
    });

    const homes = homeCandidates();
    const pyHits = homes.filter((h) => pythonCandidates(h).some((p) => existsSync(p)));
    checks.push({
        label: 'Python 解释器',
        path: pyHits[0]
            ? (pythonCandidates(pyHits[0]).find((p) => existsSync(p)) ?? '')
            : `试过 ${homes.length} 个部署目录（${homes.slice(0, 2).join(' / ')}…）`,
        ok: pyHits.length > 0,
    });

    const explicit = process.env.VOXCPM_MODEL_DIR?.trim();
    const modelHits = explicit && existsSync(explicit)
        ? [explicit]
        : homes.flatMap((h) => modelCandidates(h)).filter(looksLikeModelDir);
    checks.push({
        label: '模型目录',
        path: modelHits[0] ?? '没找到（要 config.json + tokenizer.json + 权重）',
        ok: modelHits.length > 0,
    });

    const runtime = resolveVoxCpmRuntime();
    const missing = checks.filter((c) => !c.ok).map((c) => c.label);
    return {
        runtime,
        checks,
        summary: runtime
            ? `VoxCPM 运行时可用：${runtime.python}`
            : `找不到本机 VoxCPM 运行时（缺：${missing.join('、')}）`,
    };
}

/* ------------------------------------------------------------------ *
 * worker 单例
 * ------------------------------------------------------------------ */

/** worker 的响应结构（协议见文件头）。 */
const WorkerResponse = {};   // 仅作类型说明用，运行时不参与

/** worker 单例状态。 */
const VoxCpmState = {};

/**
 * ⚠ 状态必须挂在 globalThis 上，不能用模块级变量 ——
 *   Node 的 ESM 缓存虽然稳定，但 server.js 用动态 import()，
 *   同一个模块可能被求值多次，模块级变量一重置就会再 spawn 一个 1.9GB 的 worker。
 */
const STATE_KEY = Symbol.for('linzhi.voxcpm.state');

function state() {
    const g = globalThis;
    let s = g[STATE_KEY];
    if (!s) {
        s = { worker: null, seq: 0, pending: new Map(), lineBuffer: '', stderrTail: [], cleanupRegistered: false };
        g[STATE_KEY] = s;
    }
    return s;
}

/** 杀掉上一个遗留的 worker（Node 崩了之后 Python 会变孤儿）。 */
function killStaleWorker(pidFile) {
    try {
        if (!existsSync(pidFile)) return;
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(pid) || pid <= 1) return;
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGTERM');
            console.warn(`[配音] 杀掉上一个遗留的 VoxCPM worker（pid ${pid}）`);
        } catch { /* 已经不在了 */ }
        rmSync(pidFile, { force: true });
    } catch { /* 清理失败不影响主流程 */ }
}

/** 删 pid 文件 —— 只在里面记的还是这个 pid 时才删（免得拆掉下一个 worker 的防孤儿机制）。 */
function clearPidFile(pidFile, pid) {
    if (!pid) return;
    try {
        if (!existsSync(pidFile)) return;
        const cur = Number(readFileSync(pidFile, 'utf8').trim());
        if (cur === pid) rmSync(pidFile, { force: true });
    } catch { /* 忽略 */ }
}

function startWorker() {
    const rt = resolveVoxCpmRuntime();
    if (!rt) {
        const probe = probeVoxCpm();
        const detail = probe.checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}：${c.path}`).join('\n');
        throw new Error(`本机没有 VoxCPM 运行时\n${detail}`);
    }
    killStaleWorker(rt.pidFile);

    const child = spawn(rt.python, [rt.worker], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            XA_VOICECRAFT_MODEL_DIR: rt.modelDir,
            // ⚠ 不要写死 optimize —— torch.compile 只在 CUDA 上能用，
            //   macOS 的 MPS 必须关。worker 自己按 torch.cuda.is_available() 判。
        },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    try {
        writeFileSync(rt.pidFile, String(child.pid), 'utf8');
    } catch (e) {
        console.warn(`[配音] pid 文件写不了：${e && e.message}`);
    }

    const s = state();

    child.stdout.on('data', (chunk) => {
        s.lineBuffer += chunk;
        let idx;
        while ((idx = s.lineBuffer.indexOf('\n')) >= 0) {
            const line = s.lineBuffer.slice(0, idx).trim();
            s.lineBuffer = s.lineBuffer.slice(idx + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            const id = obj.id;
            const waiter = id != null ? s.pending.get(id) : undefined;
            if (!waiter) continue;
            s.pending.delete(id);
            waiter.resolve(obj);
        }
    });

    // ⚠ stderr 必须持续消费 —— 管道写满（64KB）会把 worker 卡死。
    //   只留尾部 30 行，供报错时看上下文。
    child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
            if (line.trim()) {
                s.stderrTail.push(line.trim());
                if (s.stderrTail.length > 30) s.stderrTail.shift();
            }
        }
    });

    const failAll = (reason) => {
        for (const [, waiter] of s.pending) waiter.reject(new Error(reason));
        s.pending.clear();
        if (s.worker === child) s.worker = null;
    };
    child.on('exit', (code) => {
        failAll(`VoxCPM worker 退出（code ${code}）`);
        const rt2 = resolveVoxCpmRuntime();
        if (rt2) clearPidFile(rt2.pidFile, child.pid);
    });
    child.on('error', (e) => failAll(`VoxCPM worker 起不来：${e.message}`));

    s.worker = child;
    return child;
}

function ensureWorker() {
    const s = state();
    if (s.worker && !s.worker.killed && s.worker.exitCode === null) return s.worker;
    s.worker = null;
    return startWorker();
}

/** 进程退出时别留孤儿 Python。 */
function registerCleanup() {
    const s = state();
    if (s.cleanupRegistered) return;
    s.cleanupRegistered = true;
    const kill = () => {
        const child = s.worker;
        try { child?.kill('SIGTERM'); } catch { /* ignore */ }
        const rt = resolveVoxCpmRuntime();
        if (rt) clearPidFile(rt.pidFile, child?.pid);
    };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });
    process.on('SIGTERM', () => { kill(); process.exit(143); });
}
registerCleanup();

/** 给 worker 发一条请求，等它的响应。 */
function call(req, timeoutMs) {
    const s = state();
    const child = ensureWorker();
    const id = ++s.seq;
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            s.pending.delete(id);
            const tail = s.stderrTail.slice(-5).join(' | ');
            rejectPromise(new Error(`VoxCPM worker 超时（${timeoutMs / 1000}s）${tail ? '：' + tail : ''}`));
        }, timeoutMs);
        s.pending.set(id, {
            resolve: (r) => { clearTimeout(timer); resolvePromise(r); },
            reject: (e) => { clearTimeout(timer); rejectPromise(e); },
        });
        try {
            child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
        } catch (e) {
            clearTimeout(timer);
            s.pending.delete(id);
            rejectPromise(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

/**
 * 本地合成一段语音，返回 wav 字节。
 *
 * ⚠ 超时给到 15 分钟：第一次要加载 1.9GB 权重（实测 28 秒）+ 合成（实测 14 秒）。
 */
export async function speakViaVoxCpm(text, voice, voicesDir = '') {
    const res = await call(
        { op: 'synth', text: String(text || '').trim(), voice: voice || 'default', voicesDir },
        15 * 60_000,
    );
    if (!res.ok || !res.path) {
        throw new Error(`VoxCPM 合成失败：${res.error || '未知错误'}`);
    }
    try {
        return { path: res.path, duration: res.duration, sampleRate: res.sampleRate || 32000 };
    } catch {
        throw new Error('VoxCPM 合成失败：未返回音频路径');
    }
}

/** 音色表：default + 目录里的克隆音色（去掉扩展名）。 */
export function listVoxCpmVoices(voicesDir = '') {
    const voices = ['default'];
    try {
        if (voicesDir && existsSync(voicesDir)) {
            for (const name of readdirSync(voicesDir)) {
                if (/\.(wav|mp3)$/i.test(name)) {
                    const id = name.replace(/\.(wav|mp3)$/i, '');
                    if (!voices.includes(id)) voices.push(id);
                }
            }
        }
    } catch { /* 目录读不了就只给 default */ }
    return voices;
}

/** 探活（排障用）。 */
export async function voxCpmPing() {
    return call({ op: 'ping' }, 15_000);
}
