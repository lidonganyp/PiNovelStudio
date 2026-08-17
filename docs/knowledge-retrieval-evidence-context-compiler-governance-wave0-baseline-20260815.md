# 知识检索、证据选择与 ContextCompiler 质量治理 Wave 0 基线

**任务**：`CONTEXT-EVIDENCE-GOVERNANCE-1`  
**日期**：2026-08-15  
**状态**：Wave 0 正式完成  
**范围**：契约冻结 + 调用点盘点 + RED 缺口特征 + 生产 A 基线冻结  
**生产行为**：无变更。未恢复、删除、覆盖或暂存用户既有脏工作树。

配套契约：`.pi/extensions/novel-studio/v2/core/evidence-governance-contracts.ts`  
特征测试：`tests/ceg-wave0-contracts.test.mjs`、`tests/ceg-wave0-red.test.mjs`  
目标 RED 探针（不进 `npm test`）：`tests/ceg-wave0-red.probe.mjs`

## 1. 生产读取 / 排序 / 裁剪 / 渲染 / 验证调用点

| 步骤 | Owner | 文件 / 函数 | 输入 | 输出 | 当前 hash | 读取时是否写状态 |
|---|---|---|---|---|---|---|
| 正式状态读取 | FinalStateCommit | `v2/core/final-state-commit.ts` `loadStateStore()` | workspaceId, projectRoot | `NarrativeStateStore` | `computeNarrativeStateRevision` 对磁盘原文 SHA-256 前 16 位 | 否；但 `normalizeStore` 会重写内存中的 `updatedAt` |
| 写时回填 | HistoricalStateBackfill | `v2/core/historical-state-backfill.ts` `backfillAcceptedChapterState()` | workspaceId, beforeChapterNumber | 可能改写 `narrative-state-store.json` | 无独立内容 hash | **是**：ContextCompiler 读取前会写回填 |
| ContextCompiler 状态消费 | ContextCompiler | `v2/core/context-compiler.ts` `deriveLongTermState()` | seed + store | `LongTermStateSnapshot` + retrievalReport | `computeContextHash()`：facts 含 content，character 只含 id，longTermState 只含 entry id | 通过 backfill 写状态 |
| 工作集排序 | ContextRetrieval | `v2/core/context-retrieval.ts` `retrieveNarrativeContext()` / `scoreEntry()` | state, keywords, maxItems, forcedRecallIds | workingSet + report | 条目分是加减总分，不是内容 hash | 否 |
| 信任分槽（资产） | ContextSafety / ContextPackage | `v2/core/context-safety.ts` `compileConstraintManifestToContextPackage()`；`v2/core/trust/context-package.ts` | ConstraintManifest | ContextPackage + `contextHash` | 槽位内容 SHA-256 | 否 |
| 生产静态 Prompt 拼接 | ModelPromptAdapter | `v2/core/model-prompt-adapter.ts` `buildHistoricalContext()` / `buildChapterContract()` | CompiledContext.longTermState | 4/6/4 段历史上下文 | 无独立 hash；再次 newestFirst + maxEntries/maxChars | 否 |
| 生产 trace contextHash | UnifiedEntry | `v2/core/unified-entry.ts` → `deriveContextHashFromCompiled()` | CompiledContext 计数 | `f{n}-l{n}-c{n}-w{n}-s{n}` | **数量签名，非内容 hash** | 否 |
| 动态检索状态 | NarrativeSearchService | `novelos/agent/narrative-search-service.ts` `getStateStore()` | workspace + sourceChapter | 由 `LegacyStateAdapter.importFromLegacy()` 组装的 store | 无 snapshotId / 无内容 hash | 否；缓存首次 legacy 导入 |
| 动态正文检索 | NarrativeSearchService | `searchChapterSpan()` / `readChapterText()` | live `chapters/chapter-N/final.md` | ChapterSpan | 无冻结 hash 校验 | 否，但每次读 live 文件 |
| 工具结果协议 | Tool protocol | `novelos/tools/tool-protocol.ts` | 工具输出 | `resultKind` / `sourceRef` / `truncated` / `nextQueryHint` | 无 query 级 `retrieval_error` | 否 |
| 工具信任消费 | TrustedToolResult | `v2/core/trust/tool-result-consumer.ts` | TrustedToolResult | 消费闸门 | `contentHash` | 否 |
| 检索预算 | EvidencePlan | `novelos/agent/evidence-plan.ts` | mustVerify | `retrievalCallLimit = mustVerify ? 4 : 2` | 无 | 否 |
| Coverage | MustVerifyCoverageGate | `novelos/agent/must-verify-coverage-gate.ts` | mustVerify + 工具结果 | 覆盖判定 | 无 snapshotId 校验 | 否 |
| 事实门禁 | FactGuard / FinalFactRecheck | `v2/core/orchestrator-factguard.ts` 等 | 候选正文 + 状态 | FailureEnvelope | 无统一 snapshotId | 否 |
| 审计事件 | AuditEvent | `v2/core/audit/*` | 运行事件 | 追加事件 | 独立审计 hash，未绑定三类内容 hash | 追加写 |
| 覆盖门禁 | MustVerifyCoverageGate | `novelos/agent/must-verify-coverage-gate.ts` | mustVerify + trajectory | 现网 gate 名是 `unverified_high_risk_facts` | 无 snapshotId | 否 |
| 已知摘要裁剪 | EvidencePlan | `extractKnownFromContext` | CompiledContext | ≤80 字/条、≤12 条 | 无 | 否 |
| mustVerify 上限 | EvidencePlan | `extractMustVerifyFromIntent` | ChapterIntent | 最多 8 条 | 无 | 否 |

