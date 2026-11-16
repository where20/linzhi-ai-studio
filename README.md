# 临智AI (Linzhi AI Studio) · 本地复刻代理项目

> 对「临智AI」Web 前端的完整本地复刻 + 可自定义后端代理。前端 UI 1:1 还原，API 请求可代理到任意后端（默认指向复刻网站原站，支持运行时切换）。

---

## ⚠️ 法律与合规声明

本项目为**逆向工程学习用途**，用于研究前端架构、代理转发与可配置后端的实现方式。

- **不提供任何后端服务**：AI 生图/生视频/对话等能力依赖第三方或原站后端，本项目仅做请求转发。
- **闭源能力无法复刻**：原站部分模型（SenseNova、Agnes Video 等）为闭源商业服务，本项目不内置、不破解。
- **密钥自负**：使用原站或自建后端时，请遵守对应服务的使用条款，自行保管 API Key，勿泄露、勿滥用。
- 如权利方认为本项目存在侵权，请联系作者下架。

---

## ✨ 项目特性

| 特性 | 说明 |
|---|---|
| 🖥️ 前端完整复刻 | 38 个功能 Tab 面板、完整样式与交互逻辑 |
| 🔀 可自定义后端 | `config.json` / 环境变量 / 运行时 API 三种方式切换 |
| 🌐 跨域代理 | 自动处理 CORS、透传 API Key 与 Cookie |
| 🔌 运行时管理 | 无需重启即可增删切换后端 |
| 📦 零构建 | 纯 Node + Express，装依赖即跑，无需打包 |

---

## 📁 项目结构

```
linzhi-ai-studio/
├── README.md                 # 本文件
├── package.json              # 依赖与脚本
├── server.js                 # 代理服务器（核心）
├── local-api.js              # 本地适配层（门禁桩 / 配置中心 / AI 直连 / 热点 / 作品墙）
├── config.example.json       # 配置模板（复制为 config.json 使用）
├── .gitignore                # 忽略 node_modules / config.json / output
├── public/                   # 前端静态资源
│   ├── index.html            # 页面壳（运行时内联 body.html）
│   ├── body.html             # 完整页面 body（约 880KB）
│   ├── css/style.css         # 完整样式（约 100KB）
│   └── js/app.js             # 前端逻辑（约 880KB，392 函数）
├── engine/                   # ★ 本地引擎（Free AI Studio 插件 · 去商业版）
│   ├── vendor/               #   上游原始产物（只读，patch 的输入）
│   ├── patch.mjs             #   去商业补丁（幂等，可重复执行）
│   ├── install.mjs           #   装进 Obsidian vault（备份旧版）
│   ├── sync-config.mjs       #   config.json → 插件 data.json（单一配置真源）
│   └── main.js / manifest.json / styles.css / versions.json   # 补丁产物（生成物）
├── scripts/
│   ├── start-all.mjs         # 一键：补丁 → 安装 → 同步 → 起 Web
│   └── doctor.mjs            # 装配自检（14 项）
└── docs/
    ├── REVERSE_ENGINEERING.md  # 逆向分析记录
    └── API.md                  # API 端点清单
```

---

## 🚀 快速开始

```bash
# 1. 安装依赖
cd linzhi-ai-studio
npm install

# 2.（可选）准备后端配置
cp config.example.json config.json
# 编辑 config.json，把 original 的 apiKey 填成你自己的 Key
# 或者直接用环境变量：export API_KEY="你的Key"

# 3. 启动（默认端口 3721）
npm start

# 4. 浏览器打开
open http://localhost:3721
```

> 不填 API Key 也能启动并看到完整前端界面，但调用 AI 能力时后端会拒绝（401/403）。

---

## 🔧 后端自定义（三种方式）

### 方式一：`config.json`（重启或切换生效）

复制 `config.example.json` 为 `config.json`，按需增删后端：

```json
{
  "backends": {
    "original": {
      "name": "复刻网站原站",
      "target": "https://agnes-ai-studio-02306.app.workbuddy.host",
      "apiKey": "你的Key"
    },
    "my-local": {
      "name": "我的本地后端",
      "target": "http://localhost:8080",
      "apiKey": ""
    }
  },
  "active": "original"
}
```

