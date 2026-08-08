# Phase 4 — 工具接口 A/B 实验设计（specialized-9-tools vs typed facade）

> 状态：**设计评审**（未改生产代码）
> 前置：Phase 3.1 收口已完成（`e7db26c`，tool_visibility trajectory 全链路核对通过）
> 本文档为 Phase 4 A/B 实验的**设计契约**，先评审后实现。全文不涉及生产代码改动。

---

## 1. 背景与目标

Phase 3.1 已确认当前 NovelOS 暴露 **9 个 specialized 叙事工具**
（`search_narrative_evidence` / `search_chapter_span` / `query_canon` /
`query_character_state` / `query_timeline` / `query_character_knowledge_boundary` /
`query_promise_ledger` / `query_pattern_memory` / `query_voice_evidence`），
注入链路 `allowedTools → runtime tools → schema → visibleTools` 已用持久化 trajectory 验证一致。

Phase 4 评估一个假设：**9 个 narrow 工具是否比单个 typed facade 更优？**

- **A 组（baseline）**：当前 specialized-9-tools。模型在 9 个窄工具间选择，每个工具 schema 小、语义精确，但模型需自行判断走哪个工具，可能产生工具选择负担与重复查询。
- **B 组（treatment）**：**typed facade**，仅作为 **eval-only wrapper**，把 9 个工具包成 1 个统一入口（如 `query_narrative`），内部按类型化意图（intent）路由到现有 9 个工具。**不复制任何检索逻辑**，只做路由分发。

目标：**在证据覆盖不下降的前提下，比较二者在工具调用、上下文负担、链路收敛与失败行为上的差异**，为后续是否进入生产迁移提供数据依据。

---

## 2. 设计约束（铁律）

1. **先设计后实现**：本阶段只提交设计文档，不修改任何生产/测试代码。
2. **B 组 eval-only**：typed facade 只生活在 `dist-eval/`（`tsconfig.eval.json`），不进入 `tsconfig.prod.json` / `dist/`。
3. **B 组复用现工工具**：内部必须调用 `createNarrativeTools` 产出的既有 9 个工具对象，**不得复制检索/排序/截断/nextQueryHint 逻辑**。
4. **固定对照**：A/B 两组使用**相同 fixtures、相同 prompt、相同模型路由、相同预算**，只改变工具集合形态。
5. **证据优先**：对比指标中，`mustVerify 覆盖率` 与 `sourceRef/evidenceLevel 完整性` 是**不降级底线**；工具/上下文负担是**优化目标**。
6. **先确定性，后真实模型**：先跑 stub 确定性 replay（零成本、可复现），再跑小规模真实模型 replay（受控预算）。

---

## 3. A/B 组定义

### 3.1 A 组：specialized-9-tools（当前现状）

- 工具集合：`NARRATIVE_TOOL_NAMES`（9 个窄工具，见 `novelos/tools/narrative-tools.ts`）。
- 每个工具独立 schema，`resultKind` 区分无法预知的领域结构。
- 模型需在 9 个工具中选择，并承担"选错工具 → 空结果 → 换工具重查"的风险。

### 3.2 B 组：typed facade（eval-only wrapper）

- **形态**：单个统一工具 `query_narrative`，参数为类型化联合：
  - `intent`（必填，联合类型）：`"evidence" | "chapter_span" | "canon" | "character_state" | "timeline" | "knowledge_boundary" | "promise" | "pattern" | "voice"`
  - `query`（选填，搜索类意图复用）
  - 各意图专属过滤字段（`category` / `characterId` / `status` / `patternType` 等，按 intent 收尾）
- **实现**：`execute` 内按 `intent` 路由到 `createNarrativeTools` 的对应工具对象，调用其 `execute`，**原样透传**其 `NarrativeToolResultDetails`（sourceRef / evidenceLevel / resultKind / truncated / nextQueryHint 等）。
- **不复制逻辑**：检索、token fallback、limit 截断、nextQueryHint 生成全部由底层工具完成；facade 只做 `intent → tool` 映射与参数整形。
- **B 组 schema 上下文**：1 个入口 + 1 个意图联合 vs A 组 9 套 schema。目标观测 B 组是否在**模型选择负担**上更优，但需防"单入口 schema 过大反而更重"。

