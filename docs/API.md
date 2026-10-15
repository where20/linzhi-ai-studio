# API 端点清单 · 临智AI (Linzhi AI Studio)

> 从前端 `public/js/app.js` 静态提取的 `/api/*` 端点，按功能模块分类。
> 所有端点均通过本项目的本地代理 `/api/*` → 目标后端 转发，无需前端改动。

---

## 通用

| 端点 | 方法（推测） | 说明 |
|---|---|---|
| `/api/config` | GET | 站点/后端全局配置（含模型清单、后端架构信息） |
| `/api/config/test-key` | POST | 测试 API Key 有效性 |
| `/api/v1/*` | 混合 | v1 通用接口前缀 |

---

## 生图 / 生视频

| 端点 | 说明 |
|---|---|
| `/api/image/generate` | 文生图 / 图生图（后端耗时 20–60s，已设 120s 超时） |
| `/api/seedance/catalog` | 视频模型目录（Seedance） |
| `/api/drama/models` | 剧本/视频模型清单 |

---

## 提示词

| 端点 | 说明 |
|---|---|
| `/api/prompt/optimize` | 提示词优化 ✅ 已验证 200 |
| `/api/pexpert/optimize` | 提示词专家优化 ✅ 已验证 200 |

---

## 漫画 / AI 漫画

| 端点 | 说明 |
|---|---|
| `/api/comic/models` | 漫画模型清单 ✅ 已验证 200 |
| `/api/comic/projects` | 漫画项目列表 |
| `/api/comic/project/{id}` | 项目详情 |
| `/api/comic/generate` | 生成漫画 |
| `/api/comic/redraw` | 重绘 |
| `/api/comic/stop/{id}` | 停止生成 |
| `/api/comic/status/{id}` | 生成状态 |
| `/api/comic/delete/{id}` | 删除项目 |
| `/api/comic/export/{id}` | 导出 |
| `/api/comic/upload-text` | 上传文本 |
| `/api/aimanga/start` | AI 漫画启动 |
| `/api/aimanga/status` | AI 漫画状态 |
| `/api/aimanga/stop` | AI 漫画停止 |

---

## 封面

| 端点 | 说明 |
|---|---|
| `/api/cover/config` | 封面配置 |
| `/api/cover/generate` | 生成封面 |
| `/api/cover/list` | 封面列表 |
| `/api/cover/delete` | 删除封面 |
| `/api/cover/upload` | 上传素材 |
| `/api/cover/parse-doc` | 解析文档 |
| `/api/cover/prompt` | 封面提示词 |
| `/api/cover/retext` | 文案重排 |
| `/api/cover/sensenova-key` | SenseNova Key 配置 |

---

## 小说 / 网文

| 端点 | 说明 |
|---|---|
| `/api/novel/config` | 小说配置 |
| `/api/novel/list` | 小说列表 |
| `/api/novel/load` | 加载小说 |
| `/api/novel/save` | 保存 |
| `/api/novel/creative` | 创意生成 |
| `/api/novel/start` | 开始生成 |
| `/api/novel/status/{id}` | 状态 |
| `/api/novel/stop/{id}` | 停止 |
| `/api/novel/ai_edit` | AI 改写 |
| `/api/novel/ai_edit/status/{id}` | 改写状态 |
| `/api/novel/logic_check` | 逻辑校验 |
| `/api/novel/logic_check/status/{id}` | 校验状态 |
| `/api/novel/zhuque_check` | 朱雀检测 |
| `/api/novel/split/*` | 小说拆分（文件上传/导入/保存/启动/状态/停止） |
| `/api/webnovel/start` | 网文启动 |
| `/api/webnovel/status` | 网文状态 |
| `/api/webnovel/stop` | 网文停止 |

---

## 设计流 / 分镜 (df)

