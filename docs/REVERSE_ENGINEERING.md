# 逆向分析记录 · 临智AI (Linzhi AI Studio)

> 本文档记录对目标站点的逆向工程过程、关键发现与结论。仅用于学习研究。

---

## 1. 目标确认

| 项 | 内容 |
|---|---|
| 入口 URL | `https://dfxg.my-place.us/?i=2` |
| 实际后端 | `https://agnes-ai-studio-02306.app.workbuddy.host` |
| 应用名 | 临智AI (Linzhi AI Studio) |
| 类型 | AI 创意工具平台（生图 / 生视频 / 对话 / 漫画等） |

通过 `ego-browser` 技能逐级分析，确认入口域名仅做跳转/分发，真实前端与 API 由 `agnes-ai-studio-02306.app.workbuddy.host` 提供。

---

## 2. 技术栈

- **前端**：单页应用（SPA），原生 JS + CSS 自定义属性（CSS Variables）实现 Apple 风格浮雕质感。
- **主题系统**：6 套主题 token（indigo / emerald / amber / rose / ocean / light）。
- **后端**：混合架构（详见第 5 节）。
- **通信**：REST API，密钥通过 `x-api-key` 与 `Authorization: Bearer` 双头传递。

---

## 3. 前端规模

| 指标 | 数值 |
|---|---|
| HTML 总字符 | ~1,934,801 |
| 总行数 | 34,056 |
| CSS 大小 | ~95,566 字符 |
| JS 大小 | ~1,340,004 字符 |
| 功能 Tab 面板 | 38 |
| 前端 JS 函数 | 1,294 |
| API 端点 | 103 |

前端结构拆分为三部分落地到本项目的 `public/`：
- `index.html` — 页面壳（head + 空 body 占位）
- `body.html` — 完整页面 body（运行时由 server 内联进 index.html）
- `css/style.css` — 全部样式
- `js/app.js` — 全部前端逻辑（392 个关键函数）

---

## 4. 提取过程

1. **iframe 提取**：从 `dfxg.my-place.us` 获取内嵌 iframe 的完整 HTML（约 193 万字符，存于 `outputs/dfxg_iframe_full.html`）。
2. **直连后端**：用 `ego-browser` 直接打开 `agnes-ai-studio-02306.app.workbuddy.host`，二次抓取当前 HTML（`outputs/agnes-current.html`），与首次提取差异仅 11 字符，确认内容稳定。
3. **拆分模块**：将 CSS / body / JS 分离，得到可维护的静态资源。
4. **代理封装**：用 Express + http-proxy-middleware 将 `/api/*` 转发到目标后端，形成本地可运行项目。

---

## 5. 后端架构

从 `/api/config` 及前端调用推断，后端为混合架构：

| 服务 | 地址 / 模型 | 性质 | 可复刻？ |
|---|---|---|---|
| **ComfyUI** | `ohqnxet9m55etpek-8188.container.x-gpu.com` | 开源生图工作流 | ✅ 可自建 |
| **SenseNova** | 商汤生图模型 | 闭源商业 | ❌ 不可 |
| **Agnes Video** | 闭源视频模型 | 闭源商业 | ❌ 不可 |
| **DeepSeek** | 第三方 LLM API | 有 Key 可用 | ✅（自备 Key） |
| **GPT-Image-2** | 第三方生图 API | 有 Key 可用 | ✅（自备 Key） |
| **Doubao TTS** | 字节豆包语音 | 需企业认证 | ⚠️ 受限 |
| **Bangumi API** | 番剧元数据 | 开放 API | ✅ 可复刻 |
| **Ollama** | 本地 LLM | 本地部署 | ✅ 可自建 |

**结论**：后端无法完整复刻——核心 AI 能力依赖闭源商业模型与原站私有业务逻辑。代理转发（本项目方案）是在不破解、不托管后端的前提下，使前端可用的唯一可行路径。

---

## 6. 关键配置（脱敏）

| 项 | 值 |
|---|---|
| 默认后端 target | `https://agnes-ai-studio-02306.app.workbuddy.host` |
| 密钥请求头 | `x-api-key` / `Authorization: Bearer` |
| 前端快照来源 | `outputs/agnes-current.html`（2026-10-14） |

> 真实 API Key 不写入仓库。本项目通过 `API_KEY` 环境变量或 `config.json` 提供。

---

## 7. 已验证的 API 可用性

| 端点 | 方法 | 结果 |
|---|---|---|
| `/api/config` | GET | ✅ 200 |
| `/api/comic/models` | GET | ✅ 200 |
| `/api/prompt/optimize` | POST | ✅ 200 |
| `/api/pexpert/optimize` | POST | ✅ 200 |
| `/api/image/generate` | POST | ⚠️ 504（后端耗时长，非代码问题） |

---

## 8. 踩坑与修复

- **POST body 透传失败**：最初手动读写请求体导致 `ERR_STREAM_WRITE_AFTER_END`，改为依赖 `http-proxy-middleware` 原生透传。
- **生图接口 504**：后端处理 20–60s，代理 `timeout` 提升至 120000ms。
- **CORS**：代理响应头需手动注入 `Access-Control-Allow-*`，并清除上游重复头避免冲突。
- **HTTPS 校验**：仅对 `https://` 且非 localhost 的目标做证书校验。
