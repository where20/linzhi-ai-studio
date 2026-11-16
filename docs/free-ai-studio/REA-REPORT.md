# REA 分析报告 · Free AI Studio (Obsidian 插件) → 本地全栈复刻

> **REA** = Requirements · Extract · Assemble（需求 · 提取 · 装配）
> 分析目标：把 `free-ai-studio` 这个 **Obsidian 桌面插件**（v0.18.0，1.98MB esbuild bundle）拆透，
> 产出一套**本地全栈**实现，同时**保留原有 Obsidian 插件形态**。
> 分析日期：2026-11-04 · 工具：静态逆向（bundle / CHANGELOG / GitHub API）· 目标平台：macOS
> 分析对象：`/Users/xiaoan/Desktop/REA/free-ai-studio/`（上游 `xiaosong8584/free-ai-studio`，MIT）

---

## 0 · TL;DR

| 维度 | 结论 |
|------|------|
| **产品本体** | 一个把「AI 文本/图像/视频/配音 + 短剧成片」全塞进 Obsidian 侧边栏的工作台，21 个面板，3305 个 i18n key，84 个历史版本 |
| **技术栈** | TypeScript + esbuild 打包成单文件 `main.js`，零运行时依赖（仅 `obsidian` / `os` / `child_process`），Obsidian ≥ 1.7.2，桌面端专用 |
| **关键依赖** | 8 家厂商 API + 2 个本地账号池 + 3 个 TTS 引擎（edge-tts 协议重实现 / 豆包 / Audio8）+ 本机 ffmpeg |
| **源码可得性** | ⚠️ **GitHub 仓库只发布构建产物，无 `src/`**（已用 GitHub API 核验）。逆向只能基于 bundle + 208KB CHANGELOG |
| **最大工程量** | 不是 AI 调用，而是 **7 条幂等流水线 + 21 个面板 UI + 断点续跑状态机 + 8 厂商回退链 + i18n（10 语种）** |
| **合规红线** | ① Edge-TTS 协议重实现是 **LGPLv3 派生作品** ② edge-tts 调**微软未公开端点**（无 SLA、禁止逆向）③ MOSS-TTS 需 AI 来源标识 |
| **复刻策略** | **不是重写，是「解耦 + 双形态」**：把 `core/` 从 Obsidian API 中剥离成**平台无关层**，Web 形态与插件形态共用同一套 core |
| **建议优先级** | 先做 P0 五件套（文本/图像/视频/配音/日志）+ 本地文件落盘管线，VIP 流水线（红果 Pro 等）后置 |

---

## 1 · Requirements（需求）

### 1.1 这个插件解决什么问题

| 维度 | 分析 |
|------|------|
| **Who** | 内容创作者 / 网文作者 / 短剧制片 —— 需要在「写作 → 分镜 → 出图 → 出视频 → 配音 → 成片」这条链上不切工具 |
| **What** | 一个 Obsidian 侧边栏工作台 = 21 个 Tab 面板 + 7 条多阶段流水线 |
| **Why** | 通用 AI 工具（ComfyUI / Runway / 即梦）每个只做一段，断点续跑、产物管理、角色一致性全靠人肉 |
| **差异化** | ① **产物即笔记**（写 Vault，天然双链/检索）② **幂等流水线**（每步落盘，重启白捡）③ **多厂商回退链**（一个 Key 挂了就换下一个）④ **零成本默认**（免费面板全开，VIP 只是增量） |
| **商业模型** | Obsidian 政策要求「可选付费」：免费档不阉割任何功能，VIP 解锁 8 项增量能力；顶部预留广告位（默认关闭） |

### 1.2 功能全景（21 个面板）

