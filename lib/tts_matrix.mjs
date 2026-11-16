/**
 * tts_matrix.mjs — 本机 matrix 配音后端（免 Key）
 *
 * 定位：**一把 key 都没有时的兜底**。
 * matrix 用的是本机已登录的账号（mcode-tools CLI），用户什么都不用配。
 *
 * 与 white-board 的 XA 白板工作台同一套协议（apps/web/lib/providers/matrix.ts）：
 *   → mcode-tools connector call connector__matrix__synthesize_speech --args-file <json>
 *   ← {"code":0,"message":"ok","node_id":"...","file_name":"x.mp3"}
 *   → 再 mcode-tools get_asset_url <node_id> → {"download_url":"https://..."}
 *   → fetch(download_url) → mp3 字节
 *
 * ⚠ 三个踩过的坑（都抄自 white-board 的注释）：
 *   1. **mcode-tools 是 Electron 壳，stderr 开头永远是噪声** ——
 *      `[ERROR:electron/... Node.js environment variables are disabled…]`、
 *      `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental…`。
 *      真正有用的 `error: connector_busy: connector provider is busy` 在**最后一行**。
 *      只取前 300 字符 → 关键信息被截掉 → 限流重试判定匹配不到「busy」。
 *   2. **配音是间歇性限流的**（实测 4 次里约 3 次被拒）——
 *      错误原文写着「retry the SAME request after a brief delay」。
 *      不重试的话，10 个镜头就是 10 次暴露机会，一次限流整条配音就没了。
 *   3. **批量接口的失败是逐段的** —— 整批返回 code=0，但批内每段各自被拒
 *      （failed_items 里带 index）。所以「整批失败才重试」不够，
 *      必须把失败的那几段挑出来单独再发一轮。
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** CLI 调用超时（配音不会很久，但上游排队可能）。 */
const CLI_TIMEOUT_MS = 120_000;

/** 限流时的最大重试次数。 */
const MAX_RETRY = 3;

/** 限流/临时故障的判定特征 —— 这类错误重试同一条请求就行。 */
const RETRYABLE = /rate|限流|busy|timeout|temporar|try again|重试|too many/i;

/** 在 PATH 上找 mcode-tools。 */
function findOnPath() {
    const pathEnv = process.env.PATH || '';
    const dirs = pathEnv.split(delimiter).filter(Boolean);
    for (const dir of dirs) {
        const full = join(dir, 'mcode-tools');
        if (existsSync(full)) return full;
    }
    return null;
}

/** mcode-tools 在不在。 */
export function matrixAvailable() {
    if (process.env.MATRIX_TTS_DISABLED === '1') return false;
    return !!findOnPath();
}

/**
 * 把 mcode-tools 的 stderr 收拾成一句人能看懂的。
 *
 * ⚠ 必须留住**尾部** —— 见文件头第 1 条坑。
 */
function cliErrorMessage(err, out) {
    const raw = (err || out || '').trim();
    const kept = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/Node\.js environment variables are disabled|UNDICI-EHPA|trace-warnings/i.test(l));
    const text = kept.length ? kept.join(' | ') : raw;
    return text.length > 300 ? `${text.slice(0, 120)}…${text.slice(-160)}` : text;
}

/** 跑一条 mcode-tools 命令，返回 stdout。 */
function runCli(args) {
    const exe = findOnPath();
    if (!exe) return Promise.reject(new Error('本机找不到 mcode-tools'));
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { shell: false, windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`mcode-tools 超时（${CLI_TIMEOUT_MS / 1000}s）`));
        }, CLI_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(`起 mcode-tools 失败：${e.message}`)); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`mcode-tools 退出码 ${code}：${cliErrorMessage(err, out)}`));
                return;
            }
            resolve(out);
        });
    });
}

