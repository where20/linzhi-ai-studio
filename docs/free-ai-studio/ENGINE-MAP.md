# Free AI Studio · 引擎地图（逆向提取）

> 来源：`engine/vendor/main.js`（v0.18.0，esbuild 单文件，2.0MB，**无 sourcemap、无模块注释**）
> 方法：字符串聚类 + 关键路径上下文提取 + 真实请求验证
> 日期：2026-11-16 · 所有"已实测"标记均在本机跑通

---

## 0 · 一句话结论

这个 bundle 的真正价值不是 UI（21 面板可复刻），而是它把 **12 家厂商 + 3 条免 Key 通道 + 3 个 TTS 引擎**
收敛在同一套调用约定下。**免 Key 通道是本项目最该拿走的东西** —— 它解决的是"断 Key 就断功能"。

---

## 1 · 厂商与端点（从 `u$` 表提取，12 家）

| id | Base URL | 备注 |
|---|---|---|
| agnes | `https://api.agnes-ai.cn/v1` | 插件默认主 Key，回退链终点 |
| deepseek | `https://api.deepseek.com/v1` | |
| gpt | `https://api.openai.com/v1` | |
| qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 兼容模式 |
| doubao | `https://ark.cn-beijing.volces.com/api/v3` | 火山方舟 |
| minimax | `https://api.minimaxi.com/v1` | |
| sensenova | `https://token.sensenova.cn/v1` | 商汤 |
| zhipu | `https://open.bigmodel.cn/api/paas/v4` | GLM / CogView / CogVideo |
| ollama | `http://localhost:11434/v1` | 本地，自动探测 + 5 分钟轮询 |
| ovh | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | **免费额度**（Llama / Mistral / Qwen3.5 / SDXL） |
| pollinations | `https://text.pollinations.ai/openai` | **免 Key** |
| blockrun | `https://blockrun.ai/api/v1` | **免 Key**（nemotron 等） |

> ⚠️ 注意区分：插件里 `api.agnes-ai.cn`（源站域名），本项目 Web 侧直连用的是
> `apihub.agnes-ai.com/v1`（Agnes 官方 API）。两者不是同一入口，Key 也不通用。

### Key 回退链（原实现）

```
自定义模型 → {vendor}_key → text_api_key → agnes 全局 Key → agnes_extra_keys[0]
```

---

## 2 · 三条免 Key 通道（★ 全部已实测跑通，已搬进本项目）

### 2.1 Pollinations — 文本 + 图片

```
POST https://text.pollinations.ai/openai           # OpenAI 兼容，无 Authorization
     { model:"openai-fast", messages:[...], max_tokens, temperature }
     → { choices:[{ message:{ content, reasoning } }] }

GET  https://image.pollinations.ai/prompt/{prompt}?width=1024&height=1024&nologo=true&model=flux
     → 直接返回图片字节（jpeg/png）
```

- 实测：文本 2.7s 返回、出图 43KB/768×768 ✅
- `nologo=true` 已去掉水印；插件另外还会裁底部 6% 兜底（本项目未做，实测无必要）
- 同一个 prompt 固定 seed 可复现

### 2.2 imagefree.net — 文生图（异步任务）

```
POST https://imagefree.net/api/generate
     headers: Content-Type: application/json
              User-Agent: <Chrome UA>            ← 必须，缺了被拒
              Origin: https://imagefree.net
              Referer: https://imagefree.net/
     body: { prompt, aspect_ratio }               # aspect_ratio: 1:1 / 16:9 / 9:16 / 4:3 / 3:4
     → { taskId } | { errorCode, error }

GET  https://imagefree.net/api/generate/status?taskId=xxx
     → { status:"completed", image:"<url>" } | { status:"failed", error }
```

- 限流错误码：`FREE_TASK_IP_ACTIVE` / `FREE_GENERATION_ACTIVE` / `FREE_TASK_BROWSER_ACTIVE`
- 原实现：提交重试 4 次（6s 递增退避）、并发闸门 2、轮询 4s 间隔、总超时 6 分钟
- 画幅自动从 `size`（如 1024x1365）就近取整到 5 档

### 2.3 Veda Studio — 文生视频（设备额度制，★ 最有价值）

