# Wave 0 基线报告：修订授权与不可变候选谱系（REASONING-REPAIR-BOUNDARY-1）

**任务编号**：`REASONING-REPAIR-BOUNDARY-1`  
**本报告**：Wave 0（RRB-0.1 ~ RRB-0.5）基线冻结  
**日期**：2026-08-16  
**状态**：契约已冻结；RED 待补；生产行为未变  
**适用范围**：`novel_generate_chapter -> NovelOS Agentic -> NarrativeVerifier -> Repair -> 作者风格整章优化 -> StoryPreservation -> FinalFactRecheck -> Completeness -> FinalStateCommit`

> 本文是只读核查输出。工作树含大量用户在途改动；执行过程仅保存本报告与
> `v2/core/repair-authorization-contracts.ts` 两个新增文件，未恢复、暂存、删除、
> 覆盖或 stash 任何无关修改。

---

## 0. 本 Wave 交付物

| 任务 | 交付物 | 位置 | 状态 |
|---|---|---|---|
| RRB-0.2 | 冻结 `RepairAuthorization` / `CandidateRevisionManifest` / 修订阶梯 / failure-type 映射 / reason code / stop reason | `v2/core/repair-authorization-contracts.ts` | ✅ |
| RRB-0.3 | 与现有 `EvidenceRecord/AuthorityClass/OrchestratorDecision/AgentLineage/AuditEvent` 的字段映射 | 同上（`REPAIR_CONTRACT_REUSE_MAP`） | ✅ |
| RRB-0.1 | finding → feedback → proposal → patch → reverify → candidate → commit 调用点清单 | 本报告 §2 | ✅ |
| RRB-0.5 | 冻结修订轮数 / 模型路由 / 预算基线 | 本报告 §4 | ✅ |
| RRB-0.4 | 六项缺口的 RED 测试（旧实现稳定失败） | `tests/repair-authorization-boundary-red.test.mjs` | ⏳ 待补 |

**契约模块只含类型 + const + 映射表，零 I/O、零行为变化。** 类型别名只做 type-only
导入（`VerificationFailureType` / `AuthorityClass` / `TextSpan`），编译后不产生运行时
反向依赖；`typecheck` 已通过（`npm run typecheck` 无错误）。

---

## 1. 契约冻结摘要（RRB-0.2 / RRB-0.3）

完整定义见 `v2/core/repair-authorization-contracts.ts`，此处只列关键边界，防止实现漂移。

- `RepairAction`：`no_op | span_patch | paragraph_patch | bridge_patch | new_candidate | block | human_review`。
- `REPAIR_LADDER`：`no_op → span_patch → paragraph_patch → bridge_patch → new_candidate`。`new_candidate` 是生成新的完整候选，不是覆盖父候选的 `chapter_rewrite`。
- `RepairAuthorization`：一次性授权，绑定 `candidateTextHash` + `snapshotId` + `evidenceExcerptHashes` + `authorizedRanges` + `budgetReservationId`，`issuedBy ∈ {orchestrator, system}`。
- `RepairAuthorizationPolicyDecision`：fail-closed 裁决输出，任一准入条件不满足即 `deny`。
- `FAILURE_TYPE_TO_ALLOWED_ACTION`：17 个 `VerificationFailureType` 的 action 白名单；`language_risk → [no_op, human_review]`、`intent_covered → [no_op]`、`author_input_conflict → [block, human_review]`；未列入类型默认 `[no_op, block, human_review]`。
- `UNKNOWN_FAILURE_TYPE_DEFAULT_ACTION`：新 failure type 默认 `no_op/block/human_review`（删除 default-to-sentence-patch 行为，RRB-1.4）。
- `RepairReasonCode`：`deny_*`（准入拒绝）/ `require_*`（强制动作）结构化理由码，禁止笼统“修订失败”。
- `RepairStopReason`：`cleared | budget_exhausted | stagnant | no_authorized_action | stale_authorization | comparator_rejected | new_hard_finding | request_new_candidate | blocked`（对应 RRB-4.4）。
- `REPAIR_ADMISSION_CONDITIONS`：§3.2 十项准入条件（`hard_finding` … `repair_budget_available`）。
- `CandidateDerivationType`：`agentic_generation | span_patch | paragraph_patch | bridge_patch | new_candidate | author_style_transform | user_edit`。
- `CandidateRevisionManifest`：`candidateId + chapterId + parentCandidateId + sourceCandidateId + derivationType + textArtifactRef + textHash + parentTextHash + diffArtifactRef + diffHash + authorizationId + verifierReportId + createdAt`。
- `REPAIR_CONTRACT_REUSE_MAP`：新契约字段 → 现有协议字段的逐项复用映射（authority→`MemoryRecord.authorityClass`、evidence→`EvidenceRecord.evidenceId`、裁决→`OrchestratorDecision.decisionId`、候选→`AgentLineage.parentCandidateId/sourceCandidateId`、审计→`AuditEvent.candidate_created/candidate_derived/gate_evaluated/repair_started/repair_completed`）。
- `REPAIR_AUTHORIZATION_INVARIANTS` / `CANDIDATE_LINEAGE_INVARIANTS`：供实现与测试引用的不变量常量。

