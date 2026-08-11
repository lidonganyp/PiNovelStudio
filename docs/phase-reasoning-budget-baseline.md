# 思考/推理预算研究 — Phase 1 统一主链路基线

> 状态：**Phase 1 baseline v1 已冻结**（2026-08-11）。本结果称为"真实 Gemini dev-eval 基线"，不得称为生产发布验收。真相源补充：本文档记录"思考/推理预算"研究 Phase 1 的基线建立方法、度量契约与真实基线结果。Phase 6.2 上下文压缩已收口（见 phase6-context-compression-design.md §15.12），本阶段不依赖任何压缩候选，生产保持 A 参数。

## 1. 目标

"思考/推理预算"研究的第一阶段**仅建立基线**，不做任何预算策略改动：

记录统一主链路各阶段的模型调用次数、输入/输出 token、耗时、超时/FailureEnvelope、重试次数和最终成功率。

**固定当前配置**：Gemini 路由（`v2_rawstage2_gemini31` / `v2_amplified_gemini31`）、上下文注入参数、工具面。**不改生产行为**。完成基线后再提出候选预算策略。

## 2. 基线度量契约

统一主链路生产路径：`novel_generate_chapter` → `runUnifiedPipeline` → `unified-orchestrator`（Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → Agentic FactGuard → 作者风格整章优化 → Story Preservation → FinalFactRecheck → Completeness → FinalStateCommit）。

每条章节生成的 evidence 写入 `workspaces/{id}/traces/{chapterId}-quality-trace.json`。真实 trace 中数据分布在 `gates[v2_final_selected].evidence`（非 top-level `performanceProfile`）：

| 维度 | 数据来源（真实 trace） | 字段 |
|------|---------|------|
| 逐阶段耗时 | `gates[v2_final_selected].evidence.stageTiming` | `Record<阶段名, elapsedMs>`（如 `stage1_novelosAgentic`） |
| 逐次模型调用 | `gates[v2_final_selected].evidence.modelCalls[]` | `route/kind/model/durationMs/finishReason/tokenUsage.in/tokenUsage.out/provider/requestedRoute` |
| 输入/输出 token | `modelCalls[].tokenUsage.in/out` | OpenAI-compatible 成功路径从 `response.usage` 精确提取 |
| 模型预算 | `gates[v2_final_selected].evidence.modelBudget` | `soft/hard/used/capped` |
| 最终选择 | `gates[v2_final_selected].evidence.finalSelection` | `selectedCandidateId/selectedSource/projectGain` |
| 超时/失败 | trace 顶层 `failureEnvelopes[]`（本轮 3 章均为空） | `severity/gate/reason` |
| 重试次数 | `modelCalls[].finishReason≠stop` 推断（真实 trace 无 per-call attempt 字段） | 每 agent 聚合 |
| 最终成功率 | 无 `hard/fatal` 失败 + `finalSelection.projectGain ≠ negative` | `success` |

> **兼容性**：`reasoning-budget-baseline.mjs` 的 `extractPerfData()` 同时支持 `performanceProfile`（synthetic / 未来格式）和 `gates_evidence`（当前真实格式）两种数据源。

## 3. token 采集（精确捕获）

- `LLMTimingEntry` 新增可选字段 `inputTokens` / `outputTokens` / `reasoningTokens` / `cachedTokens`（`api/fallback-manager.ts` + `craft/quality-trace-recorder.ts` 两处接口同步）。
- 在 **OpenAI-compatible 成功调用路径**（生产 Gemini 主路径）从 `response.usage` 精确提取：
  - `prompt_tokens` -> `inputTokens` / `tokenUsage.in`
  - `completion_tokens` -> `outputTokens` / `tokenUsage.out`
  - `completion_tokens_details.reasoning_tokens` -> `reasoningTokens`（如果 provider 返回）
  - `prompt_tokens_details.cached_tokens` -> `cachedTokens`（如果 provider 返回）
- **Claude streaming 原生路径**（显式 `writerModel=claude`）无 `usage`，token 留空；错误/超时/skip 路径 token 留空。
- 纯遥测、非行为变更：新增字段不影响任何门禁判定或返回值。

### token 度量边界

- **`outputTokens` 是 provider 返回的聚合 `completion_tokens`**，Gemini 3.1 Pro Preview 是推理模型，`completion_tokens` 可能包含 reasoning/thinking tokens，**不能直接等同于可见正文长度**。
- 当前基线 trace 中 provider 未返回 `completion_tokens_details` / `prompt_tokens_details`，因此 `reasoningTokens` / `cachedTokens` 留空。
- 已在 `fallback-manager.ts` 提取逻辑中新增对这两个字段的解析，未来 trace 如 provider 返回细分将自动捕获。
- Gemini 隐式缓存（implicit caching）命中阈值 4096 tokens（Gemini 3 系），命中率不保证；做成本测算应按无缓存价格估算。

