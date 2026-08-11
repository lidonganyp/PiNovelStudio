# 思考/推理预算研究 — Phase 1 统一主链路基线

> 状态：**Phase 1 baseline v1（3 章 / 1 workspace）已冻结**（2026-08-11）；**Phase 1 baseline v2（9 章 / 2 workspaces）已冻结**（2026-08-11）；**Gemini reasoning-control capability probe 已完成**（2026-08-11，21 次真实调用，结论：当前 `api.solov.cc` 代理不支持 reasoning_effort/thinking_budget 控制，不扩大为 Gemini 原生 API 不支持）。本结果称为"真实 Gemini dev-eval 基线"，不得称为生产发布验收。真相源补充：本文档记录"思考/推理预算"研究 Phase 1 的基线建立方法、度量契约与真实基线结果。Phase 6.2 上下文压缩已收口（见 phase6-context-compression-design.md §15.12），本阶段不依赖任何压缩候选，生产保持 A 参数。**capability probe 证明 reasoning_effort/thinking_budget 在当前代理端点不生效，不进入基于该参数的 A/B；若未来更换 provider 或 endpoint 必须重新探测。替代预算方向见 §9.4。**

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

**baseline v1（3 章 / 1 workspace）**
- **来源 workspace**：`xinmo`（隔离 eval 副本 `xinmo-eval`，不修改原 workspace）
- **章节范围**：第 22–24 章（第 21 章之后连续 3 章），各生成 1 次

**baseline v2 扩展采样（9 章 / 2 workspaces）**
- **来源 workspace**：`xinmo-eval`（第 22–27 章，6 章）+ `fuben-eval`（`fuben` 隔离副本，第 2–4 章，3 章）
- **章节范围**：`xinmo-eval` ch22–27 + `fuben-eval` ch2–4，共 9 章，各生成 1 次
- **隔离副本**：`fuben-eval` 由 `fuben` robocopy 复制（排除 `_archive`/`traces`），并已修正配置中 `workspaceId` 为 `fuben-eval`；不修改原 `fuben`/`xinmo`

**共同固定配置**
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

### 5.2 基线数据（baseline v2，9 章 / 2 workspaces）

完整报告见 `reports/reasoning-budget-baseline/baseline.md`。关键指标：

| 指标 | 数值 |
|------|------|
| 样本数 | 9（成功 9，成功率 100.0%） |
| token 覆盖率 | 100%（32/32 次调用有精确 token） |
| 模型调用次数（合计） | 32 |
| 输入 token（合计） | 311,954 |
| 输出 token（合计） | 145,686 |
| token 合计 | 457,640 |
| 总耗时（合计） | 1,315,700ms（~21.9 分钟） |
| 重试次数 | 0 |
| 超时数 | 0 |
| 错误数 | 0 |
| FailureEnvelope | 0 |
| 硬失败 | 0 |

### 5.2.1 跨 workspace 分布

| workspace | 章数 | 成功率 | 模型调用 | 输入token | 输出token | 总耗时(ms) |
|------|------|------|------|------|------|------|
| fuben-eval | 3 | 100% | 9 | 56,862 | 39,537 | 359,856 |
| xinmo-eval | 6 | 100% | 23 | 255,092 | 106,149 | 955,844 |

> 两个 workspace 均 100% 成功、零重试/超时/错误、token 覆盖 100%。每章均固定触发一次 `novelos_evidence_decision` + 一次 `author_style_optimization`；差异在 `agentic_raw` 检索轮次：`xinmo-eval` 多数章节 2 次（ch22/24/25/26/27），`fuben-eval` 全部 1 次。`xinmo-eval` 输入 token/章显著更高（约 42.5k vs 19k），由**章节上下文规模 + 更多检索轮次**驱动，而非模型随机性。

### 5.3 每章明细

