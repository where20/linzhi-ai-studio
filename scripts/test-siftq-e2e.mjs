/**
 * SiftQ 免账号 MiniMax-H3 通道端到端自测
 * 用法：node scripts/test-siftq-e2e.mjs <输入图路径>
 * 无参数时自动用本地样例图（不存在则报错）
 */
import fs from "node:fs/promises";
import path from "node:path";
import { makeSiftq, makeSiftqDeviceStore } from "../lib/siftq-client.mjs";

const IMAGE = process.argv[2] || "/tmp/sq_input.jpg";

const store = makeSiftqDeviceStore(
    path.join(process.cwd(), "output", ".siftq-device.json"),
);
const siftq = makeSiftq({ deviceStore: store });

console.log("=== 1. 额度 ===");
console.log(await siftq.usage());

console.log("=== 2. 能力 ===");
console.log(await siftq.capabilities());

console.log("=== 3. 提交（图生视频）===");
const sub = await siftq.submit({
    image: IMAGE,
    prompt: "Animate the scene in the image with natural, faithful motion. Keep the subject and setting consistent with the input image.",
    ratio: "9:16",
    duration: 6,
});
console.log("submitted:", JSON.stringify(sub, null, 1));

console.log("=== 4. 轮询 ===");
const snap = await siftq.waitFor(sub.task_id, sub.access_token, {
    timeoutMs: 15 * 60_000,
    intervalMs: 10_000,
    onProgress: (s) => console.log("  ", JSON.stringify({ status: s.status, queue: s.queuePosition, active: s.activeCount })),
});
console.log("最终状态:", snap.status);

if (snap.status === "succeeded") {
    const bytes = await siftq.contentBytes(sub.task_id, sub.access_token);
    const out = path.join(process.cwd(), "output", "videos", `siftq-${sub.task_id}.mp4`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, bytes);
    console.log(`✅ 视频下载成功: ${bytes.length} bytes → ${out}`);
} else {
    console.log("⚠️ 未出片");
}

console.log("=== 5. 额度复核 ===");
console.log(await siftq.usage());
