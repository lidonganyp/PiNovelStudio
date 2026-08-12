# PiNovelStudio Agentic 证据决策合并开发计划

**任务编号**：AGENTIC-EVIDENCE-MERGE-1  
**版本**：v1.0  
**日期**：2026-08-11  
**决策**：采用方案 A，将独立 `EvidenceDecision` 模型回合合并到 NovelOS Agentic 首轮  
**状态**：实现完成；9 章独立快照对照已完成，检索路径、coverage 负例及 envelope 级恢复样本 trace 待补齐（2026-08-12；build / typecheck / test / test:eval 全部通过；9 章独立快照真实 replay：8/9 成功、1 阻断（story_preservation hard block）、零 preflight 级联、EvidenceDecision 调用 0、trace 留存 9/9、未分类失败 0、mustVerify 覆盖 64/64（100%）、事实硬错误 0；成功章节模型调用 2-3 次；运行时出现 2 次底层 HTTP 重试（524/520）均自动恢复成功。已确认 ch1 正收益：模型调用 4→2（−50%）、输入 token 9,000→5,738（−36.2%）、延迟 199.5s→179.2s（−10.2%）。注意：独立快照为改造后运行形态，改造前基线为串行形态，严格同形态对照需在改造前代码跑独立快照）
**适用范围**：统一生产主链路 `novel_generate_chapter → NovelOS Agentic`  

## 1. 背景与问题

当前生产链路在 NovelOS Agentic 正式运行前，固定执行一次独立的 `novelos_evidence_decision` 模型调用，用于判断未知点、工具选择、检索 query 与检索深度。

真实 trace 表明，该回合存在两类问题：

1. 它每章固定发生，重复传入较大的意图与种子上下文，是当前显著的 token 和延迟成本；9 章基线中约占总 token 的 29.7%。
2. 结构化 JSON 字段会经过 `llm-language-guard` 中文化，但解析器仍只识别原始英文字段，导致模型决策没有可靠形成可往返协议。当前 `source="model"` 不能证明字段完整、解析有效或决策已被系统实际采纳。

同时，当前 provider 对 `reasoning_effort`、`thinking_budget` 等隐藏推理参数的支持尚未被证明确实有效。因此本任务不引入固定 4096/8192/16384 thinking token，也不把 `thinkingLevel` 当作生产认知预算控制器。

## 2. 目标

将“是否检索、检索什么、何时停止检索、何时开始写正文”的判断合并进 Agentic 自身的首轮及后续 ReAct 循环，取消每章固定的独立 EvidenceDecision 模型调用。

改造后：

- 模型负责基于不确定性决定是否调用已授权的工具；
- 系统负责事实安全、能力边界、调用预算、覆盖校验和事务保存；
- 上下文充分时，Agentic 可直接生成初稿；
- 存在 `mustVerify` 或关键事实不确定时，Agentic 必须先取得可追溯证据；
- 删除独立 EvidenceDecision 生产实现，不保留两套并行版本。

## 3. 非目标

本任务不处理以下内容：

- 不修改作者风格整章优化、StoryPreservation、FinalFactRecheck 或状态提交逻辑；
- 不引入机器文学裁判或 raw fallback；
- 不调整 Gemini/Claude 正文模型路由；
- 不上线固定 thinking token 或未经验证的 provider 隐藏推理参数；
- 不通过降低 `mustVerify`、FactGuard 或 coverage gate 换取成功率和成本下降；
- 不把模型原始思维链写入 trace、few-shot 或长期记忆。

## 4. 目标架构

```text
ChapterIntent + CompiledContext
  → 系统创建安全 EvidencePlan
       - known
       - mustVerify
       - systemAllowedTools
       - stopConditions
       - 系统检索预算上限
  → 创建受限 NovelOS Runtime
       - 只注入 systemAllowedTools 内的工具
       - 系统强制工具调用上限
  → Agentic 首轮自主判断
       - 上下文充分：直接生成正文
       - 存在不确定性：调用工具检索
       - 证据冲突/不足：在预算内继续检索
       - 证据充分：停止检索并生成正文
  → MustVerifyCoverageGate
  → Agentic FactGuard / verify-patch
  → 作者风格整章优化及后续统一主链路
```

职责边界：

