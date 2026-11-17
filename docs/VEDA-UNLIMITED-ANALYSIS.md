# Veda "无限生成" 方法分析

> 分析日期：2026-11-17 · 方法：本地实现审查 + curl 实测 + 上游开源项目/社区资料
> 目标：搞清 `veda.hanxiao.run` 的免费额度机制，评估"无限生成"的可行路径
> 结论先行：**线上换设备 ID 刷额度已失效；真正的"无限"只有本地部署一条路，但硬件门槛极高。**

---

## 0 · TL;DR

| 问题 | 结论 |
|---|---|
| 免费额度机制 | 20 点/天，`scope=device`，5s=1/10s=2/15s=3 点，窗口按 `resets_at` 重置 |
| ~~换 `veda_did` 刷额度~~ | ❌ **今天实测已失效**：任意伪造/新建 DID，quota 都返回同一个池（used=12） |
| 额度究竟按什么计 | 服务端识别的出口 IP（本机所有请求同一代理出口 → 同一池）；`X-Forwarded-For` 伪造也无效 |
| 真正的"无限" | ✅ **本地部署 Veda/Miowtion**（开源，MIT）——唯一无额度/无审核的路，但要 **1-2 张 RTX 4090 24GB + 约 210GB 权重** |
| 保留额度池的正确做法 | `output/.free-device.json` 固定 DID 仍然对——虽然现在不靠它计数，但服务端会下发 DID，保持一致避免异常 |

---

## 1 · Veda 是什么（先纠正一个认知）

`veda.hanxiao.run` 不是普通 SaaS，它是 **Veda 研究项目的官方在线 Demo**：

- **Veda** = 一种学到的稀疏注意力方法（ICML 2026 论文《Veda: Scalable Video Diffusion via Distilled Sparse Attention》），跳过 90% 的注意力计算，端到端提速约 3.1×；
- 底座是 **MiniMax-H3**（33B 音视频 DiT），Demo 用稀疏注意力让它能在消费级 GPU 上跑；
- 项目开源：`github.com/veda-sparse/Miowtion`（Miowtion，MIT），配套 ComfyUI 节点；
- 线上 Demo 免费额度（20 点/天）本质是"让大家体验模型效果"，不是商业模式。

**这点决定了"无限生成"的正解**：既然模型和加速方法都开源，真正无限的方式是本地跑，而不是薅 Demo 额度。

---

## 2 · 线上额度机制（今天实测）

### 2.1 quota 接口实测数据

```
GET https://veda.hanxiao.run/api/quota
```
返回：
```json
{"limit":20,"used":12,"remaining":8,
 "window_start":"2026-11-16T07:17:08Z","resets_at":"2026-11-17T07:17:08Z",
 "scope":"device","unlimited":false,"costs":{"5":1,"10":2,"15":3}}
```

### 2.2 关键实测：换 DID 无效（社区旧结论已失效）

| 请求变体 | quota 结果 | 结论 |
|---|---|---|
| 本地固定 DID `b8cd9bdd…` | used=12 / remaining=8 | 基准 |
| 全新随机 DID | used=12 / remaining=8 | ❌ 无效 |
| 不带 cookie | used=12 / remaining=8 | ❌ 无效 |
| cookie 空值 / 纯 uuid 格式 | used=12 / remaining=8 | ❌ 无效 |
| 伪造 `X-Forwarded-For: 45.132.18.77` | used=12 / remaining=8 | ❌ 无效 |
| 回传服务端刚下发的 DID | used=12 / remaining=8 | ❌ 无效 |

每次无 cookie 请求都会下发一个新的 `set-cookie: veda_did=<新值>`，但 quota 始终指向同一池。

**推断**：服务端额度不再信任客户端自报的 DID，而是按它自己看到的身份（出口 IP / 连接指纹）计数。本机所有请求走同一代理出口，所以都是同一池。（注：如果换成真实不同出口 IP 的代理池，理论上可能是新池——未验证，且属规避平台限制。）