## 4. 基线工具

`scripts/reasoning-budget-baseline.mjs`：

```
node scripts/reasoning-budget-baseline.mjs --synthetic     # 内置 stub trace 验证框架（零真实数据）
node scripts/reasoning-budget-baseline.mjs --trace a.json,b.json
node scripts/reasoning-budget-baseline.mjs --dir <目录>    # 递归扫描 *-quality-trace.json
```

产出 `reports/reasoning-budget-baseline/baseline.json` + `baseline.md`：
- 汇总：模型调用次数、输入/输出 token、总耗时、重试/超时/错误数、FailureEnvelope 数、硬失败数、最终成功率、token 覆盖率。
- 每章明细：章节号、成功、耗时、模型调用数、输入/输出 token、token 覆盖率、selectedSource、projectGain、FailureEnvelope 数。
- 逐阶段平均耗时（含占比）。
- 逐模型调用（按 agent）每章均值：调用数、输入/输出 token、耗时、ok/重试/超时/错误、token 覆盖。
- 模型预算使用（soft/hard/used/capped）。
- 关键观察（自动生成）。

## 5. 真实基线结果（2026-08-11）

### 5.1 采集配置

- **来源 workspace**：`xinmo`（隔离 eval 副本 `xinmo-eval`，不修改原 workspace）
- **章节范围**：第 22–24 章（第 21 章之后连续 3 章），各生成 1 次
- **固定路由**：`v2_rawstage2_gemini31` / `v2_amplified_gemini31`（Gemini 3.1 Pro Preview）
- **上下文**：当前默认 A 参数（不切 canary、不改 production pointer）
- **工具面**：9 专用工具
- **fallback**：`PINOVEL_DISABLE_FALLBACK=1`（失败 hard block，不静默切换）
- **ChapterSeed**：每章提供明确 ChapterSeed

### 5.1.1 环境元数据

| 字段 | 值 |
|------|------|
| environment | `dev_eval` |
| PINOVEL_DEV_MODE | `1` |
| releaseGateBypassed | `true` |
| productionPointerChanged | `false` |

> `PINOVEL_DEV_MODE=1` 绕过 g6_release_gate 环境指纹检查；所有治理字段为 null，不修改 active pointer。**本结果称为"真实 Gemini dev-eval 基线"，不得称为生产发布验收。**

### 5.2 基线数据

完整报告见 `reports/reasoning-budget-baseline/baseline.md`。关键指标：

| 指标 | 数值 |
|------|------|
| 样本数 | 3（成功 3，成功率 100.0%） |
| token 覆盖率 | 100%（11/11 次调用有精确 token） |
| 模型调用次数（合计） | 11 |
| 输入 token（合计） | 126,400 |
| 输出 token（合计） | 52,699 |
| token 合计 | 179,099 |
| 总耗时（合计） | 455,806ms（~7.6 分钟） |
| 重试次数 | 0 |
| 超时数 | 0 |
| 错误数 | 0 |
| FailureEnvelope | 0 |
| 硬失败 | 0 |

### 5.3 每章明细

| 章节 | 耗时(ms) | 模型调用 | 输入token | 输出token | token覆盖 | selectedSource | projectGain |
|------|------|------|------|------|------|------|------|
| ch22 | 168,974 | 4 | 42,833 | 19,272 | 100% | v2_amplified | positive |
| ch23 | 122,940 | 3 | 39,983 | 13,928 | 100% | v2_amplified | positive |
| ch24 | 163,892 | 4 | 43,584 | 19,499 | 100% | v2_amplified | positive |

### 5.4 逐阶段耗时（平均）

| 阶段 | 平均耗时(ms) | 占比 |
|------|------|------|
| stage1_novelosAgentic | 82,982 | 54.6% |
| stage3_authorStyleOptimization | 68,744 | 45.2% |
| stage6_commitAndSave | 150 | 0.1% |
| stage4_storyPreservation | 37 | 0.0% |
| stage2_agenticFactGuard | 13 | 0.0% |
| stage5_finalFactRecheck | 10 | 0.0% |

### 5.5 逐模型调用（每章均值）

| agent | 调用/章 | 输入token/章 | 输出token/章 | 耗时ms/章 | ok/章 | 重试/章 | token覆盖 |
|------|------|------|------|------|------|------|------|
| v2_rawstage2_gemini31 | 2.67 | 37,322 | 7,641 | 82,907 | 2.67 | 0 | 8/8 (100%) |
| v2_amplified_gemini31 | 1 | 4,811 | 9,926 | 68,743 | 1 | 0 | 3/3 (100%) |

