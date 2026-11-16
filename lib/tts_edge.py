#!/usr/bin/env python3
"""
tts_edge.py — edge-tts 桥接（由 lib/tts.mjs 调用）

为什么要这层：edge-tts 的签名逻辑（Sec-MS-GEC v2）只有官方 Python 包跟得最紧。
插件当年是逆向重实现的，这里直接用 pip 包，省事且随上游升级。

用法：
    echo '{"text":"...","voice":"zh-CN-YunxiNeural","rate":"+0%","pitch":"+0Hz","out":"/tmp/a.mp3"}' \
      | python3 tts_edge.py
输出：一行 JSON {ok, out, error}
"""
import asyncio
import json
import sys


def main() -> None:
    try:
        raw = sys.stdin.read() or "{}"
        cfg = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad args: {exc}"}, ensure_ascii=False))
        return

    text = str(cfg.get("text") or "").strip()
    if not text:
        print(json.dumps({"ok": False, "error": "empty text"}, ensure_ascii=False))
        return

    try:
        import edge_tts
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"edge_tts import failed: {exc}"}, ensure_ascii=False))
        return

    voice = cfg.get("voice") or "zh-CN-YunxiNeural"
    rate = cfg.get("rate") or "+0%"
    pitch = cfg.get("pitch") or "+0Hz"
    out = cfg.get("out")

    async def run() -> None:
        comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        await comm.save(out)

    try:
        asyncio.run(run())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return

    print(json.dumps({"ok": True, "out": out, "voice": voice}, ensure_ascii=False))


if __name__ == "__main__":
    main()
