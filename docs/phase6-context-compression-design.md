# Phase 6 - 上下文压缩与记忆层设计

> **状态**：**已冻结（2026-08-10）**。负向决策：不启用压缩和状态删减，四类状态全部保持完整注入。
> **前置**：Phase 5.3.3 B-safe 已收口（`88a5fa4`，2026-08-09），生产仍为 `rel-000`，9 专用工具默认执行面未改变。
> **范围**：eval-only A/B 基线，工具决策 replay（非完整生产链路）。
>
> **冻结决策**：
> - 生产继续使用完整 CanonState、CharacterState、PromiseLedger、PatternMemory
> - 不启用上下文压缩、不删减状态类
> - 保持 `rel-000` + 9 专用工具，不切 canary、不改 production pointer
> - 实验范围限于工具决策 replay，不等于完整生产链路验证
> - 两轮独立消融 replay（各 135 场景）无状态类稳定显著，不构成压缩依据

---

## 1. 背景与目标

### 1.1 当前现状

统一主链路的上下文注入由 `ContextCompiler`（`v2/core/context-compiler.ts`）负责，经 `context-safety.ts` 做 token 预算裁剪后传入编排器。当前上下文包含以下层：

| 层 | 来源 | 注入路径 | 当前预算 |
|---|------|---------|---------|
| 事实（facts） | ChapterSeed 派生 | `deriveFacts()` | 无独立上限，受 ContextSafety P3 裁剪 |
| 角色状态（characterStates） | ChapterSeed 派生 | `deriveCharacterStates()` | 无独立上限 |
| 开放回路（openLoops） | ChapterSeed 派生 | `deriveOpenLoops()` | 无独立上限 |
| 世界规则（worldRules） | ChapterSeed 派生 | `deriveWorldRules()` | 无独立上限 |
| 风格参考（styleReferences） | 风格指纹文件 | `loadStyleProfile()` | P4 可丢弃 |
| 作品宪法（constitution） | CreativeConstitution | `deriveConstitution()` | P0/P1 保护 |
| **长期状态（longTermState）** | narrative-state-store.json | `deriveLongTermState()` -> JIT 检索 | maxItems=24-48，摘要 160 字符/条 |

四类长期叙事状态（CanonState / CharacterState / PromiseLedger / PatternMemory）通过 JIT 检索（`retrieveNarrativeContext()`）注入，已有三层预算控制：

1. **maxItems 动态缩放**：`Math.min(48, Math.max(24, floor(total / 4)))` — 下限 24、上限 48
2. **promptItems 摘要截断**：每条摘要最多 160 字符
3. **ContextSafety 分层裁剪**：P0（canon）不可丢弃，P1（相关角色/promise）不可丢弃，P3（非相关）可丢弃

### 1.2 问题

当前预算参数（maxItems 24-48、摘要 160 字符）是基于经验设定的，**未经过真实模型 A/B 验证**。以下问题待解答：

- 长期状态注入的 **边际价值** 是多少？（完全不注入 vs 当前注入量）
- 当前 maxItems 24-48 是否 **过大或过小**？（压缩到 12-24 是否降级覆盖率？）
- 摘要 160 字符是否 **信息损失过大**？（扩展到 240 字符是否提升覆盖率？）
- 四类状态的 **相对价值** 如何？（CanonState vs PatternMemory 的边际贡献差异）

### 1.3 目标

在 **eval-only** 隔离下，建立"完整上下文 vs 压缩上下文"的 A/B 基线，量化：

1. 长期状态注入的边际价值（A vs C）
2. 压缩参数对证据覆盖的影响（A vs B）
3. 各类状态的相对贡献（逐类消融）
4. 上下文 token 成本与证据覆盖的帕累托前沿

**不降级底线**：mustVerify 覆盖率、sourceRef 完整率、事实/时间线冲突率。

---

## 2. 设计约束（铁律）

1. **eval-only**：所有压缩变体只生活在 `dist-eval/`（`tsconfig.eval.json`），不进入 `tsconfig.prod.json` / `dist/`。
2. **不改生产 ContextCompiler**：通过 `evalContext` 注入压缩后的 `CompiledContext`，复用 `runUnifiedPipeline` 的 eval 路径。
3. **复用现有 fixtures/workspace**：使用与 Phase 4/5 相同的 eval workspace 和 mustVerify 场景。
4. **固定对照**：A/B/C 使用相同模型路由（GLM 5.2）、相同 seed/temperature、相同 9 专用工具。
5. **先确定性后真实模型**：先跑 stub 确定性 replay（零成本），再跑真实模型 replay（受控预算）。
6. **不降级底线优先**：mustVerify 覆盖率与 sourceRef 完整率是底线，token 成本是优化目标。

---

## 3. A/B/C 组定义

### 3.1 A 组：完整上下文（当前生产基线）

