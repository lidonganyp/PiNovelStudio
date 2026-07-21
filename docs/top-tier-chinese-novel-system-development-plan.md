# PiNovelStudio 顶尖中文长篇小说生成系统完整开发计划

**版本**：v1.1
**日期**：2026-07-14
**状态**：目标架构与迁移实施基线
**取代范围**：`quality_amplifier_v2` 试验性双链路设计、Stage0-8 运行时主架构、机械 comparator 主裁判
**控制平面调研**：`docs/open-source-coding-agent-constraint-research-and-adoption-plan.md`
**当前可用执行状态真相源**：`docs/remaining-development-dispatch-plan-20260715.md`；历史引用的 `docs/current-quality-development-task-list.md` 当前不在工作区，不得继续作为可读取真相源
**系统版本治理真相源**：`docs/evolution-release-governance-development-plan.md`；负责进化环境冻结、候选审批、晋级、回滚与正式使用反馈边界
**文档收尾边界**：本次未提交的文档收尾未改运行代码；历史工程提交按其实际文件范围记录，不归类为纯文档交付

## 1. 目标与成功定义

PiNovelStudio 的目标不是让正文通过更多检查，而是：

> 在同一基础模型、同一作品资料、相近 token 预算下，系统最终选择并交付的正文应优于该模型的 raw 自由生成；同时系统不压制未来更强模型的能力，并能从用户选择和真实使用反馈中持续调整编辑策略。

系统成功分为四层，不能互相替代：

1. **可创作**：能够生成事实正确、上下文连续的完整章节。
2. **可放大**：在存在明确编辑机会时，能够产生优于 raw 的候选。
3. **可识别**：能够可靠识别候选是否真正优于 raw；判断不清时保留 raw。
4. **可进化**：能够根据用户选择、改稿和模型版本变化，调整策略的调用概率与信誉，而不是不断向 prompt 追加规则。

现阶段证据已经支持架构决策：legacy full-chain 的真人评分明显低于 raw 与最佳 amplified，因此不再继续维护两套正文生成主链路。现有证据不用于宣称“稳定达到顶尖质量”，只用于决定架构收敛方向。

## 2. 核心设计原则

### 2.1 LLM 与代码的职责边界

LLM 负责：

- 创作正文；
- 发现高价值编辑机会；
- 形成不同的编辑假设；
- 比较候选的文学效果；
- 解释胜负并引用正文证据。

代码负责：

- 长期状态、上下文检索与来源追踪；
- 事实、实体、时间线和连续性硬约束；
- 候选匿名化、顺序随机化和裁判协议执行；
- 超时、重试、事务、trace 和原子保存；
- 策略信誉、反馈学习和模型版本隔离；
- 在证据不足时保护 raw。

代码不负责用词频、段落比例、固定阈值或机械总分决定文学优劣。

### 2.1.1 作者内容契约与表达自由

正文模型必须获得：整体剧情方向、章节功能、前文真实状态、人物动机、待推进伏笔与承诺、因果关系、不可违背事实和章末目标。

正文模型自行决定：如何开头、使用什么感官、词汇、句式、修辞、对白、段落节奏和具体场景表达。感知锚点、风格指纹、声音指纹、Few-shot、prompt pattern、情绪节拍和结构扫描不得作为 raw 的正文执行指令；它们只可用于 trace、诊断、实验或候选比较证据。

运行时由 `v2/core/methodology-policy.ts` 对方法论条目标注 `authority / role / enforcement`。作者内容和已接受事实可以进入 `generation_context / hard_boundary`；场景解法与工艺策略只能进入 `candidate_only`；文学扫描只能进入 `review_only`；感官、句式、对白比例和段落模板等正文执行启发式从 raw 排除。每章 trace 必须记录 `stageResults.methodologyPolicy` 与 `stageResults.rawPromptConstraintAudit`，出现权限越界或机械正文控制时在模型调用前 fail closed。

