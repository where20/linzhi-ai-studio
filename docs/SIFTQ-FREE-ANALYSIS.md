# SiftQ 免费生成方法 · 逆向分析

> 分析日期：2026-11-17 · 方法：社区逆向（HaizhuAI/HaizhuVideo-H3Gateway, 2026-09）+ 本地实测验证
> 目标：搞清 `siftq.com/minimax-h3/try` 匿名试用通道的免费机制，评估能否融合进本地 linzhi-ai-studio
> 说明：本文只做机制分析，不含可直接运行的绕过脚本；商业使用请遵守 SiftQ 服务条款。

---

## 0 · TL;DR

| 问题 | 结论 |
|---|---|
| 免费通道是什么 | MiniMax H3 图生视频的**匿名试用接口** `/api/minimax-trial/*`，无需账号/Cookie/付费 |
| 免费额度 | 匿名 2 次/天，登录 4 次/天（今天实测 `usage` 仍返回此值，`enabled:true`） |
| 限流键是什么 | **`X-Forwarded-For` 头的第一个值**——服务端只认客户端自报的 IP |
| 怎么"突破" | 每次提交伪造一个随机公网 XFF + 新 client id；429 就换 IP 重来。换 client id / UA 无效，换 XFF 立即重置 |
| 生成通道 | 必须走 `/showcase/video-generation`，`prompt` 才生效；但**只支持 9:16 竖屏**（上游硬限制） |
| 当前门槛 | 生成端点已被 **Cloudflare challenge** 保护（今天实测 `cf-mitigated: challenge`），但 `usage` 接口裸 curl 仍可访问 |
| 能否融合本地 | 技术上可行，但**有合规与稳定性风险**，建议作为 Veda 之外的备选，不作为主力（见 §5） |

---

## 1 · 接口全貌

### 1.1 鉴权：三无接口

试用接口**没有任何账号/Cookie/签名鉴权**，完全信任客户端自产的三个标识：

| 标识 | 载体 | 前端生成规则 | 作用 | 今天实测 |
|---|---|---|---|---|
| `client_id` | 头 `X-MiniMax-Trial-Client` + 表单 `client_id` | `mmtrial_<uuid>`，存浏览器本地 | 任务归属 | 换值**不影响**配额 |
| `visitorId` | 表单 `visitorId` | `mmguest_<uuid>`，存浏览器本地 | 遥测 | 不影响配额 |
| `X-Forwarded-For` | HTTP 头 | 浏览器不发，前端/代理写入 | **服务端限流键** | 换值**立即重置**配额 |

> 接口无 `Set-Cookie`（`credentials:"include"` 是摆设），cookie 与试用通道完全无关。

### 1.2 额度状态接口（今天实测可用）

```
GET /api/minimax-trial/usage
headers: X-MiniMax-Trial-Client: mmtrial_<uuid>, X-Forwarded-For: <ip>
```
返回（2026-11-17 实测，换两个不同 XFF 各自 remaining=2）：
```json
{"enabled":true,"authenticated":false,"limit":2,"used":0,"remaining":2,
 "bonus_remaining":0,"anonymous_daily_limit":2,"authenticated_daily_limit":4,"max_concurrent":5}
```

### 1.3 生成端点：两条通道，行为不同

| 端点 | prompt | 画幅 | 说明 |
|---|---|---|---|
| `/api/minimax-trial/video-generation` | ❌ 忽略 | 任意 | 无 showcase 时的试用口；服务端固定套用 showcase 编排（一律产出"跳舞"类内容） |
| `/api/minimax-trial/showcase/video-generation` | ✅ 生效 | **仅 9:16** | `showcase_id` 必填但显式 `prompt` 会覆盖；匿名可用 |

关键点：
- 想让提示词真正控制出片，**必须走 showcase 通道**；
- `showcase_id` 用公开值（社区实测 `case-mtqzygu8`）兜底；
- `size` 只支持 `9:16`，其他画幅返回 400（官方前端同样写死，是上游硬限制）；
- 时长档：6 / 10 / 15 秒（社区网关把 4-7→6、8-12→10、13-20→15）。

---

## 2 · 限额机制与绕过逻辑（社区实测结论）

服务端限额逻辑：
- 匿名每日 2 次，按 **XFF 第一个值**计数；
- 超出返回 `429 rate_limit_error`；
- 换 `mmtrial_` client id → **无效**（仍 429，usage 显示 `used:2`）；
- 换 UA → **无效**；
- **伪造 XFF → 立即重置配额**（社区实测 4/4 成功，`remaining` 回 2）。