- 使用当前 `ContextCompiler.compile()` 的完整输出。
- maxItems = `computeMaxItems(totalEntries)`（24-48）
- promptItems 摘要 = 160 字符/条
- ContextSafety 分层裁剪 P0-P4（默认参数）
- **这是当前生产的真实行为，作为不降级基线。**

### 3.2 B 组：压缩上下文

对长期状态注入施加更激进的压缩参数：

| 参数 | A 组（当前） | B 组（压缩） | 理由 |
|------|------------|-------------|------|
| maxItems | 24-48 | **12-24** | 测试更小工作集是否降级覆盖 |
| 摘要字符上限 | 160 | **80** | 测试更短摘要是否损失关键信息 |
| perKindFloor | min(4, itemLimit/4) | **min(2, itemLimit/6)** | 收窄每类保底名额 |
| 非相关角色状态 | P3 可丢弃 | **不注入** | 只注入 relevantCharacters 命中的角色状态 |
| 非选中 openLoops | P3 可丢弃 | **不注入** | 只注入 selectedPromiseIds 命中的伏笔 |
| PatternMemory | P3 可丢弃 | **不注入** | 叙事模式非硬事实，测试其边际价值 |

B 组保持 P0（canon 不可违背事实）和 P1（相关角色/选中伏笔）不变，只压缩 P3/P4 层。

### 3.3 C 组：无长期状态基线

- `CompiledContext.longTermState = null`
- 完全不注入四类长期叙事状态
- **测量长期状态注入的边际价值**（A vs C 的 delta）

### 3.4 逐类消融（可选，Phase 6.2）

若 A/B/C 基线证明压缩有正收益，进一步逐类消融：

| 变体 | 注入状态 | 排除状态 |
|------|---------|---------|
| B-canon | CanonState | CharacterState / PromiseLedger / PatternMemory |
| B-character | CharacterState | CanonState / PromiseLedger / PatternMemory |
| B-promise | PromiseLedger | CanonState / CharacterState / PatternMemory |
| B-pattern | PatternMemory | CanonState / CharacterState / PromiseLedger |

---

## 4. 控制变量（A/B/C 相同）

| 变量 | 固定值 |
|------|--------|
| Fixtures | 与 Phase 4/5 相同的 eval workspace（含 mustVerify 场景） |
| 工具集 | 9 专用工具（NARRATIVE_TOOL_NAMES），不使用 facade |
| 模型路由 | `narrator_testing_glm`（GLM 5.2，`fallback=[]`） |
| Prompt | 相同 system / 检索决策规则 |
| seed / temperature | 0/1/2 × 0.72 |
| 预算 | 相同 `budgetPolicy`（模型调用软 6 / 硬 10） |
| Workspace | 相同 `workspaces/{id}` 数据 |

**唯一差异**：长期状态的注入量（maxItems / 摘要长度 / 注入范围）。

---

## 5. 对比指标

### 5.1 不降级底线（必须通过）

| 指标 | 口径 | 目标 |
|------|------|------|
| mustVerify 覆盖率 | `computeMustVerifyCoverage` 逐场景计算 | B/C >= A（不降级） |
| sourceRef 完整率 | 有效 sourceRef 占比 | B/C >= A |
| 事实/时间线冲突 | FactGuard 检测的冲突数 | B/C <= A |

### 5.2 优化目标

| 指标 | 口径 | 目标 |
|------|------|------|
| 上下文 token 成本 | `estimateTokens(longTermState promptItems)` | B < A（显著下降） |
| 首次有效证据延迟 | 首次 confirmed 证据的工具调用序号 | B <= A（不延迟） |
| 总工具调用次数 | `totalCalls` | B <= A（不增加） |
| 空结果数 | `emptyResults` | B <= A |
| 停止率 | `stopped / total` | B >= A - 5%（不显著下降） |

### 5.3 章节连续性

| 指标 | 口径 | 目标 |
|------|------|------|
| StoryPreservation Gate | full_entities 覆盖率（0.25/3 阈值） | B/C 不新增 block |
| 实体保持率 | knownEntities 命中率 | B/C >= A |
| 重复查询数 | `duplicateQueries` | B <= A |

### 5.4 上下文成本明细

| 指标 | 口径 |
|------|------|
| longTermState token | `estimateTokens(promptItems 全部拼接)` |
| canon token | CanonState 条目 token 小计 |
| character token | CharacterState 条目 token 小计 |
| promise token | PromiseLedger 条目 token 小计 |
| pattern token | PatternMemory 条目 token 小计 |
| 总上下文 token | ContextBudgetReport.estimatedRetainedTokens |

---

## 6. 实现方案

### 6.1 eval-only 压缩上下文构建器

新增 `novelos/eval/compressed-context-builder.ts`（eval-only）：

