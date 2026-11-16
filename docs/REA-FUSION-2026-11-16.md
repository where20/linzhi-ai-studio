# REA 融合迭代分析 · 线上分享站 → 本地 linzhi-ai-studio

> **REA** = Requirements · Extract · Assemble（需求 · 提取 · 装配）—— 本项目沿用的逆向融合方法论（见 `free-ai-studio/REA-REPORT.md`）。
> 分析对象：线上分享站 `wbapp-ri5eo915j2fglipkmaq8u5.app.workbuddy.host`（标题「临智AI助手」，带 sharecode 分发）
> 目标宿主：本地 `linzhi-ai-studio` V2（Web 3721 + 本地引擎双形态）
> 日期：2026-11-16 · 工具：ego-browser 实测抓取（非推断）

---

## 0 · TL;DR

| 维度 | 结论 |
|---|---|
| **两者关系** | **同源异构**：都叫「临智AI」，但线上是「云端分发版」（精简重写，body 341KB，服务端零 KEY 责任），本地是「全功能复刻版」（全量前端 806KB + 本地引擎 + 适配层）。不是新旧版，是**两条路线**。 |
| **最大可融合点** | **BYOK 自带 KEY 体系**——线上让用户填自己的 Agnes/商汤 KEY（存浏览器、单次上送、服务端不保存）；本地恰好是单 KEY 且 `sk-b5d…` 已失效（靠免 Key 回落）。把 BYOK 吸进来 = 直接解掉本地的 KEY 死穴。 |
| **第二融合点** | **模型矩阵 + 生图双模型**：线上已上 DeepSeek V4 / Agnes 3.0 / Agnes Video 2.5 / MiniMax-H3，生图「商汤+Agnes 同时出」；本地仍是 V1.8.394 老列表、单通道。 |
| **第三融合点** | **UX 增强套件**：防刷新草稿自动存、方标/圆标切换、一键换色、6 音色朗读、民俗宝典入口——都是低成本高感知的增量。 |
| **融合方向** | **单向：线上 → 本地**。本地是超集（自带引擎/5 后端 TTS/分镜全链路/热点/作品墙），反向融合等于自废武功。 |
| **建议路线** | P0（BYOK + 模型矩阵 + 双通道生图）→ P1（UX 套件）→ P2（内容服务端点 / 拍照面板）。**不替换本地前端**，只做增量注入 + 配置层升级。 |

---

## 1 · Requirements（需求）

### 1.1 用户诉求拆解

| 层 | 原始指令 | 解读 |
|---|---|---|
| 表层 | 「参考当前网站，做融合优化迭代」 | 以线上分享站为参照系，把它的**增量能力**吸收进本地项目 |
| 方法 | 「用 REA 分析」 | 沿用项目既有 REA 三段式（需求→提取→装配），先分析后动手，不盲目改码 |
| 隐含 | 用户是该站作者/深度使用者（本地项目就是它的复刻） | 融合应服务「本地更好用」，不是「变成线上站的复制品」 |

### 1.2 融合要解决的真实痛点

| # | 本地现状 | 线上对应能力 | 融合价值 |
|---|---|---|---|
| 1 | 服务端单 KEY `sk-b5d…` **已失效**，靠 Pollinations/Veda 免 Key 回落 | BYOK：用户填自己的 KEY，服务端零责任 | 🔴 根治性——把「等服务端 KEY」变成「自带 KEY 即用」 |
| 2 | 模型列表停留在 V1.8.394（Agnes 3.0 Flash 等老项） | DeepSeek V4 Pro/Flash、Agnes Video 2.5、MiniMax-H3、SenseNova u1/6 | 🟠 高——模型新鲜度直接决定输出质量 |
| 3 | 生图单通道（Agnes 或免 Key 回落） | 商汤 + Agnes **双模型并行出图**，用户可选「双/仅商汤/仅 Agnes」 | 🟠 高——一次请求两组结果，质量可择优 |
| 4 | 无草稿保护，刷新即丢输入 | 防刷新 + `lz_draft_v1` 自动存草稿 | 🟡 中——体验层，实现简单 |
| 5 | 单一主题 + 方标 | `lz_theme` 一键换色 + 方标/圆标切换 | 🟡 中——纯前端，零风险 |
| 6 | 6 种朗读音色（edge-tts 子集） | 同样 6 音色，但**浏览器合成兜底**（engine:none 也能读） | 🟢 低——本地 358 音色已远超，仅借鉴兜底逻辑 |

