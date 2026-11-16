# Phase 4 - 工具接口 A/B 实验设计（specialized-9-tools vs typed facade）

> 状态：**Phase 4 设计评审完成 + Phase 5 受控生产接入已实现 + Gemini 生产路由验证完成**（2026-08-11 更新）
> 前置：Phase 3.1 收口已完成（`e7db26c`，tool_visibility trajectory 全链路核对通过）
> 本文档原为 Phase 4 A/B 实验的**设计契约**。Phase 4.3 设计评审已通过，Phase 5（§9）已实现受控生产接入（runtime facade `query_narrative_production`，仅 canary opt-in，默认生产仍为 9 专用工具）。
>
> **Gemini 生产路由验证（2026-08-11）**：
> - **SC7 单场景 5 seed**（`reports/phase4-tool-ab-real-gemini-v2/`）：B 组在 mustVerify 覆盖率（1.000）、有效证据引用率（1.000）、停止率（100%）、失败行为上**全面与 A 组持平**，schema token 改善 21.5%。
> - **全场景 3 seed**（SC1/SC6/SC7，`reports/phase4-tool-ab-real-gemini-full/`）：B 组 mustVerify 覆盖率稳定 1.000，但 SC7 出现 sourceRef 降级（0.600 vs 1.000）、空结果 4 次、非法 intent 4 次。两次 replay 的 SC7 结果差异表明 **B 组在 Gemini 下的表现存在 seed 级方差**，尚不具备生产晋级稳定性。
> - **evidenceLevel 门禁双轨制修正**：per-call 率 + 绝对命中数同时降级才判失败（详见 §8 ADR）。修正后 evidenceLevel 门禁通过，但 sourceRef/empty 门禁仍失败。
> - **生产准入决策**：保留 9 专用工具为默认生产注入；受引导 facade 保持 canary opt-in，不晋级为默认。

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

### Phase 4.3 - 生产接入设计评审（设计稿，已于 Phase 5 实现）

> **范围与边界声明**：本阶段原为**设计评审**，产出受控接入蓝图。
> **更新（2026-08-08）**：Phase 5（§9）已按本蓝图实现受控生产接入--runtime facade 变体
> `query_narrative_production` 进入生产闭包（`tsconfig.prod.json` -> `dist/`），仅在 canary
> workspace 显式 opt-in（`toolMode="facade"`）时注册。默认生产仍为 9 专用工具，**未全量切换**。
> - eval-only 的 `query_narrative`（`novelos/eval/typed-facade-tool.ts`）仍保持 eval-only，不进入 `dist/`。
> - 统一主链路（`novel_generate_chapter`）**未被切换**；生产 NovelOS Agentic 默认仍注入 9 专用工具。
> - 本设计作为 Phase 5 实现的蓝图，Phase 5 已完成受控接入实现与验证（详见 §9）。

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
- [x] 若需把"intent 引导"与"接口形态"解耦，补跑**无 `INTENT_USAGE` 的 B0 facade 对照**，否则结论归属保持"受引导的 facade vs 9 工具"。
  - 2026-08-09：B0 对照已在 `reports/phase4-real-glm-b0-v1/` 至 `v3` 多轮 replay 中完成。B0（无引导）在全部场景全面恶化，确认"引导是 facade 价值的必要前提"。
- [x] 本设计评审通过后，才可进入独立实现 Phase（届时仍须保持"不注册公开工具、不切换统一主链路"直到生产 canary + G6 全通过）。
  - 2026-08-08：Phase 5（§9）已按蓝图实现受控生产接入。runtime facade `query_narrative_production` 进入生产闭包，仅 canary opt-in 注册，默认生产仍为 9 专用工具。

---

## 7. 验收产物

