# Phase 8：Gemini 专属 Prompt 与原生能力评估

> **状态**：Stage P 已实现并完成真实 replay 评估（2026-08-10），P-B 未通过硬门；按 §7 决策保持当前生产基线，Stage N 不启动。
> **前置**：Phase 7 已正式收口（A 组当前推理预算 = 生产基线，B/C 仅保留 eval，不进入 canary）。当前生产基线冻结为：9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（`fallback=[]`）。
> **约束**：eval-only，不直接修改 `novel_generate_chapter` 生产编排或 production pointer。两个实验**按顺序、正交**执行，不同时改变 Prompt 与协议。

---

## 1. 动机

### 1.1 当前问题

NovelOS Agentic 使用的是**与模型无关的通用 Prompt 与文本协议**：

- 系统 Prompt `NOVELOS_SYSTEM_PROMPT`（`novelos/agent/agentic-raw-candidate-source.ts:270`）是硬编码的通用中文网文写作指令，不针对 Gemini 的长上下文、原生工具调用与结构化输出能力做设计。
- 工具调用走**文本协议**（模型在正文流中输出工具名/参数，系统解析抽取），未利用 Gemini 的原生 function-calling / structured output 语义。

问题：同等模型、同等上下文下，我们的 Prompt 与协议是否**稳定优于**当前通用基线？若 Gemini 专属 Prompt 或原生调用能显著降低非法调用/空结果、提升 sourceRef 完整率并压降 token，则当前生产固化了一套"未挖掘模型能力"的通用方案。

### 1.2 研究问题

在固定 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（`fallback=[]`）的前提下，分两个正交问题：

1. **Prompt-only**：Gemini 专属系统 Prompt 对比当前通用 Prompt，是否在失败行为（非法调用/空结果）、sourceRef 完整率、停止率、延时与 token 上稳定获益？
2. **Native-only**：Gemini 原生结构化工具调用/输出协议对比当前文本协议，是否在上述指标上稳定获益？

### 1.3 与 Phase 5/6/7 的正交性

| 维度 | Phase 5 | Phase 6（冻结） | Phase 7（收口） | Phase 8 |
|------|---------|----------------|----------------|---------|
| 研究问题 | 工具接口形态 | 上下文注入量 | 推理/检索预算 | Prompt 与协议 |
| 变化维度 | 工具集/接口 | 上下文压缩量 | 预算参数 | systemPrompt / 工具调用协议 |
| 固定维度 | 上下文+预算 | 工具+预算 | 上下文+工具 | 工具+上下文+预算 |
| 工具集 | — | 9 专用工具 | 9 专用工具 | 9 专用工具（三者一致） |
| 结论 | 9 专用工具 | 负向（不压缩） | A 组预算保留 | 待验证 |

> **关键不变量**：Phase 8 三种固定维度（9 专用工具 / 完整上下文 / A 组预算）与 Phase 7 收口基线完全一致；只允许变化 systemPrompt 或工具调用协议，且两者**不并行变化**。

---

## 2. 实验顺序与正交性

为保证根因可归因，**严格串行**：

1. **Stage P（Prompt-only）先行**：固定文本协议，只比较通用 Prompt vs Gemini 专属 Prompt。
2. **Stage N（Native-only）后行**：只有 Stage P 通过门禁后，才在**已确认的 Prompt 基线**上引入协议变化，比较文本协议 vs Gemini 原生结构化调用。

不在同一批内同时改 Prompt 和协议。若 Stage P 负向，则保留通用 Prompt，Stage N 也在通用 Prompt 上评估协议，避免混淆因素。

---

## 3. 固定基线（两阶段共用）

| 维度 | 固定值 |
|------|--------|
| 工具集 | 9 个专用工具（`NARRATIVE_TOOL_NAMES`，与生产一致） |
| 上下文 | 完整注入（四类长期叙事状态全保持，Phase 6 决策） |
| 推理预算 | A 组当前生产预算（`DEFAULT_BUDGET_CONFIG` + `createEvidencePlan` 默认 `retrievalDepth`） |
| 模型 | Gemini 生产 route `narrator_primary`（provider=gemini31, model=gemini-3.1-pro-preview, `fallback=[]`） |
| 场景 | 复用 `BASELINE_SCENARIOS`（含高风险 SC8，观察 mustVerify 覆盖率） |
| seed | 3 批 × 3 seed（seed 0-8），批次偏移 seed 起始值 |

---

## 4. Stage P：Prompt-only 评测

### 4.1 两臂

| 臂 | systemPrompt | 其他维度 |
|----|--------------|---------|
| P-A（基线） | 当前通用 `NOVELOS_SYSTEM_PROMPT` | 完全一致 |
| P-B（Gemini 专属） | Gemini 专属系统 Prompt（显式利用原生工具语义、长上下文、结构化输出约束） | 完全一致 |

### 4.2 实现钩子（eval-only）