`CreativeConstitution` 进入 raw 的字段限于作品身份、读者承诺、类型承诺、主角核心冲突、长期主题问题和禁止偏离。`aestheticDirection` 与自动学习的表达偏好不直接进入 raw，避免把作品审美退化成固定写法。

一次跨章序列偏好不得外推为所有章节的生产规则。每个候选都必须基于本章 raw 的可引用机会产生，并在本章独立比较；缺少自然人对齐的文学选择权威时保留 raw。

raw 通过事实守卫后，`CraftPhenomenonReport` 才可使用方法论工艺知识。报告按章节相关性覆盖对话、节奏与高潮、连载预期、类型契约、配角、世界观揭示、群像、收尾、五维推进和跨章健康十个领域；结论只允许 `observed / uncertain / not_applicable`，`observed / uncertain` 必须引用 raw 中逐字存在的 span。报告不得进入 raw prompt、不得给文学总分、不得直接改文或选择 winner。

跨章诊断使用只读 `MethodologyDiagnosticState`，从作品声明、已接受叙事状态、疲劳状态、世界揭示计划和 arc registry 中提取紧凑且带来源的先前状态。它只在 raw 通过 FactGuard 后加载，不进入 raw prompt，不读取目标章之后的信息，也不能独立授权 candidate。`cross_chapter_health` 的现象或机会除 raw span 外还必须引用本次快照中实际存在的 `sourceRef`；缺失或伪造引用时拒绝该条诊断。

`EditorialOpportunityJudge` 在同一次 post-raw 结构化判断中生成工艺报告和至多两个编辑机会。JSON 解析失败时最多追加一次 schema-only 修复调用，不允许因 schema 错误重写正文。普通 editorial candidate 跟随本章显式 writer family：默认 Gemini 使用 `v2_amplified_gemini31`，显式 Claude 使用 `v2_amplified`；中文自然度的受限 span 校准继续使用独立校准路由。

### 2.2 单一主链路

系统最终只保留 `novel_generate_chapter` 一个公开入口和一套运行时编排。不再存在 `legacy | quality_amplifier_v2` 两种生成模式，也不再保留章节白名单。

raw 不是另一条旧链路，而是新主链路内部的原生基线和安全回退。

### 2.3 机会驱动，而非固定多候选

每章先生成一份 raw。编辑诊断只有在能指出具体、高价值、可引用正文证明的改进机会时，才生成额外候选。

- 无明确机会：直接交付 raw，不消耗额外创作 token。
- 有一个主要机会：生成一个 editorial candidate。
- 有两个互不兼容且都值得尝试的机会：最多生成两个 editorial candidates。
- 默认禁止固定生成四到五个变体。

### 2.4 选择优先于改写

任何改写都必须成为候选。除事实性硬修复外，不允许直接覆盖正文。句段修复也必须经过原句/修订句 A/B 判断。

### 2.5 作品目标高于通用规则

系统必须优化“这一本书想成为什么”，而不是把所有作品优化成同一种流畅网文。作品级审美、类型承诺和人物核心矛盾由 `CreativeConstitution` 表达。

### 2.6 约束必须分层，不能全部依赖 prompt 自觉

借鉴 Codex CLI、OpenCode、Gemini CLI 等 Agent harness，系统把控制拆成五层：

1. **创作指令层**：作品目标、章卡、当前创作任务；允许模型进行文学判断。
2. **硬约束层**：不可破坏事实、知识边界、连续性和状态提交规则；由统一 `ConstraintManifest` 表达。
3. **能力层**：模型路由、文件写入、状态提交、artifact 导出等能力由 `CapabilityPolicy` 授权，不允许正文模型自行改变。
4. **上下文生命周期层**：窗口、输出预留、检索、去重、淘汰、压缩、回源和溢出恢复由代码执行。
5. **验证层**：FactGuard、FinalFactRecheck、trace、人工审阅与反向验证共同证明约束生效。

文学建议继续保持 soft/advisory；P0/P1 硬约束不得因上下文预算被静默降权或删除。

### 2.7 原始证据与工作上下文分离