| 决策 | 权威 |
|---|---|
| 是否主动检索、先查什么、使用哪个可见工具 | Agentic |
| 可见工具集合 | 系统 |
| `mustVerify` 内容及不可删除性 | 系统 |
| 最大检索调用次数、总调用预算、超时 | 系统 |
| 检索结果是否覆盖必须验证项 | CoverageGate |
| 事实、实体、时间线和世界观是否可交付 | FactGuard / FinalFactRecheck |
| 状态提交和章节保存 | 系统事务 |

## 5. 实施任务

### 5.1 先建立 RED 测试

在修改生产代码前，新增或改写测试以固定目标行为：

1. 一章生成不得出现 `kind="novelos_evidence_decision"` 的模型调用。
2. Agentic 首轮可以在同一循环内二选一：直接产出正文，或先发起工具调用。
3. `mustVerify` 非空时，即使模型直接写正文，coverage gate 仍会因缺少证据而阻断或触发既有恢复流程。
4. 模型不能调用 `EvidencePlan.allowedTools` 之外的工具。
5. 检索调用达到系统上限后，runtime 必须停止继续调用工具，不依赖 prompt 自觉。
6. 无 `mustVerify`、上下文充分的章节可以零检索成功完成。
7. trace 能区分“直接生成”“检索后生成”“覆盖不足失败”“预算耗尽”四类结果。

优先更新：

- `.pi/extensions/novel-studio/tests/phase2d-evidence-decision.test.mjs`
- Agentic loop、工具边界、coverage gate、trajectory 相关 focused tests
- 生产依赖边界测试，防止独立 EvidenceDecision 再次进入生产闭包

原 `phase2d-evidence-decision.test.mjs` 不应继续证明 `runEvidenceDecisionRound` 已接线；应改为证明独立回合已退役、Agentic 内生决策和系统边界仍然有效。若测试文件名已不再准确，直接重命名或拆分，删除旧测试，不保留新旧语义并行。

### 5.2 把 EvidencePlan 收敛为系统安全计划

修改 `.pi/extensions/novel-studio/novelos/agent/evidence-plan.ts`：

- 保留 `known`、`mustVerify`、`allowedTools`、`stopConditions`；
- 把 `allowedTools` 明确重命名或注释为系统授权边界，禁止再表达“模型选择结果”；
- 移除只服务独立决策回合的 `unknown`、`queries`、`needRetrieval`、`retrievalDepth`，或将仍有必要的字段重构为纯系统预算字段；
- 检索上限由确定性策略生成，不再被不可验证的结构化模型输出降低；
- 当前安全基线可沿用：存在 `mustVerify` 时给中等检索上限，无 `mustVerify` 时仍可保留少量按需检索能力，但不得强迫模型调用；
- `mustVerify`、工具推断与 context 摘要逻辑继续保留并补充单元测试。

建议将预算表达改为直接、可执行的系统字段，例如：

```ts
interface EvidencePlan {
  known: string[];
  mustVerify: string[];
  allowedTools: string[];
  stopConditions: StopConditions;
  retrievalCallLimit: number;
}
```

`retrievalCallLimit` 是系统上限，不是模型必须消耗的配额。Agentic 可以使用 0 到该上限之间的任意调用数。

### 5.3 删除独立 EvidenceDecision 模型回合

修改 `.pi/extensions/novel-studio/novelos/agent/agentic-raw-candidate-source.ts`：

- 删除 `runEvidenceDecisionRound` 调用；
- 删除 `novelos_evidence_decision` 模型调用及其上下文重复传输；
- 直接使用系统创建的 `EvidencePlan` 过滤工具并设置 runtime 检索上限；
- `recordToolVisibility` 中的系统允许工具和最终可见工具继续记录；原 `selectedTools/rejectedTools` 字段应删除、置为不适用，或升级 trace schema，不能伪装成仍有独立模型选择；
- 不新增兼容开关，不保留生产或 eval 双路径。历史对照使用已留存的 baseline trace、报告和提交证据，不继续维护可执行旧实现。

物理删除或移出生产闭包：

- `.pi/extensions/novel-studio/novelos/agent/evidence-decision.ts`
- 对应 import、类型、常量与构建产物引用
- `EVIDENCE_DECISION_KIND`、`EVIDENCE_DECISION_MAX_TOKENS`
- 独立决策 prompt、JSON parser、validation/merge 逻辑
- 仅服务该回合的测试和文档陈述

