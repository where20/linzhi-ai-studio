#!/usr/bin/env node
/**
 * sync-config.mjs — 单一配置真源：config.json(ai) → 插件 data.json
 *
 * 做三件事：
 *   1. Key / 模型 单向同步（config.json 为准，插件里已有的其他字段全保留）
 *   2. visibleTabs 拉满 20 个面板（否则 VIP 面板解锁了也不显示）
 *   3. 产物目录打通：vault 内的 outputFolder ←→ 本项目 output/engine 软链
 *
 * 用法：node engine/sync-config.mjs [--no-link] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, resolveVault, dataFile, OUTPUT_DIR, stamp } from './paths.mjs';

const NO_LINK = process.argv.includes('--no-link');
const DRY = process.argv.includes('--dry');

/** 全部面板（顺序即 UI 顺序，取自插件 rs 常量） */
const ALL_TABS = [
  'text', 'image', 'video', 'tts', 'cover', 'drama', 'pro', 'anchor', 'mtv',
  'dancer', 'explain', 'broll', 'inkos', 'whiteboard', 'canvas',
  'gallery', 'reference', 'cast', 'zhiguai', 'log',
];

/** config.json 的 ai 字段 → 插件设置字段 */
const KEY_MAP = {
  api_key: 'agnesApiKey',
  sensenova_api_key: 'sensenovaApiKey',
  deepseek_api_key: 'deepseekApiKey',
  doubao_api_key: 'doubaoApiKey',
  qwen_api_key: 'qwenApiKey',
  minimax_api_key: 'minimaxApiKey',
  default_text_model: 'defaultTextModel',
  default_image_model: 'defaultImageModel',
  default_video_model: 'defaultVideoModel',
};

const mask = (v) => (typeof v === 'string' && v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

/** 目标 data.json 缺失/过薄时，从 vault 里被归档的旧版插件捞回一份完整设置当底稿 */
function findLegacyData(vault) {
  const root = path.join(vault, '.obsidian', 'plugins');
  const hits = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const probe = (p) => {
    if (!fs.existsSync(p)) return;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && typeof j === 'object') hits.push({ p, n: Object.keys(j).length, m: fs.statSync(p).mtimeMs });
    } catch {
      /* 坏文件跳过 */
    }
  };
  for (const d of dirs) {
    if (d === 'free-ai-studio') continue;
    if (d.startsWith('.legacy-') || d.startsWith('.backup-')) {
      // .legacy-<ts>/<原名>/data.json
      const sub = path.join(root, d);
      for (const e of fs.readdirSync(sub, { withFileTypes: true })) {
        if (e.isDirectory()) probe(path.join(sub, e.name, 'data.json'));
        else if (e.name === 'data.json') probe(path.join(sub, e.name));
      }
      // .backup-free-ai-studio-<ts>/data.json
      probe(path.join(sub, 'data.json'));
    } else {
      probe(path.join(root, d, 'data.json'));
    }
  }
  hits.sort((a, b) => b.n - a.n || b.m - a.m);
  return hits[0]?.p ?? null;
}

function main() {
  const cfg = readConfig();
  const ai = cfg.ai || {};
  const local = cfg.local || {};
  const vault = resolveVault();
  const file = dataFile(vault);

  const changed = [];

  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`✘ data.json 解析失败：${e.message}`);
      process.exit(1);
    }
  }

  // 新建的 data.json 往往只有几个字段 —— 从归档的旧版插件捞回完整设置，避免丢用户配置
  if (Object.keys(data).length < 10) {
    const legacy = findLegacyData(vault);
    if (legacy) {
      try {
        const base = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        if (Object.keys(base).length > Object.keys(data).length) {
          data = { ...base, ...data };
          changed.push(`底稿取自旧版设置：${legacy}（${Object.keys(base).length} 个字段）`);
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  for (const [src, dst] of Object.entries(KEY_MAP)) {
    const v = ai[src];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (data[dst] === v) continue;
    data[dst] = v;
    changed.push(`${dst} = ${mask(v)}`);
  }

  // 面板全开（去商业化后 VIP 面板应可见）
  const cur = Array.isArray(data.visibleTabs) ? data.visibleTabs : [];
  const merged = [...new Set([...ALL_TABS, ...cur])].filter((t) => ALL_TABS.includes(t));
  const tabsSame = cur.length === ALL_TABS.length && ALL_TABS.every((t) => cur.includes(t));
  if (!tabsSame) {
    data.visibleTabs = ALL_TABS;
    changed.push(`visibleTabs = ${ALL_TABS.length} 个面板（原 ${cur.length}）`);
  }

  // 广告配置清零（配合 patch.mjs 的 tryShowAd 短路，双重保证不出现任何商业元素）
  const adClean = JSON.stringify(data.adState ?? null);
  const adTarget = JSON.stringify({ config: { messageKey: 'ad.message', targetUrl: '', channels: [] }, lastShownAt: 0 });
  if (data.adState && adClean !== adTarget) {
    data.adState = { config: { messageKey: 'ad.message', targetUrl: '', channels: [] }, lastShownAt: 0 };
    changed.push('adState 已清空（目标链接/渠道列表）');
  }

  const outFolder = local.engine_output_folder || data.outputFolder || '_Agnes';
  if (data.outputFolder !== outFolder) {
    data.outputFolder = outFolder;
    changed.push(`outputFolder = ${outFolder}`);
  }

  if (!DRY) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak-${stamp()}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }

  console.log(`✅ 配置同步${DRY ? '（演练，未写盘）' : ''} → ${file}`);
  if (changed.length) changed.forEach((s) => console.log(`   · ${s}`));
  else console.log('   · 无变化（已是最新）');

  // 产物目录打通：<vault>/<outFolder> ←→ output/engine
  const vaultOut = path.join(vault, outFolder);
  if (outFolder.startsWith('/') || outFolder.includes('..')) {
    console.log('   产物目录为绝对路径/含 ..，跳过软链（Obsidian 只写 vault 内相对路径）');
    return;
  }
  fs.mkdirSync(vaultOut, { recursive: true });

  const link = path.join(OUTPUT_DIR, 'engine');
  if (NO_LINK) {
    console.log(`   跳过软链（--no-link）。如需打通：ln -s "${vaultOut}" "${link}"`);
    return;
  }
  try {
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      const curTarget = fs.readlinkSync(link);
      if (curTarget === vaultOut) {
        console.log(`   · 软链已就绪：output/engine → ${vaultOut}`);
        return;
      }
      fs.unlinkSync(link);
    } else if (st) {
      console.log(`   · output/engine 已存在且非软链，跳过（不覆盖已有目录）`);
      return;
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.symlinkSync(vaultOut, link);
    console.log(`   · 已建软链：output/engine → ${vaultOut}（Web 端 /output/engine/* 可见插件产物）`);
  } catch (e) {
    console.log(`   · 软链失败（${e.code || e.message}），两套产物目录独立：${vaultOut}`);
  }
}

main();