长期正文、状态事件、质量报告和大工具输出必须保留可回源原件；进入模型窗口的是经过预算编译的工作集，而不是全量原文或不可审计的摘要。

任何裁剪、合并、压缩都必须报告：保留项、删除项、合并项、截断项、理由和回源引用。

## 3. 目标运行时架构

```text
novel_generate_chapter
  -> NovelTaskPacket + CapabilityPolicy
  -> Preflight + WorkspaceContextLoader
  -> CreativeConstitution + NarrativeStateStore
  -> ContextLifecycleManager
       -> ConstraintManifest
       -> ContextCompiler / Retrieval
       -> Budget + Dedupe + Drop Audit
  -> ChapterIntentBuilder
  -> RawCandidateGenerator
  -> FactAndContinuityGuard
  -> EditorialOpportunityJudge
       -> CraftPhenomenonReport(10 domains, span-backed, advisory-only)
       -> schema-only repair(max 1, no prose rewrite)
       -> no_op: raw
       -> 1-2 EditorialHypotheses
  -> EditorialCandidateGenerator(current writer family; Gemini default)
  -> FactAndContinuityGuard(all candidates)
  -> LanguageRiskAnalyzer(all candidates)
  -> PairwiseLiteraryJudge
  -> SelectionPolicy
       -> clear amplified win: amplified
       -> unclear/conflict/regression: raw
  -> optional SpanRepairCandidate
  -> FinalFactRecheck
  -> ChapterProxyApproval(gpt5.6-sol)
       -> clear: proxy_approved_draft
       -> hold: 不提交状态，等待重生成/诊断
  -> UserRevisionOrAcceptance(proxy_approved_draft)
  -> FinalFactRecheck(user_final_text)
  -> FinalStateCommit(user_confirmed_text)
  -> AtomicChapterSave + Trace + Checkpoint + ReviewPacket
```

正式使用时默认只向用户提交一份 `gpt5.6-sol` 代理审批稿及摘要，不要求用户常规评选 raw/editorial 多候选。raw 与其他候选保留为可展开审计证据。代理审批稿只是 pending checkpoint；用户修改或确认后的版本重新通过最终事实复检后，才能提交长期状态、写入正式章节并成为下一章 frontier。

`direct baseline`、大规模 replay 和 legacy full-chain 只存在于离线诊断工具，不进入每章正常生成成本。

### 3.1 Novel Agent Control Plane

控制平面不写正文，不替代文学判断，负责让模型在明确边界内可靠工作：

- `NovelTaskPacket`：任务目标、范围、模型锁、允许资源、验收、恢复和汇报契约。
- `CapabilityPolicy`：生成、判断、状态读写、章节保存、模型调用和 artifact 导出的运行时授权。
- `ConstraintManifest`：P0 硬事实/知识边界、P1 作者章节契约与本章相关连续状态、P2 读者体验方向、P3 未选中的全局状态/创作参考、P4 advisory 的统一真相源。
- `ContextLifecycleManager`：模型窗口、输出预留、token 估算、JIT 检索、语义去重、优先级淘汰、压缩回源、overflow recompile。
- `EvidenceStore/Checkpoint`：原始证据外置保存，工作上下文只保留高信号摘要与稳定引用。

控制平面详细来源、差距和迁移路线见 `docs/open-source-coding-agent-constraint-research-and-adoption-plan.md`。

## 4. 核心领域模型

### 4.1 CreativeConstitution

路径建议：`workspaces/{id}/creative-constitution.json`

```ts
interface CreativeConstitution {
  schemaVersion: number;
  workIdentity: string;
  readerPromise: string[];
  genrePromises: string[];
  protagonistCoreConflict: string;
  thematicQuestions: string[];
  aestheticDirection: string[];
  forbiddenDrift: string[];
  narrativePreferences: Array<{
    id: string;
    preference: string;
    rationale?: string;
    evidenceSource: "user" | "accepted_revision" | "imported";
  }>;
  updatedAt: string;
}
```

要求：

