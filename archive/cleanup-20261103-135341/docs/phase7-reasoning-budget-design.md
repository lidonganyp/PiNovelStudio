# Phase 7：思考/推理预算设计

> **状态**：设计阶段（2026-08-10）
> **前置**：Phase 5 工具接口已收口（9 专用工具默认，facade 仅 canary opt-in，compact envelope 已弃用）；Phase 6 上下文压缩已冻结为负向决策（四类状态全保持完整注入）。
> **约束**：固定 9 专用工具 + 完整上下文，只变化推理预算。eval-only，不直接切生产。

---

## 1. 动机

### 1.1 当前问题

NovelOS Agentic 的推理预算是**固定的**，不随章节复杂度变化：

| 预算维度 | 当前默认值 | 问题 |
|---------|-----------|------|
| maxTurns | 10 | 简单章节（1-2 个 P0 事实）用不完；复杂章节（5+ P0 事实）不够用 |
| maxToolCalls | 20 | 同上 |
| retrievalDepth | 2（→4 次检索） | 仅由 `mustVerify.length > 0` 二值决定，不区分风险等级 |
| maxRepairRounds | 2 | 修复预算与事实复杂度无关 |

FactRiskLevel（P0/P1/P2）已在 `must-verify-coverage-gate.ts` 中定义，但**仅用于覆盖门决策**，不影响检索预算分配。这意味着一个只有 1 个 P2 事实的章节和另一个有 6 个 P0 事实的章节获得完全相同的检索预算（depth=2 → 4 次调用）。

### 1.2 研究问题

在固定 9 专用工具 + 完整上下文的前提下：

1. **温和降低预算**是否能在不降级覆盖率的前提下降低 token 成本？
2. **按查询风险自适应预算**是否能在复杂章节提升覆盖率，在简单章节降低成本？

### 1.3 与 Phase 6 的正交性

| 维度 | Phase 6（已冻结） | Phase 7 |
|------|------------------|---------|
| 研究问题 | 上下文注入量 | 推理/检索预算 |
| 变化维度 | longTermState 完整/压缩/无 | maxTurns/maxToolCalls/retrievalDepth |
| 固定维度 | 预算 | 上下文（完整） |
| 工具集 | 9 专用工具 | 9 专用工具（一致） |
| 结论 | 负向（不压缩） | 待验证 |

---

## 2. 三臂定义

### A 组：当前预算（基线）

使用当前生产默认值，不修改任何预算参数：

```
maxTurns = 10
maxToolCalls = 20
retrievalDepth = mustVerify.length > 0 ? 2 : 0  →  4 次检索调用
maxRepairRounds = 2
maxStagnantRounds = 2
maxCoverageRetries = 1
```

### B 组：温和降低预算

降低 turn/tool/检索预算，验证是否在不降级覆盖率的前提下降低 token 成本：

```
maxTurns = 7        (-30%)
maxToolCalls = 14   (-30%)
retrievalDepth = mustVerify.length > 0 ? 1 : 0  →  2 次检索调用 (-50%)
maxRepairRounds = 1  (-50%)
maxStagnantRounds = 1  (-50%)
maxCoverageRetries = 1  (不变)
```

**设计理由**：
- retrievalDepth 从 2 降到 1：当前 depth=2 对应 4 次检索调用，depth=1 对应 2 次。对于大多数章节，2 次检索已能覆盖 P0/P1 事实（Phase 5 数据显示平均 3 次调用覆盖率达 0.926+）。
- maxTurns 从 10 降到 7：当前生产数据显示停止率仅 11%（A 组 Phase 5.3），大部分章节在预算耗尽前未主动收敛。降低预算可能迫使模型更早收敛。
- maxRepairRounds 从 2 降到 1：修复轮次是成本大户，降一半可显著降低 token。

### C 组：按查询风险自适应预算

根据 ChapterIntent 中的 mustVerify 风险分布动态分配预算：