### 1.1 已确认的双真相源

- ContextCompiler / 正式编排：`narrative-state-store.json` via `loadStateStore`
- Agentic 动态工具：`skeleton.json` / `narrative-state.json` / `arc-registry.json` / `unsettled-details.json` via `LegacyStateAdapter`
- 历史正文：动态工具直接读 live `final.md`，不走 `acceptedChapterIndex`
- 章节路径也不统一：ContextCompiler / backfill / preflight 读 `chapters/{N}.md`；`NarrativeSearchService` 读 `chapters/chapter-{N}/final.md`。同一 run 里检索可能找不到刚回填进 store 的正文。

### 1.2 现网已写入的 FailureEnvelope gate（不得平行发明同义名）

生产已在用：`preflight`、`context_load`、`capability_denied`、`pipeline_exception`、`unified_entry_exception`、`model_timeout`、`style_optimization`、`story_preservation`、`recovery_policy`、`unverified_high_risk_facts`、`memory_hard_conflict`、`agent_result_schema`、`agent_work_package`、`state_store`、`workspace_lock`、`budget_ledger`。

CEG-0.5 新名字是增量预约。`must_verify_coverage` 若接线，必须映射到现网 `unverified_high_risk_facts`，或在同一发布中物理替换旧名，不得长期双写。

## 2. 类型映射（CEG-0.1）

复用现有协议，禁止平行枚举。完整表见 `evidence-governance-contracts.ts`：

| 现有类型 | 新契约字段 | 规则 |
|---|---|---|
| `MemoryRecord.authorityClass` | `EvidenceRecord.authorityClass` | 原样复用 |
| `MemoryRecord.epistemicStatus` | `EvidenceRecord.epistemicStatus` | `declared/confirmed → confirmed`；`derived → derived`；`hypothesis → advisory`；`disputed → conflicted`；`planned/superseded` 不得当证据 |
| `TrustClass` / `Authority` | ContextPackage 槽位 | `author_declaration → author_authority/hard_constraint`；`system_derived → retrieved_reference/reference_only` |
| `TrustedToolResult` | 动态工具结果信封 | 继续用 `contentHash` / `evidenceRefs` / `contentTrust` |
| `NarrativeToolResultDetails.resultKind` | `RetrievalOutcome.status` | `no_match` ≠ `retrieval_error`；截断用 `truncated` |
| `ContextPackage.contextHash` | `contextPackageHash` | 内容 hash；不得用数量签名替代 |
| `AuditEvent` | ledger / 回放 | 只追加引用三类内容 hash，不得再派生签名 |
| `UnifiedProductionFailureEnvelope.gate` | CEG-0.5 七个新 gate 名 | 本波次只冻结名字与默认 failureClass，不接线生产 |

### 2.1 映射风险（Wave 1 必须先消掉，不得再加第四套）

1. **三套 `EvidenceLevel` 同名不同义**：工具协议 `confirmed_state / exact_chapter_span / inferred / profile_only`；审计 `observed / confirmed / derived / unavailable`；craft `doc_claim / tested / replay_validated`。CEG `EvidenceRecord.epistemicStatus` 只映射 MemoryRecord，不与这三套混用。
2. **三套（实际更多）contextHash**：`ContextCompiler.computeContextHash`（部分内容 SHA）、`deriveContextHashFromCompiled`（数量签名，写入 trace）、`ContextPackage.contextHash`（槽位 SHA）。协作态还用 `ctx:{workspaceId}:{chapterId}`，Agentic candidate 用字面量 `hash-{chapterId}-agentic_raw`。
3. **三套 FailureEnvelope**：`craft/failure-envelope.ts`（`hard_block`）、`v2/core/failure-envelope.ts`（生产 `failureClass`）、CoverageGate 专用信封。生产真相源是 unified production envelope。
4. **`authorityClass` ≠ `trustClass` ≠ `Authority`**：相关但不是 1:1；只允许走本文件映射表。
5. **`GenerationPacket` / `RetrievalBudget` 没有导出类型**：现网是 `buildContractContextString` + `retrievalCallLimit`。
6. **`resultKind` 已有 `no_match`，没有 `retrieval_error`**：Wave 2/4 补协议时不得把读失败写成 `no_match`。

## 3. 生产 A 基线（CEG-0.4，冻结）

本计划不得顺手调整下列参数，直至 Phase 6 真实 A/B 给出新结论。

