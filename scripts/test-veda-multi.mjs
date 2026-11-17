/**
 * Veda 指纹池连续生成验证
 * 用法：node scripts/test-veda-multi.mjs [条数]
 *
 * 验证目标：每个指纹发 1 条就换新指纹，N 条任务能否全部提交成功（额度不撞墙）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { VedaFingerprintPool } from "../lib/veda-fingerprint-pool.mjs";
import { makeVeda, makeDeviceStore } from "../lib/free-providers.mjs";

const N = Number(process.argv[2] || 3);
const OUT = path.join(process.cwd(), "output", "videos");
const pool = new VedaFingerprintPool({
    size: 2,
    perPool: 1,                       // 每指纹 1 条即换新
    persistFile: path.join(process.cwd(), "output", ".veda-fingerprints.json"),
});
const veda = makeVeda(undefined, makeDeviceStore(path.join(process.cwd(), "output", ".free-device.json")), {
    fingerprintPool: pool,
});

const PROMPTS = [
    "integrated_multimodal_description: [Shot 1] A hot air balloon rising over green hills at dawn, slow tilt up following the balloon, mist in the valleys, warm first light\noverall_soundscape: Distant burner hiss, birdsong below, soft morning wind, no voices\nnon_diegetic_music: A hopeful orchestral swell with strings and light percussion, building gently",
    "integrated_multimodal_description: [Shot 1] A bustling night market in Taipei, handheld camera weaving between stalls, neon reflections on wet ground, steam and colorful lights\noverall_soundscape: Crowd chatter, sizzling food, motorbikes passing, no distinct voices\nnon_diegetic_music: A lively electronic beat with a bright synth melody, energetic and playful",
    "integrated_multimodal_description: [Shot 1] An old fisherman mending nets on a wooden dock, slow dolly in, golden afternoon light, gentle water movement\noverall_soundscape: Water lapping against wood, ropes creaking, distant gulls, no voices\nnon_diegetic_music: A soft acoustic guitar and light strings, nostalgic and warm",
];

const jobs = [];
console.log(`=== 连续提交 ${N} 条（每指纹 1 条即换新）===`);

for (let i = 0; i < N; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    try {
        const sub = await veda.submit({ prompt, durationSec: 5, aspect: "16:9", mode: "raw" });
        jobs.push(sub);
        console.log(`  [${i + 1}] ✅ job=${sub.jobId} pool=#${sub.poolId} quota=${JSON.stringify(sub.quota?.remaining ?? "?")}`);
    } catch (e) {
        console.log(`  [${i + 1}] ❌ 提交失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n=== 池状态（${jobs.length} 个任务用了 ${new Set(jobs.map((j) => j.poolId)).size} 个不同池）===`);
console.table(await pool.snapshot());

console.log("=== 等待出片 ===");
const done = [];
for (const j of jobs) {
    let snap;
    for (let i = 0; i < 60; i++) {
        try {
            snap = await veda.poll(j.jobId);
        } catch (e) {
            snap = { status: "failed", error: e.message };
        }
        if (["done", "failed", "cancelled"].includes(snap.status)) break;
        await new Promise((r) => setTimeout(r, 10000));
    }
    if (snap.status === "done") {
        try {
            const buf = await veda.fetchVideoBytes(j.jobId);
            const name = `veda_pool_${j.poolId}_${j.jobId.slice(-6)}.mp4`;
            await fs.mkdir(OUT, { recursive: true });
            await fs.writeFile(path.join(OUT, name), buf);
            console.log(`  ✅ ${j.jobId} → ${name} (${buf.length} bytes)`);
            done.push(name);
        } catch (e) {
            console.log(`  ❌ 下载失败 ${j.jobId}: ${e.message}`);
        }
    } else {
        console.log(`  ❌ ${j.jobId} 状态=${snap.status} ${snap.error || ""}`);
    }
}

console.log(`\n=== 结果：提交 ${jobs.length} / 出片 ${done.length} ===`);
if (done.length) console.log("产物:", done.join(", "));
