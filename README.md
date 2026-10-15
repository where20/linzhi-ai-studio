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
├── config.example.json       # 配置模板（复制为 config.json 使用）
├── .gitignore                # 忽略 node_modules / config.json
├── public/                   # 前端静态资源
│   ├── index.html            # 页面壳（运行时内联 body.html）
│   ├── body.html             # 完整页面 body（约 880KB）
│   ├── css/style.css         # 完整样式（约 100KB）
│   └── js/app.js             # 前端逻辑（约 880KB，392 函数）
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