### 方式二：环境变量（仅覆盖默认 original）

```bash
API_KEY="你的Key" PORT=8080 npm start
```

### 方式三：运行时管理 API（无需重启）

```bash
# 查看当前后端
curl http://localhost:3721/api-backend/config

# 切换后端
curl -X POST http://localhost:3721/api-backend/switch \
  -H "Content-Type: application/json" \
  -d '{"backendId":"my-local"}'

# 新增后端
curl -X POST http://localhost:3721/api-backend/add \
  -H "Content-Type: application/json" \
  -d '{"id":"srv2","name":"服务2","target":"http://localhost:9000","apiKey":"sk-xxx"}'

# 删除后端（original 受保护，不可删）
curl -X DELETE http://localhost:3721/api-backend/delete \
  -H "Content-Type: application/json" \
  -d '{"backendId":"srv2"}'
```

---

## 🧩 工作原理

```
浏览器 ──> 本地 Express (3721) ──> /api/* 代理 ──> 目标后端 (target)
            │  ├─ 托管 public/ 静态文件
            │  ├─ 首页内联 body.html
            │  └─ /api-backend/* 后端管理
```

- 每个 `/api/*` 请求到达时，**实时读取当前激活后端**，动态创建代理目标。
- 代理自动设置 `Host`、透传 `x-api-key` / `Authorization`、Cookie，并补全 CORS 响应头。
- 客户端可用 `x-api-key` 请求头临时覆盖密钥（便于多账号测试）。

---

## 📊 原站规模（逆向数据）

| 指标 | 数值 |
|---|---|
| HTML 总字符 | ~1,934,801 |
| 总行数 | 34,056 |
| CSS 大小 | ~95 KB |
| JS 大小 | ~1,340,000 字符 |
| 功能 Tab 面板 | 38 |
| 前端 JS 函数 | 1,294 |
| API 端点 | 103 |

详见 [`docs/REVERSE_ENGINEERING.md`](docs/REVERSE_ENGINEERING.md) 与 [`docs/API.md`](docs/API.md)。

---

## 🚧 已知限制

1. **闭源模型不可用**：SenseNova 生图、Agnes Video 生视频为商业闭源服务，只能通过原站后端调用，无法本地复刻。
2. **生图/生视频延迟高**：部分接口后端处理 20–60s，代理已设 120s 超时，前端需做好 loading 体验。
3. **依赖原站可用性**：默认 `original` 后端依赖第三方托管服务，其稳定性不在本项目控制范围内。
4. **前端为快照复刻**：`public/` 下文件为某一时刻抓取的前端快照，原站更新后需重新抓取。

---

## 📄 License

MIT — 仅供学习研究。

---

## 🚀 V2 · 本地完整版（2026-11-04 升级）

前端已同步线上 V1.8.394（20 版块全量），并在 `local-api.js` 增加本地适配层：

| 能力 | 说明 |
|---|---|
| 🔓 免登录 | 门禁本地放行，无需注册/会员卡 |
| ⚙️ 本地配置中心 | `/api/config` 读写 config.json 的 `ai` 字段（Key 落盘本机） |
| 🤖 AI 直连 Agnes | 对话 `/api/ai/chat`（同步+异步 job）、生图 `/api/image/generate|img2img`、视频 `/api/video/generate` + status 轮询 |
| 📰 热点本地聚合 | 新闻热点/全网热点走 RSS（36氪/IT之家/少数派/极客公园/量子位），30 分钟缓存 |
| 🖼 作品墙 | 本地 JSON 存储（output/gallery.json），发布/撤下可用 |
| 📤 上传 | `/api/upload/image` 本地落盘 output/uploads |

产物统一落盘：`output/pictures|videos|uploads`，经 `/output/*` 同源访问。

**使用**：
```bash
npm start                      # http://localhost:3721
# 可选：config.json 的 ai.api_key 填 Agnes Key（sk- 开头），对话/生图/视频即真实可用
# 未填时登录门禁照样全解锁，AI 调用返回引导提示
```

其余未本地化的 `/api/*` 端点仍兜底代理到原站（可在 config.json 切换后端）。

---

## 🧩 本地一体化：Web 壳 + Obsidian 引擎（2026-11-16）

