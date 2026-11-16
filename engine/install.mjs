#!/usr/bin/env node
/**
 * install.mjs — 把去商业版插件装进 Obsidian vault
 *
 * 步骤：解析 vault → 校验引擎产物 → 备份旧版 → 复制 4 个文件 → 写入启用列表 → 处理同名重复插件
 *
 * 用法：
 *   node engine/install.mjs                # 安装/覆盖，备份旧版
 *   node engine/install.mjs --keep-legacy  # 不动 vault 里其他同 id 的旧插件目录
 *   OBSIDIAN_VAULT="/path/to/vault" node engine/install.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_DIR, VENDOR_DIR, PLUGIN_ID, resolveVault, pluginDir, stamp } from './paths.mjs';

const KEEP_LEGACY = process.argv.includes('--keep-legacy');
const FILES = ['main.js', 'manifest.json', 'styles.css', 'versions.json'];

const c = {
  ok: (s) => console.log(`✅ ${s}`),
  info: (s) => console.log(`   ${s}`),
  warn: (s) => console.log(`⚠️  ${s}`),
  bad: (s) => console.error(`✘ ${s}`),
};

function ensureArtifacts() {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(ENGINE_DIR, f)));
  if (missing.length) {
    c.bad(`engine/ 缺产物：${missing.join(', ')}`);
    c.info('先跑：node engine/patch.mjs（从 engine/vendor/ 上游产物生成）');
    process.exit(1);
  }
}

/** 把旧版插件文件复制到自定义备份目录（不删除、不移动原文件） */
function backupExisting(dir, vault, tag) {
  if (!fs.existsSync(dir)) return null;
  const hasPayload = FILES.some((f) => fs.existsSync(path.join(dir, f)));
  if (!hasPayload) return null;
  const dest = path.join(vault, '.obsidian', 'plugins', `.backup-${PLUGIN_ID}-${tag}`);
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const s = path.join(dir, f);
    if (!fs.statSync(s).isFile()) continue;
    fs.copyFileSync(s, path.join(dest, f));
    n += 1;
  }
  return n ? dest : null;
}

/** 找 plugins 目录下其他 manifest.id 相同的目录（旧版解压目录，常见 xxx-main） */
function findDuplicates(pluginsRoot, target) {
  const out = [];
  for (const e of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(pluginsRoot, e.name);
    if (path.resolve(p) === path.resolve(target)) continue;
    const mf = path.join(p, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    try {
      if (JSON.parse(fs.readFileSync(mf, 'utf8')).id === PLUGIN_ID) out.push(p);
    } catch {
      /* 损坏的 manifest 忽略 */
    }
  }
  return out;
}

function setEnabled(file) {
  let list = [];
  if (fs.existsSync(file)) {
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
  }
  if (list.includes(PLUGIN_ID)) return false;
  list.push(PLUGIN_ID);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  return true;
}

function main() {
  ensureArtifacts();
  const vault = resolveVault();
  const target = pluginDir(vault);
  const pluginsRoot = path.dirname(target);
  const tag = stamp();

  c.ok(`vault: ${vault}`);
  c.info(`目标目录: ${target}`);

  // 1) 旧版备份
  const bak = backupExisting(target, vault, tag);
  if (bak) c.info(`旧版已备份 → ${bak}`);

  // 2) 同名重复插件（同 manifest.id 的其他目录）：搬进隐藏归档目录，不再被 Obsidian 加载
  const dups = findDuplicates(pluginsRoot, target);
  if (dups.length) {
    if (KEEP_LEGACY) {
      c.warn(`存在 ${dups.length} 个同 id 旧插件目录，已按 --keep-legacy 保留（可能与本插件冲突）：`);
      dups.forEach((d) => c.info(`  - ${d}`));
    } else {
      const archive = path.join(pluginsRoot, `.legacy-${tag}`);
      fs.mkdirSync(archive, { recursive: true });
      for (const d of dups) {
        const dest = path.join(archive, path.basename(d));
        fs.renameSync(d, dest);
        c.info(`旧插件归档（可还原）: ${d} → ${dest}`);
      }
    }
  }

  // 3) 写入产物
  fs.mkdirSync(target, { recursive: true });
  for (const f of FILES) {
    fs.copyFileSync(path.join(ENGINE_DIR, f), path.join(target, f));
  }
  c.ok(`已写入 ${FILES.length} 个文件 → ${target}`);

  // 4) 启用
  const enabled = setEnabled(path.join(vault, '.obsidian', 'community-plugins.json'));
  c.info(enabled ? '已加入 community-plugins.json 启用列表' : '启用列表已包含 free-ai-studio');

  // 5) 提示
  console.log(`
下一步（二选一）：
  · Obsidian 已开着 → 设置 → 第三方插件 → 关闭再开启「Free AI Studio · 本地完整版」
  · 或重启 Obsidian，左侧栏 ✨ 图标打开工作台

若要还原：把 .obsidian/plugins/.backup-${PLUGIN_ID}-${tag}/ 里的文件拷回 ${target} 即可`);
}

main();