```
GET  /api/health                        → { ok, backend, queue_len, wait_s, slots_free, tasks… }
GET  /api/config                        → { durations:[{value:5,…}], aspects:[{value:"16:9",width,height}],
                                            daily_limit:20, credit_costs:{5:1,10:2,15:3}, turnstile_site_key }
GET  /api/quota      (Cookie veda_did=) → { daily_limit, used, remaining, resets_at }
POST /api/jobs       (Cookie veda_did=) → { job_id }
     body: { prompt, mode:"enhance"|"raw", duration:5|10|15, aspect:"16:9", seed:null, turnstile_token:null, refs:[] }
GET  /api/jobs/{id}                     → { status, progress, enhanced_prompt }
GET  /api/jobs/{id}/video               → mp4 字节
```

**实测踩到的坑（本人踩过，记下来）**：

| 坑 | 现象 | 解法 |
|---|---|---|
| `mode` 不是任务类型 | `HTTP 400 invalid_params: mode: Input should be 'enhance' or 'raw'` | 传 `enhance`（用 LLM 扩写提示词）或 `raw` |
| 提示词长度下限 32 | 短 prompt 直接拒 | 不足 32 字符时自动补镜头语言尾巴 |
| 设备额度按 cookie 计 | 换设备 id = 换额度池 | `veda_did` 必须持久化到磁盘，别每次随机 |
| 队列很长 | `wait_s` 可达 500s+，状态在 `queued/processing` 之间来回 | 轮询要能熬 10-20 分钟；**任务状态必须落盘**，否则重启就丢，额度白扣 |
| turnstile | 403/429 时可能要求人机验证 | 命中即放弃并提示，别硬试 |

- 5s=1 点 / 10s=2 点 / 15s=3 点，每日 20 点（约 20 条 5s 片）
- 分辨率由 aspect 决定：16:9→1344×768、9:16→768×1344、4:3→1024×768、1:1→768×768

---

## 3 · 模型目录（从 `vg` / `Oy` / 视频表提取）

**文本（24）**：agnes-3.0-flash / agnes-2.5-flash / MiniMax-M3 / agnes-2.5-pro-alpha / agnes-2.0-flash /
deepseek-v4-flash / deepseek-chat / deepseek-reasoner / qwen-turbo / qwen-plus / doubao-pro-32k / doubao-lite-32k /
sensenova-6.8-flash-lite / sensenova-6.7-flash-lite / ovh:Meta-Llama-3_3-70B-Instruct / ovh:Mistral-Small-3.2-24B /
ovh:Qwen3.5-397B-A17B / pollinations:openai-fast / blockrun:nvidia/nemotron-3.5-lightning / zhipu:glm-4.7-flash /
ollama qwen2.5:7b / 14b / llama3.1:8b / mistral:7b

**图像（13）**：agnes-image-2.5/2.1/2.0-flash / sensenova-u1.5-lite / u1.5-fast / u1-fast / doubao-seedream-3-0 /
minimax-image-01 / qwen-image-plus / **imagefree** / ovh:stable-diffusion-xl / **pollinations:image** / zhipu:cogview-3-flash

**视频（8）**：agnes-video-2.5-flash / agnes-video-2.5 / MiniMax-H3 / agnes-video-v2.0 / minimax-video-01 /
doubao-seaweed-t2v / qwen-video-gen / zhipu:cogvideox-flash

> 图像里带 `inpaintCapable:true` 的只有 Agnes 2.5/2.1/2.0-flash —— 图生图专用。

---

## 4 · 门禁结构（为什么一处改全解锁）

```js
// 唯一的判定方法，22 处调用都吃它
isVipActive(){ return this.vipState?.active === !0 }

// 四个"锁定判断"工具函数，全部形如 !vip && 名单命中
function FE(n,e){return !e && YB.includes(n)}   // VIP 命令
function tl(n,e){return !e && ZB.includes(n)}   // VIP 面板（从 tab 栏隐藏）
function OE(n,e){return !e && eV.includes(n)}   // VIP 语种（8 种）
function NE(n,e){return !e && QB.includes(n)}   // VIP TTS 引擎（edge）

YB=["open-pro","open-anchor","open-cover","open-dancer","open-broll","open-inkos","open-canvas","open-whiteboard"]
ZB=["pro","anchor","cover","dancer","broll","inkos","canvas","whiteboard"]
eV=["ja-JP","ko-KR","ru-RU","ar-SA","hi-IN","es-ES","fr-FR","de-DE"]
QB=["edge"]
```

