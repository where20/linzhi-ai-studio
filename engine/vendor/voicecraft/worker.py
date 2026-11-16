"""VoiceCraft（VoxCPM）常驻 worker —— 给 XA 应用直接调用的本地进程。

⚠ 为什么不用 HTTP：既然要「融入项目、不用另起服务」，
  这个 worker 就**不监听任何端口**，只跟调用方（Node 侧）用
  stdin/stdout 的 JSON 行对话 —— 跟调用 ffmpeg 一样是「起个子进程」。

协议（一行一个 JSON，UTF-8）：

  → {"op":"ping"}
  ← {"ok":true,"ready":false,"device":"mps","dtype":"bfloat16"}

  → {"op":"voices","voicesDir":"/path/to/project/voices"}
  ← {"ok":true,"voices":["default","alice"]}

  → {"op":"synth","text":"深夜的便利店","voice":"default",
     "voicesDir":"/path/to/project/voices"}
  ← {"ok":true,"path":"/tmp/xxx.wav","duration":3.52,"sampleRate":32000}

  → {"op":"synth",...}（模型还没加载好时）
  ← {"ok":false,"error":"...","loading":true}

模型**只加载一次**，之后每次请求都是合成 —— 加载 1.9GB 要十几秒，
每段都重载是不能接受的。

音色：克隆音色放在**项目目录**里（voicesDir 参数），
每个 wav 旁边放同名 .txt（逐字稿）—— 这是 voxcpm 的约定。
"""

import io
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mps_compat  # noqa: E402

# ⚠⚠ **Windows 上必须显式指定 UTF-8**：
#   Python 的标准流在 Windows 上默认用「本地 ANSI 代码页」（中文机器是 cp936）。
#   - stdin 用 cp936 解码 → Node 发来的 UTF-8 中文变成乱码 → **合成出来是错的**；
#   - stderr 用 cp936 编码 → 路径里有生僻字直接 UnicodeEncodeError 把 worker 打死。
#   协议通道本来就自己 encode UTF-8，这里把标准流也统一成 UTF-8。
try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ⚠⚠ **协议输出必须独占一个 fd** —— voxcpm 加载/生成时会往 stdout 打日志
#   （「Running on device: …」、tqdm 进度条），会把 JSON 行协议冲掉。
#   做法：把真正的 stdout  dup 一份专供协议用，
#        再让 fd 1 指向 stderr —— 之后所有 print() 都变成日志。
#
# ⚠ Windows 上同样成立（CRT 的 _dup / _dup2），
#   但换 fd 之前**必须把 sys.stdout 的缓冲刷掉** ——
#   换完再 flush 会写到新 fd（stderr）上去。
try:
    sys.stdout.flush()
    _PROTOCOL_FD = os.dup(1)
    os.dup2(2, 1)
except OSError as e:
    raise RuntimeError(
        "无法把 stdout 从协议通道里摘出去（os.dup/os.dup2 失败）："
        f"{e}。这条路径需要 POSIX 或 Windows CRT 的 dup 支持。"
    ) from e
sys.stdout = sys.stderr


def emit(obj):
    """写一行 JSON 到协议通道。"""
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    os.write(_PROTOCOL_FD, data)


mps_compat.install()

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from voxcpm import VoxCPM  # noqa: E402

MODEL_DIR = os.environ.get("XA_VOICECRAFT_MODEL_DIR", "")
# torch.compile 只在 CUDA 上能用 → 按**实际设备**决定，不写死。
# ⚠ 以前 Node 侧固定传 XA_VOICECRAFT_OPTIMIZE=0（macOS 的 MPS 不能 compile）。
#   但 Windows 那台是 CUDA —— 写死 0 等于白扔 torch.compile 的加速。
OPTIMIZE = mps_compat.auto_optimize_flag()

_model = None
_load_error = None
_loading = False


def model():
    """懒加载模型（第一次合成时才加载）。"""
    global _model, _load_error, _loading
    if _model is not None:
        return _model
    if _load_error is not None:
        raise RuntimeError(_load_error)
    if _loading:
        raise RuntimeError("模型正在加载中")
    _loading = True
    try:
        if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
            raise RuntimeError(
                f"找不到模型目录：{MODEL_DIR or '(未设置 XA_VOICECRAFT_MODEL_DIR)'}"
            )
        print(f"[worker] 加载模型 {MODEL_DIR} ...", flush=True)
        t0 = time.time()
        _model = VoxCPM.from_pretrained(
            MODEL_DIR,
            load_denoiser=False,
            optimize=OPTIMIZE,
        )
        print(
            f"[worker] 模型就绪（{time.time() - t0:.1f}s，device={_model.tts_model.device}，"
            f"dtype={_model.tts_model.config.dtype}）",
            flush=True,
        )
        return _model
    except Exception as e:
        _load_error = f"{type(e).__name__}: {e}"
        raise
    finally:
        _loading = False


def voice_files(voices_dir):
    """音色表：default + 目录里的 wav/mp3（去掉扩展名）。"""
    voices = ["default"]
    if voices_dir and os.path.isdir(voices_dir):
        for name in sorted(os.listdir(voices_dir)):
            if name.lower().endswith((".wav", ".mp3")):
                voices.append(os.path.splitext(name)[0])
    return voices


def synth(text, voice, voices_dir):
    """合成一段语音，返回 (wav 路径, 时长秒)。"""
    m = model()
    prompt_wav = None
    prompt_text = None
    if voice and voice != "default" and voices_dir:
        for ext in (".wav", ".mp3"):
            path = os.path.join(voices_dir, f"{voice}{ext}")
            if os.path.exists(path):
                transcript = os.path.splitext(path)[0] + ".txt"
                if os.path.exists(transcript):
                    prompt_wav = path
                    with open(transcript, "r", encoding="utf-8") as f:
                        prompt_text = f.read().strip()
                break

    wav = m.generate(
        text=text,
        prompt_wav_path=prompt_wav,
        prompt_text=prompt_text,
    )
    sample_rate = m.tts_model.sample_rate
    fd, out_path = tempfile.mkstemp(prefix="xa-voxcpm-", suffix=".wav")
    os.close(fd)
    sf.write(out_path, wav, sample_rate, format="WAV")
    return out_path, len(wav) / sample_rate


def handle(req):
    op = req.get("op") or "synth"
    if op == "ping":
        return {
            "ok": True,
            "ready": _model is not None,
            "loading": _loading,
            "device": str(getattr(_model.tts_model, "device", "")) if _model else "",
            "dtype": str(getattr(_model.tts_model.config, "dtype", "")) if _model else "",
        }

    if op == "voices":
        return {"ok": True, "voices": voice_files(req.get("voicesDir") or "")}

    if op == "synth":
        text = str(req.get("text") or "").strip()
        if not text:
            return {"ok": False, "error": "文本为空"}
        try:
            path, duration = synth(
                text,
                str(req.get("voice") or "default"),
                str(req.get("voicesDir") or ""),
            )
            return {
                "ok": True,
                "path": path,
                "duration": duration,
                "sampleRate": 32000,
            }
        except Exception as e:
            return {
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "loading": _loading,
            }

    return {"ok": False, "error": f"未知 op: {op}"}


def main():
    print("[worker] 就绪，等待指令", flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"ok": False, "error": f"请求不是 JSON：{e}"})
            continue
        try:
            resp = handle(req)
        except Exception as e:
            resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        # ⚠ 必须把请求 id 原样带回 —— 调用方靠它把响应配对到请求
        if isinstance(req, dict) and req.get("id") is not None:
            resp["id"] = req.get("id")
        emit(resp)


if __name__ == "__main__":
    main()