- 只表达作品身份、审美方向和取舍，不写句式配额。
- 用户明确要求优先级最高。
- 自动学习不得修改 `readerPromise`、`protagonistCoreConflict` 等核心字段，只能提出 proposal。

### 4.2 NarrativeStateStore

必须覆盖四种状态：

- `CanonState`：世界事实、时间线、地点、实体身份、能力规则；
- `CharacterState`：欲望、恐惧、关系、知识边界、能力代价、未完成选择；
- `PromiseLedger`：伏笔、读者期待、承诺、预计兑现窗口、当前热度；
- `PatternMemory`：近期重复桥段、意象、句式风险、冲突解决方式和章末钩子类型。

每条状态必须包含来源章节、原文 span 或生成产物引用、置信度和最后更新时间。状态只能在最终正文选定后提交。

### 4.3 ChapterIntent

`ChapterIntent` 是创作方向，不是章纲或句子清单：

```ts
interface ChapterIntent {
  chapterFunction: string;
  overallPlotDirection: string[];
  previousState: string[];
  characterMotivations: Array<{ character: string; motivation: string }>;
  foreshadowing: string[];
  causalRelations: string[];
  endingTarget: string[];
  authorEventSummaries: string[];
  authorMustInclude: string[];
  authorStateChanges: string[];
  readerExperience: string[];
  currentPressure: string[];
  meaningfulChoices: string[];
  promisesToAdvance: string[];
  possibleEndPressure: string[];
  relevantCharacters: string[];
  inviolableFacts: string[];
  sourceRefs: string[];
}
```

`ChapterIntent` 只描述作者要求发生什么和不得违背什么，不描述正文如何写。相关角色按本章作者契约筛选，不得把作品内全部存活角色默认视为本章参与者。

### 4.4 EditorialHypothesis

```ts
interface EditorialHypothesis {
  id: string;
  opportunityType:
    | "reader_payoff"
    | "character_choice"
    | "relationship_progress"
    | "information_dramatization"
    | "promise_advancement"
    | "ensemble_function"
    | "chapter_end_pressure"
    | "voice_and_naturalness";
  diagnosis: string;
  evidenceSpans: TextSpan[];
  expectedReaderGain: string;
  damageRisks: string[];
  rewriteScope: "chapter_candidate" | "event_candidate" | "span_candidate";
  confidence: number;
}
```

只有包含真实 span、明确读者增益和损伤风险的 hypothesis 才能触发候选生成。

### 4.5 JudgeVerdict

```ts
interface JudgeVerdict {
  winner: "A" | "B" | "tie";
  confidence: "clear" | "slight" | "uncertain";
  decisiveReasons: Array<{
    dimension: string;
    betterCandidate: "A" | "B" | "neither";
    evidenceA: TextSpan[];
    evidenceB: TextSpan[];
    explanation: string;
  }>;
  factualRisks: string[];
  regressionRisks: string[];
  constitutionAlignment: string;
}
```

## 5. LLM 文学裁判设计

### 5.1 为什么使用 LLM

文学质量涉及因果、期待、角色选择、语气、情绪兑现和读者感受，不能被词频与固定公式可靠表示。机械检测只能识别局部事实和已知风险。

### 5.2 裁判协议

1. 候选匿名为 A/B，不暴露模型、route、raw/amplified 身份。
2. 先独立阅读作品宪法、章节意图和必要上下文，再阅读候选。
3. 不允许绝对打分决定胜负，必须直接比较。
4. 所有负面判断必须引用正文 span。
5. 必须判断“差异是否足以值得替换 raw”，而不只是哪个更工整。
6. 必须特别保护粗粝但鲜活的对白、节奏和人物声音，避免偏爱规整文本。
7. 允许 `tie/uncertain`，该结果默认保留 raw。

### 5.3 偏差控制

默认一次主裁判，只有以下情况才进行第二次反向复判：

- 主裁判输出 `slight` 或 `uncertain`；
- 候选包含不同事实风险；
- 主裁判理由没有有效 span；
- 主裁判建议 amplified，但机械退化检查发现明确损伤。