| 章节 | 成功 | 耗时(ms) | 模型调用 | 输入token | 输出token | token覆盖 | selectedSource | projectGain |
|------|------|------|------|------|------|------|------|------|
| ch2 | ✓ | 110,312 | 3 | 21,318 | 11,837 | 100% | v2_amplified | positive |
| ch3 | ✓ | 121,402 | 3 | 20,035 | 12,977 | 100% | v2_amplified | positive |
| ch4 | ✓ | 128,142 | 3 | 15,509 | 14,723 | 100% | v2_amplified | positive |
| ch22 | ✓ | 168,974 | 4 | 42,833 | 19,272 | 100% | v2_amplified | positive |
| ch23 | ✓ | 122,940 | 3 | 39,983 | 13,928 | 100% | v2_amplified | positive |
| ch24 | ✓ | 163,892 | 4 | 43,584 | 19,499 | 100% | v2_amplified | positive |
| ch25 | ✓ | 184,083 | 4 | 44,076 | 17,991 | 100% | v2_amplified | positive |
| ch26 | ✓ | 166,253 | 4 | 42,102 | 18,229 | 100% | v2_amplified | positive |
| ch27 | ✓ | 149,702 | 4 | 42,514 | 17,230 | 100% | v2_amplified | positive |

### 5.3.1 每章调用构成（完整调用明细）

| 章节 | workspace | evidence_decision | agentic_raw | author_style_optimization | 调用合计 |
|------|------|------|------|------|------|
| ch2 | fuben-eval | 1 | 1 | 1 | 3 |
| ch3 | fuben-eval | 1 | 1 | 1 | 3 |
| ch4 | fuben-eval | 1 | 1 | 1 | 3 |
| ch22 | xinmo-eval | 1 | 2 | 1 | 4 |
| ch23 | xinmo-eval | 1 | 1 | 1 | 3 |
| ch24 | xinmo-eval | 1 | 2 | 1 | 4 |
| ch25 | xinmo-eval | 1 | 2 | 1 | 4 |
| ch26 | xinmo-eval | 1 | 2 | 1 | 4 |
| ch27 | xinmo-eval | 1 | 2 | 1 | 4 |

> 每章固定 1 次 `novelos_evidence_decision` + 1 次 `author_style_optimization`；`agentic_raw` 为 NovelOS Agentic 的 ReAct 检索轮次，轮次不固定（1–2 次），是调用次数差异的唯一来源。

### 5.4 逐阶段耗时（平均）

| 阶段 | 平均耗时(ms) | 占比 |
|------|------|------|
| stage1_novelosAgentic | 85,583 | 58.5% |
| stage3_authorStyleOptimization | 60,441 | 41.3% |
| stage6_commitAndSave | 112 | 0.1% |
| stage4_storyPreservation | 34 | 0.0% |
| stage2_agenticFactGuard | 10 | 0.0% |
| stage5_finalFactRecheck | 8 | 0.0% |

### 5.5 逐模型调用（每章均值）

| agent | 调用/章 | 输入token/章 | 输出token/章 | 耗时ms/章 | ok/章 | 重试/章 | token覆盖 |
|------|------|------|------|------|------|------|------|
| v2_rawstage2_gemini31 | 2.56 | 30,484 | 7,910 | 85,519 | 2.56 | 0 | 23/23 (100%) |
| v2_amplified_gemini31 | 1 | 4,178 | 8,277 | 60,440 | 1 | 0 | 9/9 (100%) |

### 5.6 模型预算使用

| 章节 | soft | hard | used | capped |
|------|------|------|------|------|
| ch2 | 6 | 10 | 3 | false |
| ch3 | 6 | 10 | 3 | false |
| ch4 | 6 | 10 | 3 | false |
| ch22 | 6 | 10 | 4 | false |
| ch23 | 6 | 10 | 3 | false |
| ch24 | 6 | 10 | 4 | false |
| ch25 | 6 | 10 | 4 | false |
| ch26 | 6 | 10 | 4 | false |
| ch27 | 6 | 10 | 4 | false |

### 5.7 关键观察

1. **NovelOS Agentic + 作者风格优化占总耗时 99.9%**（146,024ms / 146,188ms），是推理预算的主要消耗点。其余阶段（FactGuard / StoryPreservation / FinalFactRecheck / CommitAndSave）合计仅 164ms，无模型调用。
2. **零重试、零超时、零错误**：9 章均一次性通过，无 transient failure 触发 bounded recovery。
3. **零 FailureEnvelope**：统一主链路无 silent degrade，所有阶段正常完成。
4. **token 覆盖率 100%**：Gemini OpenAI-compatible 路径全部精确取自 `response.usage` 字段。
5. **模型预算未触顶**：soft=6, hard=10，实际使用 3–4 次，`capped=false`。
6. **调用构成固定 + 检索轮次差异**：每章均固定 `novelos_evidence_decision` + `author_style_optimization` 各 1 次；`agentic_raw` 轮次不固定——`fuben-eval`（ch2–4）各 1 次，`xinmo-eval` 多数章节 2 次（ch22/24/25/26/27），仅 ch23 为 1 次。`agentic_raw` 轮次多一次，输入 token/章约 +42.5k vs 19k，是跨 workspace 输入分布的次要驱动（主要驱动为章节上下文规模）。

