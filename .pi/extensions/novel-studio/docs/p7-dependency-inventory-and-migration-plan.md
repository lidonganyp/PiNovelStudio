# P7 依赖盘点与迁移方案（只读分析，2026-08-13）

> 状态：**只读盘点完成，方案待评审。未修改任何生产代码。**
>
> 目标：把 quality-trace.json 与 TrajectoryStore 两条独立写真相源收敛为
> `RunAggregate + Audit Event Stream` 的**只读投影**，同时不破坏 CLAUDE.md
> 的 `FailureEnvelope` 硬约束与现有 replay/eval 消费者。

---

## 1. 生产闭包边界（tsconfig.prod.json）

生产编译入口只有两个（`tsconfig.prod.json` `files`）：

```text
index.ts
novelos/index.ts   （barrel，re-export 全部 novelos 模块）
```

`index.ts` 闭包经 `tools/register-tools.ts` → `handlers/public-handlers.ts` → `v2/core/unified-entry.ts`
→ `v2/core/unified-orchestrator.ts` 拉入整个统一主链路。`handlers/public-handlers.ts:46` 还 re-export
`handleBatchGeneration`，因此 **batch-generation 也在生产闭包内**（`handlers/batch-generation-handler.ts`
→ `v2/core/batch-generation-orchestrator.ts` + `batch-generation-job-store.ts`）。

判定原则：凡是在 `dist/` 里、能被上面两个入口（含其传递闭包）导入的，都是**生产消费者**；只在
`dist-eval/` / `dist-test/`（或 `novelos/eval/`、`novelbench/`、`eval/`）里出现的，是 eval/test 消费者，
**不参与本次收敛的写侧改造**（但读侧兼容仍要照顾 replay 回放）。

---

## 2. Deliverable 1 — 两个真相源的全部生产消费者 / 写入点 / 读取点

### 2.1 quality-trace.json

**唯一物理写文件点**：`craft/quality-trace-recorder.ts`
- `outputPath = join(workspacePath, workspaceId, "traces", `${chapterId}-quality-trace.json`)`（:618）
- `flush()` 用 `writeFileSync(this.outputPath, JSON.stringify(document, null, 2))`
- `recordFailureEnvelope()` 追加到 `document.failureEnvelopes[]`；`loadExistingDocument()` 跨多实例
  append 保留既有字段（appendExisting 多实例模式）

**生产写入点（谁在调 recorder / adapter）：**

| # | 文件:行 | 角色 | 路径 |
|---|---|---|---|
| W1 | `v2/adapters/legacy-trace-adapter.ts:328-331` | `createLegacyTraceAdapter` 内部 `new QualityTraceRecorder(...)`，`record()` 映射 `V2TraceRecord`→`recordGate`/`recordPatch`/`recordFailureEnvelope`，`flush()` 写 `v2Summary`+flush | 主路径 trace 落盘 |
| W2 | `v2/core/unified-entry.ts:1269` `persistUnifiedTraceWithFallback` | 主路径 flush 最多 2 次，失败写 `reports/traces/{ws}-{ch}-quality-trace-fallback-{ts}.json` 备用归档 | 成功路径 trace |
| W3 | `v2/core/unified-entry.ts:1337` `persistEarlyBlockedTrace` | 早期阻断（release gate / control plane / preflight / context 异常）写最小 trace（含 failureEnvelope） | 早期阻断 trace |
| W4 | `craft/failure-envelope-reporter.ts:56` `flushFailureEnvelopeToTraceFile` | Stage 0 前置检查等 recorder 尚未创建的早期点，独立建 appendExisting recorder 写 + flush | 早期阻断 |
| W5 | `handlers/public-handlers.ts:210-227` | 顶层异常 catch → `createLegacyTraceAdapter` 写 `unified_entry` error trace | 顶层异常 |
| W6 | `craft/failure-envelope-reporter.ts:29` `emitFailureEnvelope` | 通过 `FailureEnvelopeTraceSink.recordFailureEnvelope` 把 envelope 交给已存在的 recorder（不独立 flush） | 各 stage 内 |

**生产读取点：**

| # | 文件:行 | 读什么 |
|---|---|---|
| R1 | `handlers/strategy-feedback-trace-context.ts:136` `loadStrategyTraceContext` | `novel_strategy_feedback` 恢复 modelVersion/selectedStrategyIds/lineage/agentLineageIndex；含 `reports/traces` 回退目录 |
| R2 | `v2/governance/release-health-aggregator.ts:497` | 快照缺失时回退读 `gates[].stage === "v2_final_selected"` |
| R3 | `v2/governance/chapter-cost-snapshot.ts:143,339` | 成本快照（当前 trace 向后兼容读） |
| R4 | `v2/governance/canary-promotion-gate.ts:161` | 校验 artifact 是真实 `traces/{chapterId}-quality-trace.json` |
| R5 | `v2/core/batch-generation-orchestrator.ts:316` | 读 `{frontier}-quality-trace.json` |
| R6 | `v2/core/batch-generation-job-store.ts:98` | 存 `traces/{chapterId}-quality-trace.json` 路径引用（job 状态） |