反向复判交换 A/B 顺序。两次冲突时保留 raw；高价值章节可配置异构仲裁模型。

### 5.4 机械检查的最终定位

保留：

- 空文、乱码、截断、大段重复；
- 实体幻觉、世界观硬冲突、时间线矛盾；
- 严重场景连续性断裂；
- 明确丢失关键事件、关键人物或用户显式要求；
- 可定位的中文表达风险。

降为证据，不参与文学总分：

- AI 腔、翻译腔、段落节奏、钩子、群像、信息密度、主动性；
- 当前 11 维 comparator 分数。

删除：

- 11 维等权总分决定 winner；
- `clearWinThreshold=5` 一类总分差门槛；
- 用词命中数量直接代表小说维度质量。

## 6. Legacy 正收益资产迁移

### 6.1 A 类：直接保留为基础设施

- 模型路由、超时、熔断与失败归因；
- workspace preflight；
- trace、FailureEnvelope、原子保存；
- NarrativeState、Skeleton、DetailLedger、ReaderExpectation、伏笔追踪；
- 格式、重复、实体、时间线、世界规则与连续性检测。

### 6.2 B 类：抽成只读证据库

新增 `LanguageRiskLibrary` 和 `CraftEvidenceLibrary`，从 legacy 迁移：

- 中文叙事自然感扫描；
- `resource_negative_is_shortcut`；
- 否定定义链及其误报过滤；
- 英文句法迁移、抽象主语、说明文惯性；
- 对话内排除、具体事物对比排除、情绪认知对比排除；
- 人物声音、群像层次、信息释放、期待兑现和情绪节拍判断。

所有检测返回：`riskId + span + evidence + confidence + suggestedScope`。不得直接改文或阻断非事实性问题。

### 6.3 C 类：退役

- Stage0-8 固定编排；
- 固定对白比例；
- 固定段落长度和悬念密度硬门；
- 风格分不足触发整章重写；
- AI 腔密度作为正文交付硬阈值；
- legacy full-chain 正文加工；
- 多版本运行时开关和白名单。

### 6.4 中文风险的正确处理

以“不是……是/而是……”为例：

1. 本地 scanner 找出 span；
2. 复用 legacy 误报过滤，排除对话、具体方位/物件对比、有效排除法和人物语气；
3. 高置信风险生成一句或一段的 repair candidate；
4. LLM 对比原文与修订文；
5. 修订没有明确胜出则不覆盖。

禁止把该结构作为通用禁词塞入生成 prompt。

## 7. 自进化设计

### 7.1 学习对象

系统学习的是“在何种上下文下，哪种编辑策略值得调用”，不是自动生成新的硬规则。

```ts
interface StrategyPolicyRecord {
  strategyId: string;
  modelFamily: string;
  modelVersion: string;
  genre: string;
  sceneTags: string[];
  attempts: number;
  clearWins: number;
  losses: number;
  ties: number;
  userAccepted: number;
  userRejected: number;
  posterior: { alpha: number; beta: number };
  status: "explore" | "active" | "dormant" | "retired";
  updatedAt: string;
}
```

### 7.2 外部反馈等级

从高到低：

1. 用户最终选择或明确评分；
2. 用户对最终正文的实际修改；
3. 异构 LLM 双裁判一致；
4. 单 LLM 裁判明确胜出；
5. 机械风险指标，仅用于诊断，不作为策略成功证据。

### 7.3 在线学习

使用轻量 contextual bandit/Thompson Sampling：

- 每章最多选择 0-2 个策略；
- 优先尝试在相似场景中有收益的策略；
- 保留少量探索概率；
- 频繁输给 raw 的策略自动进入 dormant；
- 用户反复接受的策略提高概率；
- 不自动修改作品宪法和事实规则。

### 7.4 模型升级处理

模型版本变化时：

- raw 自动反映新模型能力；
- 旧策略统计按模型族与版本隔离；
- 同模型族小版本继承衰减后的先验；
- 跨模型族不继承胜率，只继承策略定义；
- 旧策略重新进入 explore，而不是继续作为强制项；
- 机械检测规则保持可用，但不得因此扩大生成约束。