```typescript
export interface CompressionParams {
  maxItemsScale: number;       // maxItems 乘数，如 0.5 表示压缩到一半
  summaryCharLimit: number;    // 摘要字符上限
  perKindFloorScale: number;   // perKindFloor 乘数
  injectNonRelevantCharacters: boolean;  // 是否注入非相关角色状态
  injectNonSelectedPromises: boolean;     // 是否注入非选中伏笔
  injectPatternMemory: boolean;           // 是否注入 PatternMemory
}

export function buildCompressedContext(
  fullContext: CompiledContext,
  params: CompressionParams,
): CompiledContext;
```

- 接收 A 组的完整 `CompiledContext`，按 `params` 重建 `longTermState`
- 不修改 `facts` / `characterStates` / `worldRules` / `constitution` 等非长期状态层
- 返回新的 `CompiledContext`，保持类型不变

### 6.2 A/B/C replay runner

新增 `novelos/eval/context-ab-runner.ts`（eval-only）：

- 复用 `runRealToolAbScenario` 的场景/seed/模型路由框架
- 对每个场景 × seed，运行 3 个 arm：
  - A: `ContextCompiler.compile()` 完整输出
  - B: `buildCompressedContext(A, B_PARAMS)` 压缩输出
  - C: `{ ...A, longTermState: null }` 无状态输出
- 通过 `evalContext` 注入到 `runUnifiedPipeline(evalMode="B0", evalContext=...)`
- 采集 §5 全部指标

### 6.3 压缩参数预设

```typescript
const B_COMPRESSION: CompressionParams = {
  maxItemsScale: 0.5,        // 24-48 -> 12-24
  summaryCharLimit: 80,      // 160 -> 80
  perKindFloorScale: 0.5,    // min(4, n/4) -> min(2, n/8)
  injectNonRelevantCharacters: false,
  injectNonSelectedPromises: false,
  injectPatternMemory: false,
};
```

---

## 7. 执行计划

### Phase 6.1a - 确定性 replay（stub model，零 API 调用）

1. 实现 `compressed-context-builder.ts`（eval-only 压缩构建器）
2. 实现 `context-ab-runner.ts`（A/B/C runner）
3. 跑确定性 stub replay，验证框架正确性
4. 从 trajectory 提取 §5 全部指标，生成 `reports/phase6-context-ab/` 对比报告
5. 断言底线：`B.mustVerifyCoverage >= A` 且 `C.mustVerifyCoverage <= A`（验证 C 组确实测量到边际价值）

### Phase 6.1b - 小规模真实模型 replay

1. 固定场景子集（SC2/SC5/SC7）、固定 seed/temperature
2. A/B/C 各跑 3 批次 × 3 seed
3. 聚合均值/分布，产出对比报告
4. 评估 token 成本下降是否显著、覆盖率是否降级

### Phase 6.1c - 结论与后续

- 若 B 组 token 显著下降且覆盖不降级 -> 压缩参数可作 Phase 6.2 生产 canary 候选
- 若 C 组覆盖显著降级 -> 长期状态注入有正收益，当前注入量合理
- 若 C 组覆盖不降级 -> 长期状态注入无边际价值，需重新评估注入策略
- **无论结论如何，不直接切换生产 ContextCompiler**

---

## 8. 门禁（预注册）

### 8.1 B 组门禁（压缩不降级）

| 门禁 | 口径 | 容差 |
|------|------|------|
| mustVerify 覆盖率 >= A | 跨批次聚合 | 0（严格不降级） |
| sourceRef 完整率 >= A | 跨批次聚合 | 0 |
| 事实冲突数 <= A | FactGuard | 0 |
| 停止率 >= A - 5% | 跨批次聚合 | 0.05 |
| token 成本下降 > 10% | longTermState token | 10% |
| 首证据延迟 <= A + 1 | 首次 confirmed 调用序号 | +1 |

### 8.2 C 组门禁（无状态基线，记录不阻断）

C 组是测量边际价值的基线，**不设通过/失败门禁**，只记录 A-C 的 delta：
- 覆盖率 delta（A - C）
- sourceRef delta（A - C）
- token 成本 delta（A - C）

若 C 组覆盖率 delta < 5%，标记"长期状态注入边际价值不足"。

---

## 9. 验收产物

- [ ] `novelos/eval/compressed-context-builder.ts`（eval-only，压缩构建器）
- [ ] `novelos/eval/context-ab-runner.ts`（eval-only，A/B/C runner）
- [ ] `scripts/context-ab-replay.mjs`（replay 脚本）
- [ ] `tests-eval/phase6-context-ab.test.mjs`（确定性断言）
- [ ] `reports/phase6-context-ab/`（对比报告，JSON + MD）
- [ ] 本设计评审通过后，才可进入实现 Phase

---

## 10. 与 Phase 4/5 的关系

