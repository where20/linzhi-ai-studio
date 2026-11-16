/**
 * paths.mjs — 统一路径解析（engine 与 scripts 共用）
 *
 * Vault 解析优先级：环境变量 OBSIDIAN_VAULT → config.json 的 local.vault_path → 自动探测
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_DIR = path.join(ROOT, 'engine');
export const VENDOR_DIR = path.join(ENGINE_DIR, 'vendor');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const CONFIG_FILE = path.join(ROOT, 'config.json');

export const PLUGIN_ID = 'free-ai-studio';

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** 探测常见位置的 Obsidian vault（含 .obsidian 目录） */
export function detectVaults() {
  const roots = [
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    os.homedir(),
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(root, e.name);
      if (fs.existsSync(path.join(p, '.obsidian'))) found.push(p);
    }
  }
  return [...new Set(found)];
}

export function resolveVault() {
  if (process.env.OBSIDIAN_VAULT) {
    const p = process.env.OBSIDIAN_VAULT.replace(/^~(?=$|\/)/, os.homedir());
    if (!fs.existsSync(path.join(p, '.obsidian'))) {
      throw new Error(`OBSIDIAN_VAULT 指向的不是 vault（缺 .obsidian）：${p}`);
    }
    return p;
  }
  const cfgVault = readConfig()?.local?.vault_path;
  if (cfgVault) {
    const p = cfgVault.replace(/^~(?=$|\/)/, os.homedir());
    if (fs.existsSync(path.join(p, '.obsidian'))) return p;
    throw new Error(`config.json local.vault_path 无效（缺 .obsidian）：${p}`);
  }
  const found = detectVaults();
  if (!found.length) throw new Error('未找到 Obsidian vault，请设置 OBSIDIAN_VAULT 或 config.json 的 local.vault_path');
  if (found.length > 1) {
    console.warn(`⚠️ 发现多个 vault，使用第一个：${found[0]}`);
    console.warn(`   其他候选：\n${found.slice(1).map((v) => '   - ' + v).join('\n')}`);
    console.warn('   如需指定：OBSIDIAN_VAULT="/path/to/vault" node engine/install.mjs');
  }
  return found[0];
}

export function pluginDir(vault) {
  return path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
}

export function dataFile(vault) {
  return path.join(pluginDir(vault), 'data.json');
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