这保证模型越强，系统不会因历史规则锁死其能力。

## 8. 成本控制

正常章节预算：

- raw 生成：1 次；
- 编辑机会判断：1 次低温结构化调用；
- editorial 生成：0-2 次，仅有明确机会时调用；
- 主裁判：0-2 次两两比较；
- span repair：按需，默认 0 次。

成本策略：

- raw 已明显满足章节意图时提前结束；
- 编辑机会置信度不足时不生成候选；
- 本地事实检查失败时不调用文学裁判；
- 裁判 `clear` 且证据有效时不复判；
- direct/legacy baseline 不进入日常生成；
- trace 保存裁判结果，重复内容不重新调用。

## 9. 分阶段实施计划

### Phase 0：治理文档与冻结边界

目标：在代码迁移前阻止新功能继续进入 Stage0-8。

修改：

- 更新根 `AGENTS.md`：V2 原则升级为单主链路目标；删除“Stage0-8 必须执行”的冲突铁律；保留 `novel_generate_chapter` 唯一入口。
- 将 `docs/quality-amplifier-v2-design.md` 标为历史设计（已于 HISTORY-RETIREMENT-1 删除），本文件为新真相源。
- 新增迁移 feature flag 仅用于开发回滚，不暴露为长期产品模式：`PINOVEL_UNIFIED_PIPELINE=1`。

验收：文档不再同时要求 V2 和 Stage0-8 都是主架构。

### Phase 1：领域模型与状态边界

新增：

- `core/creative-constitution.ts`
- `core/chapter-intent-builder.ts`
- `core/editorial-hypothesis.ts`
- `core/judge-types.ts`
- `core/final-state-commit.ts`

改造：

- `context-compiler.ts` 按事实、作品宪法、长期状态、风格参考和候选经验分层；
- 所有条目带 sourceRef；
- 状态写入全部延迟到 final selection 之后。

测试：schema、来源追踪、缺失输入、候选切换后状态只来自最终正文。

退出条件：相同输入编译结果稳定；任何候选生成都不能提前污染长期状态。

### Phase 2：Legacy 资产抽取

新增：

- `core/language-risk-library.ts`
- `core/fact-continuity-guard.ts`
- `adapters/legacy-language-risk-adapter.ts`
- `adapters/legacy-state-adapter.ts`

迁移首批资产：

- `resource_negative_is_shortcut` 及误报过滤；
- 否定定义链；
- 中文叙事自然感 scanner；
- format/duplicate/entity/continuity/world conflict；
- skeleton/detail/expectation/state commit。

要求：检测结果必须带 span；软风险不得 hard block；不得复制简化词表替代真实实现。

测试：用现有 ch5/ch8/ch17 候选作零模型 fixture，验证风险定位和误报过滤。

退出条件：V2 能调用真实资产；`legacy-diagnostics-adapter` 中的简化 stub 不再承担生产职责。

### Phase 3：机会驱动候选生成

新增：

- `core/editorial-opportunity-judge.ts`
- `core/editorial-strategy-registry.ts`
- `core/editorial-candidate-generator.ts`

替换：

- 固定 `phase_d_amplified/editorial_amplified` 类型改为 `raw` 与 `editorial(strategyId)`；
- `EditorialPlan` 改为读取 raw、章节意图和相关状态，输出 0-2 个 `EditorialHypothesis`；
- hypothesis 必须包含 raw span、预期收益和风险；
- 候选 prompt 只携带一个主要编辑假设，避免目标互相稀释。

测试：无机会返回 no-op；无 span 不生成；最多两个候选；候选不得改变不可侵犯事实。

退出条件：日常链路不会无条件生成多候选。

### Phase 4：LLM Pairwise Judge

新增：

- `core/pairwise-literary-judge.ts`
- `core/judge-prompt-builder.ts`
- `core/judge-evidence-validator.ts`
- `core/judge-arbitrator.ts`