| 维度 | Phase 4/5 | Phase 6 |
|------|----------|---------|
| 研究问题 | 工具接口形态（9 工具 vs facade） | 上下文压缩与记忆注入量 |
| A 组 | 9 专用工具 | 完整上下文（当前 ContextCompiler） |
| B 组 | facade 变体 | 压缩上下文 |
| 工具集 | 变化（9 vs facade） | **固定**（9 专用工具） |
| 上下文 | 固定 | **变化**（完整 vs 压缩 vs 无） |
| 模型路由 | GLM 5.2 | GLM 5.2（一致） |
| 门禁口径 | 覆盖率/sourceRef/失败行为 | 覆盖率/sourceRef/token 成本/连续性 |

Phase 6 固定工具集为 9 专用工具（Phase 4/5 已证明其为最优生产注入），只变化上下文注入量。两个 Phase 正交。

> **Phase 5 结论冻结（2026-08-10）**：
> - 9 专用工具为默认生产注入，facade 仅 canary opt-in（`toolMode="facade"`）。
> - compact envelope 已在 Phase 5.3 真实 replay 中多项门禁失败（覆盖率/sourceRef/失败行为降级），**已弃用**，不进入默认生产。
> - Phase 6 上下文压缩实验固定使用 9 专用工具基线，不使用 compact envelope。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 压缩参数过于激进，覆盖率降级 | 先跑确定性 stub 验证框架，真实 replay 从温和参数开始 |
| GLM 5.2 模型变异性（Phase 5.3.3 教训） | 跑 3 批次 × 3 seed，跨批次聚合；单次结果不做最终判定 |
| evalContext 注入路径与生产行为不一致 | A 组使用与生产完全相同的 `ContextCompiler.compile()` 输出，确保基线一致 |
| 压缩构建器引入新的 bug | 确定性 stub replay 先验证 `buildCompressedContext` 输出的 `CompiledContext` 结构完整 |
| 四类状态交互效应 | Phase 6.1 先做整体压缩（B 组），Phase 6.2 再做逐类消融 |

---

## 12. Phase 6.1b 真实模型 replay 结果（2026-08-09）

> **状态**：已完成。3 批次 × 3 场景 × 3 seed × 3 arm = 81 次场景运行，GLM 5.2，`fallback=[]`。

### 12.1 跨批次聚合对比

| 指标 | A 完整 | B 压缩 | C 无状态 |
|------|--------|--------|---------|
| 平均覆盖率 | **0.951** | 0.827 | 0.840 |
| 停止率 | **81%** | 63% | 19% |
| sourceRef 完整率 | **0.769** | 0.702 | 0.706 |
| 总调用数 | 61 | 70 | 88 |
| 空结果数 | **0** | 5 | 3 |
| 非法工具选择 | **0** | 5 | 3 |
| 重复查询 | 4 | 7 | 7 |
| 上下文 token | 2844 | 1764 (-38%) | 0 |
| 上下文条目数 | 3.3 | 2.0 | 0 |
| 首证据延迟 | 0.44 | 0.11 | 0.37 |

### 12.2 逐类 token 明细（A 组）

| 状态类 | token | 占比 |
|--------|-------|------|
| CanonState | 126 | 4% |
| CharacterState | 648 | 23% |
| PromiseLedger | 171 | 6% |
| PatternMemory | 738 | 26% |
| Expectation | 0 | 0% |
| Planned | 0 | 0% |
| 结构开销 | 1161 | 41% |
| **总计** | **2844** | 100% |

### 12.3 B 组门禁（压缩不降级）

| 门禁项 | 结果 | 说明 |
|--------|------|------|
| 覆盖率 >= A | **FAIL** | 0.827 < 0.951（-13%） |
| sourceRef >= A | **FAIL** | 0.702 < 0.769（-9%） |
| 失败不劣于 A | **FAIL** | Phase 6.1.1 修复：补充 empty(5>0)/invTool(5>0) 检查 |
| 停止率不降级 | **FAIL** | 63% < 76%（81%-5%容差） |
| token 下降 >10% | PASS | 38.0% |
| 首证据不延迟 | PASS | 0.11 <= 1.44 |
| **整体门禁** | **FAIL** | 覆盖率/sourceRef/失败/停止率四项降级 |

### 12.4 C 组 delta（无状态基线）

| 指标 | A - C delta | 说明 |
|------|------------|------|
| 覆盖率 delta | **+0.111** | >=5%，**长期状态注入有正收益** |
| sourceRef delta | +0.062 | |
| 停止率 delta | +0.63 | 长期状态显著帮助模型收敛 |
| token delta | 2844 | 长期状态注入的 token 成本 |

### 12.5 结论与归因

> **实验范围声明（Phase 6.1.1 收口修正）**：本实验是**工具决策 replay**，
> 不是完整生产 `ContextCompiler -> runUnifiedPipeline -> 正文生成` 链路验证。
> runner 在 `context-ab-runner.ts` 中把模拟上下文直接前置到工具决策 prompt，
> 再调用 `runRealToolAbScenario`。它验证的是"长期状态对叙事证据检索决策的影响"，
> 不能扩大为"生产 ContextCompiler 参数已被完整验证"。