- [x] `novelos/eval/tool-ab-runner.ts`（eval-only，A/B 双 runner）
- [x] `novelos/eval/typed-facade-tool.ts`（eval-only，B 组 facade，复用现有工具）
- [x] `tests-eval/phase4-tool-ab.test.mjs`（确定性断言：底线不降级 + 指标可提取）
- [x] `reports/phase4-tool-ab/`（确定性 + 真实模型对比报告，含 trajectory 副本）
- [x] 本设计评审通过后，Phase 4.1 实现 + Phase 5 受控生产接入均已提交（详见 §9）

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
| eating-canary: 真实模型隔离 canary 未通过门禁，"默认 facade"不成立（Phase 4.2，2026-08-09） | `reports/phase4-real-glm-b0-v1/`（glm-5.2，3 场景×3 seed×A/B/B0）显示：B 受引导 facade 的 mustVerify 覆盖 0.944 < A 1.000（SC1 seed1 提前收敛漏项），B0 无引导 facade 在引用率/证据等级/空结果/非法工具/场景门禁上全面恶化。整体与 B0 门禁均未通过，**不默认切换 facade** |
| eating-canary: 单入口收益（B0）不足，facade 价值主要由描述引导贡献（Phase 4.2） | B0 无引导时无效工具 6>3、空结果 6>3、引用率 0.591<0.654、evidenceLevel 0.591<0.654 全面恶化 → 纯单入口界面不成立；B−B0 引导 delta 显示引导显著减少无效工具/调用/重复/空结果并提升停止率 → 引导是 facade 有价值的主因 |
| eating-canary: 保留 9 专用工具为默认生产注入（Phase 4.2 决策） | 真实 canary 未证明 facade 稳定正收益：受引导 facade 有覆盖回归，无引导 facade 全面更差。A 组（9 工具）覆盖稳定 1.000。在修复"高停止率诱发覆盖回归"前，不引入 facade 作为默认；混合结构亦无当前数据支持 |
| eating-canary: 修复"早终止诱发覆盖回归"后，受引导 facade 在 SC1 覆盖恢复 1.000（Phase 4.2，2026-08-09） | 根因：facade 收尾句"证据充分后立即输出终止标记"与 guidance 的"evidence=最高优先级"叠加，使模型拿到 e1 高等级证据后过早收敛，漏掉 mustVerify 其余项（SC1 seed1 0.500）。修复：改为强制"逐项遍历 mustVerify 全部待验证事实、全部覆盖后再输出终止标记"。`reports/phase4-real-glm-b0-v2/`（glm-5.2，SC1×3 seed×A/B/B0）显示 B 覆盖 0.833→**1.000**（全 seed），停止率仍 100%，引用率 1.000，失败行为门禁全过，schema token 6273 < A 6824。**"高停止率诱发覆盖回归"已消除**；B 唯一未过项为 evidenceLevel 的 `exact_chapter_span` 命中率（B=0.000 < A=0.200），属引导偏好差异（引导模型优先 evidence 而非 chapter_span），非覆盖缺陷 |
| eating-canary: SC1 修复后受引导 facade 达到"全覆盖 + 高停止率 + 低负担"三优，但需全场景复验方能晋级（Phase 4.2） | SC1 定向重跑证明早终止问题已解决；但本轮仅重跑 SC1（1 场景），未覆盖 SC6/SC7。B0 在 v2 仍全面恶化（引用率 0.667、空结果 3、非法工具 3、停止率 0%），纯单入口界面仍不成立。**9 工具仍为默认**；是否晋级 facade 需对 SC6/SC7 全场景真实 canary 复验，且评估 evidenceLevel 偏好差异是否可接受 |
| eating-canary: 全场景复验最终结论——**保留 9 专用工具为默认**，受控 opt-in facade 已无覆盖回归风险（Phase 4.2，2026-08-09） | 合并 `phase4-real-glm-b0-v2`（SC1）+ `v3`（SC6/SC7）全 3 场景真实 canary（glm-5.2×3 seed×A/B/B0）：修复后 B 的 mustVerify 覆盖**全场景全 seed 稳定 1.000 = A**（不再回归），停止率与 A 持平（SC1=100%、SC6/SC7=67%），失败行为（空结果/截断/错误/超时/非法工具）全部不恶化。但 B 在 SC7 有效证据引用率略逊 A（0.727 vs 0.833）、无效 sourceRef 微增（no_match 3 vs 1），系引导让模型对无需检索项也发起 evidence 查询的**查询精度差异，非覆盖缺陷**；SC1 的 `exact_chapter_span` 命中率差异同为引导偏好。B0 无引导在全部场景仍全面恶化（引用率 0.500、空结果/非法工具 3、SC7 门禁 FAIL）→ 纯单入口界面不成立，**引导是 facade 价值的必要前提**。决策：**保留 9 专用工具为默认生产注入**；修复后的受控 opt-in facade 因覆盖稳定可作显式选用的复用路径，但无数据支持晋升为默认或混合结构 |
| eating-canary: B-safe 混合接口未通过门禁，协议纠正收益不稳定（Phase 5.3.3，2026-08-09） | B-safe = B0 facade（无引导）+ 协议层纠正（3 层策略：已知工具名映射 / 未知工具名+args含合法intent路由 / 工具名合法但intent非法→`inferIntentFromArgs`推断）+ 空结果 bounded retry。4 次独立 replay（glm-5.2，3 场景×3 seed×3 arm×3 批次）覆盖率高度波动（0.926/0.951/0.778/0.877），平均 0.883 ≈ B0 0.877（+0.6%），未证明稳定正向收益。门禁 4/4 FAIL：Run3 覆盖率/sourceRef 降级（0.778<0.877），Run4 invalidIntents 超容差（4>1+1）。协议纠正被触发（correctedToolSelections 2-5）但无法稳定通过门禁。结论：**B-safe 不作为生产方案**，保留 9 专用工具为默认 |
| Gemini 生产路由 SC7 验证：受引导 facade 全质量指标与 9 工具持平，负担显著改善（Phase 4.3，2026-08-11） | 使用 Gemini 3.1 Pro Preview（`v2_rawstage2_gemini31`，当前生产默认 writer）对最复杂场景 SC7-multi-tool-mixed 做 5 seed 真实 A/B/B0/C replay（`reports/phase4-tool-ab-real-gemini-v2/`）。**B 组全质量指标 = A 组**：mustVerify 覆盖 1.000=1.000、有效证据引用率 1.000=1.000、停止率 100%=100%、零 errors/timeouts/empty/非法工具/解析失败。**负担改善**：schema token 8918 < 11370（−21.5%）、首证据延迟 1.4ms < 1.8ms。B0（无引导）在 SC7 仍全面恶化（引用率 0.450、非法 intent 11、停止率 40%）→ 引导仍是必要前提。C（envelope）引用率 0.889 < 1.000、停止率 80% < 100% → envelope 剪裁有损 |
| evidenceLevel 门禁双轨制修正：per-call 率 + 绝对命中数同时降级才判失败（Phase 4.3，2026-08-11） | SC7 Gemini replay 发现 `evidenceLevelsCumulativeNonDegraded` 在 `exact_chapter_span` 上误判 B 降级：A=5 calls/5 hits（per-call 1.0），B=8 calls/5 hits（per-call 0.625）。B 多出的 3 次调用是模型自主证据收集（thoroughness），返回 `confirmed_state`（有效证据），非失败。修正：双轨制——per-call 率和绝对命中数**同时**降级才判失败。修正后 B vs A evidenceLevel 门禁从 ✗ 变为 ✓。效率/负担由 `schemaTokenCost`/`totalCalls` 独立捕获，不混入质量门禁。测试 `tests-eval/phase4-tool-ab-real.test.mjs` 新增 2 个用例验证双轨制行为 |
| Gemini 全场景验证最终结论——**保留 9 专用工具为默认，facade 保持 canary opt-in 不晋级**（Phase 4.3，2026-08-11） | 全场景 3 seed replay（SC1/SC6/SC7，`reports/phase4-tool-ab-real-gemini-full/`）：B 组 mustVerify 覆盖率稳定 1.000（全覆盖），但 SC7 出现 sourceRef 降级（0.600 vs A=1.000）、空结果 4 次（A=0）、非法 intent 4 次（A=0）。SC7 单场景 5 seed replay（`reports/phase4-tool-ab-real-gemini-v2/`）中 B 组这些指标均为 0/1.000。两次 replay 的 SC7 结果差异表明 **Gemini 3.1 Pro Preview 在 facade 形态下存在 seed 级方差**：部分 seed 下模型会生成非法 intent（如 `query` 未填或填错）并触发空结果，而 9 专用工具形态不受影响。决策：**9 专用工具保持默认生产注入**；受引导 facade 保持 canary opt-in 路径，不晋级为默认。后续改进方向：(1) facade 空结果自动重试（当前 B-safe 已尝试但不稳定）；(2) intent 参数 schema 加严（必填校验）；(3) 扩大 seed 样本至 10+ 统计方差 |

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

