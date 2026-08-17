# 真实 API 验收：非 stub replay + batch 并发 ALS 归属

**日期**：2026-08-13
**任务**：`PROMPT-INJECTION-TRUST-ARCHITECTURE-1`
**脚本**：`scripts/prompt-injection-trust-real-1/run-verification.mjs`（REQUIRES_AUTH）
**报告**：`reports/prompt-injection-trust-real-1/verification-report.md`

## 背景

此前 `unknown-source-deny` 核验的评级为「Production-wired + concurrent audit isolation + FactGuard hard-path gate + stub 生产路径 run 归属证据」，并注明：

> 仍非“无条件正式发布”：真实非 stub 模型生成、batch 并发、异步回调旁路仍建议单独验收。

本验收补齐这两项。

## 生产模型可达性（前置事实）

`check-model-providers.mjs --timeout 60000` 结果：

| provider | model | 结果 |
|---|---|---|
| glm | glm-5.2 | ok（2028ms） |
| gpt | gpt-5.5 | ok（2408ms） |
| claude | claude-opus-4-6 | **permanent_error 403**：`This group does not allow /v1/messages dispatch` |
| gemini31 | gemini-3.1-pro-preview | **error**：`fetch failed`（~10.7s，非 timeout） |

生产默认 writer（Gemini 3.1 Pro）本机不可达（fetch failed），Claude provider 协议配置与代理放行口径冲突（403）。故真实 replay 用 **GLM-5.2**（`modelTestRoute=glm`，健康检查 OK）替代验证——信任归属机制与具体生成模型无关。

## 验证 1：非 stub 真实 `novel_generate_chapter` replay

`runUnifiedPipeline` 走真实生产路径（ContextCompiler → audit session → ALS 包裹 → 真实模型 → 原子保存 + trace），`modelTestRoute=glm`、`PINOVEL_DEV_MODE=1`、无 `V2_FORCE_STUB`。

首次运行证据：

- `status=ok`，`textLength=1604`（真实交付正文）
- `runId=run-…`，`eventsPath` 落盘 `events.jsonl`（14 事件，`run_started` + 终止事件齐全）
- **2 次真实 GLM 模型调用**（`nb4_generate_glm` / glm-5.2，21.5s + 9.6s，均 `ok=true`）
- **2 个 trust 事件**（`tool_result_consume`），`payload.runId` 均等于本 run 的 `runId`

后续运行（含并发）在 `agentic_fact_guard` hard block（真实模型生成了未授权高影响新设定「宗门/破练气三层/心法/封印」），FactGuard 正确 fail-closed——这同样证明信任归属在**失败路径**成立。

## 验证 2：batch 并发 + 异步 ALS 归属

两个独立 workspace/chapter 的 `runUnifiedPipeline` 同时运行（`Promise.all`），各自真实 async GLM 调用后 emit trust 事件：

- 两 run `runId` 不同
- 每 run `trustCount=1`（`tool_result_consume`）
- `misattributedCount=0`、`crossWorkspaceCount=0`（无串写）

ALS 上下文在真实网络模型调用的 `await` 边界、以及其后 agentic loop 的工具结果消费（`consumeToolResult`）中均正确保持，trust 事件经 bridge 路由到本 run 的 `AuditEventStore`（而非 standalone JSONL 或异 run store）。

## 结论

- ✅ 真实非 stub `novel_generate_chapter` replay：完整生产路径 + 真实模型 + 原子保存 + trace + 正确 trust 归属。
- ✅ batch 并发 + 异步模型/工具回调 ALS 归属：无串写。
- ⚠️ 剩余边界：生产默认 writer Gemini 3.1 Pro 本机不可达，一次**成功交付**的真实 Gemini 生成仍待补验；Claude provider 403 需路由协议配置修正。