## 6. 验证状态

- [x] prod/eval 构建通过。
- [x] `fallback-timeout-behavioral.test.mjs` 新增 token 捕获断言（mock usage -> `inputTokens=1234`/`outputTokens=567`）。
- [x] `fallback-timeout-behavioral.test.mjs` 新增 **reasoning/cached 细分断言**（mock usage 同时返回 `completion_tokens_details.reasoning_tokens=320` 与 `prompt_tokens_details.cached_tokens=1500`，断言进入 `LLMTimingEntry.reasoningTokens/cachedTokens`）；`npm run build:prod` 后运行 7/7 通过。
- [x] `reasoning-budget-baseline.mjs --synthetic` 验证框架（样本=1，逐阶段/逐调用聚合正确）。
- [x] **真实基线 v1 完成**：`xinmo-eval` workspace 第 22–24 章，3 章真实 Gemini 生成，token 覆盖率 100%，成功率 100%。
- [x] **真实基线 v2 完成**：`xinmo-eval` ch22–27 + `fuben-eval` ch2–4，共 9 章、2 workspaces 真实 Gemini 生成，token 覆盖率 100%（32/32），成功率 100%（9/9）。
- [x] 基线脚本适配真实 trace 格式（`gates_evidence` 而非 `performanceProfile`）。
- [x] 报告含 token 覆盖率、逐阶段耗时、逐模型调用、重试、timeout、FailureEnvelope、最终成功率、模型预算使用。
- [x] **跨 workspace 分布**：聚合脚本新增 `perWorkspace`，baseline.md 输出跨 workspace 分布表（fuben-eval 3 章 / xinmo-eval 6 章）。
- [x] **环境元数据**：baseline.json/Markdown 明确 `environment=dev_eval` / `PINOVEL_DEV_MODE=1` / `releaseGateBypassed=true` / `productionPointerChanged=false`；标注为"真实 Gemini dev-eval 基线"。
- [x] **trace 哈希登记**：`real-baseline-meta.json` 记录 9 条 trace 的 SHA-256 哈希、路径、生成时间、调用数与耗时。
- [x] **token 细分检查**：Gemini 3.1 Pro Preview 是推理模型，`outputTokens`（= `completion_tokens`）可能包含 reasoning tokens；当前 provider 未返回 `completion_tokens_details` / `prompt_tokens_details` 细分（9 章 trace 的 `tokenUsage` 仅含 `in/out`）。已在 `fallback-manager.ts` 新增 `reasoningTokens` / `cachedTokens` 提取逻辑，未来 trace 如 provider 返回细分将自动捕获，并由上述单元测试覆盖。

## 7. 下一步

- **Phase 1 baseline v1 与 v2 均已冻结**。v2 覆盖 9 章、2 workspaces，跨 workspace 分布已记录。
- **Gemini reasoning-control capability probe 已完成**（§9）：当前代理端点不支持 `reasoning_effort` / `thinking_budget` 参数，不进入基于该参数的 A/B。
- **替代预算候选方向（尚未启用）**：基于 v2 分布观察 + capability probe 结论，提出候选预算策略；**在候选设计完成前不修改生产预算或 production pointer**。
- 候选方向（基于 v2 分布 + probe 结论）：
  - **上下文规模是首要驱动**：`xinmo-eval` 输入 token/章约 42.5k（每章 4 次调用），`fuben-eval` 约 19k（3 次调用）。预算候选应优先针对 **NovelOS Agentic 的输入 token 预算**（其占阶段耗时 58.5%），而非单一调用次数上限。
  - **`agentic_raw` 检索轮次差异**：`xinmo-eval` 多数章节 2 次 `agentic_raw`，`fuben-eval` 全部 1 次。候选可评估是否按上下文规模/证据充分度阈值化 `agentic_raw` 的检索轮次上限（当前无上限，soft model budget 6/hard 10 未触顶）。
  - **作者风格优化**：每章固定 1 次，输入约 4.2k、输出约 8.3k，占耗时 41.3%；可考虑输出长度预算（soft/hard）。
  - **模型预算未触顶**：soft=6/hard=10 全部 `capped=false`，当前无调用次数压力；预算策略应关注 **token 成本**而非调用次数。
  - **reasoning_effort / thinking_budget 不可用**（§9 probe 结论）：不能通过 API 参数控制 evidence_decision 的隐藏 thinking token 消耗；需从 prompt 精简、结构化输出约束、或 evidence_decision 调用频率方向探索。
  - **端点切换可能性**：如需 reasoning control 能力，需评估直连 Google 官方端点或切换到支持 reasoning token 细分的代理（当前 `api.solov.cc` 不返回 `completion_tokens_details` / `prompt_tokens_details`）。