### 1.3 约束（不可退化的既有能力）

- ✅ 本地引擎 `engine/`（去商业 VIP 的 21 面板 / 7 流水线）必须保留
- ✅ 5 后端免费 TTS（edge/VoxCPM/matrix/say/custom，358 音色）不得被线上 6 音色覆盖
- ✅ 分镜→出图→成片全链路（`lib/storyboard*`、`fjgzt1.html`）不受影响
- ✅ 门禁桩 / 热点 RSS / 作品墙 / 上传等本地适配层保持可用
- ✅ **不引入登录墙**（本地项目设计就是免登录；BYOK 只做「可选填 KEY」，不做强制门禁）

---

## 2 · Extract（提取）

### 2.1 实测抓取的硬数据

| 项 | 线上分享站（实测） | 本地项目（现状） |
|---|---|---|
| 前端体积 | body 341,158 字符（精简重写） | body.html 806,670 字节（全量 V1.8.394） |
| 标题 | 临智AI助手 | 临智AI - 图片 & 视频生成 |
| SDK | `workbuddy-cloud-sdk.global.js`（本地 vendor） | `@tencent-ai/workbuddy-cloud-sdk@dev`（jsDelivr） |
| 统计 | 51.la | 无 |
| localStorage 实际键 | `lz_draft_v1`、`lz_theme`（登录墙显示时 KEY 未落，走内存/请求头） | 无持久化草稿 |
| 板块数 | 22 个主按钮（聊图鱼PT视免H3Pa邪资小文剧分留HK海AI听英诗复）+ 民俗宝典 + 拍照面板 | 20 版块 + 本地分镜浮标 |
| TTS 引擎 | `/api/tts/voices` 返回 `engine:"none"`、`default:zh-CN-XiaoxiaoNeural`、6 音色，注明「服务端神经语音不可用，自动改用浏览器合成」 | 5 后端 / 358 音色（edge 默认） |

### 2.2 BYOK 鉴权机制（最高价值提取项）

登录墙三个 KEY 输入框（实测文案）：

```
CN  Agnes 国内通道   api.agnes-ai.cn      → 占位「粘贴你自己的 Agnes KEY」
COM Agnes 国际通道   apihub.agnes-ai.com  → 占位「粘贴国际通道的 Agnes KEY」
SN  商汤通道         token.sensenova.cn   → 占位「粘贴你的商汤 KEY」
```

关键设计（值得原样吸收）：

| 特性 | 实现 | 本地对应缺口 |
|---|---|---|
| KEY 只存浏览器 | `lz_ak_cn` / `lz_ak_com` / `lz_ak_ch`（商汤）/ `lz_sn_key` / `lz_tk` | 本地 KEY 在服务端 `config.json`，用户无法自理 |
| 单次上送 | 请求头 `x-lz-ak`、`x-lz-ak-ch`、`x-lz-tk`、`x-lz-proxy` | 本地无请求头透传约定 |
| 服务端零留存 | 文案明确「服务端不保存，随请求单次上送」 | 本地适配层需新增「读请求头→临时用→不落盘」分支 |
| 状态可查 | `GET /api/config/status` → `{agnes_configured, agnes_builtin:false, agnes_user_key_required:true, agnes_channels:["cn"], sensenova_configured, ...}` | 本地 `/api/config` 暴露的是完整 config，语义不同 |
| 一键测 KEY | 每个输入框旁「测」按钮（→ `/api/config/test-key` 同类） | 本地已有 `/api/config/test-key`，可复用 |
| 留空回落 | 文案「留空则自动走服务端内置通道」 | 本地已有免 Key 回落，**语义天然兼容** |

### 2.3 API 契约（线上实测 24 个端点）

```
鉴权/配置   /api/config/status · /api/session · /api/_probe(404)
对话         /api/agnes · /api/agnes/v1/chat/completions · /api/sn/chat/completions · /api/agnes/agnesapi
生图         /api/image/generate · /api/image/img2img · /api/agnes/v1/images/generations · /api/fu/image · /api/upload/image
视频         /api/agnes/v1/videos · /api/fu/video
TTS/音乐     /api/tts · /api/tts/voices · /api/music(/)
内容服务     /api/prompts/templates · /api/prompts/xian · /api/novel/system · /api/prose/system · /api/script/system · /api/storyboard/system
```