**eval/test 读取点（不参与写侧改造，仅需读侧兼容）：** `eval/replay-runner.ts:189,1889`（回放读
quality-trace.json）、`novelos/eval/uncertainty-recall-metrics.ts`、`novelos/eval/uncertainty-driven-ablation.ts`
（读 trajectory，见 2.2）。

### 2.2 TrajectoryStore（trajectory.jsonl）

**唯一物理写文件点**：`novelos/trajectory/trajectory-store.ts`
- `outputPath = join(projectRoot, "workspaces", workspaceId, "novelos-sessions", sessionId, "trajectory.jsonl")`（:99-101）
- `flush()` 原子写（tmp → rename），`persist` flag 控制是否落盘

**生产写入点：**

| # | 文件:行 | 角色 |
|---|---|---|
| T1 | `novelos/agent/agentic-raw-candidate-source.ts:452-459` | **唯一实例化点**：`new TrajectoryStore({persist: !fullPipelinePreview})` + `recordSessionStart` |
| T2 | `novelos/runtime/runtime.ts` | 持有 trajectory，`recordToolEvent`/`recordFailure`/`recordMessage` 记录 turn/tool/message/failure/budget |
| T3 | `novelos/trajectory/tool-metrics-tracer.ts:316,362` | 记录工具可见性 / 调用指标 → trajectory |
| T4 | `novelos/agent/narrative-agent-loop.ts:122,142` | 持有 trajectory，记录 verifier_report/ranked_evidence/patch 等 |

**生产读取点：** **有 1 处**（原盘点遗漏，2026-08-14 修正）：

| # | 文件:行 | 读什么 |
|---|---|---|
| TR1 | `novelos/agent/must-verify-coverage-gate.ts:196` `readConfirmedEvidence` | coverage gate 从 trajectory 读 `ranked_evidence`（`CONFIRMED_EVIDENCE_LEVELS` 命中的 sourceRef/excerpt），用于「必验事实覆盖」门禁 |

该读点经 `narrative-agent-loop.ts` 传入 `trajectory.getDetailOutputPath()`：projection 模式下指向
内容库 `trajectory-content.jsonl`（完整明细），legacy 模式下指向 `trajectory.jsonl`。因此
trajectory **不再是纯 write-only**，其 `ranked_evidence` 明细是 coverage gate 的输入事实，已随
Stage D 一起迁移到 `getDetailOutputPath()`（4 处 `agentic-raw-candidate-source.ts` + 1 处
`narrative-agent-loop.ts`）。其余读点为 `novelos/eval/` 下的 eval 模块（不进入生产闭包）。

---

## 3. Deliverable 2 — legacy-trace-adapter 的生产依赖边界

`v2/adapters/legacy-trace-adapter.ts`（556 行）是**旧 trace 格式 → 新结构**的**写侧适配器**，位于生产闭包内。

```text
生产上游（唯一入口，均经 createLegacyTraceAdapter）
  ├─ v2/core/unified-entry.ts（persistUnifiedTraceWithFallback / persistEarlyBlockedTrace）
  └─ handlers/public-handlers.ts（顶层异常 catch）
            │
            ▼
createLegacyTraceAdapter(options) ── 内部 new QualityTraceRecorder({ appendExisting })
            │
            ▼
QualityTraceRecorder（craft/quality-trace-recorder.ts）
            │  writeFileSync
            ▼
workspaces/{ws}/traces/{ch}-quality-trace.json
```

依赖边界要点：
- **上游只依赖 `V2TraceAdapter` 接口**（`record(V2TraceRecord)` / `flush(): string`），不依赖 recorder 内部。
  `unified-entry.ts:1275` 用 `input.adapterFactory ?? createLegacyTraceAdapter`，意味着可以在不破坏上游的
  前提下替换 adapter 工厂。
- **下游依赖 craft 的 `QualityTraceRecorder`**（`craft/quality-trace-recorder.ts`）。这是唯一真正落盘
  quality-trace.json 的实现；要收敛，必须在这个边界上做「写侧分流」（见 §4）。