| 面板 | ID | VIP | 能力 |
|------|----|-----|------|
| 文本 | `text` | ❌ | 4 模式 + 6 种剧本质量工具（体检/改写/70集拆分/锁定码/八步分镜/首尾帧继承） |
| 图像 | `image` | ❌ | 文生图/图生图，参考图可从 Vault 选/本地上传/URL，自动压缩归一化，并发闸门防 429 |
| 视频 | `video` | ❌ | 文生视频/图生视频，四分支协议，任务持久化 + 重启续跑 |
| 配音 | `tts` | 部分 | 豆包整集配音（多角色+环境音+BGM+字级字幕）/ Audio8 本地 / edge-tts（9音色×6情感×3语速） |
| 短剧 | `drama` | ❌ | 梗概→大纲→分镜JSON→逐镜图→逐镜视频→配音→成片 |
| 解说片 | `explain` | ❌ | 调研→口播稿→分镜→帧图→配音→Remotion 渲染 + BGM 底轨 |
| 白板渲染动画 | `whiteboard` | ❌ | SRT/ASS→分幕→逐幕 AI 线稿→OpenCV 确定性渲染→合并（**渲染零 token**） |
| 画廊/参考/选角/志怪/日志 | 5 个 | ❌ | 素材管理、参考图收藏、角色三步建档、图册、运行期追踪面板 |
| MTV | `mtv` | ❌ | 音乐驱动视频混剪 |
| **红果 Pro** | `pro` | ✅ | **七阶段**短剧成片（剧本→分镜→定妆→首尾帧→视频→配音→成片） |
| **数字人口播** | `anchor` | ✅ | 四阶段（文稿→分段→配音→形象图I2V→段成片→字幕→成片） |
| **封面** | `cover` | ✅ | 书名+作者+简介 → 提示词 → 出图 → 裁画幅 → Canvas 排版 → 三件套 |
| **让女神跳舞** | `dancer` | ✅ | Wan-Dancer 音乐驱动舞蹈（DashScope `wan2.2-dancer`） |
| **B-roll** | `broll` | ✅ | 五阶段幂等：素材→计划→分镜→关键帧→片段 + 角色三步 |
| **InkOS 写作台** | `inkos` | ✅ | Vault 原生小说工程：章节+资产库+AI续写，可送入红果 Pro |
| **无限画布** | `canvas` | ✅ | 节点图：文本/图像/视频节点 + 依赖连线 + 并行生成 |
| **edge-tts 引擎** | — | ✅ | 微软 edge-tts（VIP 才可选，非 VIP 显示禁用态而非静默失效） |

> `data.json` 实测 `visibleTabs` = 12 个默认开启（含 `zhiguai`/`cast`），VIP 面板默认隐藏。

### 1.3 非功能需求（可从 CHANGELOG 反推的硬约束）

| 类别 | 约束 | 出处 |
|------|------|------|
| **幂等** | 每条流水线每阶段是**独立幂等函数**，每步落盘 → 断点续跑白捡 | README + CHANGELOG |
| **降级** | ffmpeg 探测不到 → 逐级降级；VIP 未激活 → 面板隐藏而非报错 | README |
| **韧性** | 指数退避重试器 + 并发信号量 + edge-tts 时钟漂移自愈 + 微软故障识别 | README |
| **容错** | HTTP 状态码判据要放宽到 2xx（0.18.0 修的真实事故：201 被当失败） | CHANGELOG 0.18.0 |
| **过载识别** | 中文厂商用 400/403 + 业务码表达过载 → 错误体识别后按 attempt 退避 | CHANGELOG 0.17.44 |
| **CSS 护栏** | 写盘前扫描 `styles.css` 括号/嵌套，结构不合法**拒绝部署** | CHANGELOG 0.17.44 |
| **测试量** | 2791 用例（1785+ 过），`test/*.test.mjs` 37 个文件 | CHANGELOG |
| **i18n** | 3305 key，10 语种（简中/英永久免费 + 8 增量包），GitHub 热更新 + 离线 zip 导入 | README + `dist/language-vip8/` |

---

## 2 · Extract（提取）

### 2.1 逆向的硬约束（决定复刻路线）