---

## 2. 调用点清单（RRB-0.1）

标注每一环的**写入 / 授权 / hash** 边界，并指向对应的 P0 缺口。

| # | 阶段 | 调用点 | 当前行为 | 边界标注 | 缺口 |
|---|---|---|---|---|---|
| 1 | finding | `novelos/verification/narrative-verifier-suite.ts:159` `diagnosticToFinding()` | 构造 `VerificationFinding` | `sourceRef: diagnostic.id`（`:201`），finding 无 `evidenceId` | G1 |
| 2 | finding | `novelos/verification/narrative-verifier-types.ts` `VerificationFinding` | 无 `evidenceId` 字段 | 证据身份未闭环 | G1 |
| 3 | feedback | `novelos/verification/verification-feedback-compiler.ts` `findingToFeedback()` | `VerificationFeedback` 透传 `sourceRef` | sourceRef 仍是定位符，非权威证据 | G1 |
| 4 | proposal | `novelos/agent/candidate-patch-service.ts:99` `proposePatches()` → `:129` `proposePatch()` | 每 finding 生成一个 `PatchProposal` | `localReplacement = !isFullChapter && spanLength < draft.length * 0.4`（`:140`）—— span ≥40% 时静默升级为整章输出 | G2 |
| 5 | patch | `novelos/agent/narrative-agent-loop.ts:824` / `:827` | `buildLocalReplacementPrompt` vs `buildFullRewritePrompt` | 40% 阈值路由到完整正文重写 prompt | G2 |
| 6 | patch | `novelos/agent/candidate-patch-service.ts:210` `evaluatePatch()` | `checkSpanImmutability(originalDraft, patchedText, [proposal.targetSpan])` | 仅校验单 proposal 单 span，未联合校验本轮全部授权 span | G4 |
| 7 | patch | `novelos/agent/candidate-patch-service.ts:285` `checkSpanImmutability`（private） | 单 span 不变量校验 | 未暴露多 span 联合校验入口 | G4 |
| 8 | reverify | `novelos/agent/narrative-agent-loop.ts:611` `verifyAndPatch()` | verify → patch → reverify 闭环 | `currentText = patchedText`（`:735`）无条件推进 | G5 |
| 9 | reverify | `novelos/agent/narrative-agent-loop.ts:740` | `madeProgress = nextFindingIds.size < previousFindingIds.size` | 只比较 finding 数量，不比较 identity/severity/evidence/hash | G5 |
| 10 | reverify | `novelos/agent/narrative-agent-loop.ts:626` / `:725` | `verifyModelCalls += 1` | 同步 `verifier.verify()` 被累计为 model call | G6 |
| 11 | candidate | `novelos/agent/candidate-workspace.ts:80` `writeDraft()` | 覆盖式写入 `draft.md`（loop `:313` / `:340` 各写一次） | 原候选正文被覆盖，无不可变谱系 | G3 |
| 12 | candidate | `novelos/agent/agentic-raw-candidate-source.ts:904` / `:909` | `id: candidate:agentic_raw:${chapterId}`、`contextHash: hash-${chapterId}-agentic_raw` | 每章固定 ID，多轮不同正文共用同一身份 | G3 |
| 13 | commit | `v2/core/evidence-record-adapter.ts:53` / `:56` `baseRecord()` | `authorityClass` 默认 `committed_state`；`sourceContentHash: ""` | 权威可降级、内容 hash 恒为空 | G1 |
| 14 | commit | `novelos/agent/narrative-agent-loop.ts:378` | `modelCallsByKind.verify = verifyModelCalls` | 生产 trace 记录旧 `verify` 口径 | G6 |