### 2.3 与 9 月逆向结论的差异

社区（free-ai-studio 公众号、本项目 `ENGINE-MAP.md`）之前记录：
> "额度按设备算，换 `veda_did` = 换额度池；改站点 URL 会得到新设备标识。"

**今天实测这条已经不成立**——说明站点在 9 月后收紧了额度计数（从信任客户端 cookie 改为服务端识别）。本地 `free-providers.mjs` 里"换 URL 换 DID"的注释已过时，但不影响功能（固定 DID 仍可用）。

---

## 3 · "无限生成"的三条路径评估

| 路径 | 做法 | 可行性 | 门槛/风险 |
|---|---|---|---|
| **A. 换设备 ID 刷额度** | 伪造 `veda_did` cookie / 换站点 URL | ❌ 已失效（今天实测） | 站点已收紧 |
| **B. 代理 IP 轮换** | 用不同出口 IP 请求，规避按 IP 计数 | ⚠️ 理论可行、未验证 | 属规避平台限额；代理成本；可能触发风控 |
| **C. 本地部署 Miowtion** | 下载开源权重，自己跑 MiniMax-H3 + Veda 稀疏注意力 | ✅ 真正无限 | **1-2× RTX 4090 24GB + ~210GB 权重**；Apple Silicon 仍在 WIP |

### 路径 C 的硬件真相（来自官方仓库）

- 验证配置：**1-2 张 RTX 4090 24GB**，权重从主机内存流式加载（host offload）；
- 权重体积：MiniMax-H3 约 **210 GB**（FL2VA + Ref2VA 组件），加 Veda predictor / Turbo LoRA；
- 速度：单张 4090 跑 14.4s 16:9 片段，Veda 90% 稀疏下端到端约 2.8× 加速；官方表格 5.17s 片段 teacher forward 约 29.3s（30/50 block offload）；
- Apple Silicon：NVMe offload 方案 **仍在开发中（WIP）**，不是可用状态；
- 许可：Miowtion 代码 MIT，但 **MiniMax-H3 权重/代码有自己的 license**（社区许可，fc 类用途需看条款）；FA4 SM8x patch 是 BSD-3。

**对你的意义**：本机是 macOS（无 NVIDIA CUDA），路径 C 在当前硬件上不可行——除非另配 4090 机器或云 GPU。

---

## 4 · 对本项目的建议

1. **保持现状**：本地 Veda 通道（20 点/天）继续作为免 Key 视频主力，`output/.free-device.json` 固定 DID 保留（虽然现在不靠它计数，但服务端会下发，保持一致）。
2. **不要做路径 A**：换 DID 刷额度已失效，写了也是白写，还会误导。
3. **路径 B 谨慎**：若真要用代理池，只作为 `provider='veda-proxied'` 显式选项，不默认启用，并在文档标注规避平台限制的风险。
4. **真正想要无限**：另配一张 4090 的机器跑 Miowtion，或租云 GPU；本项目可通过 HTTP 桥接把本地请求转发过去（类似现在 `AGNES_BASE_URL` 可切的设计）。
5. **额度重置**：`resets_at` 每天 UTC 07:17（北京时间 15:17）重置，二十点够 20 条 5s / 10 条 10s / ~6 条 15s，日常够用。

---

## 5 · 待决策 / 余留

- [ ] 是否验证"不同出口 IP = 新额度池"（路径 B）？需准备可用代理池，且确认合规边界
- [ ] 是否有可用的 4090 机器 / 云 GPU 做路径 C 桥接？
- [ ] 本地 `free-providers.mjs` 里"换 URL 换 DID"的过时注释是否更新为实测结论
- [ ] 关注 Veda Demo 是否继续收紧（换 DID 已失效是收紧信号）

---

> 数据来源：本地 `lib/free-providers.mjs` + `output/.free-device.json` + 2026-11-17 curl 实测；
> 上游 `github.com/veda-sparse/Miowtion`、`github.com/veda-sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview`；ICML 2026 论文。