```
// 风险评分（基于已有 FactRiskLevel）
riskScore = P0_count * 3 + P1_count * 2 + P2_count * 1

// 自适应预算
if (riskScore <= 3) {
  // 低风险章节（如 0-1 个 P0，0-1 个 P1）
  maxTurns = 6
  maxToolCalls = 10
  retrievalDepth = 1  →  2 次检索调用
  maxRepairRounds = 1
} else if (riskScore <= 10) {
  // 中风险章节（如 2-3 个 P0，2-3 个 P1）
  maxTurns = 10       // = 当前默认
  maxToolCalls = 20   // = 当前默认
  retrievalDepth = 2  →  4 次检索调用
  maxRepairRounds = 2
} else {
  // 高风险章节（如 4+ 个 P0 或 riskScore > 10）
  maxTurns = 14       // +40%
  maxToolCalls = 28   // +40%
  retrievalDepth = 3  →  6 次检索调用
  maxRepairRounds = 3  // +50%
}
maxStagnantRounds = 2  // 固定，不随风险变化
maxCoverageRetries = 1  // 固定
```

**设计理由**：
- 低风险章节降预算：简单章节不需要 10 turn / 4 次检索，降低可减少 token 浪费。
- 高风险章节升预算：复杂章节需要更多检索和修复机会，当前固定预算可能不够。
- riskScore 权重：P0=3, P1=2, P2=1，与 `must-verify-coverage-gate.ts` 中的风险分级一致。
- 阈值 3/10：riskScore=3 对应 1 个 P0 或 1.5 个 P1，是"简单章节"的自然边界；riskScore=10 对应 ~3 个 P0 或 5 个 P1，是"复杂章节"的自然边界。

---

## 3. 风险评分来源

### 3.1 现有 FactRiskLevel

`must-verify-coverage-gate.ts` 第 13 行已定义：

```typescript
export type FactRiskLevel = "P0" | "P1" | "P2";
```

分级逻辑（`assessMustVerifyRisk`）：
- **P0**：`inviolableFacts`（不可违背事实）和 `factAndCharacterKnowledgeForbiddenZones`（角色知识禁区）
- **P1**：`selectedPromisesToAdvance`（本章推进的伏笔）和 `expectedIrreversibleChange`（预期不可逆变化）
- **P2**：其他所有 mustVerify 项

### 3.2 riskScore 计算

在 `createEvidencePlan` 中，mustVerify 项已携带 `riskLevel` 字段。riskScore 可在 EvidencePlan 创建时计算：

```typescript
function computeRiskScore(mustVerify: MustVerifyItem[]): number {
  return mustVerify.reduce((score, item) => {
    const level = item.riskLevel ?? "P2";
    return score + (level === "P0" ? 3 : level === "P1" ? 2 : 1);
  }, 0);
}
```

### 3.3 预算注入路径

```
ChapterIntent -> createEvidencePlan -> computeRiskScore -> BudgetTier
  -> NovelOSRuntimeOptions.budget (覆盖默认 BudgetConfig)
  -> NovelOSRuntimeOptions.retrievalBudget (覆盖默认 retrievalDepth)
```

---

## 4. 控制变量（固定）

| 维度 | 固定值 | 来源 |
|------|--------|------|
| 工具集 | 9 专用工具 | Phase 5 结论 |
| 上下文 | 完整（不压缩） | Phase 6 冻结 |
| 模型路由 | GLM 5.2 (`narrator_testing_glm`) | 与 Phase 5 一致 |
| seed / temperature | 0/1/2 × 0.72 | 与 Phase 5 一致 |
| fallback | `[]`（关闭） | 与 Phase 5 一致 |
| 场景 | SC2/SC5/SC7（Phase 5 同款） | 最能暴露预算差异 |

---

## 5. 门禁（预注册）

### 5.1 B 组门禁（温和降低不降级）

