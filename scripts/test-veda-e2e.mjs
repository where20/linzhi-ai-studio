/**
 * Veda 免 Key 通道端到端自测
 * 用法：node scripts/test-veda-e2e.mjs [池数量]
 */
import fs from "node:fs/promises";
import { VedaFingerprintPool } from "../lib/veda-fingerprint-pool.mjs";
import { makeVeda, makeDeviceStore } from "../lib/free-providers.mjs";

const POOL_SIZE = Number(process.argv[2] || 2);

const PROMPT = [
    "integrated_multimodal_description: [Shot 1] A lone boat drifting on a misty lake at dawn, camera slowly pushes toward the boat, thin fog drifting over the water surface, soft golden light breaking through the mist",
    "overall_soundscape: Gentle water lapping against the hull, distant birdsong, thin wind over the reeds, no voices",
    "non_diegetic_music: A sparse solo piano melody, calm and spacious, fading gently at the end",
].join("\n");

const pool = new VedaFingerprintPool({
    size: POOL_SIZE,
    persistFile: "/tmp/veda-fp-e2e.json",
});
const veda = makeVeda(undefined, makeDeviceStore("/tmp/veda-dev-e2e.json"), { fingerprintPool: pool });

console.log("=== 1. 池快照 ===");
console.table(await pool.snapshot());

console.log("=== 2. 额度汇总 ===");
console.log(await veda.quota());

console.log("=== 3. 提交 ===");
const sub = await veda.submit({ prompt: PROMPT, durationSec: 5, aspect: "16:9", mode: "raw" });
console.log("submitted:", JSON.stringify(sub));

console.log("=== 4. 轮询 ===");
let snap;
for (let i = 0; i < 45; i++) {
    snap = await veda.poll(sub.jobId);
    if (i % 5 === 0 || snap.status !== "queued") {
        console.log(`  [${i}]`, JSON.stringify({ status: snap.status, progress: snap.progress }));
    }
    if (["done", "failed", "cancelled"].includes(snap.status)) break;
    await new Promise((r) => setTimeout(r, 8000));
}
console.log("最终状态:", snap.status, snap.error || "");

if (snap.status === "done") {
    const buf = await veda.fetchVideoBytes(sub.jobId);
    await fs.writeFile("/tmp/veda_e2e.mp4", buf);
    console.log("✅ 视频下载成功:", buf.length, "bytes → /tmp/veda_e2e.mp4");
} else {
    console.log("⚠️ 未出片（可能槽位满 / 排队中）");
}

console.log("=== 5. 池状态（用量应已 +1）===");
console.table(await pool.snapshot());