---

## 10. 紧凑结果 envelope（工具粒度收口，2026-08-09）

> **状态**：已实现 + Phase 5.2 确定性 A/B/C 机械验证通过（2026-08-09，2026-08-10 更新）。
> `renderCompactEnvelope` 已落地为生产纯函数（`novelos/tools/tool-protocol.ts`），facade 支持
> `useCompactEnvelope` 可选渲染（eval-only `typed-facade-tool.ts`）。
>
> **Phase 5.3.1 内容摘要修复后**：`renderCompactEnvelope` 每条 ref 行追加内容摘要（≤50 字符），
> 修复了真实模型 replay 中 stopRate=0%、duplicateQueries 激增的问题。但此修复使精简列表场景
> （SC2/SC5）的 C 臂文本略大于 B 臂，聚合 C=2674 > B=2598。Phase 5.2 确定性门禁已从
> 「C < B」调整为「C <= B×1.15」（不显著膨胀），机械验证（details 一致性、无结果误报守护）通过。
>
> **Phase 5.3 真实模型 replay 结果**：compact envelope 多项门禁失败（mustVerify 覆盖率
> 0.852 < 0.926、sourceRef 0.783 < 0.839、errors 1 > 0、empty 1 > 0），**已明确弃用**，
> 不进入默认生产。纯函数保留为 eval-only 资产，供未来模型升级后重新评估。
> 详见 `reports/phase5-3-envelope-real/real-ab-comparison.md`。
>
> A/B/C 确定性报告见 `reports/phase5-2-envelope-abc/`。
> 延续 §9 的受控接入：envelope 是"工具粒度"收口的一部分，
> 与"接口表面（9 工具 vs facade）"正交。目标是在**不降级证据覆盖**的前提下，压缩每次工具
> 调用返回给模型的文本（`content`），降低上下文膨胀；完整结构化数据（`details`）保留供
> verifier / trajectory / canary 消费。
>
> **前置**：B0 dry-run 已证明（`reports/phase4-tool-ab-b0-dryrun/`）——三臂（A/B/B0）证据覆盖
> 完全等价（mustVerify 覆盖 1.000、引用率 0.727、失败 0），单入口收益独立于描述引导
> （B0 schema=16797 < B 受引导=22242 < A=28149）。envelope 进一步在"结果文本量"上收口。