| 门禁 | 口径 |
|------|------|
| mustVerify 覆盖率不降级 | B.avgCoverageRatio >= A.avgCoverageRatio - 5% |
| sourceRef 完整率不降级 | B.sourceRefCompleteness >= A.sourceRefCompleteness - 5% |
| 失败行为不恶化 | B errors/timeouts/empty/truncated <= A + 容差 |
| token 成本下降 | B.totalEstimateTokens < A.totalEstimateTokens × 0.9 (-10%) |
| 停止率不降级 | B.stopRate >= A.stopRate - 5% |
| 首证据延迟不恶化 | B.firstEvidenceLatency <= A.firstEvidenceLatency + 1ms |

### 5.2 C 组门禁（自适应不降级 + 分类收益）

| 门禁 | 口径 |
|------|------|
| mustVerify 覆盖率不降级 | C.avgCoverageRatio >= A.avgCoverageRatio |
| sourceRef 完整率不降级 | C.sourceRefCompleteness >= A.sourceRefCompleteness |
| 失败行为不恶化 | C errors/timeouts/empty/truncated <= A |
| 低风险章节 token 下降 | C_low.totalEstimateTokens < A_low.totalEstimateTokens × 0.9 |
| 高风险章节覆盖率提升 | C_high.avgCoverageRatio > A_high.avgCoverageRatio |
| 停止率不降级 | C.stopRate >= A.stopRate - 5% |

### 5.3 膨胀门禁（C 组不显著增加 token）

| 门禁 | 口径 |
|------|------|
| 聚合 token 不膨胀 | C.totalEstimateTokens <= A.totalEstimateTokens × 1.15 |
| 单场景 token 无膨胀 | 每场景 C <= A × 1.5 + buffer |

---

## 6. 指标

| 指标 | 定义 | 来源 |
|------|------|------|
| avgCoverageRatio | mustVerify 覆盖率（跨场景平均） | ToolCallMetricsTracer |
| sourceRefCompleteness | 有效 sourceRef / 总调用 | ToolCallMetricsTracer |
| stopRate | 主动收敛率（model_declares_sufficient / 总场景） | AgentLoopStopReason |
| totalEstimateTokens | schema + 工具结果 token 估算 | ToolCallMetricsTracer |
| firstEvidenceLatency | 首次有效证据延迟 (ms) | ToolCallMetricsTracer |
| totalCalls | 总工具调用数 | ToolCallMetricsTracer |
| duplicateQueries | 重复查询数 | ToolCallMetricsTracer |
| emptyResults | 空结果数 | ToolCallMetricsTracer |
| errors | 错误数 | ToolCallMetricsTracer |
| timeouts | 超时数 | ToolCallMetricsTracer |
| budgetExhausted | 预算耗尽次数 | BudgetPolicy.isExhausted |

---

## 7. 实现路径

### 7.1 eval-only 模块

```
novelos/eval/
├── reasoning-budget-runner.ts     # A/B/C runner（复用 tool-interface-baseline 场景）
├── reasoning-budget-config.ts     # 三臂预算配置 + riskScore 计算
└── reasoning-budget-gate.ts       # 门禁评估
```

### 7.2 预算注入

C 组的 riskScore 计算需要 ChapterIntent 的 mustVerify 风险分布。在 eval runner 中：

1. 从 `BASELINE_SCENARIOS` 获取每个场景的 mustVerify 列表
2. 为每个 mustVerify 项标注 `riskLevel`（P0/P1/P2）
3. 计算 `riskScore` -> 确定 `BudgetTier`（low/medium/high）
4. 根据 BudgetTier 覆盖 `BudgetConfig` 和 `retrievalDepth`

### 7.3 复用现有基础设施

- 场景：复用 `tool-interface-baseline.ts` 的 `BASELINE_SCENARIOS`（SC2/SC5/SC7）
- 工具：复用 `createNarrativeTools`（9 专用工具）
- 指标追踪：复用 `ToolCallMetricsTracer`
- 聚合：复用 `aggregateArm`
- 报告格式：复用 `formatCompactEnvelopeAbcJson/Markdown` 模式

### 7.4 与生产的隔离