### 5.6 模型预算使用

| 章节 | soft | hard | used | capped |
|------|------|------|------|------|
| ch22 | 6 | 10 | 4 | false |
| ch23 | 6 | 10 | 3 | false |
| ch24 | 6 | 10 | 4 | false |

### 5.7 关键观察

1. **NovelOS Agentic + 作者风格优化占总耗时 99.9%**（151,726ms / 151,936ms），是推理预算的主要消耗点。其余阶段（FactGuard / StoryPreservation / FinalFactRecheck / CommitAndSave）合计仅 210ms，无模型调用。
2. **零重试、零超时、零错误**：3 章均一次性通过，无 transient failure 触发 bounded recovery。
3. **零 FailureEnvelope**：统一主链路无 silent degrade，所有阶段正常完成。
4. **token 覆盖率 100%**：Gemini OpenAI-compatible 路径全部精确取自 `response.usage` 字段。
5. **模型预算未触顶**：soft=6, hard=10，实际使用 3–4 次，`capped=false`。
6. **NovelOS Agentic 调用数不固定**：ch22/ch24 各 3 次 rawstage2 调用（evidence_decision + agentic_raw + agentic_raw），ch23 仅 2 次（evidence_decision + agentic_raw）。每章固定 1 次 amplified 调用。

## 6. 验证状态

- [x] prod/eval 构建通过。
- [x] `fallback-timeout-behavioral.test.mjs` 新增 token 捕获断言（mock usage -> `inputTokens=1234`/`outputTokens=567`）。
- [x] `reasoning-budget-baseline.mjs --synthetic` 验证框架（样本=1，逐阶段/逐调用聚合正确）。
- [x] **真实基线完成**：`xinmo-eval` workspace 第 22–24 章，3 章真实 Gemini 生成，token 覆盖率 100%，成功率 100%。
- [x] 基线脚本适配真实 trace 格式（`gates_evidence` 而非 `performanceProfile`）。
- [x] 报告含 token 覆盖率、逐阶段耗时、逐模型调用、重试、timeout、FailureEnvelope、最终成功率、模型预算使用。
- [x] **环境元数据**：baseline.json/Markdown 明确 `environment=dev_eval` / `PINOVEL_DEV_MODE=1` / `releaseGateBypassed=true` / `productionPointerChanged=false`；标注为"真实 Gemini dev-eval 基线"。
- [x] **trace 哈希登记**：`real-baseline-meta.json` 记录三条 trace 的 SHA-256 哈希、路径、生成时间。
- [x] **token 细分检查**：Gemini 3.1 Pro Preview 是推理模型，`outputTokens`（= `completion_tokens`）可能包含 reasoning tokens；当前 provider 未返回 `completion_tokens_details` / `prompt_tokens_details` 细分。已在 `fallback-manager.ts` 新增 `reasoningTokens` / `cachedTokens` 提取逻辑，未来 trace 如 provider 返回细分将自动捕获。

## 7. 下一步

- **Phase 1 baseline v1 已冻结**。本基线仅 3 章最小样本（1 个 workspace），不能据此直接制定生产预算策略。
- 后续扩展到 **6–9 章**并至少覆盖 **两个 workspace**，再设计 evidence_decision 和作者风格优化的预算候选。
- 基于逐阶段调用/token 分布提出候选"思考/推理预算"策略（如按阶段划分 token 预算/回合上限），再进入 A/B 验证。
- 候选方向（待基线扩展后评估）：
  - NovelOS Agentic 阶段占比 54.6%，是预算优化的首要目标；可考虑 evidence_decision 的 maxTokens（当前 512）是否可压缩。
  - 作者风格优化阶段占比 45.2%，输入 token 仅 4,811 但输出 token 高达 9,926；可考虑输出长度预算。
  - 模型预算 soft=6/hard=10 未触顶，当前无预算压力；预算策略应关注 token 成本而非调用次数限制。
  - 未来 trace 如 provider 返回 `reasoning_tokens`，需评估 reasoning 占比对预算策略的影响。

## 8. 产物索引

- 基线报告：`reports/reasoning-budget-baseline/baseline.md` + `baseline.json`
- trace 副本：`reports/reasoning-budget-baseline/traces/{22,23,24}-quality-trace.json`
- trace 元数据（含 SHA-256 哈希）：`reports/reasoning-budget-baseline/real-baseline-meta.json`
- 采集脚本：`.pi/extensions/novel-studio/scripts/reasoning-budget-real-baseline.mjs`
- 聚合脚本：`.pi/extensions/novel-studio/scripts/reasoning-budget-baseline.mjs`
- 采集元数据：`reports/reasoning-budget-baseline/real-baseline-meta.json`