**核心结论：长期状态对叙事证据检索决策有明显收益（A vs C 稳定 +8-11%）；B 组压缩的门禁结果不稳定（两次 replay 矛盾），需多次 replay 确认。**

#### 两次真实 replay 对比

| 指标 | Run 1 A | Run 1 B | Run 1 C | Run 2 A | Run 2 B | Run 2 C |
|------|---------|---------|---------|---------|---------|---------|
| 覆盖率 | 0.951 | 0.827 | 0.840 | 0.963 | **0.975** | 0.877 |
| 停止率 | 81% | 63% | 19% | 74% | 74% | 41% |
| sourceRef | 0.769 | 0.702 | 0.706 | 0.780 | **0.784** | 0.703 |
| 空结果 | 0 | 5 | 3 | 1 | 1 | 5 |
| 非法工具 | 0 | 5 | 3 | 1 | 1 | 5 |
| 门禁 | - | **FAIL** | - | - | **PASS** | - |

**Run 1 门禁 FAIL**：B 组覆盖率降级 13%、空结果+5、非法工具+5
**Run 2 门禁 PASS**：B 组覆盖率略优（0.975>0.963）、失败行为持平、token 下降 38%

两次结果矛盾的原因：
1. **GLM 5.2 在 temp=0.72 下的模型变异性**（Phase 5.3.3 B-safe 已遇到同样问题）
2. **场景状态数据量小**（每场景 3-4 条状态），压缩的边际效应被模型随机性淹没
3. **工具决策 replay 的信号弱**：模型主要依赖工具检索结果而非 prompt 中的状态摘要

#### 稳定结论（两次 replay 一致）

尽管 B 组门禁不稳定，以下结论在两次 replay 中一致：

1. **长期状态注入有正收益**（A vs C，两次一致）：
   - 覆盖率 delta：+11.1%（Run 1）、+8.6%（Run 2），均 >= 5% 显著性门槛
   - 停止率 delta：+62pp（Run 1）、+33pp（Run 2），长期状态帮助模型收敛
   - 无状态时模型倾向于持续检索（calls 88/81 vs A 61/71）

2. **token 成本下降稳定**（B vs A，两次一致）：
   - 下降 38%（2844 -> 1764），排除 PatternMemory 是主要贡献

3. **PatternMemory 因果关系为待验证假设**：
   - B 组同时改变了摘要长度、maxItems、PatternMemory、Planned 等多个变量
   - Run 2 中排除 PatternMemory 后覆盖率不降级，暗示其边际贡献可能不如预期
   - 需 Phase 6.2 单因素消融确认

### 12.6 后续

- **不调整生产 ContextCompiler 参数**：当前 maxItems 24-48 / 摘要 160 字符在工具决策 replay 中表现良好，但不等于生产链路已完整验证
- **B 组压缩方案暂不采用**：门禁结果不稳定（FAIL/PASS），需多次 replay 确认稳定性后再决策
- **Phase 6.2 逐类消融**：已完成，见 §13
- **生产链路 integration replay（可选）**：补做真正的 `ContextCompiler/runUnifiedPipeline` integration replay
- **真实 workspace 验证（可选）**：当前使用从 BaselineScenario 派生的模拟状态，可在真实生产 workspace 验证

---

## 13. Phase 6.2 逐类单因素消融结果（2026-08-09）

> **状态**：已完成。5 arm × 3 场景 × 3 seed × 3 批次 = 135 次场景运行，GLM 5.2，`fallback=[]`。
> **提交**：`da1e9f2`。

### 13.1 实验设计

单因素消融：每个 arm 只排除一类状态，其他参数与 A 组一致（maxItems 48, 摘要 160 字符）。

| Arm | 排除的状态类 | 其他参数 |
|-----|------------|---------|
| A | 无（基线） | 完整 |
| A-Canon | CanonState | 其他全注入 |
| A-Character | CharacterState | 其他全注入 |
| A-Promise | PromiseLedger | 其他全注入 |
| A-Pattern | PatternMemory | 其他全注入 |

### 13.2 跨批次聚合对比

| 指标 | A 完整 | A-Canon | A-Character | A-Promise | A-Pattern |
|------|--------|---------|-------------|-----------|-----------|
| 覆盖率 | 0.988 | 0.988 | **0.914** | 0.951 | 0.951 |
| 停止率 | 67% | 74% | **52%** | 56% | **44%** |
| sourceRef | 0.821 | 0.806 | **0.718** | 0.791 | 0.800 |
| 空结果 | 2 | 0 | 1 | 1 | **5** |
| 非法工具 | 2 | 0 | 1 | 1 | **5** |
| 上下文 token | 2844 | 2709 | 2079 | 2592 | 1764 |