- `v2/core/audit/legacy-trace-compat.ts`（313 行）是**读侧**映射（Trajectory/FailureEnvelope/quality-trace →
  AuditEvent），**已经是只读**，是本次收敛的现成桥：`mapTrajectoryEntriesToAuditEvents()`、
  `mapLegacyFailureToNormalized()`、`LEGACY_FIELD_COMPAT_MAP`（`quality-trace.gates[]`→`gate_evaluated`、
  `failureEnvelopes[]`→`failure_recorded`、final selection→`final_submission`）。

**边界结论**：写侧收口点在 `legacy-trace-adapter.ts` 与 `quality-trace-recorder.ts` 两处；读侧收敛点已经
由 `legacy-trace-compat.ts` 提供，无需新造。生产闭包内有 **1 处** trajectory 读点（coverage gate 的
`readConfirmedEvidence`，读 `ranked_evidence`），已随 Stage D 迁移到 `getDetailOutputPath()`（projection
模式下读内容库，不再直读 trajectory.jsonl）。

---

## 4. Deliverable 3 — 收敛为 Audit Event Stream 只读投影的迁移方案

目标终态：

```text
单一真相源 = AuditEventStore（JSONL append-only，先事件后物化）
        │
        ├─ 投影 P1：RunAggregate（reducer 折叠，进程内 + 可重放）
        ├─ 投影 P2：current-run-state.json / checkpoint-index.json /
        │           approval-pending.json / transition-history.json（run-projections）
        ├─ 投影 P3：strategy-policy.json（账本 feedback-evidence-ledger → 重算，P6 已收口）
        └─ 投影 P4：quality-trace.json + trajectory.jsonl（**降级为只读兼容投影**，见下）
```

分阶段（每阶段独立可回滚，不跨阶段耦合）：

**阶段 A — 写侧「双写过渡」（兼容期，无消费者变化）**
- 在 `persistUnifiedTraceWithFallback` / `persistEarlyBlockedTrace` / `QualityTraceRecorder.flush` 之后，
  **同批数据同时** `store.append` 一条 `trace_persisted` / `failure_recorded` AuditEvent。
- `TrajectoryStore.flush` 之后同样 append `trajectory_flushed` 摘要事件。
- 目标：审计流先具备「每章 trace + trajectory」的完整事实，旧文件仍是唯一被读的物化结果。
- 切换点判定：审计流 `trace_persisted` 覆盖率 = 100% 于观察窗口（可由现有 `audit-event-store.test.mjs`
  尾行恢复 + 新增投影重建测试验证）。

**阶段 B — 读侧切换到投影（消费者逐点迁移）**
- 新增 `rebuildQualityTraceFromEvents(events)` 与 `rebuildTrajectoryFromEvents(events)` 两个纯函数投影
  （放在 `legacy-trace-compat.ts` 或新 `v2/core/audit/trace-projections.ts`），输入 AuditEvent 列表，输出
  legacy `QualityTraceDocument` / `TrajectoryEntry[]` 的**等价结构**。
- 逐个把 §2 的读点 R1–R6 改为「优先读投影，投影缺失时回退读旧文件」（向后兼容过渡）。R1
  `loadStrategyTraceContext` 已在读旧文件，是最先迁移的对象；R2/R3/R4/R5/R6 治理与 batch 读点随后。
- trajectory.jsonl 生产无读点，无需迁移读侧；仅需保证 `rebuildTrajectoryFromEvents` 供 eval 回放等价
  重建（eval 读点保持不变，直到投影稳定）。

**阶段 C — 写侧收口（单真相源）**
- 把 `QualityTraceRecorder` 的写路径改为**可选**：生产默认「只 append 审计事件，不再独立写
  quality-trace.json」，保留 `writeLegacyTraceFile=true` 作为回滚开关（见 §6）。
- `TrajectoryStore` 生产默认 `persist=false`（当前 `persist: !fullPipelinePreview`），轨迹事实只进审计流；
  trajectory.jsonl 仅由投影按需重建。
- `legacy-trace-adapter.ts` 收敛为**纯读侧投影适配器**（或直接删除，用 `trace-projections` 替代），
  上游 `adapterFactory` 注入新实现。

**阶段 D — 旧文件降级为「缓存投影」，最终可选项**
- 若外部工具（CLI/UI/replay）仍需 `traces/{ch}-quality-trace.json`，由投影物化器在每次提交后
  重写为缓存（与 `run-projections.ts` 的 `writeRunProjections` 同一模式），而非真相源。

---

## 5. Deliverable 4 — 兼容 CLAUDE.md FailureEnvelope 硬约束的落地方式