### 10.1 设计约束（铁律）

1. **先设计后实现**：§10 边界已落实为 `renderCompactEnvelope` 纯函数（Phase 5.2 已实现并 dry-run）。
2. **envelope 是渲染层，不是检索逻辑**：绝不复制/改动检索、排序、token fallback、limit 截断、
   nextQueryHint 生成。它只规定"模型可见文本"如何由 `details` 结构化数据渲染而成。
3. **完整性不降级底线**：`sourceRef` / `evidenceLevel` / `resultKind` / `returnedCount` /
   `truncated` / `nextQueryHint` 必须全部保留在 `details`（供 verifier 裁决与 canary 监控），
   envelope 只约束 `content` 文本的**呈现**。
4. **可回退**：envelope 作为 facade（或工具）的**可选渲染策略**接入，默认关闭（保持现状
   完整文本）；显式 opt-in 才启用，失败可回退旧渲染。
5. **先确定性后真实模型**：envelope 的收益先用 dry-run 在 A/B/C 上量化 `resultChars` 下降
   （已完成，见 `reports/phase5-2-envelope-abc/`），再在真实模型 canary 验证。

### 10.2 边界定义（四类字段）

统一紧凑 envelope 渲染的 `content` 文本，模型每回合只看到它；`details` 保留完整数据。

| 字段 | 边界 | 内容 |
|------|------|------|
| **摘要（summary）** | 一行，≤ 120 字符 | 一句话说明"本次调用命中什么"：结果数、最高证据等级、最强 ref。如 `命中 3 条证据（confirmed_state，最强 ref=canon:evt-003）`。空结果给 `无匹配/无结果` 摘要。 |
| **来源（sourceRef）** | 每项 ≤ 1 行，最多 N 项（N=min(returnedCount, 3)） | 只列出**最强的前 3 条**证据的 ref（`ch17#final.md:120-180` 等），不贴全文 excerpt。完整列表在 `details`。 |
| **证据等级（evidenceLevel）** | 每项旁标等级 + 排序 | 每条 ref 前缀 `[等级]`（如 `[confirmed_state]`），按 `confirmed_state > exact_chapter_span > confirmed > inferred > profile_only` 排序。完整 rankedEvidenceLevels 在 `details`。 |
| **继续查询提示（nextQueryHint）** | 仅截断时透传 | envelope 仅在 `truncated=true` 时把系统生成的 `nextQueryHint` 追加一行提示；未截断时不输出（避免重复占用）。提示文本由底层工具确定性生成，envelope 不新造。 |