| 参数 | 冻结值 | 源码 |
|---|---|---|
| historicalContinuity | 4 × 2400 | `model-prompt-adapter.ts` `buildHistoricalContext` |
| historicalCharacterState | 6 × 1800 | 同上 |
| recentPatternMemory | 4 × 1000 | 同上 |
| retrieve maxItems | `min(48, max(24, floor(total/4)))` | `context-compiler.ts` `computeMaxItems` |
| passingScore | 10 | `context-retrieval.ts` |
| advisoryFloor | `max(1, floor(itemLimit/8))` | `context-retrieval.ts` |
| scoreEntry 权重 | 权威 +50/+40/+30/-20，认识 +20/-10，角色 +100，必需 Promise +120，关键词 +40，新近性 ≤20 | `scoreEntry` |
| retrievalCallLimit | mustVerify ? 4 : 2 | `evidence-plan.ts` |
| 生产专用工具 | 9 个，见 `ALL_NARRATIVE_TOOLS` / `NARRATIVE_TOOL_NAMES` | facade 继续隔离 |
| 默认正文路由 | `v2_rawstage2_gemini31` / `v2_amplified_gemini31` | `config/model-routing.json` |
| 生产 renderer | `gemini_writer_v2` | 分层 `gemini_writer_v2_layered` 仍为 eval-only |
| known 摘要 | ≤80 字/条、≤12 条 | `evidence-plan.ts` |
| mustVerify 上限 | 8 | `evidence-plan.ts` |
| promptItems 摘要 | 160 字 | `context-retrieval.ts` |
| 相关角色档案 | 总计 3200 / 单条 900 | `model-prompt-adapter.ts` |
| searchChapterSpan | 10 章 / 10 条 / ±40 字 | `narrative-search-service.ts` |
| ContextSafety 窗口 | 128000 / 8192 / 4096 | `unified-entry.ts` 默认 env |

### 3.1 冻结的真实 replay 样本（只读引用，不改内容）

| 样本 | 路径 | 用途 |
|---|---|---|
| Context Replay A | `reports/phase6-context-ab/real/` | 生产 `buildHistoricalContext` 4/6/4 对照 |
| Tool Interface A | `reports/tool-interface-baseline.md` | 9 专用工具执行面 |
| Agentic 证据合并真实轨迹 | `reports/agentic-evidence-merge-real/` | 检索/coverage 对照 |
| 干净生产回放 | `D:\CODE\pns-verify111`（rel-prod-111） | 外部干净树，本波次不触碰 |
| xinmo 工作区 | `workspaces/xinmo/` | 真实长篇样本；本波次只读 |

以下**不得**当作检索 A 基线：`reports/language-calibration-real-1/`、`reports/ending-pressure-real-1/`（stub / 评测路径）；`reports/prompt-injection-trust-real-1/`（非 Gemini 生产 writer）。

## 4. FailureEnvelope gate（CEG-0.5）

| gate | 默认 stage | 默认 failureClass | Wave 0 状态 |
|---|---|---|---|
| `snapshot_build` | context_compile | preflight | 仅定义 |
| `snapshot_hash_mismatch` | context_compile | blocked | 仅定义 |
| `evidence_conflict` | gate | blocked | 仅定义 |
| `retrieval_error` | tool | recoverable | 仅定义 |
| `retrieval_budget_exhausted` | agentic | blocked | 仅定义 |
| `must_verify_coverage` | gate | blocked | 映射现网 `unverified_high_risk_facts` |
| `context_package_validation` | context_compile | blocked | 仅定义 |

默认分类使用生产 `FailureClass`（`preflight | recoverable | interrupted | blocked | fatal`），禁止再冻结 `hard_block` / `hard`。

## 5. RED 缺口（CEG-0.3）

| ID | 当前行为（特征测试通过） | 目标不变量（probe 失败） |
|---|---|---|
| G1 | `loadStateStore` 与 `NarrativeSearchService` 对同一 workspace 返回不同事实 | 同一 snapshotId，正式 store 为唯一真相 |
| G2 | `deriveContextHashFromCompiled` = `f1-l1-c1-w1-s1`，改文本不变 | 三类内容 hash 随内容变化 |
| G3 | `buildHistoricalContext` newest 4 丢掉已选旧章事实，无 renderer dropReason | 选择集合与最终输入差异全部有 dropReason |
| G4 | `searchChapterSpan` 读 live `final.md`，run 中改写立即可见 | 当前 run 继续使用冻结正文 |

验证探针（预期 4 fail / 0 pass）：

```text
cd .pi/extensions/novel-studio
node --import ./tests/setup-test-env.mjs --test --test-concurrency=1 tests/ceg-wave0-red.probe.mjs
```

## 6. 非目标（本波次重申）

- 不改 maxItems / maxChars / 工具数 / 模型路由
- 不把 ContextPackage 接进生产主入口
- 不删除 LegacyStateAdapter
- 不切换分层 Prompt
- 不处理用户在途脏文件
