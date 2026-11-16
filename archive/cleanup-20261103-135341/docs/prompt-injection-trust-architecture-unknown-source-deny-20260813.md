# 未知来源默认拒绝 + stub 生成回放

**日期**：2026-08-13  
**核验风险**：`kind: fact` + 未知 `sourceIds`（如 `["candidate"]`）曾默认进入 FactGuard 硬路径  

## 修复

`filterContextFactsForFactGuard` 现为 **fail-closed**：

| 条件 | 硬路径 |
|---|---|
| 无 `sourceIds` | 拒绝 |
| `candidate_experience` / `style_ref` | 拒绝 |
| `suggestion` 且非权威 | 拒绝 |
| 工具/检索来源且未验证升级 | 拒绝 |
| **未知/非权威来源（含 kind=fact + candidate）** | **拒绝** |
| 权威路径（outline/skeleton/chapters/narrative-state/constitution/…） | 允许 |
| 工具结果经 `consumeToolResult(fact_guard_input)` 验证通过 | 允许 |

未知来源**不会**进入 `authorizedHighImpactSources`。

## 证据

- 生产闭包10：未知 fact / 空 sourceIds 拒绝  
- 生产闭包11：`V2_FORCE_STUB=1` 真实 `runUnifiedPipeline` 落盘 `events.jsonl`，TrustAudit 归属正确 run（若有）  
- 闭包 1–11：**11 pass / 0 fail**

## 评级

> Production-wired + concurrent audit isolation + FactGuard hard-path gate（**未知来源默认拒绝**）+ stub 生产路径 run 归属证据。

仍非“无条件正式发布”：真实非 stub 模型生成、batch 并发、异步回调旁路仍建议单独验收。