| 端点 | 说明 |
|---|---|
| `/api/df/config` | 设计流配置 |
| `/api/df/start` | 启动 |
| `/api/df/status/{id}` | 状态 |
| `/api/df/stop/{id}` | 停止 |
| `/api/df/design/{id}` | 设计 |
| `/api/df/confirm/{id}` | 确认 |
| `/api/df/text/{id}` | 文本 |
| `/api/df/media/{id}` | 媒体 |
| `/api/df/assets/{id}` | 资产 |
| `/api/df/asset/regen/{id}` | 资产重生成 |

---

## 确定性流程 (determinflow) / 墨 (inkos) / iugn

| 端点 | 说明 |
|---|---|
| `/api/determinflow/start` | 确定性流程启动 |
| `/api/determinflow/status` | 状态 |
| `/api/determinflow/stop` | 停止 |
| `/api/inkos/start` | InkOS 启动 |
| `/api/inkos/status` | 状态 |
| `/api/inkos/stop` | 停止 |
| `/api/inkos/repatch` | 重补 |
| `/api/iugn/config` | IUGN 配置 |
| `/api/iugn/list` | 列表 |
| `/api/iugn/upload` | 上传 |
| `/api/iugn/edit` | 编辑 |
| `/api/iugn/delete` | 删除 |
| `/api/iugn/keys` | Key 列表 |
| `/api/iugn/keys/test` | Key 测试 |

---

## 元宇宙 (cyberverse)

| 端点 | 说明 |
|---|---|
| `/api/cyberverse/catalog` | 目录 |
| `/api/cyberverse/rtp` | 实时原型 |
| `/api/cyberverse/personas` | 角色列表 |
| `/api/cyberverse/persona/get` | 角色详情 |
| `/api/cyberverse/persona/save` | 保存角色 |
| `/api/cyberverse/persona/delete` | 删除角色 |
| `/api/cyberverse/script/generate` | 脚本生成 |
| `/api/cyberverse/script/status` | 脚本状态 |
| `/api/cyberverse/knowledge/add` | 知识库添加 |
| `/api/cyberverse/knowledge/delete` | 知识库删除 |
| `/api/cyberverse/knowledge/search` | 知识库检索 |

---

## 白板 (whiteboard)

| 端点 | 说明 |
|---|---|
| `/api/whiteboard/projects` | 项目列表 |
| `/api/whiteboard/project` | 项目 |
| `/api/whiteboard/upload-image` | 上传图片 |
| `/api/whiteboard/file/{id}` | 文件 |
| `/api/whiteboard/preview` | 预览 |
| `/api/whiteboard/status` | 状态 |
| `/api/whiteboard/gen-lineart` | 生成线稿 |
| `/api/whiteboard/gen-lineart-all` | 批量生成线稿 |
| `/api/whiteboard/parse-srt` | 解析字幕 |
| `/api/whiteboard/annotations` | 标注 |
| `/api/whiteboard/annotation-preview` | 标注预览 |

---

## 公众号 (wechat) / 地理 (geo)

| 端点 | 说明 |
|---|---|
| `/api/wechat/pages` | 公众号页面列表 |
| `/api/wechat/pages/{id}` | 页面详情 |
| `/api/wechat/pages/save` | 保存页面 |
| `/api/wechat/topics` | 话题 |
| `/api/wechat/topics/refresh` | 刷新话题 |
| `/api/wechat/article` | 文章 |
| `/api/wechat/article/compliance` | 合规检测 |
| `/api/wechat/article/deai` | 去 AI 化 |
| `/api/wechat/article/humanize` | 拟人化 |
| `/api/wechat/compose` | 组合 |
| `/api/geo/region` | 地理区域 |

---

## 说明

- 表中「方法」多为推测（前端调用分散），实际以目标后端实现为准。
- 带 ✅ 的端点在逆向过程中已实测返回 200。
- 带 `{id}` 的为路径参数（如 `/api/comic/project/abc123`）。
- 所有端点经本地代理转发，若目标后端闭源能力不可用，会返回对应业务错误（非代理问题）。