> **实验协议标注（Phase 4.2.2，收口问题 3）**：B 组实现为 **guided facade**，而非"纯接口形态"对照。
> facade 的工具 `description` 注入了 `INTENT_USAGE`（每个意图的**何时使用 + 优先级 + 查询构造要点**，见 `typed-facade-tool.ts` 的 `QUERY_NARRATIVE_INTENT_GUIDANCE`），
> 而 A 组 9 个专用工具没有等价的集中式路由引导。因此：
> - 当前证据严格说是"**9 工具 vs 受引导的 facade**"结果，**不是**"9 工具 vs 纯单入口"的公平对照。
> - 该引导是**有意为之**的生产假设（统一入口若实现，理应携带意图路由说明），但它是 A/B 之外的**混淆变量**
>   （`intent guidance` 与 `interface surface` 同时变化），不能单独归因于"接口形态减少"。
> - 若需把"引导"与"接口形态"解耦，需补跑一个**无 `INTENT_USAGE` 引导的 B0 facade 对照**（B0 仅含类型化 intent 联合，不含"何时用/优先级/查询构造"说明）。
> - **结论归属**：本报告我只能证明"受引导的 facade ≥ 9 专用工具"在证据覆盖与失败行为上不降级、负担项改善；
>   不能证明"任意单入口 facade 都优于 9 工具"。生产迁移决策需把本偏差纳入评审。

---

## 4. 控制变量（A/B 相同）

| 变量 | 固定值 |
|------|--------|
| Fixtures | 同一组 eval fixtures（含高风险 mustVerify 正向召回 case） |
| Prompt | 相同 system / 检索决策规则 |
| 模型路由 | 相同 route / model / sampling（确定性阶段用 stub；真实阶段用同一 route） |

> **控制变量偏差（Phase 4.2.2 收口）**：§4 表"Prompt"原要求"B 组不加额外引导话术"，但为诊断 SC1 降级，
> B 组 facade 的 `description` 实际注入了 `INTENT_USAGE` 引导（见 §3.2 标注）。因此 `Prompt` 并非严格相等：
> B 组在工具描述层多了**意图路由引导**，A 组没有。本文档将此偏差显式记录，结论归属见 §3.2 标注。
| 预算 | 相同 `budgetPolicy`（模型调用软 6 / 硬 10，工具预算一致） |
| 时间 | 相同 `timeoutMs` |
| Workspace | 相同 `workspaces/{id}` 数据（canon / character / historical chapters） |

**唯一差异**：工具集合形态（9 个窄工具 vs 1 个 typed facade）。

---

## 5. 对比指标

从 `trajectory.jsonl` 的 `tool_visibility` / `tool_call_metrics` / `ranked_evidence` 条目计算（复用 `ToolCallMetricsTracer` 已采集字段）。

### 5.1 工具调用与重复查询
- 总工具调用次数（`totalCalls`）
- 每工具调用次数分布（`callsByTool`）
- 重复查询数（`duplicateQueries`，同工具同 query 第 2+ 次）
- 空结果查询数（`emptyResults`，含 `no_match`）

### 5.2 首次有效证据延迟
- 首次产生**有效证据**（`evidenceLevel ∈ {confirmed, confirmed_state, exact_chapter_span}`）的工具调用序号与累计耗时。
- 无有效证据时标 `unmeasured`。

### 5.3 结果字符 / token
- 每次工具调用 `resultChars` / `estimateTokens`（汇总 + 均值）。
- 观测 B 组是否因"单入口 + 同 schema"减少上下文膨胀，或反之。

### 5.4 mustVerify 覆盖率（不降级底线）
- 复用 `uncertainty-recall-metrics.ts` 的 `computeMustVerifyCoverage`：逐个 mustVerify 项计算 **confirmed 覆盖率**（`coverageRatio`）。
- 三态判定：`pass` / `fail` / `unmeasured`（无有效证据时不得计为 pass）。