**关键**：`vipActive=true` 时四个函数一律返回 `false`（不锁）→ 一处改全解锁。本项目 `engine/patch.mjs` 正是这么做的。

广告位同理收敛在 `tryShowAd()` + `Kp` 横幅组件两处，短路 + 不挂载即可。

---

## 5 · 面板 → 面板能力（本项目能复用的部分）

| 插件面板 | 可复用资产 | 本项目状态 |
|---|---|---|
| text | 4 模式 + 6 种剧本质量 prompt | ✅ 已全量提取（`lib/storyboard-prompts.mjs`，10 模式） |
| image / video | 多厂商路由 + 免 Key 兜底 | ✅ 已搬（`lib/free-providers.mjs`） |
| tts | 豆包 Seed-Audio / Audio8 本地 / edge-tts v2 签名 | ⏳ 未搬（Web 侧豆包 TTS 仍走代理） |
| drama / pro | 七阶段幂等流水线 + 分镜模板 | ❌ 流水线在插件内，Web 侧不复刻 |
| cover | Canvas 2D 排版（不依赖 PIL/ffmpeg） | ⏳ 可单独搬 |
| whiteboard | OpenCV 确定性渲染 | ❌ 需 Python 引擎 |
| broll / inkos / canvas | Vault 语义强绑定 | ❌ 不适合 Web |

---

## 6 · 本项目已落地的改造

| 能力 | 位置 | 说明 |
|---|---|---|
| 免 Key 文本 | `lib/free-providers.mjs` → `/api/ai/chat` | 无 Key 或 `provider:"free"` 时走 Pollinations |
| 免 Key 生图 | 同上 → `/api/image/generate` | Pollinations → imagefree 依次回落，落盘 `output/pictures` |
| 免 Key 视频 | 同上 → `/api/video/generate` | Veda 提交+轮询+拉回本地，落盘 `output/videos` |
| 任务持久化 | `output/.video-tasks.json` | 重启不丢任务（免 Key 任务额度已扣，丢了就白扣） |
| 设备标识持久化 | `output/.free-device.json` | Veda `veda_did` 固定，额度池不漂移 |
| 能力总览 | `GET /api/providers` | 列出 keyed / free 全部通道与用法 |
| 探活 | `POST /api/providers/probe` | 并发测文本/出图/Veda 健康与配额 |

---

## 7 · 提示词提取（2026-11-16 补充）

10 种模式的 prompt 全部从 bundle 抽出，见 `lib/storyboard-prompts.mjs`（由 `scripts/extract-prompts.mjs` 生成）。

| 上游短名 | 模式 | system 字数 | user 模板 |
|---|---|---|---|
| gA / hA | 剧本体检 | 3653 | `hA(n)` 拼「本集目标 + 本集剧本」 |
| mA / fA | 按报告改写 | 1370 | `fA(n, 报告)` |
| bA / vA | 70 集拆分 | 1269 | `vA(n)` |
| yA / SA | 锁定码定妆 | 4366 | `SA(n, {propsMax})` |
| wA / xA | 分镜八步 | 1820 | `xA(n, 镜数, 秒数)` |
| EA / PA | 首尾帧继承 | 3399 | `PA(分镜词, 定妆清单)` |

**被抽取的插值常量**（这些是插件的"隐含参数"，不抓出来 prompt 就跑不通）：

| 常量 | 值 | 含义 |
|---|---|---|
| `uA` | `1280×720` | 默认画幅 |
| `fH` / `bH` | `768x1024` / `1024x768` | 竖版/横版出图尺寸 |
| `vH` | `9:16` | 默认比例 |
| `cA` | `2` | 同一个人最多连说几句 |
| `dA` | `3` | 同质化判定：N 场以上同一套动作即"节奏单一" |
| `ci` | `{P, W, M}` | 定妆编号前缀：角色/道具/坐骑 |
| `pA` | `(镜数, 秒数, 4.05)` | 台词字数预算，**4.05 字/秒** 是中文配音实际语速上限 |