功能：

- 匿名 A/B；
- 随机顺序；
- 结构化 verdict；
- span 强制；
- tie/uncertain；
- 条件反向复判；
- 可选异构仲裁。

替换：

- `CandidateComparator` 降为 `CandidateEvidenceCollector`；
- `FinalSelector` 改为根据 judge verdict、事实检查和 raw fallback 选择；
- 移除机械总分 winner 权限。

离线校准：使用本轮 6 组真人评分作为固定 fixture，检查裁判是否理解已知偏好；不要求新增生成样本，也不把 6 组数据硬编码成规则。

退出条件：无证据负评失效；顺序交换冲突时保留 raw；任何 amplified 交付都有可审计胜因。

### Phase 5：统一编排与单主链路切换

改造：

- `novel_generate_chapter` 默认调用统一编排器；
- 删除 workspace/chapter whitelist；
- 删除 config `generationMode`；
- 删除 V2 `v2NotImplemented -> legacy` 回退；
- V2 内部失败按 `raw -> hard block` 降级；
- raw 有效但编辑/裁判失败时交付 raw 并记录 warning；
- 最终正文选定后统一执行状态提交和原子保存。

迁移期只保留一个短期环境回滚开关，Phase 7 删除。

测试：所有章节走统一入口；非白名单 workspace 可用；编辑层失败仍返回 raw；raw 失败结构化阻断；无 silent legacy fallback。

退出条件：开发默认路径不再执行 Stage0-8 正文加工。

### Phase 6：在线策略学习

新增：

- `learning/strategy-policy-store.ts`
- `learning/strategy-outcome-recorder.ts`
- `learning/contextual-strategy-selector.ts`
- `learning/model-version-migration.ts`
- `learning/user-feedback-ingestor.ts`

功能：

- 记录策略上下文、候选、裁判、最终选择和用户修改；
- Thompson Sampling 选择 0-2 个策略；
- dormant/retired 状态；
- 模型版本隔离与先验衰减；
- 用户反馈高权重；
- 所有自动学习可解释、可撤销。

禁止：自动修改系统 prompt、作品宪法核心字段、硬门禁和世界事实。

退出条件：策略会根据正常写作反馈调整调用概率；新模型不会继承旧模型的虚假高胜率。

### Phase 7：删除旧运行时与命名收敛

删除：

- Stage0-8 正文编排入口与条件分支；
- legacy full-chain 生成候选；
- `quality_amplifier_v2`、`phase_d` 等版本化运行时命名；
- whitelist、双模式 config、短期回滚 flag；
- 简化 diagnostics stub；
- 机械 comparator winner 和旧 acceptance 生产依赖。

保留旧代码前先确认所有 A/B 类资产已有新 owner。历史 replay 脚本可移入 `scripts/archive/`，不得被生产入口引用。

最终命名建议：

- 包：`novel-studio`；
- 内核：`generation/`、`editorial/`、`judgment/`、`state/`、`learning/`；
- 不再出现 V1/V2 的产品概念。

退出条件：只有一个公开生成路径；生产依赖图中不存在旧编排器。

## 10. 测试与验收策略

不再要求高成本持续生成矩阵作为每次开发门槛。采用三层验证：

### 10.1 确定性单元测试

- 状态、schema、来源、事务和降级；
- span 校验、匿名化和顺序随机化；
- 中文风险检测和误报过滤；
- 策略信誉与模型版本迁移；
- raw fallback 和 hard block。

### 10.2 固定正文回归集

使用已有 ch5/ch8/ch17 候选与真人评分，不重新调用生成模型：

- 风险检测是否找到真实问题；
- LLM judge prompt 是否携带正确上下文；
- 裁判输出是否有 span；
- selector 是否在冲突时保护 raw；
- 不把 fixture 的具体答案写入规则。

LLM judge 的回归允许单独运行，不放入每次 `npm test` 的确定性套件。

### 10.3 正常创作中的在线证据

不再为验收专门批量烧 token。每次真实生成自动记录：