### 5.5 sourceRef / evidenceLevel 完整性（不降级底线）
- 有效 evidenceLevel 占比（`VALID_EVIDENCE_LEVELS` 内）。
- sourceRef 有效性（排除 `INVALID_REF_PATTERNS` 黑名单，如 `:no-match` / `:empty` / `voice:profile_only:degraded`）。
- 结果是否携带完整 `resultKind` / `returnedCount` / `truncated` / `nextQueryHint`。
- **evidenceLevel 门禁采用累计强度比较**（`evaluateRealGate`→`evidenceLevelsCumulativeNonDegraded`）：沿证据强度排序
  `confirmed > confirmed_state > exact_chapter_span` 逐级累计命中数，要求 B 在每个累计阈值上的归一化累计命中率
  均不低于 A（一阶随机占优）。更强的等级可替代/补齐较弱的等级，避免把「B 的 confirmed_state 提升、exact_chapter_span
  归零」误判为退化；反向（用更弱等级顶替更强等级）仍正确失败。排序常量在 `uncertainty-recall-metrics.ts`
  的 `EVIDENCE_LEVEL_STRENGTH_ORDER`。

### 5.6 空结果 / 截断 / 错误 / 超时
- `empty` / `truncated` / `isError` / `timeout` 计数。
- 失败类型归因（`no_match` vs 工具错误 vs 超时）。

---

## 6. 执行计划

### Phase 4.1 — 确定性 replay（stub model，零 API 调用）
1. 实现 eval-only 模块 `novelos/eval/tool-ab-runner.ts`（A/B 双 runner，共用 fixtures）。
2. 实现 B 组 `query_narrative` typed facade（eval-only，复用 `createNarrativeTools`）。
3. 跑 `runAgentLoopForEval(b2)` 两次：A 组注入 9 工具，B 组注入 facade。
4. 从两次 trajectory 提取 §5 全部指标，生成 `reports/phase4-tool-ab/` 对比报告（JSON + MD）。
5. 断言底线：`B.mustVerifyCoverage ≥ A` 且 `B.sourceRef/evidenceLevel 完整率 ≥ A`。

### Phase 4.2 — 小规模真实模型 replay（受控）
1. 固定 fixtures 子集（含高风险 case）、固定 seed / temperature。
2. A/B 共用同一 route，各跑 N 次（N 受控，如 3-5）。
3. 复用确定性阶段指标采集，聚合均值 / 分布。
4. 产出对比报告，供人工审阅。

### Phase 4.3 — 生产接入设计评审（设计稿，非实现）

> **范围与边界声明（硬约束）**：本阶段是**设计评审**，产出受控接入蓝图，**不实现、不注册、不切换**。
> - `query_narrative` 保持 **eval-only**（`novelos/eval/typed-facade-tool.ts`），既不进入 `tools/register-tools.ts` 的 6 公开工具，也不进入 `createNarrativeTools`（`novelos/tools/narrative-tools.ts`）。
> - 统一主链路（`novel_generate_chapter`）**不被切换**；生产 NovelOS Agentic 仍注入 9 专用工具。
> - 本设计仅作为未来独立接入 Phase 的实现蓝图，须经后续独立 Phase 实现并再次评审后才可落地。

**4.3.1 生产接入点（注入路径）**

生产 NovelOS Agentic 的工具注入点位于 `agentic-raw-candidate-source.ts`：

```
registry.getToolsForRole("agent")   // narrative-tool-registry.ts，来源 createNarrativeTools（9 工具）
  → filter(evidencePlan.allowedTools)  // Phase 2C 白名单收窄
  → createNovelOSRuntime({ tools, ... })
```

- 工具集唯一来源是 `narrative-tool-registry.ts`（经 `createNarrativeTools` 注册 9 只读工具）。
- 若未来接入 facade，有两种等价注入方式（二选一，不并行）：
  1. **registry 层替换**：在 registry 注册 `query_narrative` 并停用 9 工具，注入面收缩为单工具；
  2. **白名单收窄**：保持 9 工具注册，`evidencePlan.allowedTools` 仅含 `query_narrative`，注入面同样收缩。
