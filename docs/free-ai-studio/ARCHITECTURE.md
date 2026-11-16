# 装配架构 · Free AI Studio 本地全栈复刻

> 配套文档：`../REA-REPORT.md`
> 目标：把 Obsidian 插件（21 面板 / 7 流水线 / 8 厂商 / 4 TTS 引擎）复刻为**本地全栈应用**，
> 同时**保留原有 Obsidian 插件形态**。

---

## 1 · 核心判断

**95% 的业务代码与 Obsidian 无关。**

```
Obsidian 依赖调用总数 331
├─ .vault.adapter.*      168  ┐
├─ .app.vault.*          145  ┴─► 313 (95%) 纯文件系统语义 → 可抽象为 FsAdapter
├─ .app.workspace.*       28  ┐
├─ .app.fileManager.*     10  │ 真正 Obsidian 专属
├─ commands/scope          3  │
└─ localStorage            3  ┘
```

结论：**不必重写，只需解耦**。把业务逻辑下沉到平台无关的 `core/`，两形态共用。

---

## 2 · 目录结构（目标）

```
free-ai-studio/                     ← 原地扩展，保留现有产物文件
├── .analysis/                      ← REA 分析产物
├── core/                           ⭐ 平台无关业务层（双形态唯一真相源）
│   ├── storage/
│   │   ├── types.ts                StorageAdapter / FsAdapter 接口
│   │   ├── memory.ts               内存实现（测试用）
│   │   ├── node-fs.ts              Node fs/promises 实现（Web 形态用）
│   │   └── obsidian.ts             Obsidian vault.adapter 实现（插件形态用）
│   ├── providers/
│   │   ├── types.ts                Provider 接口
│   │   ├── router.ts               ⭐ 8 厂商回退链（自定义→{vendor}→text→agnes→extra）
│   │   ├── agnes.ts  deepseek.ts  openai.ts
│   │   ├── qwen.ts   doubao.ts    minimax.ts
│   │   ├── sensenova.ts  zhipu.ts  ollama.ts
│   │   ├── free-video.ts           Veda Studio 适配器（adapter 模式）
│   │   └── overload.ts             平台过载识别（400/403+业务码）
│   ├── pipelines/                  ⭐ 幂等流水线（每阶段独立 + 落盘）
│   │   ├── types.ts                Stage / PipelineContext / RunState
│   │   ├── runner.ts               阶段调度 + 幂等 + 断点续跑
│   │   ├── drama.ts                短剧 7 阶段
│   │   ├── pro.ts                  红果 Pro 7 阶段
│   │   ├── anchor.ts               数字人 4 阶段
│   │   ├── explain.ts              解说片
│   │   ├── broll.ts                B-roll 5 阶段
│   │   └── whiteboard.ts           白板渲染动画
│   ├── tts/
│   │   ├── router.ts               ⭐ 4 引擎路由（edge/doubao/audio8/moss）
│   │   ├── edge.ts  edge-gec-v2.ts
│   │   ├── doubao.ts  audio8.ts  moss.ts
│   │   └── subtitles.ts            字级字幕（SRT/ASS）
│   ├── ffmpeg/
│   │   ├── probe.ts                多平台路径探测 + 降级
│   │   ├── filters.ts              ffmpegFilter（缩放/裁剪/字幕/合轨）
│   │   └── verify.ts               成片质检（renderVerify）
│   ├── i18n/
│   │   ├── index.ts  locales.ts
│   │   └── ../../locales/*.json    10 语种
│   ├── script/                     剧本质量 6 工具
│   ├── trace/                      运行期追踪（HTTP/ffmpeg/阶段）
│   └── types.ts                    共享类型
├── app/                            🌐 Web 形态（本地全栈）
│   ├── server/                     Fastify 5 + zod
│   │   ├── src/
│   │   │   ├── index.ts            入口（含 SSE）
│   │   │   ├── routes/             text|image|video|tts|pipeline|files|settings
│   │   │   ├── sse.ts              进度事件总线
│   │   │   └── workspace.ts        本地工作区（项目目录）
│   │   └── package.json
│   └── web/                        Vue 3 + Vite 6
│       ├── src/
│       │   ├── panels/             12 个免费面板
│       │   ├── components/
│       │   └── stores/             pinia
│       └── package.json
├── plugin/                         🔌 Obsidian 形态（保留原有模式）
│   ├── manifest.json
│   ├── esbuild.config.mjs
│   └── src/
│       ├── main.ts                 Plugin 入口 + ItemView
│       ├── view.ts                 侧边栏工作台
│       ├── settings.ts             PluginSettingTab
│       └── ui/                     21 面板 Obsidian 原生 UI
├── locales/                        10 语种 JSON
├── test/                           跨形态共享单测
├── scripts/
│   ├── css-structure.mjs           ⭐ CSS 结构护栏（照抄上游，治本）
│   └── doctor.mjs                  环境自检（ffmpeg/python/ollama）
├── package.json                    pnpm workspace
└── pnpm-workspace.yaml
```

---

## 3 · 双形态接入点

