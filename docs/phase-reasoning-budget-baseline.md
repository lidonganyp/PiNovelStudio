# 思考/推理预算研究 — Phase 1 统一主链路基线

> 状态：进行中（Phase 1 基线）。真相源补充：本文档记录"思考/推理预算"研究 Phase 1 的基线建立方法与度量契约。Phase 6.2 上下文压缩已收口（见 phase6-context-compression-design.md §15.12），本阶段不依赖任何压缩候选，生产保持 A 参数。

## 1. 目标

"思考/推理预算"研究的第一阶段**仅建立基线**，不做任何预算策略改动：

记录统一主链路各阶段的模型调用次数、输入/输出 token、耗时、超时/FailureEnvelope、重试次数和最终成功率。

**固定当前配置**：Gemini 路由（`v2_rawstage2_gemini31` / `v2_amplified_gemini31`）、上下文注入参数、工具面。**不改生产行为**。完成基线后再提出候选预算策略。

## 2. 基线度量契约

统一主链路生产路径：`novel_generate_chapter` → `runUnifiedPipeline` → `unified-orchestrator`（Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → Agentic FactGuard → 作者风格整章优化 → Story Preservation → FinalFactRecheck → Completeness → FinalStateCommit）。

每条章节生成的 evidence 写入 `workspaces/{id}/traces/{chapterId}-quality-trace.json`，其中：

| 维度 | 数据来源 | 字段 |
|------|---------|------|
| 逐阶段耗时 | `performanceProfile.stageTimings` | `Record<阶段名, elapsedMs>`（阶段名与 `stageTiming` key 一致，如 `stage1_novelosAgentic`） |
| 逐次模型调用 | `performanceProfile.llmTimings` | `LLMTimingEntry[]`：`agent/provider/model/attempt/elapsedMs/status/inputTokens/outputTokens` |
| 输入/输出 token | `performanceProfile.llmTimings[].inputTokens/outputTokens` | 新增（P43 扩展，见 §3） |
| 超时/失败 | `failureEnvelopes[]` | `severity/gate/reason`（`model_timeout` gate、`recoverable` 超时） |
| 重试次数 | `llmTimings[].attempt>1` 与 `status≠ok` | 每 agent 聚合 |
| 最终成功率 | 无 `hard/fatal` 失败阻断 | `success = hardFailures === 0` |

## 3. token 采集（精确捕获）

- `LLMTimingEntry` 新增可选字段 `inputTokens` / `outputTokens`（`api/fallback-manager.ts` + `craft/quality-trace-recorder.ts` 两处接口同步）。
- 在 **OpenAI-compatible 成功调用路径**（生产 Gemini 主路径）从 `response.usage` 精确提取 `prompt_tokens` / `completion_tokens`。
- **Claude streaming 原生路径**（显式 `writerModel=claude`）无 `usage`，token 留空；错误/超时/skip 路径 token 留空。
- 纯遥测、非行为变更：新增字段不影响任何门禁判定或返回值。

## 4. 基线工具

`scripts/reasoning-budget-baseline.mjs`：

```
node scripts/reasoning-budget-baseline.mjs --synthetic     # 内置 stub trace 验证框架（零真实数据）
node scripts/reasoning-budget-baseline.mjs --trace a.json,b.json
node scripts/reasoning-budget-baseline.mjs --dir <目录>    # 递归扫描 *-quality-trace.json
```

产出 `reports/reasoning-budget-baseline/baseline.json` + `baseline.md`：
- 汇总：模型调用次数、输入/输出 token、总耗时、重试/超时/错误数、FailureEnvelope 数、硬失败数、最终成功率。
- 逐阶段平均耗时。
- 逐模型调用（按 agent）每章均值：调用数、输入/输出 token、耗时、ok/重试/超时/错误。

## 5. 验证状态

- [x] prod/eval 构建通过。
- [x] `fallback-timeout-behavioral.test.mjs` 新增 token 捕获断言（mock usage → `inputTokens=1234`/`outputTokens=567`）。
- [x] `reasoning-budget-baseline.mjs --synthetic` 验证框架（样本=1，逐阶段/逐调用聚合正确）。
- [ ] **真实基线**：运行统一主链路真实 Gemini 章节，采集 quality-trace 后用 `--trace`/`--dir` 聚合。样本范围待确认后执行。

## 6. 下一步

- 确认真实基线样本范围（workspace/chapter、章节数）后运行真实基线。
- 基线完成后，基于逐阶段调用/token 分布提出候选"思考/推理预算"策略（如按阶段划分 token 预算/回合上限），再进入 A/B 验证。