## 8. 产物索引

- 基线报告：`reports/reasoning-budget-baseline/baseline.md` + `baseline.json`
- trace 副本：`reports/reasoning-budget-baseline/traces/{2,3,4,22,23,24,25,26,27}-quality-trace.json`
- trace 元数据（含 SHA-256 哈希）：`reports/reasoning-budget-baseline/real-baseline-meta.json`
- 采集脚本：`.pi/extensions/novel-studio/scripts/reasoning-budget-real-baseline.mjs`
- 聚合脚本：`.pi/extensions/novel-studio/scripts/reasoning-budget-baseline.mjs`
- 采集元数据：`reports/reasoning-budget-baseline/real-baseline-meta.json`
- v2 manifest（受版本控制）：`docs/evidence/reasoning-budget-baseline-v2-manifest.json`
- capability probe 脚本：`.pi/extensions/novel-studio/scripts/gemini-reasoning-capability-probe.mjs`
- capability probe 结果（受版本控制）：`docs/evidence/gemini-reasoning-capability-probe-result.json`
- capability probe 原始报告：`reports/reasoning-budget-baseline/capability-probe.json` + `capability-probe.md`

## 9. Gemini Reasoning-Control Capability Probe（eval-only，2026-08-11）

### 9.1 背景与目标

baseline v2 数据显示，固定每章一次的 `novelos_evidence_decision` 调用 9 次共消耗 136,106 token。虽然 `maxTokens=512`，completion usage 实际为 1,234–2,932，说明隐藏 reasoning token 可能占主要部分。

本探测验证 Gemini 3.1 Pro Preview OpenAI-compatible 端点是否接受并真正生效 `reasoning_effort` / `thinking_budget` 参数，评估其对 token 使用、延迟和结构化输出的影响。

**约束**：eval-only，不修改生产路由、不进入 `novel_generate_chapter` 路径。探测前已获得用户对真实模型调用成本的确认（21 次调用，预估 $0.50–$3.00 USD）。

### 9.2 探测配置

- **端点**：`https://api.solov.cc/v1/chat/completions`（`GOOGLE_GEMINI_BASE_URL` 代理，OpenAI 兼容路径）
- **模型**：`gemini-3.1-pro-preview`
- **固定参数**：`max_tokens=512`、`temperature=0.72`（与生产 `evidence_decision` 一致）
- **prompt**：固定代表性 `evidence_decision` 风格结构化 JSON 任务（不包含 workspace 私有内容）
- **每配置采样**：3 次
- **总调用**：21 次（7 配置 × 3 采样）

| 配置 | 说明 | 额外参数 |
|------|------|------|
| `baseline` | 无 reasoning control（当前生产行为） | `{}` |
| `reasoning_effort_low` | OpenAI 兼容映射 thinking_level=low | `{reasoning_effort: "low"}` |
| `reasoning_effort_medium` | Gemini 3.1 新增中档 | `{reasoning_effort: "medium"}` |
| `reasoning_effort_high` | Deep Think Mini | `{reasoning_effort: "high"}` |
| `thinking_budget_0` | 禁用 thinking（Gemini 2.5 兼容参数） | `{thinking_budget: 0}` |
| `thinking_budget_1024` | 限制 thinking 到 1024 token | `{thinking_budget: 1024}` |
| `reasoning_effort_low_maxtok_512` | reasoning_effort=low + max_tokens=512 组合 | `{reasoning_effort: "low"}` + maxTokens=512 |

### 9.3 探测结果