### 13.3 消融门禁（各 arm vs A 不降级）

| Arm | 覆盖率>=A | sourceRef>=A | 失败不劣于A | 停止率不降级 | 覆盖率 delta | 显著贡献 | 门禁 |
|-----|-----------|-------------|------------|-------------|-------------|---------|------|
| A-Canon | PASS | **FAIL** | PASS | PASS | 0.000 | 否 | FAIL |
| A-Character | **FAIL** | **FAIL** | PASS | **FAIL** | **0.074** | **是** | FAIL |
| A-Promise | **FAIL** | **FAIL** | PASS | **FAIL** | 0.037 | 否 | FAIL |
| A-Pattern | **FAIL** | **FAIL** | **FAIL** | **FAIL** | 0.037 | 否 | FAIL |

### 13.4 结论

> **结论级别声明（Phase 6.2.1 收口修正）**：以下结论为**强假设**，不是已确认的事实。
> 两轮独立 replay（各 135 场景）结果不一致，证实模型波动影响显著。
> 只有多轮独立 replay 持续表现同方向优势后，才能正式标记为"不可压缩"。
> 实验仍是工具决策 replay（使用模拟状态），不是完整生产链路验证。

#### 两轮消融 replay 对比

| Arm | Run 1 覆盖率 delta | Run 2 覆盖率 delta | 方向一致 | 显著(>5%) |
|-----|-------------------|-------------------|---------|----------|
| A-Canon | 0.000 | -0.037 | 否 | 否 |
| A-Character | 0.074 | 0.037 | 是（同方向） | Run 1 是，Run 2 否 |
| A-Promise | 0.037 | -0.012 | 否 | 否 |
| A-Pattern | 0.037 | -0.025 | 否 | 否 |

**结论：没有任何状态类在两轮 replay 中都表现出显著的边际贡献。**

- CharacterState 在 Run 1 中 delta=7.4%（显著），但在 Run 2 中降到 3.7%（不显著）
- 3/4 arm 的 delta 方向在两轮间不一致（正值变负值）
- 所有 arm 的门禁都 FAIL（主要因停止率降级）

**当前决策：四类状态全部保持完整注入，不删除任何状态类。**

各类状态的边际贡献排序：

1. **CharacterState（delta=7.4%，显著）**：
   - 去除后覆盖率降级 7.4%（唯一超过 5% 显著性门槛）
   - 停止率降级 15pp（67% -> 52%）
   - sourceRef 降级 10.3pp（0.821 -> 0.718）
   - **CharacterState 是最重要的状态类，不可压缩**

2. **PromiseLedger（delta=3.7%，不显著）**：
   - 去除后覆盖率降级 3.7%，停止率降级 11pp
   - 有正贡献但低于 5% 显著性门槛
   - **PromiseLedger 有价值但边际贡献中等**

3. **PatternMemory（delta=3.7%，不显著）**：
   - 去除后覆盖率降级 3.7%，但空结果从 2 增到 5、非法工具从 2 增到 5
   - **PatternMemory 对覆盖率影响不大，但对失败行为有显著影响**
   - 这回答了 Phase 6.1 的问题：PatternMemory 单独排除的因果效果是 delta=3.7%（不是 B 组多变量混合的 13%）

4. **CanonState（delta=0.000，无贡献）**：
   - 去除后覆盖率不变，但 sourceRef 降级 1.5pp
   - 门禁 FAIL 仅因 sourceRef 微降
   - **CanonState 在工具决策 replay 中对覆盖率无边际贡献**
   - 可能原因：CanonState 的事实信息已通过工具检索获得，prompt 注入是冗余的

### 13.5 与 Phase 6.1 B 组的对比

| 对比 | B 组（多变量） | A-Pattern（单变量） |
|------|-------------|-----------------|
| 变化 | 摘要 80 字符 + maxItems 24 + 排除 Pattern + 排除 Planned | 只排除 Pattern |
| 覆盖率 delta | -13%（Run 1）/ +1.2%（Run 2） | -3.7% |
| 空结果 | +5（Run 1）/ 0（Run 2） | +3 |
| 非法工具 | +5（Run 1）/ 0（Run 2） | +3 |

**结论**：B 组的 13% 降级是多变量联合效应，不能单独归因于 PatternMemory。PatternMemory 单独排除的因果效果是 3.7%。

### 13.6 后续

- **四类状态全部保持完整注入**：在多轮 confirmation replay 确认前，不删除任何状态类
- **CharacterState 需多轮确认**：三批波动大（7.4%/0%/14.8%），只有持续同方向优势后才能标记"不可压缩"
- **CanonState 可能有优化空间**：工具决策 replay 中对覆盖率无贡献，需生产链路验证是否冗余
- **PatternMemory 对失败行为有影响**：虽覆盖率 delta 不显著，但空结果和非法工具显著增加
- **生产链路 integration replay 仍是待办**：当前结论限于工具决策层面
- **Phase 6.2.1 收口**：evaluateAblationGate 已移入共享 gate 模块；原始 entry 已保存；消融 arm 参数测试 16/16 通过