硬约束原文：**「每 Stage/Gate 失败产生结构化 `FailureEnvelope`（stage/gate/severity/reason/evidence/recoverable/retryPlan）
写入 `workspaces/{id}/traces/{chapterId}-quality-trace.json`」。**

落地要点（保证迁移不弱化该约束）：

1. **FailureEnvelope 语义不动**：`craft/failure-envelope.ts` 的 `FailureEnvelope` 类型（:37）与三个工厂
   （preflight/recoverable/hardBlock）保持不变，仍然是所有阻断的归一化结构。
2. **审计流把 FailureEnvelope 作为一等事实**：`failure_recorded` AuditEvent 的 payload **原样携带**
   完整 `FailureEnvelope`（不是摘要），投影 `rebuildQualityTraceFromEvents` 把 `failure_recorded` 集合
   还原为 `document.failureEnvelopes[]`，逐字段等价（stage/gate/severity/reason/evidence/recoverable/retryPlan/userActionRequired）。
   这已由 `legacy-trace-compat.ts` 的 `LEGACY_FIELD_COMPAT_MAP`（`failureEnvelopes[]`→`failure_recorded`）预留映射。
3. **早期阻断路径不遗漏**：`flushFailureEnvelopeToTraceFile`（W4）与 `persistEarlyBlockedTrace`（W3）两条
   「recorder 尚未创建」路径，在阶段 A 同样 append `failure_recorded` 事件——保证早期阻断（preflight/release
   gate/control plane/顶层异常）与成功路径一样被审计流捕获。
4. **硬约束验收口径不变**：`tests/dependency-boundary.test.mjs` 与现有 replay 回放继续以
   `traces/{ch}-quality-trace.json`（或等价投影）校验 `failureEnvelopes[]` 非空且字段完整；迁移后验收改为
   「投影重建结果逐字段 == 旧文件」的双向断言，防止回归。
5. **降级为投影 ≠ 删除文件**：阶段 C 默认仍保留「按需物化 quality-trace.json」能力（阶段 D 缓存投影），
   因此外部契约路径 `traces/{ch}-quality-trace.json` 不消失，只是从「独立真相源」变为「审计流投影的物化缓存」。

---

## 6. Deliverable 5 — 风险、分阶段切换点、回滚边界

### 6.1 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 双写不一致（审计事件与旧文件漂移） | HIGH | 阶段 A 同一函数内紧邻写，事件带 `artifactHash`；投影重建测试逐字段比对旧文件 |
| 读侧切换漏读（某读点仍只读旧文件） | HIGH | 逐点迁移，每点加「投影缺失回退旧文件」；R1–R6 全量清单已列 |
| FailureEnvelope 早期阻断被遗漏 | CRITICAL | W3/W4/W5 三条早期路径全部纳入阶段 A 事件发射，含顶层异常 |
| eval replay 回放依赖旧文件 | MEDIUM | 阶段 C 前 eval 读点不动；提供 `rebuildTrajectoryFromEvents` / `rebuildQualityTraceFromEvents` 等价重建 |
| 审计流体积膨胀（trajectory 全量入流） | MEDIUM | trajectory 只入摘要事件（`trajectory_flushed` 带 counts + 关键 failure），细节轨迹留在 session 目录或按需投影 |
| batch-generation / governance 读点被破坏 | MEDIUM | R2–R6 与 batch 路径在阶段 B 逐点验证，`batch-generation-orchestrator.ts:316` 单独回归 |

### 6.2 分阶段切换点（gate）

- **A→B 切换点**：审计流 `trace_persisted` / `failure_recorded` 覆盖率 100%（观察窗口），且
  `rebuildQualityTraceFromEvents(events)` 与既有旧文件逐字段一致（新增投影重建测试全绿）。
- **B→C 切换点**：R1–R6 全部改为投影优先，治理/batch 回归全绿；`dependency-boundary.test.mjs` 仍通过。
- **C→D 切换点**：`writeLegacyTraceFile=false` 跑一个观察周期，外部 CLI/UI/replay 无缺失投诉，再降级为缓存投影。

### 6.3 回滚边界（rollback boundary）

- **阶段 A**：删除新增的 `store.append` 调用即可，无任何行为变化（纯追加双写）。
- **阶段 B**：每个读点保留「投影缺失回退旧文件」分支，单点回滚 = 恢复旧读法，无需重建数据。
- **阶段 C**：`writeLegacyTraceFile=true` 与 `TrajectoryStore persist=true` 是**显式回滚开关**；回滚即
  恢复独立写，审计流不删除（追加式，历史保留）。
- **永不回滚项**（红线）：不删除审计历史实现 rollback（与既有约束一致）；不删除旧 quality-trace /
  trajectory 文件，只停止**新增**独立写。