社区网关的"轮换引擎"做法：
1. 每次提交铸造新 `mmtrial_<uuid>` + `mmguest_<uuid>` + 随机公网 XFF；
2. 每个假 IP 理论 2 次/天，429 就烧毁当前身份、铸新身份重试；
3. 提交时限默认 900s，近似无限轮换；并发受信号量控制（上游上限 5）；
4. 后台 poller 每 3s 轮询上游到终态，结果落 SQLite；出片即本地缓存（上游约 1-2 天回收任务）。

另外两条未采用的路径（成本高/不可得）：
- `/api/minimax-experience/admin/accounts` + `X-MiniMax-Admin-Key` 可铸 2000 积分体验账户——但 key 在站方手里；
- 登录走 Google Firebase idToken——账号农场成本高。

---

## 3 · 今天的实测验证（2026-11-17）

| 项 | 方法 | 结果 |
|---|---|---|
| 试用页 HTML | `curl /minimax-h3/try` | HTTP 403 / 浏览器显示 Cloudflare "正在进行安全验证" |
| usage 接口（裸 curl + 伪造 XFF） | `curl /api/minimax-trial/usage -H "X-Forwarded-For: …"` | ✅ 200，返回完整额度 JSON |
| 不同 XFF 各自配额 | 换两个 IP 请求 | ✅ 均 `remaining:2`（证明按 XFF 分流） |
| 不同 client_id 同 XFF | 换两个 client id | 配额相同（证明 client id 不影响限流） |
| 生成端点可达性 | `OPTIONS /showcase/video-generation` | ❌ `cf-mitigated: challenge`，被 Cloudflare 挡 |

**与 9 月逆向文档的差异**：生成端点新增了 Cloudflare challenge。`usage` 仍裸奔，但真正提交生成需要过 CF 挑战——这大幅提高了纯 HTTP 客户端直接调用的门槛（社区网关若仍可用，需带 CF cookie 或真实浏览器上下文）。

---

## 4 · 与本地已有免 Key 通道对比

| 通道 | 类型 | 额度 | 画幅 | 稳定性 | 本地状态 |
|---|---|---|---|---|---|
| **Veda Studio** (`veda.hanxiao.run`) | 设备额度 | 20 点/天，5/10/15s=1/2/3 | 多种 | 已跑通，队列波动大 | ✅ 已接入 `lib/free-providers.mjs` |
| **Pollinations** | IP 限流 | 1 次/45s/IP | 图片 | 稳 | ✅ 已接入（文本/出图） |
| **SiftQ 匿名试用** | IP 伪造 | 2 次/天/IP，可轮换 | **仅 9:16** | ⚠️ CF challenge + 上游回收任务 | ❌ 未接入 |

结论：SiftQ 的边际价值在于"**竖屏短剧**"场景（9:16 正好匹配短剧/口播），以及 Veda 额度耗尽时的补充。但它有 CF 门槛、画幅单一、且属灰色通道，不适合做主力。

---

## 5 · 融合建议（待决策）

**不建议直接融合为默认通道**，理由：
1. 生成端点已被 Cloudflare challenge 保护，纯服务端调用不稳；
2. "伪造 XFF 无限轮换"属规避平台限额，稳定性与合规性都差（平台随时可修）；
3. 本地 Veda 通道已跑通且画幅灵活，够用。

**如果确实要接**（比如专门做 9:16 短剧且 Veda 额度不够）：
- 走 `ego-browser`/真实浏览器上下文拿 CF cookie，再调 showcase 通道；
- 用本地已有的 `output/.free-device.json` 类似机制持久化轮换状态；
- 作为 `lib/free-providers.mjs` 的第三个视频 provider，`provider='siftq'` 显式选择，不自动回落；
- 明确标注"灰色通道，可能失效"。

---

## 6 · 待决策 / 余留

- [ ] 是否接入 SiftQ 作为可选 provider？（默认：不接）
- [ ] 若接：CF cookie 方案（浏览器上下文 vs 第三方打码服务）的合规边界需确认
- [ ] 关注 SiftQ 是否进一步收紧（今天生成端点已加 CF challenge，趋势是收紧）
- [ ] 分享站链接 `wbapp-ri5eo915j2fglipkmaq8u5…` 已失效（作者取消发布），H3 iframe 无法再抓取核对

---

> 数据来源：GitHub `HaizhuAI/HaizhuVideo-H3Gateway`（2026-09 逆向）+ 2026-11-17 本地 curl / ego-browser 实测