其中 `/api/prompts/*`、`/api/novel|prose|script|storyboard/system`、`/api/music` 是本地**完全没有**的内容服务族——线上把这些做成了服务端系统提示词下发，这是轻量但聪明的做法。

### 2.4 模型矩阵与生成模式（实测 select 选项）

```
对话模型    DeepSeek V4 Pro / DeepSeek V4 Flash / Agnes 3.0 Flash / Agnes 2.5 Flash
视频模型    Agnes Video 2.5 Flash（另有 MiniMax-H3 独立 iframe 通道）
生图尺寸    1K横屏16:9 / 1K竖屏9:16 / 1K方版1:1 / 1K竖版3:4 / 1K横版4:3 / 1K宽银幕2.37:1
生图模式    双模型（商汤+Agnes同时出） / 仅商汤 / 仅Agnes
视频尺寸    1152×768(默认) / 1280×720 / 1920×1080 / 768×1344
视频时长    5 / 8 / 10 / 12 秒
视频参考    自动1~2张首尾帧锚定(3~5张多图参考) / 仅首尾帧锚定 / 多图参考(≤5张)
朗读音色    晓晓·温柔女声 / 晓伊·甜美女声 / 晓北·东北女声 / 晓妮·陕西女声 / 晓佳·粤语女声 / 晓臻·台湾女声
拍照面板    摄像头(前/后置) + 4K/1080p/720p/480p + 人脸468点/手势/姿态33点 + 3/5/10秒定时 + 单张/连拍3/5
妆容/汉服   6妆容 + 6妆容部位 + 4质感 + 唐/宋/明/魏晋/仙侠/武侠/清宫/敦煌/婚服/常服 + 5画幅
```

### 2.5 板块性质分类（决定融合方式）

| 类别 | 板块 | 融合策略 |
|---|---|---|
| **真·自研能力** | 聊(对话)、图(生图)、视(生视频)、资产生图、东方邪术、拍照 | 对齐模型/模式参数即可，逻辑本地已有 |
| **iframe 聚合** | 鱼(pai.zaiduyu.top)、PT(PabaTV)、免(Veda)、H3(SiftQ)、Pa(Pavo)、HK(Hark)、AI导航、诗库、词光、布谷音乐、复(视频复刻) | 本地多数已有等价物（免=Veda 已通）；其余是外链，加入口即可 |
| **内容型** | 小说、散文、剧本、分镜 | 本地分镜工作台已更强（`studio/storyboard.html`），只需补小说/散文/剧本的系统提示词 |

---

## 3 · Assemble（装配）

### 3.1 融合三原则

1. **单向吸收**：线上 → 本地。本地是超集，绝不反向砍功能去迁就线上。
2. **不换前端骨架**：本地 `body.html` 是全量 806KB，线上 341KB 是精简版；整站替换会丢失 20 版块深度。**只做增量注入**（patch 脚本 + 配置层升级），保持可回滚。
3. **KEY 双轨制**：保留服务端 `config.json` KEY（服务端内置通道）作为兜底，新增前端 BYOK（用户自带）为优先轨；两轨都空 → 走既有免 Key 回落。三轨并存，任一可用即工作。

### 3.2 分层装配方案

#### P0 · 核心融合（根治 KEY 死穴 + 对齐模型）—— 建议优先做

| # | 落点 | 具体改动 | 风险 |
|---|---|---|---|
| P0-1 | KEY 双轨 | `local-api.js`：`/api/config/status` 新语义 + 所有 AI 端点读请求头 `x-lz-ak*` 临时覆盖 config KEY（不落盘） | 低 |
| P0-2 | 前端 KEY 面板 | 注入「本地 KEY 设置」抽屉（复用线上三通道 UI 文案），存 localStorage，fetch 拦截器自动加请求头 | 低 |
| P0-3 | 模型矩阵 | 对话下拉补 DeepSeek V4 Pro/Flash、Agnes 2.5；视频补 Agnes Video 2.5 / MiniMax-H3 入口 | 低 |
| P0-4 | 双模型生图 | `/api/image/generate` 支持 `model=both`，并行调 Agnes + 商汤，返回双图；前端加模式下拉 | 中（商汤 KEY 需用户填） |