- 参照现有 eval-only 覆盖字段 `retrievalPromptOverride`（`agentic-raw-candidate-source.ts:136`），为 `AgenticRawSourceInput` 新增 eval-only 字段 `systemPromptOverride`（仅 eval runner 注入，生产不传则行为不变）。
- 在 `agentic-raw-candidate-source.ts:471` 注入点将 `systemPrompt: NOVELOS_SYSTEM_PROMPT` 改为 `systemPrompt: systemPromptOverride ?? NOVELOS_SYSTEM_PROMPT`。
- 新增 eval-only 模块 `novelos/eval/prompt-ab-runner.ts`（参照 `reasoning-budget-runner.ts`），复用 `BASELINE_SCENARIOS`、`runRealToolAbScenario`、`aggregateRealArm` 与 stub 模式。
- Gemini 专属 Prompt 作为 eval-only 常量集中定义（不含生产硬编码，不入 `tsconfig.prod.json`）。

### 4.3 门禁（P-B 相对 P-A，全部满足才通过）

| 指标 | 方向 |
|------|------|
| mustVerify 覆盖率不降级 | ≥ A - 0.05 |
| sourceRef 完整率不降级 | ≥ A - 0.05 |
| 非法调用不恶化 | ≤ A |
| 空结果不恶化 | ≤ A |
| 停止率不降级 | ≥ A - 5% |
| token 成本 | 获益（< A×0.9）为加分项，非硬门 |
| 首证据延迟不恶化 | ≤ A + 1ms |

> 强调失败行为与 sourceRef 优先；token 为加分项，避免仅为省 token 牺牲覆盖/召回。

---

## 5. Stage N：Native-only 评测

### 5.1 两臂

| 臂 | 工具调用协议 | systemPrompt | 其他维度 |
|----|--------------|--------------|---------|
| N-A（基线） | 文本协议（现状） | **Stage P 确认的 Prompt**（P-A 或 P-B） | 完全一致 |
| N-B（Native） | Gemini 原生 function-calling / structured output | 同上 | 完全一致 |

> Stage N 的 Prompt 固定为 Stage P 的结论（不含同时变化），确保协议收益可独立归因。

### 5.2 实现钩子（eval-only）

- 原生协议作为 eval-only 适配层：将 Gemini 原生 tool declarations 与 structured output schema 映射到现有 9 专用工具协议，产出与文本协议一致的 `ToolCall` 事件与 JSON 输出。
- 复用 `versioned` 模型生成适配器（`v2/adapters/legacy-model-route-adapter.ts`）注入 route，但新增协议层开关（eval-only）。
- 指标采集复用 `ToolCallMetricsTracer`，保证两臂落在同一指标口径。

### 5.3 门禁（N-B 相对 N-A）

同 Stage P 门禁口径（见 §4.3）。若 Stage P 已切换 Prompt，N-A/N-B 均在此 Prompt 上对比，结论为**协议层的独立边际收益**。

---

## 6. 真实 replay 与授权

- 使用 Gemini route `narrator_primary`，`fallback=[]`，**hard block**（失败不静默降级）。
- 至少 3 批 × 3 seed（seed 0-8），跨批次聚合，单次结果不做最终判定。
- 观测指标：mustVerify 覆盖率、sourceRef 完整率、非法调用、空结果、停止率、首证据延迟、估算 token。

### 6.1 成本 profile 授权（需处理）

现有 `benchmark-cost-profile.ts` 的 `production_validation` 仅允许 gpt/claude，**不含 gemini31**。Phase 8 真实 replay 走 Gemini route，需在实现阶段：
- 为 Phase 8 新增/调整授权集（如 `PINOVEL_BENCHMARK_COST_PROFILE` 增加 gemini 允许，或 Phase 8 replay 不设该 env 并显式 `--require-auth`）。
- 决策点：新增 `gemini_validation` profile 或扩展 `production_validation`，实现时与现有守卫对齐，违规仍 hard block。

### 6.2 稳定性门槛

复用 Phase 7 口径：所有阻断有结构化 FailureEnvelope，无 silent degrade；只统计 confirmed 证据；无有效证据标 unmeasured；固定温度/随机种子。

---

## 7. 决策与 canary 门槛

- **稳定获益**：Stage P 与/或 Stage N 在 ≥2/3 批次通过门禁且跨批次方向一致，才进入 canary 候选设计。
- **canary 候选**：仅当真实 replay 稳定获益后才设计（受控接入慢启动，先 eval 后 canary，参照 Phase 5 facade 模式）。
- **否则保持当前生产基线**：不修改 `novel_generate_chapter` 编排、不移动 production pointer，Prompt/协议层改动仅存于 eval。

---

## 8. 验收产物