- 注入边界防御：`tool-schema-injector.ts` 的 `MAX_INJECTED_TOOLS=12` fail-closed 上限会拦截超限注入，防止绕过 `allowedTools` 的全量注入。

**4.3.2 Canary 策略（受控灰度）**

复用既有治理，不新造第二套 release 机制：

1. 变更分级：把"9 工具 → 单 facade"归类为 **changeClass=R2**（接口面显著减少、调用行为变化但事实检索能力等价）。
2. 策略决策：`canary-policy.ts::decideCanaryStrategy`（changeClass × healthStatus × currentStatus）→ healthy 走 **bounded_canary**，warning/insufficient_data 走 **shadow_required**，auto_hold_eligible/retired_suggestion → **blocked**。
3. Canary 执行：在独立 workspace 完成 bounded canary run，产出完成态 trace（`canary-trace-store.ts`）。
4. 晋级门禁：`canary-promotion-gate.ts::evaluateCanaryPromotionGate` 校验 trace 完成态 + 证据 artifact hash + observedChapters/observedCalls 统计一致性 + release 绑定（R2 要求 `bounded_canary` 或 `shadow_required` 策略）。
5. 生产门禁：`production-release-gate.ts`（G6）全通过才进入 active_prod：`active_prod` + 非空 `approvalRef` 且审批 artifact 真实（`finalVerdict=APPROVE_DEV`）+ 环境指纹匹配 + R2/R3 需 canary 晋级证据事件。

**4.3.3 回滚设计**

- 保持 A 组（9 工具）release 为**独立可切换的 active pointer**；回滚 = 经 `release-pointer-store.ts` 把 active production pointer 切回 A 组 release（既有原子路径，无需新机制）。
- 触发回滚判定依据（对齐 §5.6 门禁）：**失败行为不得恶化**——`emptyResults` / `truncated` / `errors` / `timeouts` / 非法工具 / 解析失败任一指标在 canary 期间劣于 A 组即触发回滚评估。
- 回滚后 `novel_generate_chapter` 自动回到 9 工具注入（因为工具集随 registry / release 变化，Gate 不阻断 9 工具这一既有现状）。

**4.3.4 Trace 监控**

- 章节级：`release-health-aggregator.ts` 从 `traces/{chapterId}-quality-trace.json`（`v2_final_selected` gate）聚合模型调用、失败恢复、release 绑定。
- Canary 级：`canary-trace-store.ts` 留存 canary run 的 started/completed trace 与结果 artifact。
- 监控口径（与 Phase 4.2 门禁一致）：mustVerify 覆盖率、有效证据引用率、evidenceLevel 命中、`empty/truncated/errors/timeouts/非法工具/解析失败`、schema token 成本、首证据延迟。`empty/truncated` 必须纳入 `allPassed`（Phase 4.2.3 已实现）。
- 汇报：`reports/generation-blocker-summary.md` 式仪表盘（成功率/首次成功率/恢复后成功率/失败分布）作为生产健康基线。

**4.3.5 模型版本隔离**

- `environment-fingerprint.ts` 将 **tool schema / model routing / runtime files / build artifacts** 纳入环境指纹；facade 接入会改变 tool schema → 指纹变化 → 需重新 `capture release` + 通过审批，防止"未审批的 facade 二进制静默进入生产"。
- 模型路由真相源 `config/model-routing.json`：facade 接入绑定的模型版本按 release 隔离，canary 期观察数据不污染旧模型信誉（对齐"按模型版本隔离策略信誉"铁律）。
- 若需在受控组观察，route 使用实验路由（如 `narrator_testing_glm`，`fallback=[]`），不进入生产默认路由。

**4.3.6 进入实现前的评审前置条件（必须全部满足）**

- [x] 真实 replay（GLM/Doubao，`fallback=[]`）在**稳定 commit** 上全门禁通过，含修正后 evidenceLevel 口径（`rankedEvidenceLevels` + `evidenceLevelsCumulativeNonDegraded` 累计强度比较）与 `empty/truncated` 逐场景门禁。
  - 2026-08-08：证据等级门禁从逐级独立比较修正为累计强度比较（commit `9702eef`），并在 `reports/phase4-real-glm-full-v3/` 补跑 3 场景 × 3 seed 真实 replay（glm-5.2，`fallback=[]`）→ `allPassed=true`。修正后 real replay 门禁不再阻断，Phase 4.3 设计评审条件满足；**仍不切生产**，生产接入须等独立实现 + 生产 canary + G6 全通过。