---

## 7. 结论与暂停点

盘点已覆盖：quality-trace.json 6 写入点 + 6 生产读点；TrajectoryStore 4 写入点 + 1 生产读点（coverage gate）；
legacy-trace-adapter 的写侧收口边界（`unified-entry` + `public-handlers` 两上游，`QualityTraceRecorder` 一下游）；
`legacy-trace-compat.ts` 作为现成读侧桥；FailureEnvelope 硬约束通过「事件原样携带 + 投影逐字段还原」兼容。

**下一步（待评审批准后执行，本轮不动作）**：
1. 阶段 A 双写过渡（新增 `trace_persisted` / `failure_recorded` / `trajectory_flushed` 事件发射）。
2. 新增 `trace-projections.ts`（`rebuildQualityTraceFromEvents` / `rebuildTrajectoryFromEvents`）+ 双向一致测试。
3. 阶段 B 逐点迁移 R1–R6 读侧。
4. 阶段 C 写侧收口（`writeLegacyTraceFile` / `persist` 回滚开关）。

**明确不执行**（按指示暂停）：P7 主编排改造、真实子进程 SIGKILL 注入、re-FactGuard 编排层接线。

---

## 8. 阶段 A 设计说明（评审补充，2026-08-13）

> 阶段 A 执行前三项补充确认，非代码改动。授权后据此实施。

### 8.1 `failure_recorded` 唯一发射责任

- **唯一发射点**：`craft/quality-trace-recorder.ts` 的 `recordFailureEnvelope()`。所有 FailureEnvelope
  落 quality-trace.json 前必经此单一漏斗：`emitFailureEnvelope`（经 `sink.recordFailureEnvelope`）、
  `flushFailureEnvelopeToTraceFile`（`recorder.recordFailureEnvelope`）、`persistEarlyBlockedTrace` 与
  顶层 catch（经 `adapter.record → recordFailureEnvelope`）、最终 `persistUnifiedTraceWithFallback`
  （经 `adapter.record → recordFailureEnvelope`）全部收敛到该方法。其余四处是**调用方**，非发射方，天然不重复。
- **去重**：`eventId = failureRecorded:<sha256(stage|gate|severity|reason|canonicalEvidence)>`（内容寻址，
  确定性）；发射侧维护 `emittedFailureEventIds` 集合，同一 eventId 只 append 一次，覆盖 appendExisting
  多实例模式下同一 envelope 被重复 record 的场景。
- **零行为变化**：sink 缺省 no-op；`recordFailureEnvelope` 旧写逻辑不动，仅 push 后追加
  `this.auditSink?.recordEvent(...)`。

### 8.2 `trace_persisted` 单事件 + 可追踪

- **只产生一个事件**：在 `persistUnifiedTraceWithFallback` **返回后**（调用点 unified-entry.ts :2239 之后）
  emit 一次，不在内部 for/retry 循环 emit。捕获最终 `status ∈ {primary, fallback, failed}`、`path`、
  `primaryAttempts`、`errors`。
- **eventId**：`tracePersisted:<runId>:<chapterId>`（每 run 一章一个，确定性）。
- **causedByEventId**：指向该 run 的 `final_submission`（缺省回退 `chapter_saved` → `run_started`）。
- **failed 也记录**：status=failed 仍 emit（payload.errors 完整），保证「trace 留存违约」可审计而非静默。

### 8.3 sink 传递（防漏记）

- **单一类型**：复用既有 `AuditEventSink`（`v2/core/audit/audit-run-session.ts` 已定义，runtime.ts:125 已引用）。
- **生产强制、测试可选**：生产入口 `runUnifiedPipeline` / `handleGenerateChapter` 必传 sink；底层构造
  `createQualityTraceRecorder` / `createLegacyTraceAdapter` / `TrajectoryStore` 的 `auditSink?` 可选、默认 no-op。
- **唯一生产线程**：`unified-entry.ts` 的 `runUnifiedPipeline` 已持有 `AuditRunSession`，透传给
  `persistUnifiedTraceWithFallback` / `persistEarlyBlockedTrace` / `createLegacyTraceAdapter`；
  `TrajectoryStore` 的 sink 从 orchestrator 经 `agentic-raw-candidate-source.ts` 透传（执行时确认具体线程点）。
- **防漏记断言**：新增测试断言生产闭包入口路径上三处调用 sink 非 no-op。

（`trajectory_flushed` 在本设计说明中只出现一次：`TrajectoryStore.flush()` 成功后追加，payload 携带
`sessionId` / `entryCount` / failure 摘要。）
