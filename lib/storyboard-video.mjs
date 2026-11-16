/**
 * storyboard-video.mjs — 逐镜图 → 成片（Ken Burns + 硬字幕）
 *
 * 关键约束（本机实测）：
 *   · Homebrew ffmpeg 8.1 **没有 libass/drawtext**（烧不了字幕）
 *   · imageio_ffmpeg 的静态构建 v7.1 **有 libass**（能烧）
 *   → 拼片用系统 ffmpeg（快、新），烧字幕用静态构建（唯一能烧的）
 *
 * 字幕样式按用户偏好：底部、小号、白字黑描边、无底色遮挡。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
].filter(Boolean);

/** 找 imageio_ffmpeg 的静态构建（带 libass） */
function findLibassBinary() {
    const tryList = [process.env.FFMPEG_SUBTITLE_PATH].filter(Boolean);
    // 常见 venv / 用户级安装路径
    const globs = [
        path.join(os.homedir(), '.local/lib'),
        path.join(os.homedir(), 'Library/Python'),
    ];
    for (const base of globs) {
        try {
            const stack = [base];
            let guard = 0;
            while (stack.length && guard < 3000) {
                const dir = stack.pop();
                guard += 1;
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) { stack.push(p); continue; }
                    if (e.isFile() && /^ffmpeg-macos/.test(e.name)) tryList.push(p);
                }
            }
        } catch { /* 目录不存在 */ }
    }
    for (const bin of tryList) {
        try {
            const r = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 8000 });
            if ((r.stdout || '').includes('subtitles')) return bin;
        } catch { /* 下一个 */ }
    }
    return null;
}

let _probe = null;
export function probeFfmpeg() {
    if (_probe) return _probe;
    const main = CANDIDATES.find((p) => {
        try {
            return fs.existsSync(p) && spawnSync(p, ['-version'], { timeout: 5000 }).status === 0;
        } catch {
            return false;
        }
    }) || 'ffmpeg';
    const subtitle = findLibassBinary();
    _probe = { main, subtitle };
    return _probe;
}

const run = (bin, args, timeout = 600000) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) {
        const tail = (r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ');
        throw new Error(`ffmpeg 失败（${path.basename(bin)}）：${tail || 'exit ' + r.status}`);
    }
    return r;
};