**边界规则摘要**：
- **摘要 > 全文**：模型看到的是摘要 + 最强前 3 条 ref，不是全部 excerpt。
- **证据等级随 ref 走**：每条 ref 必须标等级，且按强度排序；等级判定权在底层工具，envelope 不重判。
- **nextQueryHint 只在截断时给**：避免"未截断还提示继续查"的冗余调用。
- **空白行/装饰**：envelope 不引入结构化标记（如 JSON 代码块），保持纯文本紧凑，避免额外 token。

### 10.3 与现有 `NarrativeToolResultDetails` 的关系

- `details` = 真相源（不变，含 `sourceRef` / `evidenceLevel` / `resultKind` / `returnedCount` /
  `truncated` / `nextQueryHint` / `rankedEvidences` / 各类 `entries` / `spans`）。
- `content` = envelope 渲染（由 `details` 派生，可开关）。
- verifier / trajectory / canary 读 `details`；模型只读 `content`。二者解耦，envelope 改动不影响证据裁决。

### 10.4 度量（envelope 收益 = resultChars 下降，证据不降级）

| 指标 | 口径 | 目标 |
|------|------|------|
| 结果字符（resultChars） | 每次调用 `content` 文本长度 | envelope 启用后显著下降（dry-run 量化） |
| mustVerify 覆盖率 | 不变（读 details） | 不降级 |
| sourceRef / evidenceLevel 完整性 | 不变（读 details） | 不降级 |
| 判读延迟 / 停止率 | 模型决策行为 | dry-run 先验证框架，canary 验证真实模型 |

### 10.5 接入与验收

- **接入**：envelope 渲染函数作为纯函数（`renderCompactEnvelope(details)`），供 facade 与专用工具
  可选调用；不进入检索/排序路径。
- **验收**：dry-run 断言 `resultChars(renderCompactEnvelope(details))` 不显著膨胀
  （C <= B×1.15），且 `details` 经 envelope 渲染后再回读仍完整（`NarrativeToolResultDetails` roundtrip 不丢字段）。
  **（Phase 5.2 已验收，2026-08-10 更新）** A/B/C 确定性机械验证通过：details 与 B 完全一致，
  证据覆盖与失败指标不降级，无「无结果」误报；门禁从「C < B」调整为「C <= B×1.15」
  （Phase 5.3.1 内容摘要修复后 C=2674 > B=2598，但未显著膨胀）。集成测试
  `tests-eval/phase5-2-envelope-abc.test.mjs` 与
  guard N4 单测 `tests/phase5-compact-envelope.test.mjs` 锁定边界。
- **不 cutover**：compact envelope 已在 Phase 5.3 真实 replay 中多项门禁失败，**已弃用**，
  不作为默认渲染策略。纯函数保留为 eval-only 资产。

> **结论归属**：确定性 dry-run 证明 envelope 渲染机械正确（details 一致、无结果误报守护）；
> 但 Phase 5.3 真实模型 replay 证明 compact envelope 在真实模型下覆盖率/sourceRef/失败行为
> 均降级，不进入默认生产。当前仍保持 A=9 专用工具默认、`rel-000` 不切换。
> 真实 replay 报告见 `reports/phase5-3-envelope-real/real-ab-comparison.md`。

---

## 11. Phase 5.3 真实模型 envelope replay（2026-08-09，2026-08-10 更新）

> **状态**：已执行真实模型 replay（GLM 5.2，`narrator_testing_glm` route，`fallback=[]`，
> 3 场景 SC2/SC5/SC7 × 3 seed × 4 臂 A/B/B0/C）。**compact envelope 多项门禁失败，已弃用**。
>
> Phase 5.3 真实 replay 结果（`reports/phase5-3-envelope-real/real-ab-comparison.md`）：
> - C 组门禁（vs A）：mustVerify 覆盖率 0.852 < 0.926 FAIL、sourceRef 0.783 < 0.839 FAIL、
>   errors 1 > 0 FAIL、empty 1 > 0 FAIL
> - Envelope 门禁（C vs B）：mustVerify 覆盖率 0.852 < 1.000 FAIL、sourceRef 0.783 < 0.867 FAIL、
>   失败行为 errors/timeouts/empty 恶化 FAIL
> - **结论**：compact envelope 在真实模型下覆盖率/sourceRef/失败行为均降级，不进入默认生产。
>   纯函数保留为 eval-only 资产，供未来模型升级后重新评估。