#### P1 · UX 增强（低成本高感知）

| # | 落点 | 具体改动 | 风险 |
|---|---|---|---|
| P1-1 | 草稿防刷新 | `beforeunload` + 输入防抖写 `lz_draft_v1`，恢复时回填 | 极低 |
| P1-2 | 主题/图标切换 | 复用线上 `lz_theme` 结构，加圆标↔方标、换色按钮 | 极低 |
| P1-3 | 朗读兜底 | TTS 失败时降级 `speechSynthesis`（线上 engine:none 的做法） | 低 |
| P1-4 | 状态徽标 | 顶栏显示 KEY 状态（内置/自带/免Key回落），一眼知道当前走哪条轨 | 低 |

#### P2 · 内容服务 / 增量板块（按需）

| # | 落点 | 具体改动 | 风险 |
|---|---|---|---|
| P2-1 | 系统提示词服务 | 补 `/api/prompts/{templates,xian}`、`/api/{novel,prose,script,storyboard}/system`，本地落库提示词模板 | 中 |
| P2-2 | 内容面板 | 补「小说 / 散文 / 剧本」三个轻量 tab（复用对话引擎 + 各自 system） | 中 |
| P2-3 | 拍照面板 | 内嵌 `getUserMedia` 拍照页（本地已有 poseatlas 类似能力，评估复用） | 中 |

### 3.3 明确不做的事（负向清单）

- ❌ **不替换前端为线上精简版**——会丢 20 版块深度与本地引擎入口
- ❌ **不引入强制登录墙**——本地免登录是设计前提；BYOK 是「可选增强」
- ❌ **不砍本地 TTS 358 音色**去迁就线上 6 音色
- ❌ **不引入 51.la 统计 / WorkBuddy 云 SDK vendor**——本地已用 jsDelivr SDK，多余
- ❌ **不做 iframe 外链的逐站复刻**——诗库/词光/Hark 等是第三方站，加入口即可，不搬运

### 3.4 融合后的目标架构（三轨 KEY + 双形态）

```
              ┌──────────────── 前端（本地 body.html + 增量 patch）────────────────┐
              │  KEY 抽屉(可选) → localStorage(lz_ak_*) → fetch 头 x-lz-ak*        │
              │  模型下拉(新版) · 生图双模式 · 草稿防刷新 · 主题/圆标 · 状态徽标      │
              └────────────────────────────┬────────────────────────────────────┘
                                           │ 请求
              ┌────────────────────────────▼────────────────────────────────────┐
              │                   local-api.js（适配层）                          │
              │  KEY 解析优先级：请求头 BYOK > config.json 内置 > 免Key回落(Pollinations/Veda)
              │  /api/config/status(新) · /api/ai/chat · /api/image/generate(both)  │
              │  /api/video/generate · /api/prompts/*(P2) · 21 面板引擎保留         │
              └──────────────┬──────────────────────────┬────────────────────────┘
                             │                          │
                    ┌────────▼────────┐        ┌────────▼────────┐
                    │ Agnes CN/COM    │        │ 商汤 SenseNova   │
                    │ (按 KEY 选通道)  │        │ (生图双模型第二轨)│
                    └─────────────────┘        └─────────────────┘
                             │
                    ┌────────▼────────────────────────────────┐
                    │ engine/（free-ai-studio 去商业版 21 面板） │
                    │ 5 后端 TTS 358音色 · 分镜全链路 · 断点续跑  │  ← 本地独有，不融合掉
                    └─────────────────────────────────────────┘
```

---

## 4 · 待决策 / 余留

- [ ] **融合范围**：P0（推荐先做）/ P0+P1 / 全量 P0+P1+P2？
- [ ] **BYOK KEY 落盘策略**：浏览器 localStorage 明文（同线上）还是 `sessionStorage`（关标签即失效，更安全）？
- [ ] **商汤通道**：本地 config 已预留 sensenova 字段但无真实 Key——双模型生图是否需要用户自备商汤 KEY 才启用（否则降级为「仅 Agnes」）？
- [ ] **模型真实性**：线上 DeepSeek V4 / Agnes 3.0 是否真在 Agnes 网关可用？需实测一轮再写死进下拉（避免列了却报错）
- [ ] **前端注入方式**：独立 patch 脚本（可回滚、幂等）vs 直接改 `body.html`？建议前者，符合项目 `engine/patch.mjs` 既有惯例
- [ ] **线上站资源抓取受限**：`/vendor/*` 返回 403（需浏览器上下文），若要做 1:1 借鉴需走 ego-browser 页面内 `fetch` 导出