把两个项目合成**一套东西**：`临智AI` 的 Web 壳（浏览器，20 版块）负责业务面，
`Free AI Studio` 插件（Obsidian）负责**本地流水线**（短剧/数字人/封面/B-roll/InkOS/无限画布/配音/成片）。
两边**共用一份 Key、一套产物目录、一条启动命令**，并且**商业模型全部拆除**。

### 一条命令

```bash
npm run all        # 补丁 → 装插件 → 同步配置 → 起 Web(3721)，并打印两个入口
npm run setup      # 只装配不启动（改完 config.json 后跑 npm run sync 更快）
npm run doctor     # 14 项自检：补丁 / 安装 / Key / 面板 / 残留 / ffmpeg / 软链 / 门禁
```

### 拆了哪些商业模型

| 位置 | 商业元素 | 处置 |
|---|---|---|
| 插件 | VIP 门禁（红果Pro / 数字人 / 封面 / 跳舞 / B-roll / InkOS / 无限画布 / edge-tts / 8 语种） | `isVipActive()` 恒真 —— 插件内 22 处门禁全部收敛到这一个方法，一处改全解锁 |
| 插件 | 顶部赞助广告位（爱发电） | `tryShowAd()` 短路 + 横幅不再挂载 DOM + `adState` 链接/渠道清空 |
| 插件 | 设置页激活码输入 / 设备指纹 / `（VIP）` 命令后缀 | 激活区换成「本地完整版」说明；设备指纹区随激活区一起消失；命令后缀去掉 |
| 插件 | 断网校验 | 无 —— VIP 校验本来就离线（签名封条），不联网、不回调作者 |
| Web 壳 | 登录墙 / 会员卡 / CIAM / 卡号激活 | `local-api.js` 门禁桩：`/api/member/gate → unlocked:true`、`whoami → 本地用户` |

> ⚠️ 这也意味着**不再收到上游 VIP 权益**（作者的激活码/更新服务）；插件本体仍可随上游升级，升级后重跑 `npm run patch` 即重新去商业化（补丁幂等，目标串不匹配会直接报错而不是静默失效）。

### 两个入口，一套配置

| 资源 | 单一真源 | 同步方向 |
|---|---|---|
| API Key / 默认模型 | `config.json` 的 `ai` 段 | → 插件 `data.json`（`agnesApiKey` / `sensenovaApiKey` / `default*Model` …） |
| 面板可见性 | `engine/sync-config.mjs` 的 `ALL_TABS` | → `data.json.visibleTabs` 拉满 20 个（否则解锁了也不显示） |
| 产物目录 | vault 内 `_Agnes`（插件写入） | ← `output/engine` 软链，Web 端 `/output/engine/*` 直接浏览 |
| vault 路径 | `config.json` 的 `local.vault_path` | 或 `OBSIDIAN_VAULT=... ` 覆盖；都缺则自动探测 |

### 分工（为什么不是合成一个 UI）

| | Web 壳（浏览器） | Obsidian 引擎（插件） |
|---|---|---|
| 强项 | 20 版块业务面、免安装、手机也能开 | ffmpeg 长任务、断点续跑、Vault 双链、角色一致性 |
| 弱项 | 无法跑 ffmpeg 长任务，深加工靠代理源站 | 要装 Obsidian，UI 是侧边栏 |
| 结论 | 保持两个入口，共享配置与产物 —— 而不是把 21 个面板重写进 Web（那是重写引擎，不是整合） |

### 故障排查

| 现象 | 处置 |
|---|---|
| 插件面板少了一半 | `npm run sync`（`visibleTabs` 没拉满） |
| 插件里没 Key | `npm run sync`；确认 `config.json.ai.api_key` |
| 升级上游后 VIP 又锁了 | `npm run patch && npm run install-engine` |
| 网页看不到插件产物 | `npm run sync` 重建 `output/engine` 软链 |
| 想还原成付费版 | 把 `.obsidian/plugins/.backup-free-ai-studio-<时间戳>/` 拷回 `free-ai-studio/` |

---

## 🆓 免 Key 通道：断额不断功能（2026-11-16）