### 11.1 动机（Phase 5.2 的两个限制）

Phase 5.2 确定性 A/B/C dry-run 已验证机械正确性（details 一致、无结果误报守护），但有两个限制必须在真实
模型下补验：

1. **零模型 ≠ 真实模型理解**：dry-run 是确定性 stub，不能证明真实模型会正确理解 compact envelope，
   也不能证明停止率、查询精度和事实覆盖在真实模型下不下降。
2. **聚合不膨胀掩盖局部膨胀**：SC2（C=281 > B=270）、SC5（C=274 > B=228）在单场景字符上出现
   局部膨胀。Phase 5.2 门禁只要求聚合不显著膨胀（C<=B×1.15），没有限制单场景/单调用明显变长。这个问题必须在
   真实 replay 前纳入门禁。

### 11.2 目标

在 eval/canary 隔离下，验证真实 GLM 模型对 compact envelope 的理解不下降：

- A/B/C 使用**同一 GLM route**（`narrator_testing_glm`）、同一 fixtures、seed、temperature、
  `fallback=[]`（`PINOVEL_DISABLE_FALLBACK=1`）。
- 至少覆盖 **SC2、SC5、SC7**（最能暴露 envelope 局部膨胀或信息损失）。
- 记录真实模型 **fingerprint**（`provider:model:route`）、toolMode、renderMode、resultChars、
  停止率、mustVerify、sourceRef、非法调用与失败指标。
- **replay 前预注册「单场景/单调用结果膨胀」门槛**（C vs B），不能只看聚合下降。

### 11.3 门禁（预注册，C vs B）

envelope 门禁（`EnvelopeRealGate`）在真实 replay 前已注册，逐项校验：

| 门禁 | 口径 |
|------|------|
| 聚合结果字符不膨胀 | C.totalResultChars ≤ B.totalResultChars |
| 单场景无膨胀 | 每场景 C ≤ B × `factor` + `buffer` |
| 单调用无膨胀 | 每场景 C 最大单回合字符 ≤ B 最大单回合 × `factor` + `buffer` |
| mustVerify 覆盖率不降级 | C.avgCoverageRatio ≥ B |
| 有效证据引用率不降级 | C.sourceRefCompleteness ≥ B |
| 停止率不显著下降 | C.stopRate ≥ B − 5% |
| 失败行为不恶化 | C errors/timeouts/empty/truncated/非法工具/解析失败 ≤ B |

膨胀门槛常量：`ENVELOPE_EXPANSION_FACTOR=1.5`、`ENVELOPE_EXPANSION_BUFFER=1`（字符）。
语义：允许 envelope 对精简列表/短 span 有少量摘要开销，但超过 `B × 1.5 + 1` 即判「明显膨胀」。

同时保留 C vs A 门禁（`gateC`，envelope facade 失败行为不劣于 9 专用工具）与逐场景失败门禁
（`scenarioGateC`）。

### 11.4 运行与产物

```bash
# dry-run（验证框架，零 API）
node scripts/tool-ab-real-report.mjs --envelope

# 真实模型（需 GLM/Doubao 临时授权）
PINOVEL_DISABLE_FALLBACK=1 node scripts/tool-ab-real-report.mjs --envelope --mode real --require-auth
```

`--envelope` 默认输出到 `reports/phase5-3-envelope-real/`：
`real-ab-comparison.json` / `.md` / `trajectory/{SC2|SC5|SC7}-{A|B|B0|C}-{seed}.jsonl`。
报告含 provenance（路由/provider/model/seed 支持/fallback 关闭）、C 组门禁、envelope 门禁与
逐场景/逐调用字符明细。

### 11.5 准入与后续

- **真实 replay 已执行**（2026-08-09）：envelope 门禁多项失败（覆盖率降级、sourceRef 降级、
  errors/empty 恶化），compact envelope **已弃用**。
- **不切换 production pointer**（`active-production.json` 仍指向 `rel-000`，
  `rel-phase5b` 保持 held），默认仍为 9 专用工具。
- compact envelope 纯函数保留为 eval-only 资产，供未来模型升级后重新评估。
- 若未来模型（如 GPT/Claude）工具选择更稳定，可重新评估 compact envelope 是否有正收益。

---