/** 秒 → SRT 时间码 */
function srtTime(sec) {
    const ms = Math.round(sec * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** 按标点优先折行（字幕 1-2 行，避免溢出画面，也别在词中间断开） */
const PUNCT = new Set([...'，。！？；：、,.!?;:…”’）)']);

function wrapText(text, perLine = 14, maxLines = 2) {
    const chars = [...String(text).replace(/\s+/g, '')];
    const lines = [];
    let cur = '';
    for (const ch of chars) {
        cur += ch;
        if ([...cur].length >= perLine) {
            // 从后往前找最近标点，至少保留 60% 行长，避免断成碎片
            let cut = -1;
            const arr = [...cur];
            for (let i = arr.length - 1; i >= Math.floor(perLine * 0.6); i -= 1) {
                if (PUNCT.has(arr[i])) { cut = i + 1; break; }
            }
            if (cut > 0) {
                lines.push(arr.slice(0, cut).join(''));
                cur = arr.slice(cut).join('');
            } else {
                lines.push(cur);
                cur = '';
            }
        }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
        const kept = lines.slice(0, maxLines - 1);
        const rest = lines.slice(maxLines - 1).join('');
        kept.push([...rest].slice(0, perLine - 1).join('') + '…');
        return kept.join('\\N');
    }
    return lines.join('\\N');
}

/**
 * 生成 SRT
 * 默认只用台词（画面描述太长，烧成字幕会糊满屏幕）；需要时 useDesc=true 才退用描述。
 */
export function buildSrt(shots, { useDesc = false, perLine = 14, maxLines = 2 } = {}) {
    let t = 0;
    const blocks = [];
    let idx = 1;
    for (const s of shots) {
        const sec = Math.max(1, Number(s.seconds) || 3);
        let text = String(s.line || '').trim();
        if (!text || /^[无—\\-–]+$/.test(text)) text = useDesc ? String(s.desc || '').trim() : '';
        if (text) {
            blocks.push(`${idx}\n${srtTime(t)} --> ${srtTime(t + sec - 0.06)}\n${wrapText(text, perLine, maxLines)}\n`);
            idx += 1;
        }
        t += sec;
    }
    return { srt: blocks.join('\n'), duration: t };
}

/** Ken Burns 单镜片段 */
function renderClip({ bin, image, out, seconds, width, height, fps, zoom = 1.12 }) {
    const frames = Math.max(2, Math.round(seconds * fps));
    const vf = [
        `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
        `crop=${width * 2}:${height * 2}`,
        `zoompan=z='min(zoom+0.0012,${zoom})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
        'format=yuv420p',
    ].join(',');
    run(bin, [
        '-y', '-v', 'error',
        '-loop', '1', '-i', image,
        '-t', String(seconds),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-an', out,
    ]);
}

/**
 * 渲染成片
 * @param {object} opts
 * @param {Array}  opts.shots   [{image:{file|url}, seconds, line, desc}]
 * @param {string} opts.rootDir 项目根（把 /output/xx 映射成磁盘路径）
 * @param {string} opts.outFile 输出 mp4 绝对路径
 * @param {number} [opts.width] [opts.height] [opts.fps]
 * @param {string} [opts.bgm]  背景音乐绝对路径
 * @param {boolean}[opts.subtitle]
 * @param {(s)=>void} [opts.onProgress]
 */
export async function renderStoryboardVideo({
    shots, rootDir, outFile, width = 1280, height = 720, fps = 24,
    bgm = null, subtitle = true, useDesc = false, onProgress = () => {}, crossfade = 0, voiceMap = null,
}) {
    const usable = shots.filter((s) => s.image && (s.image.file || s.image.url));
    if (!usable.length) throw new Error('没有可用画面 —— 先跑一遍逐镜出图');

    const { main, subtitle: subBin } = probeFfmpeg();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbvideo-'));
    const clipDir = path.join(tmp, 'clips');
    fs.mkdirSync(clipDir, { recursive: true });

    try {
        // 1) 逐镜片段
        const clips = [];
        let done = 0;
        for (const s of usable) {
            const rel = String(s.image.file || s.image.url).replace(/^\/output\//, '');
            const abs = path.join(rootDir, 'output', rel);
            if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
            const sec = Math.max(1, Number(s.seconds) || 3);
            const out = path.join(clipDir, `c${String(s.index).padStart(3, '0')}.mp4`);
            renderClip({ bin: main, image: abs, out, seconds: sec, width, height, fps });
            clips.push(out);
            done += 1;
            onProgress({ stage: 'clips', progress: Math.round((done / usable.length) * 60), detail: `片段 ${done}/${usable.length}` });
        }

        // 2) 拼接
        const listFile = path.join(tmp, 'list.txt');
        fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join('\n') + '\n');
        const silent = path.join(tmp, 'silent.mp4');
        onProgress({ stage: 'concat', progress: 65, detail: '拼接中' });
        run(main, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);
        let current = silent;

        // 3) 字幕（必须用带 libass 的构建）
        const { srt, duration } = buildSrt(usable, { useDesc: !!useDesc });
        let subtitleBurned = false;
        if (subtitle && srt.trim()) {
            onProgress({ stage: 'subtitle', progress: 78, detail: '烧字幕' });
            if (subBin) {
                const srtFile = path.join(tmp, 'sub.srt');
                fs.writeFileSync(srtFile, srt, 'utf8');
                const styled = path.join(tmp, 'styled.mp4');
                const style = [
                    'FontName=Heiti SC', `FontSize=${Math.max(11, Math.round(height / 40))}`,
                    'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H00000000',
                    'BorderStyle=1', 'Outline=1.2', 'Shadow=0',
                    'MarginV=22', 'MarginL=40', 'MarginR=40', 'Alignment=2', 'Spacing=0.4',
                ].join(',');
                run(subBin, [
                    '-y', '-v', 'error', '-i', current,
                    '-vf', `subtitles=${srtFile}:force_style='${style}'`,
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
                    '-c:a', 'copy', styled,
                ]);
                current = styled;
                subtitleBurned = true;
            }
        }

        // 3.5) 逐镜配音：按镜长 pad/trim 后拼成整轨，再 mux 回视频
        let voiced = false;
        if (voiceMap && Object.keys(voiceMap).length) {
            onProgress({ stage: 'voice', progress: 82, detail: '拼配音轨' });
            const segFiles = [];
            for (const s of usable) {
                const sec = Math.max(1, Number(s.seconds) || 3);
                const f = voiceMap[String(s.index)];
                if (f && fs.existsSync(f)) {
                    segFiles.push({ file: f, seconds: sec });
                } else {
                    const sil = path.join(tmp, `sil-${s.index}.mp3`);
                    run(main, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
                        '-t', String(sec), '-c:a', 'libmp3lame', '-q:a', '6', sil]);
                    segFiles.push({ file: sil, seconds: sec });
                }
            }
            const track = path.join(tmp, 'voice.m4a');
            const inputs = segFiles.flatMap((x) => ['-i', x.file]);
            const parts = segFiles.map((x, i) =>
                `[${i}:a]aresample=44100,aformat=channel_layouts=mono,atrim=0:${x.seconds},apad,atrim=0:${x.seconds}[a${i}]`
            ).join(';');
            const concat = segFiles.map((_, i) => `[a${i}]`).join('') + `concat=n=${segFiles.length}:v=0:a=1[out]`;
            run(main, ['-y', '-v', 'error', ...inputs, '-filter_complex', `${parts};${concat}`,
                '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', track]);
            const muxed = path.join(tmp, 'voiced.mp4');
            run(main, ['-y', '-v', 'error', '-i', current, '-i', track,
                '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxed]);
            current = muxed;
            voiced = true;
        }

        // 4) BGM（有配音就压到 18% 当底噪，没配音就 35%）
        if (bgm && fs.existsSync(bgm)) {
            onProgress({ stage: 'audio', progress: 90, detail: '混入 BGM' });
            const mixed = path.join(tmp, 'mixed.mp4');
            if (voiced) {
                run(main, [
                    '-y', '-v', 'error', '-i', current, '-stream_loop', '-1', '-i', bgm,
                    '-filter_complex', '[1:a]volume=0.18[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]',
                    '-map', '0:v', '-map', '[a]', '-shortest',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', mixed,
                ]);
            } else {
                run(main, [
                    '-y', '-v', 'error', '-i', current, '-stream_loop', '-1', '-i', bgm,
                    '-filter_complex', '[1:a]volume=0.35[a]',
                    '-map', '0:v', '-map', '[a]', '-shortest',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', mixed,
                ]);
            }
            current = mixed;
        }

        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.copyFileSync(current, outFile);
        onProgress({ stage: 'done', progress: 100, detail: '完成' });
        return {
            outFile,
            duration: Number(duration.toFixed(2)),
            clips: clips.length,
            size: { width, height, fps },
            subtitle: subtitleBurned,
            subtitle_reason: subtitleBurned ? null : (subtitle ? (subBin ? '无字幕内容' : '未找到带 libass 的 ffmpeg（字幕跳过）') : '已关闭'),
            bgm: !!(bgm && fs.existsSync(bgm)),
            voiced,
        };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
}

/** 探测能力（给 /api 用） */
export function ffmpegCapabilities() {
    const p = probeFfmpeg();
    return { main: p.main, subtitle_bin: p.subtitle || '', can_burn_subtitles: !!p.subtitle };
}
