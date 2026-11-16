#!/usr/bin/env node
/**
 * start-all.mjs — 一条命令把「本地一体化」全部拉起来
 *
 *   ① patch      engine/vendor → engine/（去商业补丁，幂等）
 *   ② install    engine/ → Obsidian vault（产物有变化才覆盖，自动备份）
 *   ③ sync       config.json(ai) → 插件 data.json（Key / 20 面板 / 产物目录）
 *   ④ serve      Web 壳起在 PORT（默认 3721），并做门禁自检
 *
 * 用法：npm run all          常驻启动
 *      npm run setup        只跑 ①②③ 不启动 Web
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENGINE_DIR, PLUGIN_ID, resolveVault, pluginDir } from '../engine/paths.mjs';

const SETUP_ONLY = process.argv.includes('--setup-only');
const PORT = process.env.PORT || 3721;

const step = (n, s) => console.log(`\n\x1b[1m[${n}/4]\x1b[0m ${s}`);
const ok = (s) => console.log(`  ✅ ${s}`);
const info = (s) => console.log(`     ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);

function run(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (r.status !== 0) {
    if (out) console.error(out);
    console.error(r.stderr || '');
    throw new Error(`${path.basename(script)} 失败（退出码 ${r.status}）`);
  }
  if (out) console.log(out.split('\n').map((l) => `     ${l}`).join('\n'));
  return out;
}

function sha(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function engineDirty(vault) {
  const target = pluginDir(vault);
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    const a = path.join(ENGINE_DIR, f);
    const b = path.join(target, f);
    if (!fs.existsSync(b)) return true;
    if (sha(a) !== sha(b)) return true;
  }
  return false;
}

async function waitHealth(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/member/gate`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function main() {
  console.log('\x1b[1m临智 AI Studio · 本地一体化\x1b[0m  (Web 壳 + Obsidian 引擎，商业门禁已移除)');

  // ① patch
  step(1, '去商业补丁：engine/vendor → engine/');
  run(path.join('engine', 'patch.mjs'));

  // ② install
  step(2, '安装引擎到 Obsidian vault');
  const vault = resolveVault();
  info(`vault: ${vault}`);
  if (engineDirty(vault)) {
    run(path.join('engine', 'install.mjs'));
  } else {
    ok('vault 内插件已是最新产物，跳过覆盖');
  }

  // ③ sync
  step(3, '同步配置（单一真源 config.json）');
  run(path.join('engine', 'sync-config.mjs'));

  if (SETUP_ONLY) {
    console.log('\n✅ 装配完成（--setup-only）。启动 Web：npm start');
    return;
  }

  // ④ serve + 自检
  step(4, '启动 Web 壳');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });

  const gate = await waitHealth(PORT);
  if (gate?.unlocked) {
    ok(`Web 就绪：http://localhost:${PORT}（门禁 unlocked=${gate.unlocked}，无会员校验）`);
  } else {
    warn(`Web 未在 ${PORT} 响应，检查端口占用或看上方日志`);
  }
  console.log(`
  ┌─ 两个入口，一套配置 ────────────────────────────────
  │ Web 壳     http://localhost:${PORT}
  │ Obsidian   ✨ 图标 → Free AI Studio · 本地完整版
  │ 产物       ${path.join('output')}/ ←→ vault/${fs.existsSync(path.join(ROOT, 'output', 'engine')) ? '（engine 子目录已打通）' : '（未打通）'}
  │ 配置       config.json（改完重跑 npm run sync）
  └────────────────────────────────────────────────────`);

  const stop = () => {
    child.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(`\n✘ ${e.message}`);
  process.exit(1);
});