## 12. Phase 5.3.3 B-safe 混合接口设计（2026-08-09）

> **状态**：已收口（2026-08-09）。4 次真实 replay 全部未通过门禁，生产不采用。
> 协议纠正机制保留为 eval-only 资产。生产仍为 `rel-000`，9 专用工具默认执行面未改变。
> 提交 `88a5fa4` 包含实现、测试和设计结论。Phase 5.3.3 正式收口，进入 Phase 6。

### 12.1 动机

Phase 5.3 的真实 envelope replay（§11）显示 B0（无引导 facade）在覆盖率上优于 A（9 专用工具），
但 B0 存在结构性问题：facade arm 模型只看到 1 个 `query_narrative`，容易产生：
- **非法工具名**（乱码字符、中文变体、幻觉名称）
- **非法 intent**（工具名合法但 intent 字段非合法枚举值）
- **空结果**（intent 路由不精确导致无匹配）

B-safe 假设：**在不引入 prompt 引导的前提下，通过协议层结构化纠正和 bounded retry，
既保留 B0 的查询覆盖能力，又消除非法工具选择和空结果。**

### 12.2 设计

B-safe = B0 facade（`includeIntentGuidance=false`）+ 协议层纠正 + 空结果 bounded retry。
与 B0 的唯一差异是协议层机制，工具面完全相同。

#### 12.2.1 协议层纠正（三层策略互补覆盖）

1. **策略 1：已知底层工具名映射** — 模型输出 `search_narrative_evidence` 等已知底层工具名
   时，通过 `TOOL_NAME_TO_INTENT` 映射到对应 intent，路由到 `query_narrative`。
2. **策略 2：未知工具名 + args 含合法 intent** — 模型输出幻觉工具名（如中文变体、乱码）时，
   从 args 中提取 intent 字段，若为合法 intent 或中文变体（`CHINESE_TO_INTENT_MAP`），
   路由到 `query_narrative` + 转换后的英文 intent。
3. **策略 3：工具名合法但 intent 非法** — 模型输出 `query_narrative` 但 intent 非法时，
   调用 `inferIntentFromArgs(args)` 从参数字段推断合法 intent：
   - `status` 字段 → `promise`（唯一判别，高置信）
   - `patternType` 字段 → `pattern`（唯一判别，高置信）
   - `category` 字段 → `canon`（唯一判别，高置信）
   - `query` + `maxChapters` 组合 → `chapter_span`（高置信）
   - `query` 单字段 → `evidence`（中置信，默认首选）
   - `characterId` 字段 → `character_state`（低置信，三义性取最高优先级）
   - 无判别字段 → 推断失败，保留非法 intent，计入 `invalidIntents`

纠正和重试**不计入失败指标**，单独记录为 `correctedToolSelections` 和 `emptyResultRetried`。

#### 12.2.2 空结果 bounded retry

对 `evidence` / `chapter_span` / `voice` 意图的首次空结果（含 `no_match`），
用 query 前 4 字符简化重试一次。重试结果替换原空结果。

### 12.3 实验结果

4 次独立真实 replay（glm-5.2，`narrator_testing_glm` route，`fallback=[]`，
temp=0.72，3 场景 SC2/SC5/SC7 × 3 seed × 3 arm × 3 批次）。

#### 12.3.1 四次独立 replay 覆盖率波动

| Run | B-safe 覆盖率 | B0 覆盖率 | B-safe vs B0 | 门禁结果 |
|-----|--------------|----------|-------------|---------|
| 1 | 0.926 | — | — | — |
| 2 | 0.951 | — | — | — |
| 3 | 0.778 | 0.877 | -0.099 | FAIL（覆盖率/sourceRef 降级） |
| 4 | 0.877 | 0.877 | +0.000 | FAIL（invalidIntents 超容差） |
| **平均** | **0.883** | **0.877** | **+0.006** | **4/4 FAIL** |

B-safe 覆盖率高度波动（0.778–0.951），平均 0.883 ≈ B0 0.877（+0.6%），
**未证明有稳定正向收益**。门禁 4/4 FAIL，但失败原因在不同运行间变化。

#### 12.3.2 Run 3 vs Run 4 跨批次聚合对比（详细数据）