| 发现 | 证据 | 影响 |
|------|------|------|
| ⚠️ **上游无源码** | GitHub API `contents/` 返回仅 10 项：`main.js` / `styles.css` / `manifest.json` / `versions.json` / `data.json` / `README*` / `CHANGELOG` / `LICENSE` / `THIRD_PARTY` / `dist/`；`contents/src` → **404** | 不能「拉源码改改」，必须**从 bundle 逆向重建** |
| ✅ **CHANGELOG 是金矿** | 208KB / 84 版本，每版列 `src/core/xxx.ts` `test/xxx.test.mjs` `doc/NN-xxx.md` | 拿到了**模块地图 + 测试清单 + 事故史**（等于原作者的开发日志） |
| ⚠️ **bundle 已 mangle** | esbuild 单文件、1576 行、无 sourcemap、类名全部压缩成 `Xp`/`Zt`/`Nt` | 不能靠符号名导航，只能靠**字符串常量 + 结构特征**定位 |
| ✅ **字符串全保留** | 3305 个 i18n key、全部 URL、全部面板 ID 都在 bundle 里 | **可按 key 前缀反推模块归属**（见 2.4） |

### 2.2 Obsidian 依赖面（决定「插件形态保留」的成本）

```
require("obsidian")            × 53 处   → 53 个独立模块各 import 一次（esbuild 不做 hoist）
require("child_process")       × 1       → ffmpeg 调用
require("os")                  × 2       → 平台判断 / PATH
```

| API | 频次 | 用途 | 本地全栈对应物 |
|-----|-----|------|--------------|
| `.vault.adapter.*` | **168** | 文件读写（read/write/readBinary/writeBinary/exists/list/mkdir/remove/stat/rmdir） | → Node `fs/promises`，**直接换成 fs 即可** |
| `.app.vault.*` | 145 | 高层 Vault 操作（create/modify/createBinary/getFiles/read/cachedRead/modifyBinary） | → 文件系统 + 索引层 |
| `.vault.getAbstractFileByPath` | 42 | 路径→文件对象 | → 路径解析函数 |
| `.app.workspace.*` | 28 | `getLeavesOfType`（RTL 方向适配）/ `getLeaf` / `documentEl` | → **无对应，纯 Obsidian 专属** |
| `.app.fileManager.trashFile` | 14 | 删除走**回收站**（非 rm） | → `trash` / `Electron shell.trashItem` |
| `.app.saveLocalStorage` / `loadLocalStorage` | 3 | 偏好持久化 | → SQLite / JSON |
| `.scope.register` / `commands.*` | 3 | 事件订阅 + 命令注册 | → 无对应 |

> **结论**：Obsidian 依赖**高度集中在文件系统**（313/331 ≈ 95%）。
> 这意味着把 `core/` 抽象成 `FsAdapter` 接口后，插件形态与 Web 形态可**共用 90%+ 的业务代码**。

### 2.3 外部依赖地图

| 类别 | 实例 | 可复刻性 |
|------|------|---------|
| **厂商 API（8）** | Agnes AI `api.agnes-ai.cn/v1` · DeepSeek · OpenAI · 通义千问 · 豆包 `ark.cn-beijing.volces.com/api/v3` · MiniMax · SenseNova · 智谱 `open.bigmodel.cn/api/paas/v4` | ✅ 全部可自备 Key 复刻 |
| **聚合/中转** | `oai.endpoints.kepler.ai.cloud.ovh.net/v1` · `blockrun.ai/api/v1` · `your-proxy.com/v1` | ✅ 纯转发 |
| **免费源** | Veda Studio `veda.hanxiao.run`（20点/天/设备）· imagefree.net · pollinations.ai（text/image） | ⚠️ 无 SLA，随时可能挂 |
| **账号池** | doubao-account-pool `127.0.0.1:17888` · dola-pool `127.0.0.1:8000` · Ollama `11434` | ✅ 本地自建 |
| **TTS** | edge-tts `speech.platform.bing.com`（**未公开端点**）· 豆包 Seed-Audio `openspeech.bytedance.com/api/v3/tts/create` · Audio8 `127.0.0.1:8024`（本机）· MOSS-TTS-Nano（Python sidecar，Apache-2.0） | ⚠️ edge-tts 合规风险 |
| **媒体工具** | ffmpeg / ffprobe（多平台路径探测：WinGet/scoop/brew/usr/bin） | ✅ 外部依赖 |
| **渲染** | Remotion（解说片）· OpenCV（白板，Python 侧车）· Canvas 2D（封面排版） | ⚠️ 重依赖，本地全栈需保留 |
| **GitHub 热更** | `cdn.jsdelivr.net/gh/` · `ghfast.top` · `ghproxy.net`（三源竞速） | ✅ |

