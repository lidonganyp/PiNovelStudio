# TrustAudit 并发隔离修复

**日期**：2026-08-13  
**阻断项**：进程级单例 `activeBridge` 导致双 run 串写  
**状态**：已修复并专项测试通过

## 问题

`trust-audit-bridge.ts` 原实现：

```ts
let activeBridge: TrustAuditSink | null = null;
setTrustAuditSink(sink); // 后启动的 run 覆盖先启动的 run
```

双并发 `AuditRunSession` 时，workspace A 的 TrustAudit 事件会写入 run B 的 `events.jsonl`。

## 修复

| 层 | 变更 |
|---|---|
| `trust-audit.ts` | `registerTrustAuditSink(key)` 多 sink 注册表；`AsyncLocalStorage` 绑定当前 run；`runWithTrustAuditContext(Async)` |
| `trust-audit-bridge.ts` | 按 `runId` 注册独立 sink；`shouldAcceptTrustEventForBridge` 拒绝跨 workspace/run 串写 |
| `audit-run-session.ts` | `runInTrustContext` / `runInTrustContextAsync`；start 时按 run 装桥 |
| `unified-entry.ts` | 生产主路径 `await auditSession.runInTrustContextAsync(...)` 包裹 |
| `orchestrator-factguard.ts` | 导出 `gateToolResultsForFactGuard`，强制 `consumeToolResult({ purpose: "fact_guard_input" })` |

## 测试

- 生产闭包7：双并发 ALS 隔离，A/B 事件不串写  
- 生产闭包8：无 ALS 时跨 workspace 不写入错误 store  
- 合计信任相关：**60 pass / 0 fail**

## 复核阻断项（同日二次修复）

| 阻断 | 修复 |
|---|---|
| ALS 命中时不校验 event 自身 run/workspace | `shouldAcceptTrustEventForBridge`：event 标识硬过滤 + ALS/event 一致性；伪造 B 标签在 A-ALS 内写入 A/B 均拒绝（闭包9） |
| `gateToolResultsForFactGuard` 无生产调用方 | `checkCandidateFactGuard` 必经 `filterContextFactsForFactGuard`；未验证检索/工具 facts 不得进硬路径（闭包10） |
| language-calibration Windows UNKNOWN 写文件 | `writeJsonAtomic` 重试 + tmp rename |

专项：生产闭包 1–10 + 20 项 Eval = 35 pass。

## 评级

> **Production-wired (core paths) + concurrent audit isolation + FactGuard hard-path gate。**

发布前仍建议：

1. 全量 `npm test`（含 language-calibration 原子写修复验证）  
2. 真实 `novel_generate_chapter` replay 确认 TrustAudit run 归属  
3. 其它旁路若直接把 tool text 喂给 hard gate，继续收敛到 `consumeToolResult`