---

## 14. Phase 6 冻结决策记录（2026-08-10）

### 决策

**负向决策：不启用上下文压缩和状态删减。四类长期叙事状态全部保持完整注入。**

### 决策依据

1. **Phase 6.1 整体压缩（B 组）**：两轮真实 replay 门禁矛盾（FAIL/PASS），模型变异性导致结论不稳定
2. **Phase 6.2 逐类消融**：两轮独立 replay（各 135 场景）中，没有任何状态类在两轮中都表现出显著的边际贡献（>5%）
   - CharacterState：Run 1 delta=7.4%（显著）→ Run 2 delta=3.7%（不显著）
   - CanonState/PromiseLedger/PatternMemory：两轮方向不一致
3. **实验范围限制**：所有实验均为工具决策 replay（使用模拟状态），非完整 `ContextCompiler -> runUnifiedPipeline` 生产链路验证

### 冻结范围

| 项目 | 冻结状态 |
|------|---------|
| CanonState 注入 | 保持完整 |
| CharacterState 注入 | 保持完整 |
| PromiseLedger 注入 | 保持完整 |
| PatternMemory 注入 | 保持完整 |
| maxItems 24-48 / 摘要 160 字符 | 不调整 |
| 生产 release pointer | `rel-000` 不变 |
| 工具集 | 9 专用工具不变 |
| canary | 不切换 |

### 提交记录

| 提交 | 内容 |
|------|------|
| `34bd491` | Phase 6.1a：eval-only runner + dry-run 验证 |
| `dc3ad62` | Phase 6.1b：真实模型 replay 结论 |
| `96cdd5e` | Phase 6.1.1：产物隔离 + 门禁修复 + 实验范围声明 |
| `06ac1f6` | Phase 6.1.1：两次 replay 对比结论 |
| `da1e9f2` | Phase 6.2：逐类单因素消融变体 + gate 模块提取 |
| `1a917b8` | Phase 6.2：消融结论 |
| `2aaf3ea` | Phase 6.2.1：evaluateAblationGate 共享 + 原始 entry + 消融 arm 测试 + 结论降级 |
| `96d423e` | Phase 6.2.1：confirmation replay 两轮不一致结论 |
| 本次提交 | Phase 6 冻结决策记录 |

### 后续

Phase 6 冻结。下一研究模块：**思考/推理预算设计**（eval-only A/B，不触碰生产链路）。

---

## 15. 上下文压缩/记忆层研究 — Gemini 冻结基线口径（2026-08-11）

> **状态**：**研究重启并锁定对照口径**。上文的 Phase 6 冻结决策（GLM 5.2 两轮消融无稳定显著差）基于 `narrator_testing_glm` 路由与独立 `buildContextBlock` 路径，**不构成**以 Gemini 生产路由为基线的压缩结论的依据。本节重建以 A 组冻结基线为准的对照口径。

### 15.1 对照基线（A 组冻结，唯一参照）

真实 Gemini replay，`reports/phase4-tool-ab-real-gemini/`，route=`v2_rawstage2_gemini31`，provider=gemini31，model=gemini-3.1-pro-preview，temperature=0.72，maxTokens=2048，`gemini_validation` cost profile，`DISABLE_FALLBACK=1`，场景 SC1/SC6/SC7 × seed 0/1，共 6 arm 样本。

| 指标 | 冻结值 |
|------|--------|
| schemaTokenCost | 9208 |
| mustVerify（avgCoverageRatio） | 0.667 |
| sourceRefCompleteness | 0.400 |
| emptyResults | 3 |
| errors | 3 |
| timeouts | 3 |
| stopRate | 0.500（3/6） |
| truncatedResults | 0 |
| invalidToolSelections | 0 |
| parseErrors | 0 |
| evidenceLevelCounts | confirmed_state=2, exact_chapter_span=2 |
| firstValidEvidenceLatencyMs | 2 |

### 15.2 研究红线（不可违反）

1. **所有压缩方案必须与 A 组冻结基线做同模型、同 seed、同场景对照**。不得以历史 stub 基线（`tool-interface-baseline.json` 2026-08-07，零模型调用确定性 stub）或跨模型结果（GLM 5.2）替代对照。
2. **任一冻结指标不劣化方可通过**：schemaTokenCost / mustVerify / sourceRef / empty / errors / timeouts / stopRate。
3. **生产注入路径才是对照路径**：生产长期状态经 `buildHistoricalContext` 的 `boundedEntries` 输出注入（`historicalContinuity` 4×2400 字符、`historicalCharacterState` 6×1800、`recentPatternMemory` 4×1000）。独立 `buildContextBlock`（`compressed-context-builder.ts`）仅作 eval 参考，**不得**作为生产注入等价物。
4. **schemaTokenCost 与状态注入正交**：`schemaTokenCost=9208` 是工具 schema 注入成本（`estimateSystemPromptTokens × turns.length`），压缩候选（针对状态注入）不改变它；压缩研究的收益度量是 `contextBlockTokens`，质量底线是 mustVerify/sourceRef/empty/errors/timeouts/stopRate。