- [x] `novelos/eval/prompt-ab-runner.ts`（Stage P 两臂 runner + stub/real）
- [x] `novelos/eval/prompt-ab-gate.ts`（Stage P 门禁）
- [x] `novelos/eval/gemini-prompt-library.ts`（Gemini 专属 Prompt，eval-only）
- [ ] `novelos/eval/native-protocol-runner.ts`（Stage N 原生协议 runner）—— **未启动**（Stage P 负向，按 §7 保持基线）
- [ ] `novelos/eval/native-protocol-gate.ts`（Stage N 门禁）—— **未启动**（Stage P 负向）
- [x] `tests-eval/phase8-prompt-native.test.mjs`（确定性断言）
- [x] `reports/phase8-prompt-native/`（对比报告 JSON + MD，含 dry-run 与 real）
- [x] `api/benchmark-cost-profile.ts` 新增 `gemini_validation` profile（独立授权，不改 `production_validation`）
- [x] `scripts/prompt-ab-replay.mjs`（CLI：dry-run stub / real 需 `--require-auth` + `gemini_validation`）
- [x] `agentic-raw-candidate-source.ts` 新增 eval-only `systemPromptOverride` + `permitSystemPromptOverride` fail-closed 守卫
- [x] 本设计评审通过后，才可进入实现 Phase

### 8.1 Stage P 真实 replay 结果（2026-08-10）

route：`narrator_primary`（provider=gemini31, model=gemini-3.1-pro-preview, fallback=[]），3 批 × 3 seed（seed 0-8），P-A（通用 Prompt）vs P-B（Gemini 专属 Prompt），工具/上下文/预算固定。

| 指标 | P-A（通用） | P-B（Gemini 专属） | 门禁 | 结论 |
|------|-------------|--------------------|------|------|
| mustVerify 覆盖率 | 0.983 | 0.134 | ≥ A-0.05 | ✗ |
| sourceRef 完整率 | 0.880 | 0.083 | ≥ A-0.05 | ✗ |
| 非法调用 | 0 | 0 | ≤ A | ✓ |
| 空结果 | 0 | 9 | ≤ A | ✗ |
| 停止率 | 85% | 88% | ≥ A-5% | ✓ |
| token 成本 | 11610 | 52 | < A×0.9（加分项） | ✓ |
| 首证据延迟 | 4ms | 3ms | ≤ A+1ms（加分项） | ✓ |

**硬门全部通过：否**（3 批次全部 FAIL，方向一致）。

**根因分析**：P-B 的 Gemini 专属 prompt 过度强调"证据充分即输出 `<done>` 终止标记"，导致真实模型在检索验证前就过早终止：总调用仅 10（P-A=124），9 个场景空结果/超时/错误。mustVerify 覆盖率从 0.983 崩溃至 0.134，sourceRef 完整率从 0.880 崩溃至 0.083。首次证据延迟因无有效证据而未测（unmeasured）。

**决策（§7）**：P-B 未达 ≥2/3 批次硬门通过门槛 → **保持当前生产基线（通用 Prompt）**，不移动 production pointer，Stage N（Native-only）不启动。Prompt 层改进仅存于 eval，供后续迭代参考。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 同时改 Prompt 与协议导致无法归因 | 严格串行：Stage P 通过后才开 Stage N |
| Gemini 专属 Prompt 偏向当前场景 | 固定 9 专用工具 + 完整上下文 + 同 route，只变 Prompt；跨 seed 聚合 |
| 原生协议适配层引入新 bug | Native 协议为 eval-only 适配，复用现有 ToolCall 事件口径，不触碰生产文本协议 |
| Gemini 生产 route 不稳定/超时 | `fallback=[]` hard block + 结构化 FailureEnvelope + 固定温度/seed 重跑 |
| 成本 profile 误拦 gemini | 实现阶段显式处理 gemini 授权（§6.1），违规仍 hard block |
| 仅省 token 却牺牲覆盖/召回 | token 列为加分项，失败行为与 sourceRef 为硬门 |

---

## 10. 与 Phase 5/6/7 的关系

| 维度 | Phase 5 | Phase 6 | Phase 7 | Phase 8 |
|------|---------|---------|---------|---------|
| 研究问题 | 工具接口 | 上下文 | 预算 | Prompt/协议 |
| 固定 | — | 工具+预算 | 上下文+工具 | 工具+上下文+预算 |
| 结论 | 9 专用工具 | 不压缩 | A 组预算 | 待验证 |
| canary 前提 | — | 负向 | 未过 | 仅在稳定获益后设计 |

> **Phase 8 结论更新（2026-08-10）**：Stage P（Prompt-only）真实 replay 为**负向**——P-B（Gemini 专属 Prompt）mustVerify 覆盖率 0.134 / sourceRef 0.083，远低于 P-A（0.983 / 0.880）；按 §7 决策保持当前生产基线（通用 Prompt），Stage N（Native-only）不启动。生产链路、9 工具、完整上下文、A 组预算全部保持不变。

> Phase 8 是 Phase 7 收口后的下一个正交能力维度，三者固定维度逐层叠加：工具（P5）→ 上下文（P6）→ 预算（P7）→ Prompt/协议（P8）。