从 Free AI Studio bundle 里逆向出三条**零 Key**通路，已接进本地适配层。
Key 额度用完、忘记续费、断网重连后 Key 失效 —— 这三条仍能出文本 / 出图 / 出片。

| 通道 | 能力 | 端点 | 限制 |
|---|---|---|---|
| Pollinations | 文本 + 图片 | `text.pollinations.ai/openai`（OpenAI 兼容）/ `image.pollinations.ai/prompt` | 无 Key、无硬额度；出图约 3–10s |
| imagefree.net | 图片（异步） | `/api/generate` + `/api/generate/status` | 需浏览器 UA/Origin/Referer；有 IP/浏览器级限流 |
| Veda Studio | 视频（异步） | `/api/jobs` + `/api/jobs/{id}` + `/api/jobs/{id}/video` | **每日 20 点**（5s=1 / 10s=2 / 15s=3）；队列可能排 10–20 分钟 |

### 用法

无 Key 时**自动**走免 Key；也可以显式指定：

```bash
# 文本
curl -X POST localhost:3721/api/ai/chat -H 'Content-Type: application/json' \
  -d '{"message":"解释一下什么是本地部署","provider":"free"}'

# 生图
curl -X POST localhost:3721/api/image/generate -H 'Content-Type: application/json' \
  -d '{"prompt":"a green ceramic cup, studio light","size":"768x768","provider":"free"}'

# 视频（免费通道只支持 5/10/15 秒）
curl -X POST localhost:3721/api/video/generate -H 'Content-Type: application/json' \
  -d '{"prompt":"海边黄昏，浪花拍打礁石，镜头缓慢推进","seconds":5,"width":1344,"height":768,"provider":"free"}'
# → { task_id }，再轮询 GET /api/video/status/{task_id}
```

### 两个运维细节（踩过坑才写的）

1. **任务落盘**：`output/.video-tasks.json` —— 免 Key 视频提交即扣额度，服务重启若丢任务就是白扣。
2. **设备标识**：`output/.free-device.json` 固定 `veda_did` —— 换 id 等于换额度池，别让插件每次随机。

### 能力总览与探活

```bash
curl localhost:3721/api/providers          # 列出 keyed / free 全部通道
curl -X POST localhost:3721/api/providers/probe   # 并发实测：文本 / 出图 / Veda 健康 + 配额
npm run doctor -- --online                 # 自检时顺带联网探活（多 5s）
```

### 自动回落（不用手动切）

Agnes 返回「Key 无效 / 额度用尽 / token 不可用」这类错误时，**服务端自动改走免 Key 通道**，
响应里带 `provider: "pollinations(fallback)"` 和说明。也可以强制免 Key：`config.json` 里 `ai.prefer_free: true`。

| 场景 | 行为 |
|---|---|
| 有 Key 且正常 | 走 Agnes（图生图/参考图只有它有） |
| Key 失效 / 额度尽 | 自动回落免 Key，用户无感 |
| 图生图 + Key 失效 | 无法回落（Veda/Pollinations 无参考图能力），返回明确提示 |
| 视频 + Key 失效 | 自动回落 Veda（消耗 1 点起） |

> **水印**：Pollinations 即使 `nologo=true` 仍会带角标，落盘前用本机 ffmpeg 裁掉底部 6%
> （`crop=iw:trunc(ih*0.94/2)*2:0:0`）。想保留原图设 `FREE_IMAGE_CROP=0`。

> 协议细节与逆向过程见 [`docs/free-ai-studio/ENGINE-MAP.md`](./docs/free-ai-studio/ENGINE-MAP.md)。

---

## 🎬 本地分镜工作台（2026-11-16）：替掉走源站的 dramapro

`/studio/storyboard.html` —— 单页工具，10 种模式，**全部在本地跑**（不再点一下就报"需要会员"）。

### 10 种模式（提示词从插件 bundle 里原样提取，一字未改）

