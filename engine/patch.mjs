#!/usr/bin/env node
/**
 * patch.mjs — 拆除 Free AI Studio 的商业模型（幂等）
 *
 * 做什么：
 *   1. isVipActive() 恒 true  → 红果Pro / 数字人 / 封面 / 跳舞 / B-roll / InkOS / 无限画布 /
 *      edge-tts / 8 语种 全部解锁（这些门禁在 bundle 里全部收敛到这一个方法）
 *   2. tryShowAd() 直接返回 → 广告位永不弹出
 *   3. 广告横幅不再挂载 DOM → 页面上没有「赞助作者」条
 *   4. 设置页 VIP 激活码区 → 换成「本地完整版」说明
 *   5. 移除子命令名里的「（VIP）」后缀
 *
 * 输入：engine/vendor/main.js（上游原始产物，只读）
 * 输出：engine/main.js + engine/manifest.json + engine/styles.css + engine/versions.json
 *
 * 用法：node engine/patch.mjs [--check]
 *   --check 只校验不改写（CI/自检用），补丁未生效时退出码 1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(__dirname, 'vendor');
const OUT = __dirname;
const CHECK_ONLY = process.argv.includes('--check');

const TARGET = 'main.js';

/** 每条补丁：find 必须命中，replace 后必须与原文不同 */
const PATCHES = [
  {
    id: 'vip-unlock',
    desc: 'VIP 门禁总闸 → 恒真',
    find: 'isVipActive(){return this.vipState?.active===!0}',
    replace: 'isVipActive(){return!0}',
  },
  {
    id: 'ad-popup',
    desc: '广告弹层 → 短路',
    find: 'async tryShowAd(){let t=this.vipState?.active===!0;',
    replace: 'async tryShowAd(){return;let t=this.vipState?.active===!0;',
  },
  {
    id: 'ad-mount',
    desc: '广告横幅 → 不挂载',
    find: 'this.adBanner.setState(this.adState),this.adBanner.mount();',
    replace: 'this.adBanner.setState(this.adState);',
  },
  {
    id: 'vip-settings-ui',
    desc: '设置页 VIP 激活区 → 本地版说明',
    find: 'vipStatusSection(){let t=this.plugin.isVipActive(),i=this.plugin.vipState?.active===!0?this.plugin.vipState:null,',
    replace:
      'vipStatusSection(){new $.Setting(this.containerEl).setName("授权状态")' +
      '.setDesc("本地完整版：商业门禁已移除，全部面板与设置项直接可用（无需激活码、无广告、无联网校验）。");return;let t=this.plugin.isVipActive(),i=this.plugin.vipState?.active===!0?this.plugin.vipState:null,',
  },
  {
    id: 'vip-command-suffix',
    desc: '命令名去掉（VIP）后缀',
    find: 'name:s?o:`${o} ${a("vip.gate.suffix")}`',
    replace: 'name:s?o:o',
  },
];

function fatal(msg) {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

/** 读取源：优先 vendor 原始件；已打补丁时回退到上一版产物（保证可重复执行） */
function pickSource() {
  const vendorPath = path.join(VENDOR, TARGET);
  if (!fs.existsSync(vendorPath)) fatal(`缺少上游原始产物：${vendorPath}`);
  return fs.readFileSync(vendorPath, 'utf8');
}

function main() {
  const src = pickSource();
  let out = src;
  const applied = [];
  const already = [];

  for (const p of PATCHES) {
    const hit = out.includes(p.find);
    const done = out.includes(p.replace);
    if (done && !hit) {
      already.push(p);
      continue;
    }
    if (!hit) {
      fatal(`补丁 [${p.id}] 目标串未命中 —— 上游版本可能已变更（${p.desc}）`);
    }
    out = out.split(p.find).join(p.replace);
    applied.push(p);
  }

  // 校验：解锁总闸必须存在
  const gateOk = out.includes('isVipActive(){return!0}');
  const adOk = !out.includes('this.adBanner.setState(this.adState),this.adBanner.mount();');

  if (CHECK_ONLY) {
    const ok = gateOk && adOk;
    console.log(`${ok ? '✅' : '✘'} 补丁状态：门禁=${gateOk ? '已移除' : '仍在'}，广告=${adOk ? '已移除' : '仍在'}`);
    console.log(`   已应用 ${PATCHES.length - already.length} 条，已处于目标态 ${already.length} 条`);
    process.exit(ok ? 0 : 1);
  }

  if (!applied.length) {
    console.log(`✅ 全部 ${PATCHES.length} 条补丁已处于目标态，无需改写`);
  } else {
    for (const p of applied) console.log(`  ✔ [${p.id}] ${p.desc}`);
  }

  // 产物落盘：main.js 打补丁，其余原样复制
  fs.writeFileSync(path.join(OUT, TARGET), out);
  for (const f of ['styles.css', 'versions.json']) {
    fs.copyFileSync(path.join(VENDOR, f), path.join(OUT, f));
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'manifest.json'), 'utf8'));
  manifest.name = 'Free AI Studio · 本地完整版';
  manifest.description =
    '本地完整版（商业门禁已移除）：文本 / 图片 / 视频 / 配音 / 短剧 / 数字人 / 封面 / B-roll / InkOS / 无限画布全解锁，产物写入 Vault。桌面端专用。';
  manifest._localPatch = {
    by: 'linzhi-ai-studio',
    patches: PATCHES.map((p) => p.id),
    note: '上游升级后重跑 node engine/patch.mjs 即可',
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');

  const kb = (fs.statSync(path.join(OUT, TARGET)).size / 1024 / 1024).toFixed(2);
  console.log(`\n✅ 产物已生成：engine/{main.js (${kb} MB), manifest.json, styles.css, versions.json}`);
  console.log(`   已应用 ${applied.length} 条 / 已在目标态 ${already.length} 条`);
}

main();