---

## 3. 六项 P0 缺口与 RED 定位（RRB-0.4）

RED 测试将证明旧实现在六项边界上**稳定失败**，实现 Phase 1+ 后转绿。

| 缺口 | 现象 | 当前代码证据 | 预计 RED 断言 |
|---|---|---|---|
| G1 证据权威 | diagnostic ID 可穿过 `sourceRef` 充当权威证据 | `narrative-verifier-suite.ts:201`、`evidence-record-adapter.ts:56` | finding 的 `sourceRef` 等于 `diagnostic.id` 且无 `evidenceId`；`EvidenceRecord.sourceContentHash === ""` |
| G2 修订权限 | span ≥40% 静默升级整章输出 | `candidate-patch-service.ts:140` | `proposePatch` 对大 span 返回 `localReplacement=false` 并进入整章重写 |
| G3 候选不可变 | `draft.md` 被覆盖、候选固定 ID | `candidate-workspace.ts:80`、`agentic-raw-candidate-source.ts:904` | 两次 `writeDraft` 后首版正文不可回放；candidateId 与正文 hash 无关 |
| G4 多 span 校验 | 逐 proposal 单 span 校验同一 patchedText | `candidate-patch-service.ts:210` | 多 proposal 时授权范围外变化未被联合拒绝 |
| G5 新 hard finding | reverify 后 `currentText` 无条件推进 | `narrative-agent-loop.ts:735`、`:740` | 新增 hard finding（数量不变但 identity 换新）时 currentText 仍推进 |
| G6 调用计量 | 本地 validator 计作 model call | `narrative-agent-loop.ts:626`、`:725`、`:378` | 本地 `verifier.verify()` 使 `verifyModelCalls` / `modelCallsByKind.verify` 递增 |

RED 测试文件路径（待补）：`tests/repair-authorization-boundary-red.test.mjs`。
RED 导入边界：从编译产物 `dist*/` 导入，覆盖
`candidate-patch-service.js`、`candidate-workspace.js`、`narrative-verifier-suite.js`、
`evidence-governance-contracts.js`；`evidence-record-adapter.js` 不在 `dist/` 生产闭包，
G1 证据侧通过 `narrative-verifier-suite` + 类型断言路径覆盖。

---

## 4. 冻结基线（RRB-0.5）

本计划**不**顺手增加修订轮数、模型调用或模型 fallback。以下数值视为冻结基线：

| 项 | 当前值 | 来源 |
|---|---|---|
| 修订轮数 `maxRepairRounds` | **2**（默认），`PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS` 可覆盖 | `narrative-agent-loop.ts:154`、`:665` |
| 停滞阈值 `maxStagnantRounds` | 由 `EvidencePlan.stopConditions` 提供 | `narrative-agent-loop.ts:619`、`:766` |
| Agentic 预算 `maxTurns` / `maxToolCalls` | **10 / 20** | `novelos/runtime/budget-policy.ts:41-43` |
| 模型路由版本 | **v4.31.0**（2026-07-21） | `config/model-routing.json` `_version` |
| 生产 writer 隔离 | Claude Opus 4.6 主写；GPT judge / Doubao 校准 / GLM 隔离均为旁路 | `config/model-routing.json` 迁移注记 |

> 注：`CLAUDE.md` 的“routing config v4.18.0”为 2026-07-17 快照，已过期；本报告以
> `config/model-routing.json` 当前 `_version=4.31.0` 为准（该 JSON 是唯一真相源）。

---

## 5. 工作树快照（只读，未改动）

执行 Wave 0 时工作树处于大量在途修改状态。本 Wave 仅新增两个文件：

1. `v2/core/repair-authorization-contracts.ts`（新增，契约冻结）
2. `docs/model-reasoning-external-verification-minimal-revision-wave0-baseline-20260816.md`（本报告）

未 `git add`、未 `stash`、未 `restore`、未删除任何既有文件。后续 Wave 开工前须重新
保存各自工作包的 `git status` / `git diff` 只读快照并限定文件清单（计划 §6.2）。