| 模式 | 体系 | 用途 |
|---|---|---|
| 自由写作 / 短剧大纲 / 分镜脚本 / 提示词优化 | 轻 | 日常出稿 |
| **剧本体检** | 重（3.6k 字 prompt） | 只诊断不改稿：先判「能不能开拍」，再按优先级列改法 |
| **按报告改写** | 重 | 严格只改报告列出的问题，其余一字不动 |
| **70 集拆分** | 重 | 小说正文 → 70 集片段大纲，每集约 210 字 |
| **锁定码定妆** | 重（4.3k 字 prompt） | 角色 P / 道具 W / 坐骑 M 编号 + desc + prompt，锁跨镜一致性 |
| **分镜八步** | 重 | 定妆→镜数拆分→台词归属→性别一致→称谓不改 |
| **首尾帧继承** | 重 | 给已定稿分镜补首帧/尾帧提示词 |

### 为什么值得抄

插件里最硬的一条约束是**台词字数预算**：

```
镜数 × 每镜秒数 × 4.05 字/秒  →  台词上限（下限 = 上限 × 0.9）
例：10 镜 × 12 秒 = 120 秒 → 上限 486 字，下限 437 字
```

超过就"念不完"。这不是经验值，是它整套流水线判断"能不能开拍"的依据 —— 已做成工具页右侧的实时计算。

另外两条一致性铁律（写在分镜八步 prompt 里）：
- **称谓与年龄一律沿用剧本原文**，不许把成年角色改叫"老人/中年"、也不许把孩子改叫"婴儿/幼童"
- 同一场戏里台词归属要交替，同一个人不得连说 3 句以上

### 提示词是「提取」不是「手抄」

```bash
node scripts/extract-prompts.mjs          # 从 engine/vendor/main.js 抽 → lib/storyboard-prompts.mjs
node scripts/extract-prompts.mjs --check  # 只校验产物在不在
```

6 个重模式 system prompt（1.6 万字）+ 6 个 user 模板 + 4 个轻模式，全部按上游原文生成；
插值常量（画幅 1280×720 / 定妆前缀 P/W/M / 连说上限 2 / 同质化阈值 3）一并抓出来。
**上游升级后重跑即可同步**，不用人肉 diff。

### API

```bash
GET  /api/local/storyboard/modes          # 模式清单 + 台词预算默认值
POST /api/local/storyboard/run            # {mode, input, extra, provider} → job_id
GET  /api/local/storyboard/status/:id     # 轮询（completed 时带 text + json_result）
GET  /api/local/storyboard/list           # 历史
GET  /api/local/storyboard/:id            # 单条全量（含 prompt 与原文）
```

产物落 `output/storyboards/<jobId>.json`，重启不丢（含 system/user prompt 原文，方便日后复现）。

### 逐镜出图（分镜 → 画面，纯本地免 Key）

工具页结果区点「逐镜出图」，或：

```bash
POST /api/local/pipeline/run   {text:"<分镜文本>", limit:3, width:1024, height:576}
GET  /api/local/pipeline/status/:id
GET  /api/local/pipeline/list
```

链路：**解析镜头 → 批量英译提示词 → 逐镜免 Key 出图 → 落盘 `output/pictures` + `output/pipelines/<id>.json`**

#### 为什么必须中间加一步英译

实测教训：免 Key 出图通道**读不懂中文**。「雨夜办公楼外窗」会出成「山谷河流」、
「室内昏暗，人在电脑前」会出成「日式空会议室」。加上一步批量英译后，画面立刻对上了。

> 中文留给人看，进模型前统一转英文 —— 这是这类免费通道能用的前提，不是可选优化。

#### 真实性限制（写在代码里的常量）

| 通道 | 限制 | 应对 |
|---|---|---|
| Pollinations 文本 | **1 次回复 / 45 秒 / IP**，超了 402 `FREE_LIMIT`（响应体带 `Retry after Ns`） | 全局闸门 `POLLINATIONS_INTERVAL_MS`（默认 7s）+ 读 retry-after 等够再试一次 |
| Pollinations 出图 | 同样按 IP 限流 | 同上；失败即切 imagefree |
| imagefree | 单次请求 10–20 秒，队列排队 | 提交 60s / 轮询 60s / 总超时 8 分钟，轮询间隔 5s |

所以 3 镜出图约 2–4 分钟是正常速度，不是卡住。想要快就配一把 Agnes Key（`config.json.ai.api_key`）。

#### 主站入口

