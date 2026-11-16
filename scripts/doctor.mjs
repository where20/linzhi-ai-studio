#!/usr/bin/env node
/**
 * doctor.mjs — 一体化装配自检（只读，不改任何文件）
 *
 * 检查：引擎产物 / 补丁是否生效 / vault 安装一致性 / Key 与面板配置 /
 *       商业元素残留 / ffmpeg / 产物软链 / Web 服务与门禁
 *
 * 用法：npm run doctor
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENGINE_DIR, OUTPUT_DIR, readConfig, resolveVault, pluginDir, dataFile } from '../engine/paths.mjs';

const rows = [];
const add = (status, name, detail) => rows.push({ status, name, detail });
const PASS = '✅', WARN = '⚠️', FAIL = '✘';
const which = (bin) => {
  try {
    return execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

async function main() {
  // ---------- 1. 引擎产物与补丁 ----------
  const mainJs = path.join(ENGINE_DIR, 'main.js');
  if (!fs.existsSync(mainJs)) {
    add(FAIL, '引擎产物', 'engine/main.js 不存在 → 跑 npm run patch');
  } else {
    const src = fs.readFileSync(mainJs, 'utf8');
    const gate = src.includes('isVipActive(){return!0}');
    const adGone = !src.includes('this.adBanner.setState(this.adState),this.adBanner.mount();');
    const vipUi = src.includes('本地完整版：商业门禁已移除');
    add(gate && adGone && vipUi ? PASS : FAIL, '去商业补丁', gate ? `门禁已移除 · 广告${adGone ? '已移除' : '仍在'} · 设置页${vipUi ? '已替换' : '未替换'}` : 'VIP 总闸未打补丁');
    const mb = (fs.statSync(mainJs).size / 1024 / 1024).toFixed(2);
    add(PASS, '引擎体积', `${mb} MB（main.js）`);
  }

  // ---------- 2. vault 安装一致性 ----------
  let vault = null;
  try {
    vault = resolveVault();
    add(PASS, 'vault 定位', vault);
  } catch (e) {
    add(FAIL, 'vault 定位', e.message);
  }

  if (vault && fs.existsSync(mainJs)) {
    const target = pluginDir(vault);
    const installed = ['main.js', 'manifest.json', 'styles.css'].every((f) => {
      const b = path.join(target, f);
      return fs.existsSync(b) && sha(b) === sha(path.join(ENGINE_DIR, f));
    });
    add(installed ? PASS : FAIL, '插件安装', installed ? `已同步到 ${path.basename(target)}/` : '与 engine/ 不一致 → 跑 npm run install');
    const mf = readJson(path.join(target, 'manifest.json'));
    if (mf) add(/本地完整版/.test(mf.name || '') ? PASS : WARN, '插件身份', `${mf.name} v${mf.version}`);
  }

  // ---------- 3. 配置 ----------
  const cfg = readConfig();
  const key = cfg?.ai?.api_key || '';
  add(key ? PASS : FAIL, 'Agnes Key', key ? `${key.slice(0, 6)}…${key.slice(-4)}（已填，是否有效看下面「实测」）` : 'config.json ai.api_key 为空');

  if (vault) {
    const d = readJson(dataFile(vault));
    if (!d) {
      add(FAIL, '插件配置', 'data.json 读取失败 → 跑 npm run sync');
    } else {
      const pk = d.agnesApiKey || '';
      add(pk ? PASS : WARN, '插件 Key', pk ? `已同步 ${pk.slice(0, 6)}…${pk.slice(-4)}` : '未同步 → npm run sync');
      const tabs = Array.isArray(d.visibleTabs) ? d.visibleTabs : [];
      add(tabs.length >= 20 ? PASS : WARN, '面板可见', `${tabs.length}/20${tabs.length < 20 ? ' → npm run sync 拉满' : ''}`);
      add(!d.vip && !d.vipSeal ? PASS : WARN, '商业残留', d.vip || d.vipSeal ? '存在 VIP 激活态（不影响使用，可清）' : '无 VIP 激活态');
      const adUrl = d.adState?.config?.targetUrl || '';
      const adCh = d.adState?.config?.channels?.length ?? 0;
      add(!adUrl && !adCh ? PASS : WARN, '广告位', !adUrl && !adCh ? '已清空' : '仍有赞助链接/渠道');
    }
  }

  // ---------- 4. 运行时依赖 ----------
  const ff = cfg?.local?.ffmpeg_path || '/opt/homebrew/bin/ffmpeg';
  const ffOk = fs.existsSync(ff) || which('ffmpeg');
  add(ffOk ? PASS : WARN, 'ffmpeg', ffOk ? ff : '未找到 → 配音/成片/合成类面板会降级隐藏');

  // ---------- 4.5 免 Key 通道资产 ----------
  const devFile = path.join(OUTPUT_DIR, '.free-device.json');
  try {
    const d = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    add(d?.id ? PASS : WARN, '免 Key 设备', d?.id ? `veda_did=${String(d.id).slice(0, 8)}…（额度池固定）` : '设备标识为空');
  } catch {
    add(WARN, '免 Key 设备', '尚未生成（首次免 Key 视频后自动落盘）');
  }

  const tasksFile = path.join(OUTPUT_DIR, '.video-tasks.json');
  try {
    const arr = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const running = arr.filter((t) => t.status === 'processing').length;
    const done = arr.filter((t) => t.status === 'completed').length;
    add(PASS, '视频任务库', `${arr.length} 条（完成 ${done} / 进行中 ${running}，重启不丢）`);
  } catch {
    add(WARN, '视频任务库', '尚无任务记录（首次生成后自动落盘）');
  }

  // ---------- 4.6 本地分镜工作台 ----------
  const promptLib = path.join(ROOT, 'lib', 'storyboard-prompts.mjs');
  if (fs.existsSync(promptLib)) {
    try {
      const mod = await import('../lib/storyboard-prompts.mjs');
      const heavy = mod.MODES.filter((m) => (m.system || '').length > 1000).length;
      add(mod.MODES.length === 10 ? PASS : WARN, '分镜提示词', `${mod.MODES.length} 种模式（${heavy} 重 / ${mod.MODES.length - heavy} 轻），画幅 ${mod.FRAME_SPEC}`);
    } catch (e) {
      add(FAIL, '分镜提示词', `加载失败：${e.message} → node scripts/extract-prompts.mjs`);
    }
  } else {
    add(FAIL, '分镜提示词', 'lib/storyboard-prompts.mjs 缺失 → node scripts/extract-prompts.mjs');
  }
  const sbDir = path.join(OUTPUT_DIR, 'storyboards');
  try {
    const n = fs.readdirSync(sbDir).filter((f) => f.endsWith('.json')).length;
    add(PASS, '分镜任务库', `${n} 条（output/storyboards/，重启不丢）`);
  } catch {
    add(WARN, '分镜任务库', '尚无记录（首次生成后自动落盘）');
  }

  try {
    const tts = await import('../lib/tts.mjs');
    const cat = tts.voiceCatalog();
    const list = cat.providers.map((x) => {
      const n = (x.voices || []).length;
      if (!x.available) return `${x.id}:不可用`;
      return `${x.id}:${n}音色${x.ready === false ? '(签名过期需升级)' : ''}`;
    });
    const edge = cat.providers.find((x) => x.id === 'edge');
    const say = cat.providers.find((x) => x.id === 'say');
    const voxcpm = cat.providers.find((x) => x.id === 'voxcpm');
    const matrix = cat.providers.find((x) => x.id === 'matrix');
    const okTts = (edge?.available && edge?.ready !== false) || say?.available
      || voxcpm?.available || matrix?.available;
    add(okTts ? PASS : WARN, 'TTS 后端', list.join(' · '));
    if (edge?.available && edge?.ready === false) {
      add(WARN, 'TTS 签名', 'edge-tts 为 v1 签名（微软已废弃）→ python3 -m pip install -U edge-tts');
    }
    // 本机 VoxCPM：离线零 Key + 可克隆音色，是豆包之外最值得装的
    if (voxcpm?.available) {
      const rt = voxcpm.runtime || {};
      add(PASS, 'VoxCPM 运行时', `已就绪（模型 ${path.basename(rt.modelDir || '?')}，首合成约 30s）`);
    } else {
      add(WARN, 'VoxCPM 运行时', (voxcpm?.note || '本机没装 VoxCPM（可选，不影响其他后端）'));
    }
    add(matrix?.available ? PASS : WARN, 'matrix 配音', matrix?.available
      ? '本机 mcode-tools 账号可用，免 Key'
      : '本机找不到 mcode-tools（可选）');
  } catch (e) {
    add(WARN, 'TTS 后端', `探测失败：${e.message}`);
  }

  try {
    const mod = await import('../lib/storyboard-video.mjs');
    const caps = mod.ffmpegCapabilities();
    add(caps.can_burn_subtitles ? PASS : WARN, '字幕烧录', caps.can_burn_subtitles
      ? `libass 可用（${path.basename(caps.subtitle_bin)}）`
      : '系统 ffmpeg 缺 libass；设 FFMPEG_SUBTITLE_PATH 指向 imageio_ffmpeg 静态构建');
  } catch (e) {
    add(WARN, '字幕烧录', `探测失败：${e.message}`);
  }

  const renderDir = path.join(OUTPUT_DIR, 'renders');
  try {
    const arr = fs.readdirSync(renderDir).filter((f) => f.endsWith('.json'));
    add(PASS, '分镜成片', `${arr.length} 条 → output/renders/ 与 output/videos/`);
  } catch {
    add(WARN, '分镜成片', '尚无记录（首次合成后自动落盘）');
  }

  const pipeDir = path.join(OUTPUT_DIR, 'pipelines');
  try {
    const arr = fs.readdirSync(pipeDir).filter((f) => f.endsWith('.json'));
    const done = arr.filter((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(pipeDir, f), 'utf8')).status === 'completed'; } catch { return false; }
    }).length;
    add(PASS, '分镜出图', `${arr.length} 条（完成 ${done}）→ output/pipelines/`);
  } catch {
    add(WARN, '分镜出图', '尚无记录（首次逐镜出图后自动落盘）');
  }

  const link = path.join(OUTPUT_DIR, 'engine');
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      const t = fs.readlinkSync(link);
      add(fs.existsSync(t) ? PASS : FAIL, '产物软链', `output/engine → ${t}${fs.existsSync(t) ? '' : '（目标不存在）'}`);
    } else {
      add(WARN, '产物软链', 'output/engine 是真实目录，Web 与插件产物分开存放');
    }
  } catch {
    add(WARN, '产物软链', '未建立 → npm run sync');
  }

  // ---------- 5. Web 服务 ----------
  const port = process.env.PORT || 3721;
  let online = false;
  try {
    const gate = await (await fetch(`http://127.0.0.1:${port}/api/member/gate`)).json();
    online = true;
    add(gate?.unlocked ? PASS : FAIL, 'Web 门禁', `unlocked=${gate?.unlocked} gate=${gate?.gate}（会员校验已拆除）`);
  } catch {
    add(WARN, 'Web 服务', `端口 ${port} 未监听 → npm start`);
  }
  if (online) {
    try {
      const c = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
      add(c?.api_key_set ? PASS : WARN, 'Web 配置中心', c?.api_key_set ? `Key 已就绪，文本模型 ${c.default_text_model || '默认'}` : '未读到 Key');
    } catch {
      add(WARN, 'Web 配置中心', '/api/config 无响应');
    }
  }

  // ---------- 6. 免 Key 通道联网探活（--online 才跑，约 5s）----------
  if (process.argv.includes('--online')) {
    // Agnes Key 是否真好用（只看"有没有填"会误判 —— 失效的 Key 也是非空）
    try {
      const mod = await import('../lib/agnes-client.mjs');
      const client = new mod.AgnesClient({
        apiKey: cfg?.ai?.api_key || '',
        baseUrl: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
        timeoutMs: 20000,
      });
      const res = await client.verifyCredentials({});
      if (res && res.ok) add(PASS, 'Agnes 实测', `Key 可用（${res.latencyMs}ms）`);
      else add(WARN, 'Agnes 实测', `${String(res?.reason || '不可用').slice(0, 70)} → 已自动回落免 Key`);
    } catch (e) {
      add(WARN, 'Agnes 实测', `${String(e?.message || e).slice(0, 70)} → 已自动回落免 Key`);
    }

    try {
      const mod = await import('../lib/free-providers.mjs');
      const veda = mod.makeVeda(mod.ENDPOINTS.veda, mod.makeDeviceStore(path.join(OUTPUT_DIR, '.free-device.json')));
      const [txt, quota, health] = await Promise.allSettled([
        mod.pollinationsText({ messages: [{ role: 'user', content: '只回复 OK' }], maxTokens: 8 }),
        veda.quota(),
        veda.probe(),
      ]);
      add(txt.status === 'fulfilled' ? PASS : FAIL, '免 Key 文本', txt.status === 'fulfilled' ? `Pollinations 正常（样例「${String(txt.value.content).slice(0, 12)}」）` : `Pollinations 失败：${txt.reason?.message}`);
      if (quota.status === 'fulfilled' && quota.value) {
        const q = quota.value;
        add(q.remaining > 0 ? PASS : WARN, 'Veda 配额', `剩余 ${q.remaining}/${q.limit} 点${q.remaining === 0 ? ' → 今日额度已用尽' : ''}`);
      } else {
        add(WARN, 'Veda 配额', '查询失败（站点可能限流）');
      }
      if (health.status === 'fulfilled') {
        const h = health.value;
        add(h.online ? PASS : WARN, 'Veda 服务', h.online ? `在线 · 队列 ${h.queueLen} · 空槽 ${h.slotsFree} · 预计等待 ${Math.round(h.waitSec)}s` : `离线：${h.note || '无响应'}`);
      }
    } catch (e) {
      add(WARN, '免 Key 探活', `跳过：${e.message}`);
    }
  }

  // ---------- 输出 ----------
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log('\n\x1b[1m临智 AI Studio · 本地一体化自检\x1b[0m\n');
  for (const r of rows) console.log(`  ${r.status} ${pad(r.name, 12)} ${r.detail}`);
  const fail = rows.filter((r) => r.status === FAIL).length;
  const warn = rows.filter((r) => r.status === WARN).length;
  console.log(`\n  合计 ${rows.length} 项：${rows.length - fail - warn} 通过，${warn} 提醒，${fail} 失败`);
  console.log('  一键修复：npm run setup（补丁 + 安装 + 同步）\n');
  process.exit(fail ? 1 : 0);
}

main();