### 2.4 模块归属反推（i18n key 前缀 = 模块指纹）

| key 前缀 | 计数 | 推定模块 |
|---------|-----|---------|
| `settings.*` | 1720 | 设置页（含全部厂商 Key、ffmpeg、语言、流水线参数） |
| `wb.*` | 1010 | 白板渲染动画（whiteboard） |
| `explain.*` | 951 | 解说片 |
| `prog.*` | 768 | 进度文案（各流水线共用） |
| `err.*` | 768 | 错误文案（全局） |
| `pipe.*` | 577 | 流水线阶段名 |
| `drama.*` | 371 | 短剧 + 红果 Pro |
| `tts.*` / `voice.*` / `model.*` | 321/85/51 | 配音引擎 |
| `mtv.*` | 314 | MTV |
| `cover.*` | 307 | 封面 |
| `dancer.*` | 278 | 让女神跳舞 |
| `anchor.*` | 275 | 数字人口播 |
| `broll.*` | 181 | B-roll |
| `canvas.*` | 165 | 无限画布 |
| `zhiguai.*` / `cast.*` / `dressup.*` / `inkos.*` | 138/127/112/111 | 志怪图册 / 选角台 / 换装 / InkOS 写作台 |

**已知源码模块（CHANGELOG 直接点名）**：
`src/core/tts.ts` · `ttsGecV2.ts` · `ttsRouter.ts` · `audio8Tts.ts` · `audio8Service.ts` · `videoKeySlot.ts` · `videoSpec.ts` · `ffmpegFilter.ts` · `renderVerify.ts` · `scriptQuality.ts` · `childOutput.ts` · `overload.ts` · `brollFinish.ts` · `brollAlign.ts` · `providers.ts` · `tabPrefs.ts` · `src/vip/gate.ts` · `src/i18n/{index,githubSync,localeFileStore,localeSyncCore}.ts` · `src/settings.ts` · `src/ui/{brand,confirmDialog,Audio8VoiceModal}.ts` · `src/ad/top-ad-slot.ts` · `scripts/{css-structure,check-gec-consistency,gen-locales,locale-budget,remove-gec-v2}.mjs` · `scripts/moss/sidecar.py`

### 2.5 持久化与状态模型

| 数据 | 位置 | 机制 |
|------|------|------|
| 设置 | `data.json`（Vault 内，**schemaVersion: 19**） | Obsidian `loadData`/`saveData` |
| API Key | `data.json` 的 `enc:v1:` 前缀字段 | Electron `safeStorage` 加密，桌面端加密/移动端明文回退 |
| 流水线状态 | Vault 内目录（`_Agnes/` 系列） | 每阶段落盘 JSON + 媒体文件 → 断点续跑 |
| 输出目录 | `outputFolder: "_Agnes"` + 子目录 `notes/pictures/videos/audio/covers/dramas/anchors/dancer/cast` | Vault 相对路径 |
| 语言包 | 插件目录 `language/`（**不占 data.json**） | GitHub 热更新 + 离线 zip 导入导出 |
| 缓存/任务 | 30 天自动清理 + 手动按钮 | 任务中心 |

---

## 3 · Assemble（装配）

### 3.1 核心洞察：**95% 的代码与 Obsidian 无关**

`.vault.adapter` + `.app.vault` 合计 313 次调用，占 Obsidian 依赖的 **95%**。
真正的 Obsidian 专属只有三处：

| Obsidian 专属 | 用途 | 插件形态保留策略 |
|-------------|------|-----------------|
| `ItemView` + `workspace.getLeavesOfType` | 侧边栏工作台 | ✅ **原样保留** |
| `commands.*` / `scope.register` | 命令与事件 | ✅ 原样保留 |
| `documentEl` / RTL 方向适配 | 主题与多语言 | ✅ 原样保留 |