主站右下角有个「🎬 本地分镜」浮标（`public/studio/entry.js`，由 server.js 注入，× 可隐藏，
按会话记忆）。不想用浮标直接记 URL：`/studio/storyboard.html`。

### 合成视频（分镜 → 成片，Ken Burns + 硬字幕）

工具页出图完成后点「合成视频（含字幕）」，或：

```bash
POST /api/local/storyboard/render   {pipeline_id:"pl...", width:1280, height:720, subtitle:true, use_desc:false}
GET  /api/local/storyboard/render/status/:id
GET  /api/local/storyboard/render/list
GET  /api/local/storyboard/ffmpeg        # 探测字幕能力
```

链路：**逐镜图 → 缓慢推镜片段（zoompan）→ 拼接 → 烧字幕 → （可选）混 BGM → `output/videos/`**

#### 本机 ffmpeg 的一个坑（已在代码里绕过）

| 二进制 | libass | 用途 |
|---|---|---|
| `/opt/homebrew/bin/ffmpeg` 8.1 | ❌ 无 | 拼片、zoompan（快、新） |
| imageio_ffmpeg 静态构建 v7.1 | ✅ 有 | **只用来烧字幕** |

所以是「两条 ffmpeg 分工」，不是随便挑一个。探测逻辑会自动找带 `subtitles` 滤镜的二进制，
找不到就输出无字幕成片并在响应里说明原因（`subtitle_reason`），不会静默失败。

#### 字幕样式（按你的偏好定的）

底部 · 小号（`height/40`）· 白字黑描边 · **无底色块** · 1–2 行、
**按标点断行**（「林律师，你丈夫在临市，/ 他说不认识你。」），不会在词中间断开或溢出画面。
没台词的镜头默认不出字幕（画面描述太长会糊满屏幕），需要时勾「无台词时用画面描述当字幕」。

---

## 🔗 主站内嵌（不只是浮标）

| 位置 | 做了什么 |
|---|---|
| 右下角浮标 | 🎬 本地分镜 → 工具页，× 可隐藏（会话级记忆） |
| **剧本分镜 → 分镜工作台1** | 源站这个子页是 `fjgzt1.html`，本地原本 **404**。现在用 `public/fjgzt1.html` 顶上——内嵌本地工作台（`?embed=1` 隐藏顶栏） |
| 版块顶部提示条 | 进入「剧本分镜」自动注入一条说明 + 「去本地工作台 →」按钮 |

深链：`/?tab=fjgzt` 可直达该版块（也方便自动化截图核验）。

---

## 🔊 免费 TTS（五个后端，自动降级）

分镜成片可以带配音了。**全部不需要任何 Key，不产生任何费用**。五个后端，按速度与依赖排序：

| 后端 | 成本 | 中文音色 | 依赖 | 实测 |
|---|---|---|---|---|
| **edge-tts**（默认） | 免费、无 Key | 10 个（晓晓/云希/云健/东北话/粤语…） | `pip install edge-tts` | 1.8s/句，4.2s 音频 25KB |
| **本机 VoxCPM** | 免费、**离线** | default + 任意克隆音色 | 本机已装 1.9GB 模型 | 首合成 44.8s（含 28s 加载），常驻后 7.8s/句 |
| **本机 matrix** | 免费、无 Key | **327 个** | 本机 `mcode-tools` 已登录 | 3.8s/句 |
| **macOS say** | 免费、**离线** | 20 个（Tingting/Eddy/Flo…） | 系统自带，零安装 | 1.6s 出 3.9s 音频 |
| **custom** | 看你的服务 | 取决于后端 | OpenAI 兼容 `/audio/speech` | 填 `config.json` 的 `ai.tts_*` |

### 为什么不把豆包当默认

火山引擎（豆包语音）**要收费**，只是有试用期：

| 项目 | 额度 / 价格 |
|---|---|
| 语音合成免费额度 | 2 万字符，**半年**有效，用完即止 |
| 公版音色（Seed-TTS） | 6.5 元/万字符 |
| 复刻音色 | 8 元/万字符 |
| 音色年费 | 150 元/个 + 1 元/月存储费 |
| 开通正式版后 | 试用音色要**在控制台下单购买**才能用 |