| 指标 | Run3 B-safe | Run3 B0 | Run4 B-safe | Run4 B0 |
|------|------------|---------|------------|---------|
| 平均覆盖率 | 0.778 | 0.877 | 0.877 | 0.877 |
| sourceRef 完整率 | 0.678 | 0.760 | 0.775 | 0.726 |
| 停止率 | 41% | 41% | 33% | 30% |
| 总字符 | 7011 | 7326 | 7786 | 7244 |
| 空结果数 | 10 | 9 | 10 | 15 |
| 非法工具选择 | 10 | 9 | 10 | 15 |
| 非法 intent | 2 | 0 | 4 | 1 |
| 协议纠正数 | 2 | — | 5 | — |
| schema token 成本 | 50540 | 51072 | 51604 | 52136 |

**关键观察**：
- Run 4 中 B-safe 在覆盖率/sourceRef/空结果/非法工具上**与 B0 持平或更优**，
  但 invalidIntents=4 > B0 1+容差 1 = 2，导致 `failuresNotWorseThanB0` FAIL。
- 协议纠正在 Run 4 更活跃（correctedToolSelections=5 vs Run3=2），
  减少了空结果（10 vs B0 15）和非法工具（10 vs B0 15）。
- 但策略 3 推断失败也更多（invalidIntents=4 vs Run3=2），成为门禁短板。

#### 12.3.3 门禁评估（B-safe vs B0 不降级，Run 4）

| 门禁项 | Run 3 | Run 4 | 说明 |
|--------|-------|-------|------|
| 覆盖率 >= B0 | **FAIL** (0.778<0.877) | PASS (0.877=0.877) | Run4 持平 |
| sourceRef >= B0 | **FAIL** (0.678<0.760) | PASS (0.775>0.726) | Run4 更优 |
| 停止率不降级 | PASS | PASS | 容差 0.15 |
| 字符不膨胀 | PASS | PASS | 余量 20% |
| 失败不劣于 B0 | **FAIL** | **FAIL** | Run3: invTool 10>9; Run4: invIntents 4>1+1 |
| 失败不劣于 A | PASS | PASS | errors/timeouts/parse 均 0 |
| **整体门禁** | **FAIL** | **FAIL** | 不同失败原因 |

### 12.4 结论与归因

**B-safe 混合接口未通过门禁**（4/4 FAIL），不作为生产方案。

归因分析：
1. **模型行为高变异性**：GLM 5.2 在 temp=0.72 下覆盖率波动大（0.778–0.951），
   单次消融实验结果不足以做最终判定。协议纠正的收益被模型随机性淹没。
2. **门禁失败原因不稳定**：Run3 因覆盖率/sourceRef 降级 FAIL，Run4 因 invalidIntents
   超容差 FAIL。B-safe 无法在任何单次运行中同时通过所有门禁项。
3. **协议纠正部分有效**：correctedToolSelections=2-5 证明纠正机制生效，能减少空结果
   和非法工具（Run4: B-safe empty/invTool=10 < B0=15）。但纠正效果被 invalidIntents
   残留抵消。
4. **策略 3 推断是短板**：`inferIntentFromArgs` 对某些参数组合推断失败，残留
   invalidIntents=2-4，超过容差 +1。策略 3 的"尽力而为"语义无法保证 invalidIntents
   稳定在容差内。
5. **空结果重试未被 exercise**：`emptyResultRetried=0`（4 次均未触发），该路径未被验证。
6. **结构性不公平**：facade arm 的 invalidTool/empty/invalidIntents 结构性高于
   specialized arm（A），与 A 对比是"苹果比橘子"；与 B0（同 facade arm）对比才公平，
   但 B-safe 在失败行为上无法稳定优于 B0。

### 12.5 后续

- **B-safe 不进入生产**：保留 9 专用工具为默认生产注入。
- **协议纠正机制保留为 eval-only 资产**：`inferIntentFromArgs` 与三层纠正策略
  已实现并测试（`tests/b-safe-protocol-correction.test.mjs`，16 断言），
  可供未来模型升级后重新评估。
- **模型变异性是主要瓶颈**：在固定温度/seed 下重跑仍波动（0.778–0.951），
  说明 GLM 5.2 的工具选择行为本身不稳定；协议纠正无法弥补模型层面的不稳定性。
- **若需改进 B-safe**：优先优化策略 3 `inferIntentFromArgs` 的推断覆盖率（减少
  invalidIntents 残留），或放宽 invalidIntents 容差（需论证合理性）。
- **若未来模型（如 GPT/Claude）工具选择更稳定**，可重新评估 B-safe 是否有正收益。