- raw 是否直接交付；
- 哪个 hypothesis 被采用；
- candidate 是否胜出；
- 用户是否保留、替换或修改；
- 模型版本和成本。

这些数据用于策略学习与阶段复盘，而不是阻止开发推进。

## 11. 可观测性与质量指标

运行指标：

- rawDirectDeliveryRate；
- editorialOpportunityRate；
- candidateGenerationCount；
- judgeClearWinRate；
- judgeConflictRate；
- rawFallbackRate；
- factHardFailureRate；
- userOverrideRate；
- acceptedCandidateEditDistance；
- costPerDeliveredChapter；
- latencyPerDeliveredChapter。

质量指标以用户行为为最高证据：

- 用户选择 amplified/raw；
- 用户最终改稿幅度；
- 同类问题是否重复出现；
- 伏笔与状态是否跨章正确延续。

禁止用单一“质量总分”作为系统健康度。

## 12. 数据与 Trace

每章 trace 至少记录：

- 模型、版本、route、prompt hash、context hash；
- CreativeConstitution 版本；
- ChapterIntent 与 sourceRefs；
- raw candidate；
- EditorialHypotheses；
- CraftPhenomenonReport、schema repair 次数与被拒绝的无效 span；
- 所有 candidate；
- fact/risk evidence；
- 匿名映射；
- judge verdict 与 span；
- 复判/仲裁结果；
- final selection 和 fallback 原因；
- 最终状态提交摘要；
- token、时延与失败恢复。

用户反馈作为追加事件写入，不覆盖原 trace。

## 13. 实施顺序与依赖

```text
Phase 0 文档治理
  -> Phase 1 状态边界
  -> Phase 2 资产抽取
  -> Phase 3 机会驱动候选
  -> Phase 4 LLM 裁判
  -> Phase 5 单主链路切换
  -> Phase 6 在线学习
  -> Phase 7 删除旧运行时
```

Phase 2 与 Phase 1 可部分并行；Phase 4 可在 Phase 3 输出 schema 稳定后开发。Phase 7 必须最后执行，且删除前完成资产 owner 清单。

## 14. 非目标与防偏规则

本计划不做：

- 追求一个万能文学评分公式；
- 把所有小说经验塞进生成 prompt；
- 自动把每次用户修改升级成全局规则；
- 强迫每章生成固定数量候选；
- 用同一个 LLM 的自我认可证明自进化；
- 为了保留历史投入继续维护双运行时；
- 以测试通过宣称已经产出顶尖小说。

开发过程中任何新需求都应先回答：

1. 它是在帮助模型获得可靠上下文，还是在限制模型如何写？
2. 它提供的是事实证据、编辑判断，还是机械代理指标？
3. 它失败时是否会错误覆盖 raw？
4. 模型能力提升后，它仍有价值，还是会变成能力上限？
5. 它能否被正常创作反馈验证和撤销？

## 15. 完成定义

本架构迁移完成必须同时满足：

- `novel_generate_chapter` 只有一条生产生成路径；
- raw 永久存在且可安全交付；
- 只有带具体证据的编辑机会才生成候选；
- 文学候选由匿名、span 约束的 LLM pairwise judge 提供证据；只有通过自然人对齐闸门后才允许自动决定胜负，未通过时保留 raw 并进入人工复核；
- 事实硬伤由确定性代码守护；
- legacy 正收益资产已有明确新 owner；
- Stage0-8 不再加工正文；
- 所有状态只根据最终正文提交；
- 策略会依据外部反馈调整概率，并按模型版本隔离；
- 用户可以查看为什么选择某候选并撤销自动学习结果；
- 系统不会因裁判失败或策略失败交付低于 raw 的文本。

达到以上条件后，PiNovelStudio 才从“V2 实验链路”真正收敛为面向未来强模型的中文长篇小说创作系统。

文档收口口径：调研和架构规划已完成并纳入版本控制；执行状态由当前任务清单维护；文档一致性检查覆盖全部三份文件。