**全部 21 次调用成功**（HTTP 200，无 network_error / http_error）。

| 配置 | ok | json有效 | completion avg (min-max) | reasoning | cached | 延迟 avg (min-max) ms |
|------|------|------|------|------|------|------|
| baseline | 3/3 | 2/3 | 1436 (1322-1515) | N/A | N/A | 15454 (14601-16471) |
| reasoning_effort_low | 3/3 | 2/3 | 1543 (1349-1681) | N/A | N/A | 16108 (15530-16833) |
| reasoning_effort_medium | 3/3 | 2/3 | 1450 (1325-1542) | N/A | N/A | 16862 (13689-22263) |
| reasoning_effort_high | 3/3 | 1/3 | 1328 (1245-1431) | N/A | N/A | 15381 (14096-16805) |
| thinking_budget_0 | 3/3 | 3/3 | 1647 (1404-1805) | N/A | N/A | 16050 (13780-17210) |
| thinking_budget_1024 | 3/3 | 3/3 | 1659 (1488-1781) | N/A | N/A | 17133 (15014-18866) |
| reasoning_effort_low_maxtok_512 | 3/3 | 1/3 | 1608 (1478-1697) | N/A | N/A | 16634 (15381-18076) |

**vs baseline delta**：

| 配置 | completion delta | reasoning delta | 延迟 delta |
|------|------|------|------|
| reasoning_effort_low | +107 | +0 | +654ms |
| reasoning_effort_medium | +14 | +0 | +1408ms |
| reasoning_effort_high | -108 | +0 | -73ms |
| thinking_budget_0 | +211 | +0 | +596ms |
| thinking_budget_1024 | +223 | +0 | +1679ms |
| reasoning_effort_low_maxtok_512 | +172 | +0 | +1180ms |

### 9.4 结论

**判定：NOT_EFFECTIVE_THROUGH_PROXY - 当前 `api.solov.cc` 第三方 OpenAI-compatible 代理不支持 reasoning_effort/thinking_budget 控制。**

> 此结论仅限定于当前代理端点，不扩大解释为 Gemini 原生 API 不支持。若未来更换 provider 或 endpoint，必须重新探测。

**证据**：

1. **参数被静默接受但不生效**：全部 7 个配置 21 次调用都返回 HTTP 200（OpenAI 兼容端点通常忽略未知字段），但：
   - `completion_tokens_details` 和 `prompt_tokens_details` 始终为 `null` — 代理不返回 reasoning/cached token 细分
   - `completion_tokens` 无一致性规律：
     - `reasoning_effort_high` 反而 **低于** baseline（1328 vs 1436），与"高 reasoning 应增加 thinking"预期相反
     - `thinking_budget_0`（应禁用 thinking）反而 **高于** baseline（1647 vs 1436），与预期相反
     - 所有 delta（+107 到 +223）都在噪声范围内（baseline 自身波动 1322-1515，range=193）

2. **延迟无显著差异**：所有配置 15-17s，参数不影响模型行为

3. **completion 远超 maxTokens**：全部 1245-1805，远超 `max_tokens=512`，证实隐藏 thinking token 被计入 `completion_tokens`，但无法通过 API 参数控制

**影响**：
- 不能通过 `reasoning_effort` / `thinking_budget` 降低 `evidence_decision` 的 token 消耗
- baseline v2 中 9 次 `evidence_decision` 共消耗 136,106 token 的隐藏 thinking token 无法通过 API 参数控制
- completion_tokens（1245-1805）远超 maxTokens=512，证实隐藏 thinking token 被计入 completion

**替代预算优化方向**（不修改生产路由）：
1. **prompt 精简**：减少 `evidence_decision` 的 prompt 复杂度，可能降低 thinking 需求
2. **结构化输出约束**：使用 JSON schema / response_format 约束输出长度
3. **调用频率优化**：评估是否每章都需要独立的 `evidence_decision`，或可合并到 `agentic_raw` 的 ReAct 循环
4. **端点切换评估**：如需 reasoning control，需评估直连 Google 官方端点或切换到支持 reasoning token 细分的代理

**不进入正式 A/B**：在 capability probe 证明参数有效前，不进入基于 `reasoning_effort` / `thinking_budget` 的正式 A/B，也不修改 production pointer。当前结论是参数**不有效**，转向替代方向。