/** 退避时长：2s → 4s → 8s。 */
function backoffMs(attempt) {
    return 2000 * Math.pow(2, attempt);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * 调一个 connector 工具。
 *
 * 参数走临时文件而不是命令行内联 —— JSON 里带中文和引号，内联转义在 Windows 上太容易出错。
 */
async function callConnector(tool, args, attempt = 0) {
    const file = join(
        tmpdir(),
        `linzhi-matrix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
        writeFileSync(file, JSON.stringify(args), 'utf8');
        let out;
        try {
            out = await runCli(['connector', 'call', tool, '--args-file', file]);
        } catch (e) {
            if (attempt < MAX_RETRY && RETRYABLE.test(e && e.message)) {
                await sleep(backoffMs(attempt));
                return callConnector(tool, args, attempt + 1);
            }
            throw e;
        }
        let res;
        try {
            res = JSON.parse(out);
        } catch {
            throw new Error(`matrix 返回的不是 JSON：${out.slice(0, 160)}`);
        }
        if (res?.code !== 0 && attempt < MAX_RETRY && RETRYABLE.test(String(res?.message || ''))) {
            await sleep(backoffMs(attempt));
            return callConnector(tool, args, attempt + 1);
        }
        return res;
    } finally {
        try { unlinkSync(file); } catch { /* 忽略 */ }
    }
}

/** node_id → 短效下载链接 → 字节。 */
async function fetchNodeBytes(nodeId) {
    const out = await runCli(['get_asset_url', nodeId]);
    let json;
    try {
        json = JSON.parse(out);
    } catch {
        throw new Error('get_asset_url 返回的不是 JSON');
    }
    const url = json?.download_url;
    if (!url) throw new Error('matrix 没给下载地址');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 matrix 资源失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * 用 matrix 合成一段语音（mp3 字节）。
 */
export async function speakViaMatrix(text, voiceId) {
    const body = { text, output_file: `linzhi-voice-${Date.now()}.mp3` };
    if (voiceId) body.voice_id = voiceId;
    const res = await callConnector('connector__matrix__synthesize_speech', body);
    if (res?.code !== 0) {
        throw new Error(`matrix 配音失败：${res?.message || '未知错误'}`);
    }
    if (!res?.node_id) {
        throw new Error(`matrix 配音没返回成品：${res?.summary || res?.message || '未知错误'}`);
    }
    return fetchNodeBytes(res.node_id);
}

/**
 * 批量合成语音（一次最多 10 段）。
 *
 * ⚠ 为什么要批量 + 分轮重试：见文件头第 3 条坑。
 *   批量接口的成功列表**不带下标**，只能靠文件名把成品映射回原来的段序。
 */
export async function speakBatchViaMatrix(texts, voiceId) {
    if (!texts.length) return [];
    const out = new Array(texts.length).fill(null);
    let pending = texts.map((text, i) => ({ text, i }));

    for (let round = 0; round < MAX_RETRY && pending.length; round++) {
        const requests = pending.map(({ text, i }) => {
            const r = { text, output_file: `linzhi-voice-${String(i + 1).padStart(2, '0')}.mp3` };
            if (voiceId) r.voice_id = voiceId;
            return r;
        });

        const res = await callConnector('connector__matrix__batch_text_to_audio', { requests });
        if (res?.code !== 0) {
            await sleep(backoffMs(round));
            continue;
        }

        for (const item of res?.success_items || []) {
            const m = /linzhi-voice-(\d+)\.mp3/.exec(String(item.file_name || ''));
            const idx = m ? Number(m[1]) - 1 : -1;
            if (idx >= 0 && idx < out.length) {
                out[idx] = await fetchNodeBytes(item.node_id);
            }
        }

        const failedIdx = new Set();
        for (const f of res?.failed_items || []) failedIdx.add(Number(f.index));
        const succeeded = (res?.success_items || []).length;
        if (!succeeded && !failedIdx.size) {
            await sleep(backoffMs(round));
            continue;
        }
        const next = pending.filter((_, k) => failedIdx.has(k));
        if (!next.length) break;
        pending = next;
        await sleep(backoffMs(round));
    }
    return out;
}

/** matrix 的音色表。 */
export async function listMatrixVoices() {
    const res = await callConnector('connector__matrix__get_voice_list', {});
    const list = Array.isArray(res?.available_voices) ? res.available_voices : [];
    return list.map((v) => ({
        id: String(v.voice_id || ''),
        name: String(v.voice_name || v.voice_id || ''),
    })).filter((v) => v.id);
}
