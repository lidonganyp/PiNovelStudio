# AGENTIC-EVIDENCE-MERGE-1 真实 replay 报告

> **模式**：真实模型生成（real-model-generation）
> **独立章节快照**：是（每章独立重建，避免级联污染）
> **模型**：gemini-3.1-pro-preview
> **时间**：2026-08-12T04:15:29.769Z
> **章节数**：9

## 汇总

| 指标 | 值 |
|---|---|
| 成功章节 | 6 |
| 阻断章节 | 3（hard block 3 + preflight 级联 0 + 可恢复 0） |
| 未分类失败 | 0 |
| 可恢复阻断（重试后成功） | 0 |
| trace 留存率 | 100% (9/9) |
| 独立 EvidenceDecision 调用数 | 0（目标 0） |
| 总输入 token | 58813 |
| 总输出 token | 189976 |
| 总模型调用延迟 | 1442.5s |
| mustVerify 覆盖 | 44/44（100%） |
| 事实硬错误章节 | 0 |
| 自动恢复率 | N/A（本次无可恢复失败） |
| 整体成功率 | 66.7%（6/9） |
| 零检索成功章节 | 6 |
| 归档 trace 文件数 | 15（持久保存到 D:\CODE\PiNovelStudio\reports\agentic-evidence-merge-real\traces） |

## 逐章明细

| 章 | 场景 | 焦点角色 | 稀疏 | 状态 | firstAction | 检索 | mustVerify覆盖 | modelCalls | 输入token | 延迟(s) | 停止原因 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 碎星剑觉醒 | 叶尘 | 否 | ok | draft | 0 | 8/8 | 3 | 9498 | 220.1 | verifier_cleared |
| 2 | 暗流涌动 | 林婉儿 | 是 | ok | draft | 0 | 4/4 | 3 | 8264 | 172.1 | verifier_cleared |
| 3 | 神秘来客 | 苏影 | 否 | blocked | - | - | null/null | 1 | 2192 | 84.7 | - |
| 4 | 尘心诀的代价 | 叶尘 | 否 | blocked | - | - | null/null | 3 | 8220 | 194.8 | - |
| 5 | 青鱼嘴之战 | 叶尘 | 否 | ok | draft | 0 | 8/8 | 2 | 4991 | 112.4 | verifier_cleared |
| 6 | 面具之下 | 林婉儿 | 是 | blocked | - | - | null/null | 3 | 7598 | 216.6 | - |
| 7 | 海外来客的真相 | 苏影 | 否 | ok | draft | 0 | 8/8 | 2 | 5069 | 125.9 | verifier_cleared |
| 8 | 三方会盟 | 叶尘 | 否 | ok | draft | 0 | 8/8 | 3 | 7794 | 181.2 | verifier_cleared |
| 9 | 封印松动 | 叶尘 | 否 | ok | draft | 0 | 8/8 | 2 | 5187 | 134.5 | verifier_cleared |

## 已知限制与验收口径

> **验收状态**：实现完成；真实 replay 交付物待补齐。详见 [baseline-comparison.md](baseline-comparison.md) §9 与验收状态章节。

### trace 留存口径

- **运行时读取**：9/9（每章运行时成功读取 quality-trace.json）
- **归档持久化**：15 份（`archiveChapterTrace()` 每章运行后立即复制到 `reports/agentic-evidence-merge-real/traces/`，含 ch1-ch9 quality-trace + ch3/ch4/ch6 blocked-candidate-evidence/quality-evidence-report）
- **限制**：独立快照模式每章 `scaffoldWorkspace()` 会 rmSync 整个 workspace；若不先归档，最终目录只保留最后一章的 trace。当前已通过 `archiveChapterTrace()` 修复，归档目录包含完整 9 章 trace。

### 独立快照模式设计限制

- **chapterNumber=1**：独立快照模式固定传入 `chapterNumber: 1`，每章从干净 workspace 以第 1 章语义独立生成，避免前章失败级联污染。
- **多场景覆盖**：`CHAPTER_SCENARIOS` 定义 9 个不同场景（标题/焦点角色/稀疏上下文），覆盖多角色变化（叶尘/林婉儿/苏影）和稀疏上下文（是/否）。
- **未覆盖**：PromiseLedger、跨章检索、负例等需要串行模式（chapterNumber > 1）的场景。这些场景需在串行模式下补验。

### 524/520 HTTP 自动重试

- **运行观察**：ch2/ch5 出现 HTTP 网关错误（524/520），由模型调用层自动重试（attempt=1→2）恢复成功。
- **持久化证据**：无。这两次属 HTTP 调用层重试，不产生 FailureEnvelope（`hasRecoverableFailure=false`），无持久化原始日志或 trace 字段。仅作为运行观察，不作为可回放证据。

### envelope 级 recoverable failure

- **真实生产样本**：未自然触发（`recoverableBlocked=0`）。
- **受控构造 trace**：已通过 `scripts/agentic-evidence-merge-trace-construction.mjs --case=recovery` 构造，归档于 `traces/recovery-timeout-ch1-quality-trace.json`，含 `gate=model_timeout, severity=recoverable` envelope。该 trace 为受控环境生成（本地 HTTP 挂起服务器 + 100ms 超时），非真实生产模型调用。