> **装配原则**：不改写插件形态，而是把业务逻辑下沉成**平台无关 core**，插件形态退化为「core + Obsidian 适配壳」。

### 3.2 目标架构：三层 + 双形态

```
┌─────────────────────────────────────────────────────────────┐
│  形态 A：Obsidian 插件（保留原有模式）                        │
│  manifest.json + main.js(esbuild) · ItemView · PluginSettingTab│
│         ↓ 复用 core/ · 注入 ObsidianAdapter                 │
├─────────────────────────────────────────────────────────────┤
│  形态 B：本地全栈 Web（新增）                                │
│  Fastify/NestJS 后端 (127.0.0.1:8787) + Vue3/React 前端      │
│  SSE 进度流 · 本地文件库 · 多项目工作区                       │
├─────────────────────────────────────────────────────────────┤
│  ⭐ core/ —— 平台无关业务层（100% 共享，两形态唯一真相源）    │
│  providers(8厂商回退链) · pipelines(7条幂等流水线)             │
│  tts(4引擎路由) · ffmpeg · i18n(10语种) · vip · storage(FsAdapter)│
└─────────────────────────────────────────────────────────────┘
```

**对应关系表**

| core 模块 | Obsidian 形态实现 | Web 形态实现 | 差异 |
|-----------|------------------|-------------|------|
| `core/storage` | `ObsidianAdapter`（vault.adapter） | `NodeFsAdapter`（fs/promises） | 仅读写原语不同 |
| `core/providers` | `requestUrl`（Electron net） | `fetch`（undici） | 请求原语不同 |
| `core/pipelines` | 同一份 | 同一份 | **零差异** |
| `core/ffmpeg` | `child_process` | `child_process` | **零差异** |
| `core/tts` | 同一份 | 同一份 | **零差异** |
| `core/i18n` | 同一份（落 `language/`） | 同一份（落 `data/i18n/`） | 路径不同 |
| `ui/*` | Obsidian 原生控件 | Web 组件 | **需重写**（21 面板 × 2） |

### 3.3 技术选型（对齐 REA 既有项目）

| 层 | 选择 | 理由 |
|----|------|------|
| 后端 | **Fastify 5 + zod** | 复用 `code-video-studio` 既有栈（同 REA 目录，一致性） |
| 前端 | **Vue 3 + Vite 6** | 复用 `code-video-studio` 的 Vue 栈；且 Obsidian 插件 UI 也是原生 DOM，两者心智一致 |
| 语言 | **TypeScript** | 原插件即 TS，core 层可直接对拷语义 |
| 存储 | **JSON 文件 + 目录树**（非 SQLite） | 原生即 Vault 目录树；SQLite 会破坏「产物即文件」语义 |
| 进度 | **SSE** | 与原插件的轮询语义一致，且能复用 `traceLogLevel` 日志模型 |
| 打包 | **esbuild**（与原插件同款） | 双形态共用构建链 |

### 3.4 复刻执行清单（分 6 阶段）

| # | 阶段 | 交付 | 优先级 |
|---|------|------|--------|
| 1 | **REA 分析** | 本报告 + `.analysis/raw/*` | ✅ 已完成 |
| 2 | **core 层骨架** | `core/{storage,providers,ffmpeg,tts,i18n,pipelines}` + `FsAdapter` 接口 | P0 |
| 3 | **Web 后端** | Fastify 路由 + SSE 进度 + 静态文件服务 + 项目工作区 | P0 |
| 4 | **Web 前端** | 12 个免费面板（text/image/video/tts/drama/explain/whiteboard/gallery/reference/cast/zhiguai/log） | P0 |
| 5 | **插件形态** | `manifest.json` + esbuild 打包 + `ObsidianAdapter` + ItemView | P1 |
| 6 | **VIP 流水线** | pro / anchor / cover / dancer / broll / inkos / canvas | P2 |

### 3.5 P0 面板复刻规格（Web 形态）