按照版本收敛原则，独立 EvidenceDecision 的可执行实现应物理删除；历史研究结论和 baseline trace 可作为只读证据保留，但不得继续形成另一套可运行基线。`tsconfig.prod.json → dist/` 与 `tsconfig.eval.json → dist-eval/` 均不得传递依赖它。

### 5.4 强化 Agentic 首轮不确定性决策

修改 `.pi/extensions/novel-studio/novelos/agent/narrative-agent-loop.ts`：

- 保留并精简当前“不确定性驱动检索”规则；
- 明确模型可以直接生成，也可以调用可见工具，不要求先输出额外 JSON 计划；
- 注入 `known`：明确这些事实可直接使用，无需重复检索；
- 注入 `mustVerify`：明确正文涉及这些事实前必须取得工具证据；
- 不向模型暴露系统内部 token 数字或固定 thinking budget；
- 不要求模型输出思维过程，只允许输出工具调用或章节草稿；
- 证据冲突时允许在系统预算内继续检索；无进展达到 `maxStagnantRounds` 时停止；
- 不通过强制“至少检索一次”模拟思考深度，是否调用由不确定性决定，安全性由 coverage gate 保证。

### 5.5 调整运行时检索预算

当前 `retrievalDepth → 0/2/4/6 次` 的预算映射来自独立决策输出。删除该输出后，改为系统风险预算：

| 系统风险状态 | 建议调用上限 |
|---|---:|
| 无 `mustVerify`，上下文摘要完整 | 2 |
| 存在 `mustVerify` | 4 |
| 多个关键状态、伏笔或 bridge context 缺失/冲突 | 6 |

要求：

- 数值是上限，不是必须调用次数；
- 风险判定必须来自结构化输入和确定性代码，不新增一次 LLM 决策；
- 单次调用、章节总调用和超时仍受现有 BudgetPolicy/HARD budget 控制；
- 达到上限后必须产生结构化 stop reason 或 FailureEnvelope，禁止无限循环或 silent degrade；
- 若现有数据不足以支持三级风险分类，首版可先采用保守的 `mustVerify ? 4 : 2`，后续用真实 replay 再调整。

### 5.6 升级 trace 与可观测性

删除“独立决策成功”的误导性口径，新增 Agentic 实际行为证据：

- `decisionMode: "agentic_inline"`
- `firstAction: "draft" | "tool_call"`
- `systemAllowedTools`
- `visibleTools`
- `retrievalCallLimit`
- `actualRetrievalCalls`
- `mustVerifyCount`
- `mustVerifyCoveredCount`
- `stopReason`
- `coverageResult`
- `modelCallsByKind`

要求：

- 不记录原始思维链；
- trace 只能根据实际工具调用和 gate 结果断言“模型进行了检索”；
- 禁止仅因模型返回可解析文本就标记为“决策已应用”；
- 旧 `context_decision` 若继续保留，应改为记录系统计划与 Agentic 实际行为摘要；否则删除该 entry type，使用语义准确的新事件名。

### 5.7 清理语言保护层相关耦合

本方案取消独立 JSON 决策协议，因此无需为该协议建立英文字段往返映射。但仍需新增回归测试，确保：

- 机器工具 schema 和 tool-call parser 的字段协议不会被 `llm-language-guard` 破坏；
- Agentic 工具调用能被稳定解析和执行；
- 语言保护层不再把不可解析的输出静默标记为有效决策。

不要为保留已退役 EvidenceDecision 而扩大语言保护层复杂度。

### 5.8 文档与版本收敛

同步更新以下文档中的当前事实：

- `docs/top-tier-chinese-novel-system-development-plan.md`
- EvidenceDecision prompt inventory、reasoning budget 研究结论及相关阶段文档
- 必要时更新 `docs/project-memory.md`

文档应统一表述为：

> EvidencePlan 由系统建立安全边界；是否检索及检索顺序由 NovelOS Agentic 在同一 ReAct 循环内决定；系统通过工具白名单、调用上限、MustVerifyCoverageGate 和 FactGuard 保证安全。

不得继续写“每章固定一次 EvidenceDecision”“模型先输出检索深度 JSON”或固定 thinking token 已投入生产。

## 6. 测试与验证

### 6.1 自动化验证

至少执行：