- 预算配置通过 `NovelOSRuntimeOptions.budget` 和 `NovelOSRuntimeOptions.retrievalBudget` 注入
- 生产路径不修改 `DEFAULT_BUDGET_CONFIG`，不修改 `createEvidencePlan` 的默认 `retrievalDepth`
- C 组的 riskScore 逻辑仅存在于 eval runner，不进入生产 `evidence-plan.ts`
- 通过后仍需真实模型 canary + 评审后才决定是否进入生产

---

## 8. 验收产物

- [x] `novelos/eval/reasoning-budget-config.ts`（三臂配置 + riskScore）
- [x] `novelos/eval/reasoning-budget-runner.ts`（A/B/C runner）
- [x] `novelos/eval/reasoning-budget-gate.ts`（门禁评估）
- [x] `tests-eval/phase7-reasoning-budget.test.mjs`（确定性断言）
- [x] `reports/phase7-reasoning-budget/`（对比报告 JSON + MD）
- [x] 本设计评审通过后，才可进入实现 Phase（Phase 7 已正式收口：A 组保留生产基线，B/C 不进入 canary，跨模型确认）

> **Phase 7 决策结果（2026-08-10，跨模型双重确认）**：真实 replay 先后在 gemini31 与 GLM 5.2 上执行，结论一致。
>
> **gemini31（`narrator_primary`，GLM 配额耗尽临时改用）**：3 批 × 3 seed。仅 batch-1（seed 0-2）数据干净；batch-2 降质、batch-3 全部超时无效（gemini31 不稳定）。以干净 batch-1 为准：**B 组未过 token 成本下降门（B=4072 > A×0.9），C 组未过 sourceRef 完整率门（0.809<0.878）与失败行为门（errors 2>1）**。
>
> **GLM 5.2（`narrator_testing_glm`，配额恢复后重跑）**：3 批 × 3 seed，全部调用成功（干净数据）。**B 组仅 batch-3 通过**（token 下降 5782<6613×0.9），batch-1/2 未过 token 成本下降门（B 反而升高 5393/5845）且停止率被压制到 67-71%；**C 组 3 批全部未通过**（batch-2 sourceRef 0.481<0.558、batch-1/3 高风险覆盖率已达 1.000 无法再提升、batch-3 mustVerify 0.975<0.992）。
>
> **最终决策**：两模型均**未通过 → 保留 A 组生产预算**，B/C 不进入 canary。当前场景中预算并非成本瓶颈，降低/自适应预算不省成本反损完成率。生产零改动，B/C 仅存于 eval-only。决策详见 `reports/phase7-reasoning-budget-real-gemini/decision.md` 与 `reports/phase7-reasoning-budget-real-glm/decision.md`。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| B 组预算过低导致覆盖率崩塌 | 先跑确定性 stub 验证框架，真实 replay 从温和参数开始 |
| C 组 riskScore 阈值不合理 | 先用当前场景数据计算 riskScore 分布，验证阈值覆盖低/中/高三档 |
| GLM 5.2 模型变异性 | 跑 3 批次 × 3 seed，跨批次聚合；单次结果不做最终判定 |
| 预算注入路径与生产行为不一致 | A 组使用与生产完全相同的 BudgetConfig，确保基线一致 |
| 修复轮次降低导致 verifier 残留 | B 组门禁单独检查 verifier 残留数不降级 |

---

## 10. 与 Phase 5/6 的关系

| 维度 | Phase 5 | Phase 6 | Phase 7 |
|------|---------|---------|---------|
| 研究问题 | 工具接口形态 | 上下文压缩量 | 推理/检索预算 |
| A 组 | 9 专用工具 | 完整上下文 | 当前预算 |
| B 组 | facade 变体 | 压缩上下文 | 温和降低预算 |
| C 组 | facade+envelope | 无状态 | 自适应预算 |
| 工具集 | 变化 | 固定 | 固定 |
| 上下文 | 固定 | 变化 | 固定 |
| 预算 | 固定 | 固定 | 变化 |
| 结论 | 9工具默认 | 不压缩 | 待验证 |

三个 Phase 正交：Phase 5 固定上下文和预算变化工具；Phase 6 固定工具和预算变化上下文；Phase 7 固定工具和上下文变化预算。