---

---

## 5 · 装配执行记录（2026-11-16 18:00 · 用户确认全量 P0+P1+P2 + KEY 双存储可切）

### 5.1 已改动文件

| 文件 | 改动 | 类别 |
|---|---|---|
| `lib/byok.mjs`（新） | 三轨 KEY 解析 + `/api/config/status` 状态回显（不回传明文） | P0 |
| `lib/sensenova-client.mjs`（新） | 商汤 SenseNova 轻量生图客户端（OpenAI 兼容端点） | P0 |
| `local-api.js` | `getAgnes(ctx)` 支持 BYOK 覆盖；`ctxFor(req)`；chat/image/video 端点读请求头；双模型 `model=both` 并行；视频 task 存 `keyCtx` 供轮询；status/test-key 支持 CN/COM 通道 | P0 |
| `public/fusion/patch.js`（新） | BYOK fetch 头注入 + KEY 抽屉（三通道/测试/记住开关）+ 模型下拉增强 + 草稿防刷新 + 圆标方标 + 朗读兜底 + 3 个内容面板入口 | P0/P1/P2 |
| `server.js` | 启动时读入 patch.js、算 MD5 版本、注入 `</body>` | 装配 |

### 5.2 实测验证（ego-browser + curl）

| 项 | 结果 |
|---|---|
| BYOK 头注入全链路 | ✅ 前端 sessionStorage KEY → fetch 头 → 后端 `source:byok`，Agnes/商汤掩码正确 |
| 三轨优先级 | ✅ 有 BYOK 用 BYOK；无则内置 KEY；KEY 失效自动回落免 Key（`pollinations(fallback)`） |
| 模型矩阵 | ✅ 对话下拉首项 Agnes 3.0 Flash，含 DeepSeek V4 Pro/Flash |
| 双模型生图 | ✅ `model=both` 并行 Agnes+商汤，任一成功即回，返回 `dual/results` 两组 |
| UX 套件 | ✅ 徽标/KEY 按钮/圆标方标/3 内容面板/生图模式下拉/草稿钩子全部挂载 |
| doctor 自检 | ✅ 24 项全通过 |
| 语法检查 | ✅ local-api.js / server.js / 2 个 .mjs 全过 |

### 5.3 踩坑记录（复用价值高）

1. **fetch patch 必须写回 `arguments[1]`**：改局部 `init` 变量后 `orig.apply(this, arguments)` 传的还是原参数，注入无效。必须 `arguments[1] = opts`。
2. **app.js 有 4 层 fetch patch，且 `initGenProgress()` 在 DOMContentLoaded 后才包装**：会把我们的 patch 挤到内层甚至覆盖。解法：wrapper 打 `__fusionFetch` 标记 + 定时 `ensureFetchPatch()` 把自己顶回最外层（50/300/1000ms + 1.5s×40 兜底）。
3. **不能给 headers 传 `Headers` 实例**：app.js 内层 patch 用 `Object.assign({}, opts.headers)` 展开，Headers 实例属性不可枚举会被展开成 `{}`，头丢失。必须用普通对象字面量。
4. **WorkBuddy 沙箱后台起服务**：`node server.js &` 会随任务结束被杀；必须用 `exec node server.js` 配 run_in_background 常驻。

### 5.4 余留

- [ ] 模型真实性：`deepseek-v4-*` / `agnes-3-flash` 是否在 Agnes 网关真实可用未逐一实测（列了但可能报错，需真 KEY 才能验）
- [ ] 商汤双模型需用户自备商汤 KEY；无 KEY 时自动降级为仅 Agnes（已实现）
- [ ] 徽标文字在 1.5s 定时刷新前可能短暂显示旧值（纯显示延迟，不影响功能）

---

> 分析方法：REA（Requirements·Extract·Assemble）· 数据来源：ego-browser 实测（2026-11-16 17:43-18:00）
> 本报告分析 + 装配均已完成，代码改动经实测验证通过。