```bash
npm run build
npm run typecheck
npm test
npm run test:eval
```

Focused tests 必须覆盖：

- Agentic 直接生成路径；
- Agentic 先检索后生成路径；
- 未授权工具调用被拒绝；
- `mustVerify` 未覆盖时阻断；
- 检索预算耗尽；
- 模型超时与既有 bounded recovery；
- trace schema 和生产依赖闭包；
- `novelos_evidence_decision` 调用数恒为 0。

### 6.2 真实 replay

使用同一批真实 workspace/章节，对改造前基线证据与改造后版本进行对照。评测至少覆盖 9 章，并包含：

- 无关键验证点的普通章节；
- 多角色状态变化章节；
- PromiseLedger 推进章节；
- bridge context 不完整或需要跨章检索的章节；
- 事实冲突或检索结果不足的负例。

采集指标：

| 指标 | 验收方向 |
|---|---|
| 独立 EvidenceDecision 调用数 | 必须为 0 |
| 章节总模型调用数 | 不高于基线，正常章节应减少 1 次 |
| 总输入 token | 明显下降；不得因把完整决策 prompt 塞入 Agentic 而抵消收益 |
| 总延迟 | 下降或不劣化 |
| `mustVerify` 覆盖率 | 不低于基线，目标 100% |
| 事实硬错误 | 不增加，目标 0 |
| 无关检索比例 | 不高于基线 |
| 零检索成功章节占比 | 可观测且符合上下文充分场景 |
| 自动恢复后成功率 | 继续满足项目稳定性门槛 ≥85% |
| 未分类失败 | 0 |
| trace 留存率 | 100% |

文学质量不由本任务中的机器 judge 决定。改造后的章节仍走作者风格整章优化，最终文学评价由用户或真人盲评完成；至少确认故事保持率与人工偏好没有明显下降。

## 7. 验收标准

只有同时满足以下条件，任务才可判定完成：

1. 生产代码不再调用 `runEvidenceDecisionRound`，生产 trace 中 `novelos_evidence_decision` 调用数为 0。
2. `EvidenceDecision` 旧可执行实现已物理删除，`dist/` 与 `dist-eval/` 均不包含其运行时依赖。
3. Agentic 可在首轮自主选择直接生成或调用系统授权工具。
4. `mustVerify`、工具白名单、检索调用上限、coverage gate、FactGuard 均继续由系统强制。
5. 不存在固定 thinking token 配置进入生产的改动。
6. build、typecheck、生产测试、eval 测试全部通过。
7. 真实 replay 中事实硬错误不增加、`mustVerify` 覆盖不下降、未分类失败为 0。
8. 正常章节模型调用减少 1 次，整体 token/延迟获得可测量正收益。
9. trace 能解释 Agentic 实际采取了什么动作，且不记录原始思维链。
10. 相关文档已更新为单一最新版本，不再把独立 EvidenceDecision 描述为生产阶段。

## 8. 实施顺序与提交建议

建议按以下顺序开发，避免一次性大改难以定位回归：

1. **RED：测试和 trace 契约**——先证明当前仍会调用独立决策回合。
2. **EvidencePlan 系统化**——建立确定性的工具边界和调用上限。
3. **Agentic 合并**——删除独立调用，首轮直接进入 ReAct。
4. **可观测性升级**——记录实际首动作、调用数和 coverage。
5. **物理清理**——删除旧模块、旧测试、旧类型和生产构建引用。
6. **自动化验证**——build/typecheck/test/eval。
7. **真实 replay**——验证成本、稳定性、事实安全与故事保持。
8. **文档收敛**——更新架构真相源和项目记忆。

每一步提交前必须检查 `git diff`，不得覆盖当前工作树中用户正在进行的其他修改；不要处理、暂存或清理与本任务无关的脏文件和 stash。

## 9. 开发完成后的交付物

- 生产实现与相关类型清理；
- 更新后的自动化测试；
- 生产依赖边界证明；
- 真实 replay 原始矩阵与摘要；
- token、延迟、调用数、覆盖率和失败分类对照表；
- 至少一条成功直接生成 trace、一条检索后生成 trace、一条覆盖不足负例 trace；
- 更新后的架构文档与项目记忆；
- 简短实施说明：删除了什么、保留了哪些系统安全边界、实际获得了多少正收益。