### 15.3 现状与可压缩热点（已盘点）

- 注入链路：`ContextCompiler.compile → deriveLongTermState → retrieveNarrativeContext(JIT) → LongTermStateSnapshot → buildRawPrompt → buildChapterContract → buildHistoricalContext`。
- 真实存量（xinmo ch21）：character=125（生产仅注入 6 条相关）、pattern=89（注入 4 条）、canon=17、promise=14、planned=490（不注入 prompt，仅 trace）、expectation=0。
- 热点：character 冗余最高（125→6），pattern 次之（89→4）；压缩空间集中在「低相关度条目保留策略 + 摘要长度」。
- B 组压缩参数（maxItems 24 + 摘要 80 + 排 Pattern）曾在 GLM 历史报告 token 降 38% 且覆盖不降级——但**模型与路径均不符合本节口径，需重跑确认**。

### 15.4 B 方案真实 Gemini replay 结果（2026-08-11）— B 不通过，保持 A 基线

**执行口径**：`scripts/context-ab-replay.mjs`，`reports/phase6-context-ab/real/context-ab-comparison.json`，route=`v2_rawstage2_gemini31`（Gemini 3.1 Pro Preview），temperature=0.72，maxTokens=2048，`DISABLE_FALLBACK=1`，SC1/SC6/SC7 × seed 0/1 共 6 样本，工具面固定 A 组 9 专用工具，唯一变量为长期状态注入压缩；走生产 `buildHistoricalContext`（`boundedEntries`）注入路径。

**B 组压缩参数**（`HistoricalContextOverrides`，生产默认不传）：canon `2×1200`（生产 4×2400）、character `3×900`（生产 6×1800）、pattern `inject:false`（生产 4×1000）。C 组为哨兵 `null` 不注入。

**压缩收益（contextBlockTokens，与 schemaTokenCost 正交）**：

| 指标（跨 6 样本合计） | A（完整） | B（压缩） | 变化 |
|------|--------|--------|------|
| contextBlockTokens | 386 | 250 | **-35.2%** |
| 平均条目数 itemCount | 2.33 | 1.33 | -42.9% |
| schemaTokenCost（工具 schema，与本轮正交） | 14963 | 11510 | 不列为收益 |

**质量指标同场景/同 seed 对照（任一劣化则 B 不通过）**：

| 指标 | A | B | 判定 |
|------|-----|-----|------|
| mustVerify avgCoverage | 1.000 | **0.833** | ❌ 劣化 |
| sourceRef avgCompleteness | 0.667 | **0.500** | ❌ 劣化 |
| empty / errors / timeouts | 0 / 0 / 0 | 0 / 0 / 0 | ✅ 未劣化 |
| stopRate | 1.000 | 1.000 | ✅ 持平 |
| bGate allPassed | — | **false** | ❌ 不通过 |

**跨 seed 不稳定（决定性失败）**：SC1-canon-fact seed1 下，A coverage=1 / sourceRef=1，B **coverage=0 / sourceRef=0**（其余 5 样本 B 均 coverage=1）。压缩后同一场景在 seed1 完全丢失证据覆盖，违反"结果跨 seed 不稳定则保持 A 基线"红线。

**结论**：
1. **B 不通过**：`coverageGteA=false`（0.833 < 1.0）、`sourceRefGteA=false`（0.5 < 0.667），且 SC1:s1:B coverage=0 跨 seed 不稳定；`bGate.allPassed=false`。
2. **保持 A 基线**：不进入生产，不切 canary，不改 production pointer；生产 ContextCompiler 参数未改动。
3. **不可归因于单一因素**：B 同时改变 maxItems、摘要长度并排除 PatternMemory，属组合方案；虽 token 降 35.2%，但质量劣化，**不能**据此得出"PatternMemory 应排除"的结论。后续如需继续，应先做**单因素消融**（分别消融 maxItems、摘要长度、PatternMemory 影响），并扩大 seed 数验证稳定性，才能区分各因素贡献。
4. **C 组（无状态注入）参考**：coverage=1.0、sourceRef=0.667，token 降到 138（-64.2%），`marginalValueInsufficient=true`——样本内不注入长期状态在本次 6 样本下未现覆盖损失，但样本量小不足以支撑"删减长期状态"的结论，仅作参考，不改变生产保持完整注入的冻结决策。