- [ ] 若需把"intent 引导"与"接口形态"解耦，补跑**无 `INTENT_USAGE` 的 B0 facade 对照**，否则结论归属保持"受引导的 facade vs 9 工具"。
- [ ] 本设计评审通过后，才可进入独立实现 Phase（届时仍须保持"不注册公开工具、不切换统一主链路"直到生产 canary + G6 全通过）。

---

## 7. 验收产物

- [ ] `novelos/eval/tool-ab-runner.ts`（eval-only，A/B 双 runner）
- [ ] `novelos/eval/typed-facade-tool.ts`（eval-only，B 组 facade，复用现有工具）
- [ ] `tests-eval/phase4-tool-ab.test.mjs`（确定性断言：底线不降级 + 指标可提取）
- [ ] `reports/phase4-tool-ab/`（确定性 + 真实模型对比报告，含 trajectory 副本）
- [ ] 本设计评审通过后，先提交 Phase 4.1 实现（RED/GREEN 分开提交）

---

## 8. 决策记录（ADR）

| 决策 | 理由 |
|------|------|
| B 组用 typed facade 而非"减少工具数量" | 保持 9 工具检索能力不变，只比较接口形态；facade 是纯路由，零逻辑复制 |
| 先确定性后真实模型 | 确定性可复现、可审阅、零成本；真实模型只做受控验证 |
| mustVerify / sourceRef 覆盖为底线 | 工具形态优化不得以牺牲证据覆盖为代价（对齐项目"事实安全优先"约束） |
| B 组实现为 guided facade（Phase 4.2.2） | 诊断 SC1 降级时在 facade description 注入 INTENT_USAGE（何时用/优先级/查询构造）。这是**有意**的生产假设，但构成 A/B 混淆变量（intent guidance 与 interface surface 同时变化）；结论归属被限定为"受引导的 facade vs 9 工具"，不推广为"任意单入口 facade 优于 9 工具"。如需解耦须补跑无 INTENT_USAGE 的 B0 对照 |
| `query_narrative` 暂不注册生产公开工具（Phase 4.3） | 收口审计未完成前不 cutover；保持 6 公开工具契约 + 统一主链路注入 9 工具现状不变。Phase 4.3 仅产出受控接入设计 |
| 生产接入复用既有 canary/G6 治理，不新造第二套 release 机制（Phase 4.3） | `decideCanaryStrategy`（R2=bounded_canary）+ `evaluateCanaryPromotionGate` + `production-release-gate`（G6）已具备分级灰度/晋级/审批/指纹门禁全套能力；避免重复造轮子 |
| 回滚 = active pointer 切回 A 组 release（Phase 4.3） | `release-pointer-store.ts` 提供原子切换；失败行为（empty/truncated/errors/timeouts/非法工具/解析失败）任一恶化即触发回滚评估 |
| 模型版本隔离走 environment-fingerprint + model-routing（Phase 4.3） | 指纹含 tool schema/model-routing，facade 接入改变指纹 → 需重 capture + 审批；模型信誉按 release 隔离，canary 数据不污染旧模型 |

---

## 9. Phase 5 — 受控生产接入实现（2026-08-08）

> **范围声明（硬约束）**：Phase 5 是 **受控生产接入实现**，不是全量切换生产。
> 只实现并验证 **"guided facade vs 9 工具" 的受控对照**，不推广为"任意单入口 facade 更优"。
> 项目总计划中的"统一主链路切换"Phase 5 已完成，**不在此重复实施**。

### 9.1 目标

在保持默认生产行为完全不变（9 专用工具执行面）的前提下，为**显式 opt-in 的 canary workspace**
提供一条受控的 facade 生产路径：模型只看到 1 个统一入口 `query_narrative_production`
（按 intent 路由到 9 个底层专用工具），并复用既有 R2/G6 canary、trace、environment fingerprint
与 rollback 机制。只有 promotion gate 通过后才允许切换 active pointer；失败立即回到 9 专用工具。

