"""macOS / Apple Silicon 的 MPS 兼容层。

从 server.py 里抽出来的 —— server.py 和 worker.py 共用同一套 shim。

⚠ 三个坑都是 MPS 后端的能力缺口，**不是模型/代码的 bug**：
  1. SDPA 不支持 enable_gqa=True（GQA 模型直接 LLVM ERROR 把进程打崩）
  2. conv1d 不支持「输出通道 > 65536」（音频 VAE 的深度可分离卷积）
     ⚠ torch 自带的 PYTORCH_ENABLE_MPS_FALLBACK=1 不覆盖这个 op
  3. arange 不支持 bfloat16

全部用 torch.backends.mps.is_available() 守卫 ——
CUDA / CPU 路径的行为完全不变。

另外：torch.compile（optimize=True）**只在 CUDA 上能用**，
非 CUDA 设备上 voxcpm 直接 raise「can only be optimized on CUDA device」，
所以非 CUDA 必须关掉（见 caller 传 optimize 参数）。
"""

import os


def install():
    """装上所有 MPS shim（非 MPS 平台是 no-op）。"""
    _install_mps_gqa_shim()
    _install_mps_conv_fallback()
    _install_mps_bf16_arange_shim()


def _mps_available():
    try:
        import torch

        return bool(torch.backends.mps.is_available())
    except Exception:
        return False


def _install_mps_gqa_shim():
    """MPS 的 SDPA 不支持 enable_gqa=True —— 自己把 KV 头 repeat 出来。

    症状（不修就是进程 abort）：
      mps.matmul(tensor<10x16x5x64xf32>, tensor<10x2x64x5xf32>)
        -> "incompatible dimensions" / "invalid shape"
      LLVM ERROR: Failed to infer result type(s)
    （CPU/CUDA 的 matmul 会退化成逐 batch 循环，MPS 不会。）
    """
    try:
        import torch
        import torch.nn.functional as F

        if not _mps_available():
            return
        orig = F.scaled_dot_product_attention

        def patched(
            query,
            key,
            value,
            attn_mask=None,
            dropout_p=0.0,
            is_causal=False,
            scale=None,
            enable_gqa=False,
        ):
            if enable_gqa and query.device.type == "mps":
                n_rep = query.shape[1] // key.shape[1]
                if n_rep > 1:
                    key = key.repeat_interleave(n_rep, dim=1)
                    value = value.repeat_interleave(n_rep, dim=1)
                enable_gqa = False
            return orig(
                query,
                key,
                value,
                attn_mask=attn_mask,
                dropout_p=dropout_p,
                is_causal=is_causal,
                scale=scale,
                enable_gqa=enable_gqa,
            )

        F.scaled_dot_product_attention = patched
        print("[VoiceCraft] MPS GQA shim 已启用", flush=True)
    except Exception as e:
        print(f"[VoiceCraft] MPS GQA shim 未启用：{e}", flush=True)


def _install_mps_conv_fallback():
    """MPS 不支持某些 conv —— 该 op 单独回落 CPU 跑，其余仍在 GPU。

    实测：音频 VAE 的深度可分离卷积
    （weight (64,1,7), groups=64, 输入长 70566）会抛
    「Output channels > 65536 not supported at the MPS device」。
    """
    try:
        import torch
        import torch.nn.functional as F

        if not _mps_available():
            return
        orig_conv1d = F.conv1d
        orig_conv_t = F.conv_transpose1d

        def wrap(orig):
            def patched(input, weight, bias=None, *args, **kwargs):
                try:
                    return orig(input, weight, bias, *args, **kwargs)
                except NotImplementedError:
                    if input.device.type != "mps":
                        raise
                    print(
                        f"[VoiceCraft] MPS 不支持该 conv，回落 CPU: {tuple(input.shape)}",
                        flush=True,
                    )
                    out = orig(
                        input.cpu(),
                        weight.cpu(),
                        bias.cpu() if bias is not None else None,
                        *args,
                        **kwargs,
                    )
                    return out.to(input.device)

            return patched

        F.conv1d = wrap(orig_conv1d)
        F.conv_transpose1d = wrap(orig_conv_t)
        print("[VoiceCraft] MPS conv CPU 兜底已启用", flush=True)
    except Exception as e:
        print(f"[VoiceCraft] MPS conv 兜底未启用：{e}", flush=True)


def _install_mps_bf16_arange_shim():
    """MPS 的 arange 不支持 bfloat16 —— CPU 造好再搬过去。

    症状： "arange_mps" not implemented for 'BFloat16'
    为什么值得开 bf16（实测 M1 / MPS）：float32 0.19x 实时 → bf16 0.32x。
    """
    try:
        import torch

        if not _mps_available():
            return
        orig_arange = torch.arange

        def arange(*args, **kwargs):
            if kwargs.get("dtype") is torch.bfloat16:
                kw = dict(kwargs)
                kw["dtype"] = torch.float32
                out = orig_arange(*args, **kw).to(torch.bfloat16)
                device = kw.get("device")
                return out.to(device) if device is not None else out
            return orig_arange(*args, **kwargs)

        torch.arange = arange
        print("[VoiceCraft] MPS bf16 arange 兜底已启用", flush=True)
    except Exception as e:
        print(f"[VoiceCraft] MPS bf16 arange 兜底未启用：{e}", flush=True)


def optimize_flag(default="1"):
    """torch.compile 只在 CUDA 上能用 → 非 CUDA 必须关。

    XA_VOICECRAFT_OPTIMIZE=0 关掉（macOS 启动脚本就是这么设的）。
    """
    return os.environ.get("XA_VOICECRAFT_OPTIMIZE", default).lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def auto_optimize_flag():
    """按**实际设备**决定要不要开 torch.compile。

    torch.compile 只在 CUDA 上能用 —— MPS / 纯 CPU 上 voxcpm 直接 raise
    「VoxCPMModel can only be optimized on CUDA device」，**模型加载阶段就炸**。

    ⚠ 为什么不能写死：macOS 是 MPS（必须关），Windows 那台是 CUDA（必须开，
      开着稳态 0.87x 实时）。写死一个值就有一头吃亏。
      所以：环境变量显式给了就听它的；否则按 `torch.cuda.is_available()` 判。
    """
    raw = os.environ.get("XA_VOICECRAFT_OPTIMIZE")
    if raw is not None and raw.strip():
        return raw.strip().lower() not in ("0", "false", "no", "off")
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False