### 3.1 StorageAdapter —— 唯一的平台抽象点

```ts
// core/storage/types.ts
export interface StorageAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: number }>;
  rmdir(path: string): Promise<void>;
  /** 回收站语义（上游用 fileManager.trashFile，非 rm） */
  trash(path: string): Promise<void>;
}
```

| 实现 | 用在 | 关键点 |
|------|------|-------|
| `ObsidianAdapter` | 插件形态 | 包 `vault.adapter`；`trash` → `fileManager.trashFile` |
| `NodeFsAdapter` | Web 形态 | `fs/promises`；`trash` → `shell.trashItem`（macOS 回收站） |
| `MemoryAdapter` | 单测 | 零 I/O |

### 3.2 Provider 路由 —— 8 厂商回退链

```
自定义模型 → {vendor}_key → text_api_key → agnes 全局 Key → agnes_extra_keys[0]
```

```ts
// core/providers/router.ts
export async function callText(req: TextRequest): Promise<TextResult> {
  for (const key of resolveKeyChain(req.vendor)) {
    try {
      return await PROVIDERS[req.vendor].text(req, key);
    } catch (err) {
      if (!isOverload(err)) throw err;   // 过载 → 退避重试
      await backoff(attempt);            // 非过载 → 直接换下一个 Key
    }
  }
  throw new ProviderExhaustedError();
}
```

> 照抄上游两个关键教训（CHANGELOG 0.18.0 / 0.17.44）：
> ① HTTP 成功判据放宽到 **2xx**（201 被当失败的真实事故）
> ② 过载识别看**错误体**不只看状态码（中文厂商用 400/403 + 业务码表达过载）

### 3.3 幂等流水线 —— 断点续跑

```ts
// core/pipelines/types.ts
export interface Stage {
  id: string;
  /** 幂等：已有产物则跳过，直接返回落盘结果 */
  run(ctx: PipelineContext): Promise<StageResult>;
}

export interface RunState {
  runId: string;
  pipeline: string;
  stageIndex: number;
  artifacts: Record<string, string>;  // stageId → 产物路径
  updatedAt: number;
}
```

**落盘契约**（与上游一致）：
- 每阶段产物写入 `<workspace>/<pipeline>/<runId>/<stageId>.*`
- `RunState` 落 `run.json`
- 重新进入面板 → 列出历史 run（按 `updatedAt` 倒序）→「断点续跑」白捡已完成阶段
- 单点重生：允许指定 stage 强制重跑并级联失效后续

### 3.4 两种形态的 UI 复用策略

| 策略 | 覆盖 | 做法 |
|------|------|------|
| **完全复用** | core 逻辑、流水线、TTS、ffmpeg、i18n | 同一份 TS，零分支 |
| **视图层重写** | 21 个面板 UI | 插件用 Obsidian 原生控件；Web 用 Vue 组件。**共享的是数据契约不是视图** |
| **样式共享** | 主题 token、间距、状态 chip | 抽 `styles/tokens.css` + `styles/components.css`，插件直接 `styles.css` 引用，Web 引为 CSS 变量 |

---

## 4 · 与上游的差异（有意为之）

| 项 | 上游 | 本项目 | 理由 |
|----|------|--------|------|
| VIP 门禁 | `src/vip/gate.ts` + 激活码 | **移除**，全功能开放 | 本地项目无付费压力 |
| 广告位 | `src/ad/top-ad-slot.ts` 预留 | **移除** | 同上 |
| 语言包热更 | GitHub 三源竞速 + zip 导入 | 打包 10 语种 JSON | 离线可用，去掉代理链 |
| edge-tts | v2 + v1 兜底 | **保留 v2，去掉 v1 兜底** + README 标注风险 | v1 已被微软收紧 |
| 供应商 | 8 家 + 2 池 | 保留全部 | 核心能力 |
| 账号池 | 需另起本地服务 | 保留为可选外部服务 | 文档写清如何起 |
| Remotion | 解说片渲染依赖 | 保留（可选外部项目目录） | 重依赖不内置 |

---

## 5 · 环境自检（doctor）

```bash
npm run doctor
```

| 检查项 | 缺失时 |
|--------|--------|
| Node ≥ 20 | 阻断 |
| ffmpeg / ffprobe | 配音/成片类面板降级隐藏，其余可用 |
| Python 3 | 白板渲染（OpenCV 侧车）不可用 |
| Ollama | 本地模型探测关闭 |
| Audio8 服务 `127.0.0.1:8024` | 配音引擎选项禁用（而非静默失效） |
| 豆包账号池 `127.0.0.1:17888` | 免费额度池不可用 |

> 照抄上游原则：**缺失一律「禁用态 + 明确提示」，不静默失效**。

---

## 6 · 开发命令

```bash
pnpm install
pnpm dev            # Web 形态：server + web 并行
pnpm dev:plugin     # 插件形态：esbuild watch
pnpm build          # 双形态产物
pnpm test           # 跨形态单测
pnpm lint:css       # CSS 结构护栏（写盘前扫描）
pnpm doctor         # 环境自检
```