| 面板 | 关键能力 | 复用插件逻辑 |
|------|---------|-------------|
| 文本 | 4 模式 + 6 剧本质量工具；JSON 结构化渲染；带 frontmatter 存 Markdown | `core/scriptQuality.ts` |
| 图像 | 文生图/图生图；参考图（Vault→本地库）；并发闸门 | `core/providers` |
| 视频 | 文生视频/图生视频；任务中心 + 轮询 + 续跑 | `core/providers` + taskStore |
| 配音 | 4 引擎路由（edge/豆包/Audio8/MOSS）；整集多角色 + BGM + 字级字幕 | `core/tts/*` |
| 短剧 | 7 阶段幂等流水线，每步落盘 | `core/pipelines/drama` |
| 日志 | 运行期追踪（HTTP / ffmpeg / 阶段推进），导出笔记 | `trace` 模块 |

### 3.6 不做的事（明确的负向清单）

- ❌ **不复刻 VIP 门禁/激活/广告位** —— 本地项目没有付费压力，`src/vip/gate.ts` 直接移除，全功能开放
- ❌ **不复刻 edge-tts 的 v1 兜底** —— 保留 v2 实现，但把「未公开端点」风险在 README 显式标注
- ❌ **不复刻 GitHub 语言包热更新竞速** —— 本地直接打包 10 语种 JSON，去掉三源代理链
- ❌ **不做 SaaS / 多租户 / 登录** —— 与 REA 既有项目一致（用户偏好极简）
- ❌ **不打包模型权重** —— 同上游策略，用户自备

---

## 4 · 合规与风险（必须先读）

| 风险 | 等级 | 处置 |
|------|-----|------|
| **Edge-TTS = LGPLv3 派生作品** | 🔴 高 | 复刻版**必须以 LGPLv3 发布**并附 GPL/LGPL 全文 + 可重新链接源码；或**改用 Audio8/豆包路线彻底规避** |
| **Edge-TTS 调未公开微软端点** | 🔴 高 | 微软 EULA 禁止逆向。**商业部署前必须重新评估**；本项目建议默认引擎改为 Audio8（本地）/ 豆包，edge-tts 降级为「实验性」 |
| **MOSS-TTS 需 AI 来源标识** | 🟡 中 | 每段 WAV 内嵌 `LIST/INFO/AIMD` 隐式标识（《互联网信息服务深度合成管理规定》§16）；保留音色克隆授权提示 |
| **免费源无 SLA** | 🟡 中 | Veda（20点/天）/ pollinations / imagefree 均标注「随时可能失效」，设计降级路径 |
| **上游 MIT 但含 LGPL 派生文件** | 🟡 中 | 复刻需**逐文件标注**归属（原插件已在 `THIRD_PARTY.md` 做对，照抄该做法） |

---

## 5 · 待决策 / 余留

- [ ] **项目落点**：新建 `/Users/xiaoan/Desktop/REA/ai-studio`？还是直接在 `free-ai-studio/` 下开 `app/` 子目录？
- [ ] **前端栈**：Vue 3（对齐 code-video-studio）还是 React 19（对齐 image-studio / YanShi）？
- [ ] **edge-tts 留不留**：① 保留并以 LGPLv3 发布 ② 改用 Audio8/豆包默认 ③ 两者（默认豆包，edge 作为可选）
- [ ] **复刻深度**：全 21 面板全量复刻，还是先做 P0 六面板 + 核心流水线？
- [ ] **VIP 门禁**：确认**完全移除**（本地项目）还是保留为「实验性功能开关」？
- [ ] **后端端口**：8787（避开 17888/8000/8024/11434 已占端口）
- [ ] **是否发布**：私有本地 or 开源（影响 LGPL 全文附带成本）

---

## 6 · 原始数据索引

```
.analysis/raw/
├── artifact-meta.txt          产物元数据（大小/行数/构建器/sourcemap）
├── obsidian-api-surface.txt   Obsidian API 调用频次全表
└── endpoints-and-i18n.txt     全部 URL + i18n key 前缀分布

.analysis/docs/
└── ARCHITECTURE.md            目标架构与模块拆分（装配阶段的落地文档）
```

**上游参考**：`xiaosong8584/free-ai-studio`（MIT，构建产物发布型仓库，无 src/）
