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

### Phase 4.3 — 生产迁移讨论门（Gate）
仅当 **全部**满足才进入生产迁移讨论：
- `B.mustVerifyCoverage ≥ A`（不降级）
- `B.sourceRef/evidenceLevel 完整率 ≥ A`（不降级）
- B 在**至少一项负担指标**显著更优（工具调用 / 重复查询 / 结果 token / 首证据延迟），且**无失败行为退化**（空结果 / 截断 / 错误 / 超时不劣于 A）。

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