### 9.2 设计要点

- **runtime facade 变体**：`query_narrative_production`（`novelos/tools/query-narrative-facade.ts`）
  与 eval-only 的 `query_narrative`（`novelos/eval/typed-facade-tool.ts`）**严格区分**。
  前者进入生产闭包（`tsconfig.prod.json` → `dist/`），后者保持 eval-only（`dist-eval/`），
  避免把 eval 模块拉进 dist/（依赖边界铁律）。二者共享 **纯数据常量**（intent 路由映射），零逻辑复制。
- **受控接入开关**：`NarrativeToolMode = "standard" | "facade"`（`evidence-plan.ts`）。
  - `standard`/缺省：默认生产，9 专用工具（`NARRATIVE_TOOL_NAMES`），行为不变。
  - `facade`：registry 额外注册 `query_narrative_production`（`enableFacade=true`），
    `evidencePlan.allowedTools` 收窄为 `[query_narrative_production]`，
    runtime 注入白名单/检索预算扩为 `NARRATIVE_TOOL_NAMES_WITH_FACADE`。
- **opt-in 走 workspace canary 授权**：`canary-authorization.json` 新增可选 `toolMode` 字段
  （`canary-workspace-authorization.ts` schema 校验，可选枚举 `standard|facade`）。
  `resolve-tool-mode-from-canary-authorization.ts` 以 **fail-closed** 语义解析：
  仅当授权**明确**声明 `toolMode="facade"` **且未过期**才返回 `"facade"`；
  授权缺失 / standard / 未声明 / schema 校验失败 / 损坏 JSON / 过期 一律返回 `undefined`（= 默认 9 工具）。
- **显式 allowedTools 优先于 toolMode**：调用方可精确控制注入工具集，toolMode 仅作默认收窄。

### 9.3 接线

- `unified-entry.ts`：`evalMode/qualityExperiment` 缺省时调用 `resolveToolModeFromCanaryAuthorization(projectRoot, workspaceId)`
  解析 `toolMode`，only 对显式 opt-in 的 canary workspace 传 `"facade"`，其余 `undefined`（非全量切换）。
- `unified-orchestrator.ts` → `orchestrator-types.ts`：把 `toolMode` 透传给 `agenticCandidateSource.generate(toolMode)`。
- `agentic-raw-candidate-source.ts`：`toolMode === "facade"` 时 `enableFacade=true`、注入白名单
  `NARRATIVE_TOOL_NAMES_WITH_FACADE`、检索预算集合同样扩为含 facade（统一入口调用也计入检索预算）。

### 9.4 验证

- focused 测试：`tests/phase5-facade-controlled-access.test.mjs`（22 断言）覆盖
  registry facade 注册（默认 9 / facade 10）、evidence-plan 受控注入（facade 收窄 / 显式优先 / 缺省默认）、
  resolve-tool-mode fail-closed（缺失 / standard / 未声明 / 非法 / 损坏 / 过期 / rollback 删除授权即回退）。
- 无回归：`npm run build` 通过；受影响模块 focused 测试（canary 授权 / evidence-decision /
  tool-visibility / retrieval-budget / production-tool-registration / dependency-boundary）79 断言全通过。
- 依赖边界：`dist/` 不含 eval-only `query_narrative`；`query_narrative_production` 仅在
  `enableFacade=true` 时注册，默认生产 9 工具执行面不变。

### 9.5 边界与后续

- **不 cutover**：默认生产仍为 9 专用工具；facade 仅对显式 opt-in 的 canary workspace 生效。
- 后续需独立产线：隔离 workspace bounded canary（R2）→ promotion gate 通过 → 切换 active pointer；
  任一失败行为（empty/truncated/errors/timeouts/非法工具/解析失败）恶化即回滚 9 专用工具。
- 若需解耦"意图引导"与"接口形态"，另行补跑**无 `INTENT_USAGE` 的 B0 facade 对照**（延续 §3.2 标注）。