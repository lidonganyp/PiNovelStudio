# 提示注入信任架构 — 生产闭包修复报告

**日期**：2026-08-13  
**前置核验**：不能接受“Wave 0–4 已全部完成”的原声明；评级为 Partial。  
**本轮目标**：按核验建议的 6 条最小修复顺序，完成生产闭包接线。

## 修复对照

| # | 缺口 | 修复 | 证据 |
|---|---|---|---|
| 1 | TrustAudit 仅进程内 | `AuditRunSession.start` 安装 `installTrustAuditBridgeFromStore`；无 run 时写 `traces/trust-audit/events.jsonl` | 生产闭包测试 1、2 |
| 2 | 工具结果未强制消费 | `consumeToolResult` + runtime `afterToolCall` 默认 reference 审计；硬路径 `assertToolResultSafeForCanon` | 生产闭包测试 3 |
| 3 | FinalStateCommit 未走晋级 | `evaluateEntryPromotionGate` 对每条 staged entry 调用 `createFactPromotionCandidate` → `promoteFactCandidate` → `canWriteToLongTermState` | `final-state-commit.ts` |
| 4 | accept_with_edits 无 UserRevisionRecord | `acceptProxyDraftWithEdits` 创建/落盘 `UserRevisionRecord`；entry 传 parentText | 生产闭包测试 4、6 |
| 5 | 反馈入口未分类 | `handleStrategyFeedback` 入口 `classifyUserFeedbackTrustCategory` + `assertFeedbackCannotBypassSecurity` | handlers + 测试 5 |
| 6 | 生产闭包测试 | `tests/prompt-injection-trust-production-closure.test.mjs` | 6 pass |

## 验证

```text
prompt-injection-trust-architecture-eval.test.mjs     25 pass
prompt-injection-trust-production-closure.test.mjs     6 pass
autonomy-policy + action-approval-receipt             25 pass
合计 56 pass / 0 fail
npm run build (tsc prod) 通过
```

## 仍需注意（诚实边界）

1. **工具硬路径**：runtime afterToolCall 对所有结果按 `reference_material` 记录；进入 Canon/hard_gate 时调用方须再调 `consumeToolResult({ purpose: "canon_state" })` 或 `assertToolResultSafeForCanon`。FactGuard 主路径若直接吃检索文本，应继续收敛到该 API。  
2. **真实 workspace replay**：本轮补了模块级生产闭包测试与落盘证明，尚未跑完整长篇真实 replay 仪表盘。发布前建议按 runbook 做一次 stub/真实 workspace 回放。  
3. **反馈路径**：公共 `handleStrategyFeedback` 已闸门；代理审批 feedback recorder 等旁路若另有入口，应复用同一分类函数（当前 recorder 主要记录定稿 outcome，不解析“关闭 FactGuard”类 NL）。

## 评级修正

- **此前（核验）**：Implemented but underverified / Partial  
- **闭包 6 项后**：Production-wired (core paths)  
- **并发隔离复核后**：进程级单例串写为阻断项（已修，见 `prompt-injection-trust-architecture-concurrency-isolation-20260813.md`）  
- **当前**：Production-wired (core paths) + concurrent audit isolation；发布前仍建议真实 `novel_generate_chapter` replay 与全量 `npm test`