免费额度只够测几次（2 万字符 ≈ 30 分钟音频）。本项目的 5 个免费后端无限量、零 Key，
所以豆包只作为 `custom` 通道的**可选目标**，不占默认位。

### 三个免费后端怎么选

| 场景 | 选 |
|---|---|
| 日常配音、图快 | `edge`（默认） |
| 要**克隆自己的声音**（给一段参考 wav + 逐字稿，零样本复刻） | `voxcpm` —— 唯一支持克隆的 |
| 要**多音色/方言/情感** | `matrix`（327 个音色，含 `male-qn-qingse` 这类方言音色） |
| 完全断网、机器上啥都没有 | `say` |

### 本机 VoxCPM：唯一能克隆音色的免费后端

模型已装在 `~/DevSpace/VoiceCraft-voxCPM`（1.9GB + venv），**不用再装**。

```bash
# 探测
node -e "import('./lib/tts_voxcpm.mjs').then(m=>console.log(m.probeVoxCpm()))"

# 克隆音色：把 参考.wav + 参考.txt 放到一个目录
export VOXCPM_VOICES_DIR=/path/to/voices   # 里面放 alice.wav + alice.txt（逐字稿）
# 之后音色下拉里就会出现「克隆音色：alice」
```

⚠ 首次合成要 28 秒加载权重 —— worker 常驻不卸载，**第二条起只要 7.8 秒**。
⚠ 不监听端口，直接 spawn Python 子进程，用 stdin/stdout 的 JSON 行对话。
⚠ Node 崩了 Python 会变孤儿，worker 把 PID 写进 `worker.pid`，下次拉起前先杀旧的。

### 关键坑：edge-tts 的签名会过期

```
403 WSServerHandshakeError ... Sec-MS-GEC-Version=1-143.0.3650.75
```

微软 2026-10 把 `Sec-MS-GEC-Version` 从 `1-` 升到 `2-`，**旧版 edge-tts 全线 403**（插件当年是逆向重实现的签名）。
解法一条命令：

```bash
python3 -m pip install -U edge-tts      # 7.2.8 → 7.3.1 即恢复
```

`npm run doctor` 会读出当前签名版本，v1 直接告警提示升级 —— 不用等它某天突然哑了再排查。

### 关键坑：matrix 配音是间歇性限流的

实测 4 次里约 3 次被拒，错误原文写着 `connector_busy`。
`lib/tts_matrix.mjs` 做了三件事扛住它：

1. **批量接口**（一次 10 段）—— 限流暴露从「每镜一次」降到「整批一次」；
2. **分轮重试** —— 批量接口整批返回 `code=0` 但批内每段各自被拒（`failed_items` 带 index），
   所以必须把失败的那几段挑出来单独再发一轮，不能只看整批成功与否；
3. **读 stderr 尾部** —— mcode-tools 是 Electron 壳，stderr 开头永远是噪声，
   真正有用的 `connector_busy` 在**最后一行**。只取前 300 字符会漏掉限流特征 → 退化成硬报错。

### 用法

```bash
# 音色清单（含可用性）
curl localhost:3721/api/local/tts/voices

# 某个后端的完整音色表（voxcpm / matrix 要现场查）
curl localhost:3721/api/local/tts/voices/matrix

# 单句合成
curl -X POST localhost:3721/api/local/tts/synthesize -H 'Content-Type: application/json' \
  -d '{"text":"林律师，你丈夫在临市。","voice":"zh-CN-YunxiNeural"}'
# → { audio_url:"/output/audio/tts_xxx.mp3", duration:4.58, provider:"edge" }
```

工具页「合成视频」那一行现在有：**台词配音开关 + 音色下拉**（按后端分组，voxcpm/matrix 分组实时拉取）。
成片时逐镜合成、按镜长 pad/trim、拼成整轨再 mux；没台词的镜头自动补静音。
有配音时 BGM 自动压到 18% 当底噪。

实测音量分布（3 镜，只有第 2、3 镜有台词）：

| 时间 | 内容 | mean_volume |
|---|---|---|
| 0–4s | 无台词 | **-91.0 dB**（静音） |
| 4–9s | 台词配音 | -24.6 dB |
| 9–13s | 台词配音 | -29.5 dB |
