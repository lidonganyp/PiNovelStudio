# PiNovelStudio Skill、规则与能力包模块化装载及生命周期治理开发计划

**任务编号**：`CAPABILITY-PACKAGE-GOVERNANCE-1`  
**版本**：v1.0  
**日期**：2026-08-15  
**状态**：待安排执行  
**架构真相源**：`docs/top-tier-chinese-novel-system-development-plan.md` v1.2  
**适用范围**：统一主链路中的能力分类、能力包注册、按章准入、渐进式加载、工具与预算边界、输出契约、消费血缘、评测准入、BehaviorBundle 身份和单一生产版本收敛。

## 1. 计划结论

PiNovelStudio 不把 Skill 实现为一段额外 Prompt，而把它实现为受系统控制的能力包：

```text
不可变 Package Manifest + 内容寻址 Payload
  -> Release Package Set
  -> Chapter Catalog
  -> Eligibility / Compatibility / Conflict / Budget
  -> Activation Manifest
  -> 按需加载 Payload
  -> 受限工具执行与结构化输出
  -> Delivery / Consumption Ledger
  -> Eval Evidence
  -> 人工批准后的单一 Active 版本
```

本计划的正式架构决策如下：

1. 能力包是控制面治理的执行单元，不是可自行扩权的 Prompt 片段。
2. `novel_generate_chapter` 和统一主链路保持唯一；能力包不得形成第二生成入口或旁路编排器。
3. 继续复用 `methodology-policy.ts` 的权威边界。作者事实与已接受状态可进入 `hard_boundary / generation_context`；工艺和编辑方法只能进入 `candidate_only`；诊断只能进入 `review_only`；评测资产只能进入 `eval_only`。
4. `active` 只表示已被当前生产 release 准入，不等于与当前章节相关，也不等于每章自动加载。运行时必须依次区分 `admitted -> eligible -> selected -> activated -> delivered -> consumed`。
5. Catalog、Activation Manifest、Payload 和 Output Contract 四层渐进加载。模型只能从本章已授权 Catalog 中请求能力，不能加载未授权能力、修改权限、扩充预算或调用未授权工具。
6. Skill 输出不能提升自身权威，不能写正式状态、提交章节、修改 registry 或切换 production pointer。
7. 能力包内容、激活规则、工具依赖、输出 schema 或预算任一变化，都必须改变 `capabilityPackageSetHash`，继而改变 `bundleId`。
8. 同一 slot 只保留一个生产有效版本。候选和历史版本可作为不可执行审计证据保留，但不得构成第二套可执行生产基线。
9. `canary` 只允许在隔离 replay / preview 中运行，不做线上流量分叉。晋级 `active` 时原子替换旧版本，并从生产依赖闭包物理删除旧执行逻辑。
10. 文学质量仍由用户裁决。能力包准入系统可以验证边界、安全、成本与真实 A/B 证据，但不得在生产引入机器文学 judge。

## 2. 能力分类与所有权边界

不是所有“能力相关资产”都应塞进同一个 Package schema。目标分类如下：

| 类型 | 真相源 / Owner | 运行时作用 | 正文边界 |
|---|---|---|---|
| 权威规则 | CreativeConstitution、ChapterContract、正式 NarrativeState、ContextCompiler | 提供事实、意图和不可违背约束 | 仅权威来源可进入 `hard_boundary / generation_context` |
| Workflow Skill | CapabilityPackageRegistry + NovelOS Agentic Runtime | 调查伏笔、核验角色知识、分析章末压力等方法 | 输出证据、问题或候选指导；不创建事实、不提交状态 |
| Craft Gene / Pattern | CapabilityPackageRegistry，复用现有 Pattern/Gene 资产 | 提供抽象工艺候选 | `candidate_only` 或 `excluded_from_raw`，禁止机械配额与仿写 |
| Editorial Strategy | EditorialStrategyRegistry + Package Manifest | 为作者风格优化阶段提供候选策略 | 不得改写事实、越过 StoryPreservation / FinalFactRecheck |
| Diagnostic Module | Review Surface / Methodology diagnostics | 输出 span-backed 风险和审阅问题 | `review_only`，不得直接改文或决定文学 winner |
| Provider Capability | `capability-registry.ts` | 判断 endpoint / protocol / adapter 能否执行某 Package | 不进入正文内容 |
| Eval Asset | NovelBench、Replay Matrix、Eval Manifest | 提供准入证据和回放 | `eval_only`，不得进入生产 Prompt |

约束：

- 权威规则继续由 ContextCompiler 和 ChapterContract 管理，不复制进 Skill Payload。
- Provider Capability 继续由 endpoint 级 `lookupStrict()` 管理，不复制成提示文本。
- Eval Asset 只被 Package Manifest 引用，不作为运行时 Payload。
- 能力包注册表主要治理 Workflow Skill、Craft Gene / Pattern、Editorial Strategy 和 Diagnostic Module；不得借统一 schema 抹平它们的权限差异。

## 3. 当前基线与已确认缺口

### 3.1 可直接复用的资产

| 现有资产 | 已有能力 | 本计划中的定位 |
|---|---|---|
| `v2/core/methodology-policy.ts` | `authority / role / enforcement` 及 raw 越权 fail-closed | 能力包上层权威协议；扩展 `eval_only` 后作为唯一枚举来源 |
| `v2/core/prompt-pattern-library.ts` | 来源、许可、状态、准入样本、数量/长度限制、production/evaluation 解析、selected/dropped trace | 迁移为 Pattern 类型 Payload 和 admission adapter，不再独立决定每章相关性 |
| `v2/core/portable-craft-gene.ts` | 抽象指导、数量/长度限制、反模仿校验 | 迁移为 Craft Gene Payload validator，不直接成为 raw 注入器 |
| `v2/core/editorial-strategy-registry.ts` | 候选策略注册和策略选择 | 保留策略引擎；Package 引用 `strategyId`，不重复实现 Thompson Sampling |
| `novelos/protocol/capability-registry.ts` | endpoint/model/protocol/adapter 级能力与 `lookupStrict()` | Package 模型兼容性唯一检查入口 |
| `v2/core/budget-ledger.ts` 及预算契约 | 全局调用、token、时延等预算治理 | Package 预算只做子配额，不另建第二本总账 |
| `v2/governance/behavior-bundle.ts` | 完整行为组件 hash 与 `bundleId` | 新增 `capabilityPackageSetHash` 并纳入 release 身份 |
| FailureEnvelope / production release gate | 结构化失败、发布权限和 fail-closed | 复用既有失败与审批协议，不新增平行错误格式或 pointer |
| ContextPackage / ContextDeliveryLedger 计划与在途实现 | `contextPackageHash / modelInputHash` 和实际交付血缘 | Package ledger 引用这些 hash，不复制上下文交付系统 |

### 3.2 已确认缺口

1. 尚无统一 `CapabilityPackageManifest`，适用条件、排除条件、输入、输出、工具、预算、依赖、冲突、模型要求与准入证据分散在不同模块。
2. `PromptPatternLibrary` 在 production 模式按 `active` 直接选取，尚未独立表示 `eligible / relevant`；多个 active 项会按库顺序进入数量截断。
3. `loadPromptPatternLibrary()` 对缺失和解析失败回退为空结果。它尚不能区分 release-required 与 truly-optional，也没有统一 `optional_capability_unavailable` 事件。
4. `compilePortableCraftGenes()` 当前搜索只见定义和测试调用。生产入口虽透传 `craftGenes`，但 `buildRawPrompt()` 没有真实渲染或消费点。
5. 生产入口加载 Prompt Pattern 后传入已废弃的 positive-gain 字段；当前统一生产编排没有可证明的 Pattern 消费闭环。这个缺口不能通过重新注入 raw 修复。
6. 当前 trace 主要记录 selected/dropped 和个别 `consumedByRawPrompt` 布尔值，没有跨 Package 的选择、激活、实际交付、结构化产出、跳过和拒绝事件语义。
7. `BehaviorBundleComponents` 尚无显式能力包集合 hash，Package 内容或激活策略变化不一定单独反映为可审计的行为身份维度。
8. Package 要求尚未与 `lookupStrict()` 形成通用兼容性闸门。provider 名称相同仍不足以证明 endpoint、protocol 和 adapter 能执行能力。
9. 依赖图、冲突槽位、工具 allowlist、Package 子预算和停止条件尚未形成统一运行时授权对象。
10. 目前没有 Skill 专项 Eval Matrix，无法系统证明“不相关不加载、候选不进 raw、未授权工具不可调用、预算不可扩容、内容变化必改 hash”。

## 4. 目标架构

### 4.1 控制流

```text
EvolutionReleaseManifest
  -> frozen CapabilityPackageSet
  -> Capability Catalog（元数据，不含完整方法）
  -> Activation Planner
       - status / slot
       - applicableWhen / excludedWhen
       - authority / enforcement / targetStage
       - dependencies / conflicts
       - lookupStrict(model capability)
       - allowedTools intersection
       - BudgetLedger reservation
  -> CapabilityActivationManifest（系统签发，不可由模型修改）
  -> Capability Runtime
       - preload mandatory authoritative context through ContextCompiler
       - load optional payload on demand
       - enforce tool grants / stop conditions / budget
       - validate structured output
  -> authorized stage channel
  -> CapabilityConsumptionLedger + modelInputHash + outputArtifactHash
```

### 4.2 阶段分流

| `enforcement` | 合法入口 | 禁止行为 |
|---|---|---|
| `hard_boundary` | ContextCompiler / ChapterContract / FactGuard | Skill 自己创建或覆盖事实 |
| `generation_context` | 经权威校验后的 ContextPackage 槽位 | 从 methodology / heuristic 提升为作者事实 |
| `candidate_only` | Agentic 方案工作区或作者风格优化的候选指导通道 | 进入初稿 raw 权威上下文、直接覆盖最终正文 |
| `review_only` | Fact/Story/Completeness 后的 Review Surface | 修改正文、写状态、决定 winner |
| `eval_only` | `dist-eval`、隔离 replay、只读 preview | 进入生产构建闭包或生产模型输入 |
| `excluded_from_raw` | 可在被授权的 post-raw 阶段使用 | 进入 NovelOS Agentic 初稿输入 |

### 4.3 “消费”的可证明定义

不得用模型自述或“对象曾传入编排器”推断消费：

| 事件 | 可证明条件 |
|---|---|
| `admitted` | Package 版本存在于当前 release 的冻结 Package Set |
| `eligible` | 适用、权限、依赖、冲突、模型、工具和预算检查全部通过 |
| `selected` | Activation Planner 将 Package 写入本章 Activation Manifest |
| `activated` | Runtime 按 activationId 成功读取并校验对应 Payload |
| `rendered` | Payload 被转换为目标阶段允许的规范化内容或工具说明 |
| `delivered_to_model` | 内容真实出现在已发送模型输入中，并可由 `modelInputHash` 回放 |
| `consumed` | 模型调用该 Package 授权工具，或返回通过 Output Contract 校验且引用 activationId 的结构化产物 |
| `skipped / rejected` | 有明确 reason、stage、budget 和兼容性证据 |

对于被动注入的权威上下文，只能证明 `delivered_to_model`，不得伪称模型内部认知已“消费”。

## 5. 核心契约

Phase 0 必须先冻结契约。字段可在实现评审时调整命名，但不得创建平行 schema。

### 5.1 CapabilityPackageManifest

```ts
interface CapabilityPackageManifest {
  schemaVersion: "capability-package-v1";
  packageId: string;
  version: string;
  slot: string;
  kind: "workflow_skill" | "craft_gene" | "prompt_pattern" |
    "editorial_strategy" | "diagnostic_module";
  purpose: string;
  applicableWhen: CapabilityPredicate[];
  excludedWhen: CapabilityPredicate[];
  requiredInputs: RequiredInputContract[];
  outputArtifacts: OutputArtifactContract[];
  payloadRef: ContentAddressedPayloadRef;
  targetStages: CapabilityStage[];
  allowedTools: string[];
  stopConditions: StopCondition[];
  budgetPolicy: CapabilityBudgetPolicy;
  authority: MethodologyAuthority;
  enforcement: MethodologyEnforcement | "eval_only";
  dependencies: PackageRef[];
  conflicts: PackageRef[];
  modelCapabilityRequirements: ModelCapabilityRequirement[];
  provenance: ProvenanceRef[];
  evalManifestId: string;
  admissionEvidence: AdmissionEvidenceRef[];
  contentHash: string;
  status: "draft" | "eval" | "held" | "rejected" |
    "canary" | "active" | "retired";
  criticality: "required" | "optional";
}
```

契约规则：

- `applicableWhen / excludedWhen` 使用受限声明式谓词，不允许执行任意代码、正则脚本或模型生成表达式。
- `payloadRef` 指向内容寻址、只读的 Payload，并携带 media type、payload hash 和审计 sourceRef；运行时不得按可变文件名猜测内容身份。
- `contentHash` 覆盖除 `contentHash` 自身外的全部 Manifest 行为字段、Payload 内容、Output schema、工具引用和预算；时间戳、文件顺序不得造成非确定性。
- `authority / enforcement` 复用并扩展现有 Methodology 类型，不建立第二套权限枚举。
- validator 必须约束 kind/authority/enforcement 合法组合。Workflow、Craft、Pattern、Editorial 和 Diagnostic Package 不能仅靠声明把自己升级为 `author / accepted_text / hard_boundary`；权威上下文仍由 ContextCompiler 编译。
- `allowedTools` 必须是当前目标阶段工具 allowlist 的子集；交集为空但 Package 声明工具必需时判定 incompatible。
- `criticality=required` 表示 release 或命中适用条件后不可静默缺失，不表示每章无条件加载。
- 同一 `slot` 在冻结生产 Package Set 中最多一个 `active` 版本。

### 5.2 CapabilityCatalogEntry

Catalog 只暴露模型做选择所需的最小信息：

```ts
interface CapabilityCatalogEntry {
  packageId: string;
  version: string;
  purpose: string;
  targetStage: CapabilityStage;
  estimatedCost: CapabilityCostEstimate;
  outputKinds: CapabilityOutputKind[];
  activationId: string;
}
```

Catalog 不包含完整 Payload、admission 报告、历史胜率、来源原文或 release 控制字段。

### 5.3 CapabilityActivationManifest

```ts
interface CapabilityActivationManifest {
  schemaVersion: "capability-activation-v1";
  runId: string;
  workspaceId: string;
  chapterId: string;
  releaseId: string;
  bundleId: string;
  capabilityPackageSetHash: string;
  routeCapabilityKey: CapabilityKey;
  catalogHash: string;
  decisions: CapabilityActivationDecision[];
  issuedAt: string;
  manifestHash: string;
}

interface CapabilityActivationDecision {
  activationId: string;
  packageId: string;
  version: string;
  targetStage: CapabilityStage;
  decision: "selected" | "skipped" | "rejected" | "unavailable";
  reasons: string[];
  grantedTools: string[];
  reservedBudget: CapabilityBudgetReservation;
  payloadHash: string;
}
```

该 Manifest 只能由系统签发。模型输出中的同名字段不具备授权效力。

`manifestHash` 对不含 `issuedAt` 的规范化授权内容计算；同一 run identity、冻结输入和预算快照必须得到同一 hash。`issuedAt` 只作审计时间，不参与行为身份。

### 5.4 CapabilityOutputEnvelope

```ts
interface CapabilityOutputEnvelope {
  schemaVersion: "capability-output-v1";
  activationId: string;
  packageId: string;
  outputKind: "evidence" | "unresolved_questions" |
    "candidate_guidance" | "diagnostic" | "review_question";
  artifacts: unknown[];
  sourceRefs: string[];
  toolCallIds: string[];
  budgetUsed: CapabilityBudgetUsage;
  stopReason: "completed" | "no_match" | "budget_exhausted" |
    "blocked" | "not_applicable";
  outputArtifactHash: string;
}
```

方法论 Package 不提供 `fact` 或 `hard_constraint` 输出类型。只有 ContextCompiler 从作者或 accepted-text 权威源编译出的正式上下文，才能进入事实通道。

### 5.5 CapabilityConsumptionLedger

Ledger 使用追加事件，不覆写历史状态：

```text
discovered -> admitted -> eligible -> selected -> activated
  -> rendered -> delivered_to_model -> consumed
  -> skipped | rejected | failed | budget_exhausted
```

每条事件至少记录：

```text
runId / chapterId / releaseId / bundleId
packageId / version / activationId / targetStage
event / reason / payloadHash / outputArtifactHash
contextPackageHash / modelInputHash / modelTurnId
grantedTools / toolCallIds / budgetReserved / budgetUsed
timestamp
```

Package ledger 只引用 ContextDeliveryLedger 的 `contextPackageHash / modelInputHash`，不复制模型输入或另建第二份上下文血缘真相源。

## 6. 生命周期与发布规则

```text
draft
  -> eval
  -> held | rejected
  -> canary（仅隔离 replay / preview）
  -> active（人工批准并原子替换）
  -> retired（不可执行审计记录）
```

规则：

1. `draft / eval / held / rejected / canary / retired` 均不能进入默认生产模型输入。
2. `eval` 和 `canary` 必须携带 `evalOnly=true`、独立 run root、固定 release/bundle/package identity，禁止写正式状态和章节。
3. Eval Gate 只能生成 admission recommendation，不能修改 Package status、release manifest 或 production pointer。
4. `active` 切换必须由既有 release approval 权限完成；模型、Skill 和自动反馈管线均无此权限。
5. 新版本成为 active 时，同 slot 旧版本立即退出可执行集合；旧 Payload 从生产依赖闭包删除，只保留不可执行 hash、manifest 和评测证据。
6. 生产不保留旧版 fallback。新 active 失败时结构化阻断并前向修复，不静默切换旧 Package。
7. 策略信誉按 `modelVersion + bundleId + packageId + packageVersion + evalProtocolVersion` 隔离。

## 7. 实施阶段与任务卡

### Phase 0：契约冻结、调用点盘点与 RED 基线（P0）

**目标**：在不改变生产行为的前提下，锁定真相源、术语和失败语义。

**任务**：

- `CPG-0.1`：盘点 PromptPattern、PortableCraftGene、EditorialStrategy、Methodology diagnostics、NovelOS tools、BudgetLedger、BehaviorBundle 和 release gate 的真实生产/eval 调用点。
- `CPG-0.2`：冻结第 5 节四个核心契约及事件语义，明确 `delivered_to_model` 与 `consumed` 的证据差异。
- `CPG-0.3`：冻结 Package stage/channel 矩阵，验证 candidate/review/eval 不进入 raw。
- `CPG-0.4`：建立 RED 测试，覆盖未授权激活、重复加载、工具越权、预算扩容、模型能力不兼容、hash 漂移、required/optional 失败语义。
- `CPG-0.5`：产出 Wave 0 基线报告，列出所有独立 status、loader、hash、trace、budget 和 release 读取点及迁移 owner。

**依赖**：无。  
**完成标准**：契约评审通过；RED 测试按预期失败；无生产代码行为变化；未碰用户现有在途文件。

### Phase 1：统一 Package Registry、内容寻址与 BehaviorBundle 身份（P0）

**目标**：建立单一、不可变、可校验的能力包注册与发布身份。

**任务**：

- `CPG-1.1`：实现 Manifest/Payload validator、规范化序列化和 `contentHash`。
- `CPG-1.2`：实现 Package Set validator，拒绝重复 `packageId@version`、同 slot 双 active、未知依赖、依赖环、冲突 required 包和缺失 eval/provenance。
- `CPG-1.3`：将 `MethodologyEnforcement` 扩展为包含 `eval_only` 的唯一类型；现有 MethodologyPolicy 改为复用该类型。
- `CPG-1.4`：在 `BehaviorBundleComponents`、EvolutionReleaseManifest、release freeze/gate/trace 中加入 `capabilityPackageSetHash`。
- `CPG-1.5`：当前生产 release 必须显式冻结 Package Set；无 hash、hash 不匹配或 candidate 冒充 active 时 fail-closed。
- `CPG-1.6`：为旧 PromptPattern/Gene/Strategy 资产提供一次性只读迁移 adapter；不得长期保留两套生产 status 真相源。

**依赖**：Phase 0；数据版本与发布治理 DG-1/DG-3 契约。  
**完成标准**：任一 Package 行为字段变化都会改变 `contentHash -> capabilityPackageSetHash -> bundleId`；同输入重复 capture hash 一致；生产 Package Set 只有一个 active 版本/slot。

### Phase 2：Catalog、相关性判定与 Activation Planner（P0）

**目标**：把“已准入”与“本章相关”分离，并由系统签发不可扩权的 Activation Manifest。

**任务**：

- `CPG-2.1`：实现 Catalog 最小投影，禁止把完整 Payload 和评测报告预注入模型。
- `CPG-2.2`：实现声明式 `applicableWhen / excludedWhen` 求值，只允许读取冻结的 ChapterIntent、ContextPackage 元数据、当前阶段和正式状态摘要。
- `CPG-2.3`：按 status -> applicability -> authority/stage -> dependency/conflict -> model capability -> tool grant -> budget reservation 顺序计算 eligibility。
- `CPG-2.4`：使用 `lookupStrict()` 检查精确 CapabilityKey；未登记 endpoint 不得继承 provider 级能力。
- `CPG-2.5`：`grantedTools = package.allowedTools ∩ stage.allowedTools ∩ release.allowedTools`，模型不能扩大交集。
- `CPG-2.6`：从现有 BudgetLedger 原子预留 Package 子预算；预留失败时不得先执行后补账。
- `CPG-2.7`：依赖和冲突由系统确定性处理。模型不能解决权限冲突，也不能把 candidate-only 升级为 hard boundary。

**依赖**：Phase 1；ContextCompiler 的冻结 run/snapshot 身份。  
**完成标准**：active 但不相关的 Package 不进入 Activation Manifest；未知模型能力、工具缺失、依赖缺失和预算不足均有确定性结果；相同输入产生相同 manifestHash。

### Phase 3：渐进式 Payload Runtime、工具沙箱与输出验证（P0）

**目标**：让模型只在需要时加载授权 Payload，并只产生被允许的结构化结果。

**任务**：

- `CPG-3.1`：在 NovelOS Agentic 工具层提供内部 `activate_capability_package(activationId)`；它不是公开 `novel_*` 工具。
- `CPG-3.2`：Runtime 仅按 Activation Manifest 读取内容寻址 Payload；packageId 存在但 activationId 未授权时拒绝。
- `CPG-3.3`：每次 Package 激活绑定 stage、tool grant、remaining budget、stop conditions 和 Output Contract。
- `CPG-3.4`：Package 工具调用通过既有 Tool Protocol 和信任边界，禁止路径逃逸、跨 workspace 读取和状态写入。
- `CPG-3.5`：输出执行 schema 校验、sourceRef 校验和 authority/channel 校验；parse/schema 失败只重试 Package 输出，不触发正文重写。
- `CPG-3.6`：执行 stop condition 与硬预算；耗尽后返回 `budget_exhausted`，模型不能自行申请扩容。
- `CPG-3.7`：对于当前生产 ReAct adapter，先以 capability probe 证明结构化 tool loop 和 tool-result continuation；未证明前只能使用兼容的系统预激活变体或标记 unavailable，禁止按 provider 名称猜测兼容。

**依赖**：Phase 2；Tool Protocol、CapabilityRegistry、BudgetLedger、提示注入信任边界。  
**完成标准**：未授权 Package/工具调用为 0；输出越权为 0；模型无法修改 activation、budget、status、release 或 pointer；Package 失败不会改写已接受事实。

### Phase 4：统一主链路阶段接线与现有资产迁移（P0）

**目标**：在不恢复 legacy 编排、不污染 raw 的前提下，将不同能力接到唯一合法阶段。

**任务**：

- `CPG-4.1`：权威规则继续只通过 Preflight -> ContextCompiler -> ChapterContract 注入；不把事实复制进 Skill Payload。
- `CPG-4.2`：Workflow Skill 只接入 NovelOS Agentic 的调查/核验工作区，输出 evidence、unresolved questions 或 candidate guidance，不直接输出章节正文。evidence 必须重新通过 EvidenceEligibilityGate/authority 校验后才能进入生成上下文；candidate guidance 不得进入初稿 raw。
- `CPG-4.3`：Craft Gene / Prompt Pattern 迁移为 `candidate_only / excluded_from_raw` Payload，仅供明确授权的方案或作者风格优化阶段消费。
- `CPG-4.4`：EditorialStrategyRegistry 保留策略选择职责；Package 只提供版本、工具、预算、阶段和输出边界，不再实现第二个策略选择器。
- `CPG-4.5`：Diagnostic Package 只进入 post-raw / post-final Review Surface，输出 span-backed 诊断，不修改正文或决定文学 winner。
- `CPG-4.6`：Eval Package 只编入 `dist-eval`；依赖边界测试保证 `dist/` 无 eval payload、grader 和 canary loader。
- `CPG-4.7`：移除 `positiveGainPromptPatternResolution` 等废弃透传与无消费字段；有正收益资产迁入新 owner，无正收益资产保留为不可执行证据或删除。

**依赖**：Phase 3；统一主链路现行阶段边界。  
**完成标准**：生产公开入口仍只有 `novel_generate_chapter`；candidate/review/eval 进入 raw 次数为 0；Agentic 初稿仍必须经过作者风格整章优化、StoryPreservation、FinalFactRecheck 和保存事务。

### Phase 5：消费血缘、FailureEnvelope 与可回放审计（P0）

**目标**：证明每个 Package 为什么可用、是否被加载、模型实际看到什么、产生了什么结果以及成本是多少。

**任务**：

- `CPG-5.1`：实现 CapabilityConsumptionLedger 追加事件并接入统一 trace。
- `CPG-5.2`：将 rendered 内容映射到 ContextDeliveryLedger / model input，写入 `contextPackageHash / modelInputHash / modelTurnId`。
- `CPG-5.3`：工具调用和结构化输出写 `activationId / toolCallIds / outputArtifactHash`，仅满足第 4.3 节时记录 consumed。
- `CPG-5.4`：required Package 缺失、损坏、hash 漂移、不兼容、依赖失败或预算不可满足时写 FailureEnvelope 并 fail-closed。
- `CPG-5.5`：optional Package unavailable 可以继续，但必须写 `optional_capability_unavailable` 事件、原因和影响阶段，禁止 silent degrade。
- `CPG-5.6`：Package 输出越权或工具越权进入安全 FailureEnvelope；schema 重试记录 attempt history，不触发整章重写。
- `CPG-5.7`：trace replay 可重建 Catalog、Activation Manifest、Payload hash、实际模型输入、工具调用、输出和最终 stop reason。

**依赖**：Phase 3/4；ContextDeliveryLedger、FailureEnvelope、模型调用观测。  
**完成标准**：所有 Package 决策可解释率 100%；required silent degrade 为 0；模型输入与 Package delivery ledger 一致率 100%；预算账实一致。

### Phase 6：专项 Eval、准入证据与人工晋级（P1）

**目标**：证明能力包在正确时机带来正收益，而不是只增加 Prompt、token 和延迟。

**任务**：

- `CPG-6.1`：建立第 9 节确定性、安全、集成、replay 和真人 A/B 矩阵。
- `CPG-6.2`：每个 Package 的 EvalManifest 预先声明场景、模型版本、bundle、预算、指标、失败阈值和样本要求。
- `CPG-6.3`：统计激活精度、不必要激活率、实际交付率、结构化消费率、工具调用收益、token/延迟增量、事实安全回归和用户偏好。
- `CPG-6.4`：文学 Package 与同模型、同作品上下文、相近预算的无 Package 基线做真人匿名 A/B；机器 judge 仅可作为 eval 辅助证据，不能生产裁决或自动晋级。
- `CPG-6.5`：迁移现有 Prompt Pattern 时不得降低当前 `sampleSize >= 8`、`validatedWinRate >= 0.55` 和高置信实验来源下限；未来 active 阈值由版本化 EvalManifest 预先声明。
- `CPG-6.6`：Eval Gate 只输出 `admit / hold / reject` 建议，人工 release approval 才能改变 active。

**依赖**：Phase 5；NovelBench / Replay Matrix / 用户反馈证据管线。  
**完成标准**：事实安全指标零回归；成本不越预算；不相关场景不激活；文学类 Package 有真实人评正收益证据后才具备晋级资格。

### Phase 7：单一生产版本迁移、旧路径删除与发布收口（P0）

**目标**：把验证通过的 Package Set 原子纳入唯一生产 release，并删除平行执行逻辑。

**任务**：

- `CPG-7.1`：冻结唯一生产 `CapabilityPackageSet`，写入 EvolutionReleaseManifest 和 active production pointer 指向的 release。
- `CPG-7.2`：完成 candidate -> eval -> canary replay -> 人工批准 -> active 演练；不做生产流量分叉。
- `CPG-7.3`：物理删除旧独立 production loader、双 status owner、废弃透传、旧 active Payload 和 fallback 分支。
- `CPG-7.4`：保留旧 manifest/hash/eval report 作为不可执行审计证据；验证其不能被生产加载。
- `CPG-7.5`：更新依赖边界、发布 runbook、故障诊断和前向修复流程。
- `CPG-7.6`：在 clean checkout 执行 build、typecheck、全量相关测试、真实 workspace replay 和 trace 重建。

**依赖**：Phase 1 至 Phase 6；release approval。  
**完成标准**：第 10 节全部门槛通过；生产只有一个 Package Set 和一个 active 版本/slot；旧执行路径在 `dist/` 中为 0。

## 8. 建议开发波次与派工

复杂度为相对工作量，不等同于自然日。负责人由排期时填写。

| 波次 | 工作包 | 优先级 | 复杂度 | 建议角色 | 依赖 | 可并行 | 负责人 |
|---|---|---:|---:|---|---|---|---|
| Wave 0 | CPG-0.1~0.5 契约、盘点、RED、基线 | P0 | M | 架构/测试 | 无 | 调用点盘点与测试设计可并行 |  |
| Wave 1A | CPG-1.1~1.3 Package schema、hash、权限类型 | P0 | L | 核心治理 | Wave 0 | 与 1B 并行 |  |
| Wave 1B | CPG-1.4~1.6 BehaviorBundle、release、迁移 adapter | P0 | L | 发布治理 | Wave 0 | 与 1A 并行，合并前对齐 schema |  |
| Wave 2A | CPG-2.1~2.4 Catalog、适用性、模型兼容 | P0 | L | Agentic/协议 | Wave 1 | 与 2B 并行 |  |
| Wave 2B | CPG-2.5~2.7 工具 grant、预算、依赖冲突 | P0 | L | 安全/预算 | Wave 1 | 与 2A 并行 |  |
| Wave 3A | CPG-3.1~3.4 Payload Runtime 与工具沙箱 | P0 | XL | NovelOS/工具协议 | Wave 2 | 与 3B 部分并行 |  |
| Wave 3B | CPG-3.5~3.7 输出、停止条件、adapter probe | P0 | L | 协议/测试 | Wave 2 | 与 3A 部分并行 |  |
| Wave 4A | CPG-4.1~4.4 主链路与策略资产接线 | P0 | XL | 统一编排/质量 | Wave 3 | 与 4B 部分并行 |  |
| Wave 4B | CPG-4.5~4.7 Review/Eval 隔离与旧字段清理 | P0 | L | 诊断/构建边界 | Wave 3 | 与 4A 部分并行 |  |
| Wave 5 | CPG-5.1~5.7 Ledger、FailureEnvelope、replay | P0 | L | 可观测性/审计 | Wave 3/4 | 测试可与实现并行 |  |
| Wave 6 | CPG-6.1~6.6 专项 Eval 与真人验收 | P1 | XL | Eval/质量研究 | Wave 5 | 数据采集与盲评可并行 |  |
| Wave 7 | CPG-7.1~7.6 发布、迁移、删除、收口 | P0 | XL | 集成/发布治理 | Wave 6 | replay 场景可并行 |  |

### 8.1 关键路径

```text
Wave 0 契约与 RED
  -> Wave 1 Package / Release 身份
  -> Wave 2 Activation Planner
  -> Wave 3 Runtime / Tool Boundary
  -> Wave 4 主链路阶段接线
  -> Wave 5 Consumption / Failure Trace
  -> Wave 6 Eval / 人工准入
  -> Wave 7 单一版本发布与旧路径删除
```

### 8.2 合并边界

- 每个 Wave 先合并契约与 RED 测试，再合并实现。
- Wave 1~5 不得用长期 feature flag 保留两套生产 Package Runtime；隔离实现只允许存在于 test/eval 构建。
- Wave 4 不得以“接线”为由把 Craft Gene、Pattern 或 Diagnostic 塞进 raw。
- Wave 7 删除动作必须在真实 replay 和 clean checkout 验证通过后执行；删除后再跑一次完整验证。
- 当前工作树存在大量用户在途修改和未跟踪测试。执行者必须按工作包限定文件范围，不得恢复、删除、暂存或覆盖无关改动。

### 8.3 建议文件归属

以下是建议 owner，不是要求预先创建全部文件；实现评审可合并文件，但不得复制平行契约：

| 领域 | 建议新 owner | 必须协同的现有 owner |
|---|---|---|
| Package/Activation/Output 契约 | `v2/core/capability-package-contracts.ts` | `methodology-policy.ts`、`orchestrator-types.ts` |
| Registry、Package Set、内容 hash | `v2/governance/capability-package-registry.ts` | `evolution-release-types.ts`、`evolution-release-schema.ts`、`behavior-bundle.ts` |
| Catalog 与 Activation Planner | `v2/core/capability-activation-planner.ts` | `context-compiler.ts`、`capability-registry.ts`、预算 admission |
| Payload Runtime 与内部激活工具 | `novelos/agent/capability-package-runtime.ts` | NovelOS tool registry、Tool Protocol、Agent loop |
| Consumption Ledger | `v2/core/capability-consumption-ledger.ts` | `context-delivery-ledger.ts`、模型调用观测、trace recorder |
| 生产 gate 与主链路接线 | 不新增入口文件 | `production-release-gate.ts`、`unified-entry.ts`、`unified-orchestrator.ts` |
| 旧资产迁移 adapter | 尽量放在原资产 owner 内 | `prompt-pattern-library.ts`、`portable-craft-gene.ts`、`editorial-strategy-registry.ts` |

若某个建议新文件只剩单一薄函数，应合并到既有 owner，避免为“架构完整”制造空壳模块。

## 9. 最小验收矩阵

| ID | 场景 | 预期 |
|---|---|---|
| T01 | Package 为 active，但 `applicableWhen` 不命中 | 不进入本章 Catalog/Activation；记录 not_applicable |
| T02 | 同一 slot 出现两个 active 版本 | release freeze 失败 |
| T03 | 同一 Package 被模型重复激活 | 返回同一 activation 或拒绝重复计费；Payload 不重复注入 |
| T04 | 模型请求未出现在 Activation Manifest 的 packageId | 拒绝，写 unauthorized_activation |
| T05 | 模型请求 Package 未授权工具 | 工具调用在执行前拒绝 |
| T06 | Package 试图扩大预算 | 拒绝，原预算不变 |
| T07 | Package 预算耗尽 | 立即停止并返回 budget_exhausted；无额外调用 |
| T08 | Package 要求 native Function Calling，当前 route 为未验证 ReAct | 使用已声明兼容变体，或 unavailable / 结构化阻断；无静默套用 |
| T09 | endpoint 改变但 provider/model 名称相同 | `lookupStrict()` 不继承旧 endpoint 能力 |
| T10 | required Package 文件缺失或 JSON 损坏 | FailureEnvelope + fail-closed |
| T11 | optional Package 文件缺失 | 可继续，但 trace 必含 optional_capability_unavailable |
| T12 | Payload 内容变化但 packageId/version 未变 | contentHash 不匹配，release/运行阻断 |
| T13 | 激活规则、输出 schema、工具或预算变化 | capabilityPackageSetHash 与 bundleId 变化 |
| T14 | candidate-only Package 尝试进入 raw | prompt 构建前 fail-closed |
| T15 | review-only Package 产生正文 patch | Output Contract 拒绝，正文不变 |
| T16 | methodology Package 输出 `fact` 或 `hard_constraint` | authority/channel 校验拒绝 |
| T17 | Package 工具结果含“提交状态/修改 pointer”指令 | 保持 untrusted content，不执行动作 |
| T18 | Workflow Skill 正常调查 Promise | 输出 evidence/unresolvedQuestions/candidateGuidance，sourceRef 可回放 |
| T19 | selected 但未请求 Payload | 记录 selected/skipped，不伪记 consumed |
| T20 | Payload 已进入实际模型输入 | ledger 有 modelInputHash，可重建文本 |
| T21 | 模型返回结构化 Package 结果 | activationId/schema/sourceRef 通过后才记 consumed |
| T22 | Package 输出 schema 失败 | 只重试 Package 输出；不重写正文 |
| T23 | 依赖缺失、依赖环或 required 冲突 | release freeze 或 activation fail-closed |
| T24 | canary Package 尝试写正式章节/状态 | 拒绝；隔离 run root 不污染 workspace |
| T25 | Eval Asset 出现在生产依赖闭包 | dependency boundary 测试失败 |
| T26 | 新版本 active 后旧版本仍可生产加载 | 验收失败；必须物理删除旧执行路径 |
| T27 | Package 试图修改 registry/status/pointer | 权限拒绝，审计事件完整 |
| T28 | 同模型、同上下文、相近预算真人 A/B | 事实指标不退化；文学 Package 晋级需预声明的正收益证据 |
| T29 | trace replay | 可重建 Catalog、Activation Manifest、Payload、模型输入、工具调用、输出与预算 |
| T30 | clean checkout 生产构建 | 单一主链路、单一 Package Set、无 eval/canary/旧 runtime |

## 10. 生产验收门槛

### 10.1 P0 安全与治理门槛

| 指标 | 目标 |
|---|---:|
| 未授权 Package 激活 | 0 |
| 未授权工具调用成功 | 0 |
| candidate/review/eval 越权进入 raw | 0 |
| 方法论输出被提升为硬事实 | 0 |
| Package 直接写章节、状态、registry 或 production pointer | 0 |
| required Package silent degrade | 0 |
| optional unavailable 未记录 | 0 |
| 同 slot 双 active | 0 |
| Package / Package Set / Bundle hash 漂移漏检 | 0 |
| 模型/endpoint 能力静默假设 | 0 |
| 预算超支后继续调用 | 0 |
| 冲突/依赖未分类失败 | 0 |
| Package 决策可解释率 | 100% |
| 实际模型输入可回放率 | 100% |
| ledger 与预算账本一致率 | 100% |
| 生产 trace 留存率 | 100% |

### 10.2 P1 质量与效率门槛

- 基于人工标注 fixture 的激活精度达到 EvalManifest 预声明门槛；不得用“所有 active 都加载”提高表面召回。
- 不必要激活率、token 增量、时延增量和工具调用数均在 Package 预算内，并与无 Package 基线同时报告。
- `selected -> activated -> delivered -> consumed` 各阶段转化率全部可观测，不以高加载次数冒充价值。
- 事实错误、状态污染、硬冲突静默通过、提示注入越权相对生产 A 基线均不得增加。
- 文学 Package 只有在同模型、同资料、相近预算的真人匿名 A/B 达到预声明正收益门槛后才能 active。
- 用户反馈只更新隔离策略证据，不能自动修改 Package 内容、准入状态或生产 release。

## 11. 与现有计划的依赖关系

| 现有计划 / 模块 | 本计划复用内容 | 本计划不重复建设 |
|---|---|---|
| 数据版本与发布治理 | EvolutionReleaseManifest、BehaviorBundle、approval、单一 active pointer | 不新增 Package 专用 production pointer |
| 知识检索与 ContextCompiler 治理 | NarrativeEvidenceSnapshot、ContextPackage、ContextDeliveryLedger、modelInputHash | 不复制权威事实、检索或模型输入血缘 |
| 多代理协作边界 | WorkPackage、上下文 grant、工具权限、结果契约 | 不让代理或 Skill 获得提交权 |
| Prompt 注入信任架构 | 信任分区、工具结果净化、未知来源 deny | 不让 Payload/工具结果提升系统权限 |
| 预算治理 | BudgetLedger、reservation、actual usage、recovery budget | 不建立独立可超发的 Package 总账 |
| 用户反馈证据管线 | 用户选择、改稿、策略归因与模型版本隔离 | 不允许反馈自动晋级 active |

实现顺序上，Phase 1 依赖 BehaviorBundle/release schema 稳定；Phase 2/3 依赖预算与 CapabilityRegistry；Phase 5 依赖 ContextDeliveryLedger 的 hash 语义。若上游仍在开发，先冻结接口并用 test adapter，禁止复制一套临时生产真相源。

## 12. 明确不在本计划中的内容

- 不新增公开 `novel_*` 工具或第二个章节生成入口。
- 不恢复 legacy Stage0-8、one-shot raw fallback、章节白名单或双模式。
- 不把所有规则、知识、Provider Capability 和 Eval Asset 强行改造成同一种 Skill。
- 不把 PromptPattern、Craft Gene、Diagnostic 或机器 judge 直接注入生产 raw。
- 不规定固定反转数、对白比例、段落字数、句式模板等机械配额。
- 不默认把生产协议迁移到 Native Function Calling；是否迁移必须另有真实能力 probe、收益证据和 release 审批。
- 不允许 Skill 自生成新 Skill、自修改 Manifest、自扩预算或自我晋级。
- 不在本阶段实现“模型内部草稿、反思、自我校验与最小修订”专项；该主题应在本能力边界稳定后另立计划。

## 13. 开发完成定义

只有同时满足以下条件，才能声明“Skill、规则与能力包模块化装载和生命周期治理完成”：

1. 生产只有一个 `CapabilityPackageSet`，并作为完整 BehaviorBundle 身份的一部分被冻结。
2. 所有运行时 Package 都有不可变 Manifest、Payload hash、工具边界、输入输出契约、预算、停止条件、模型要求、评测身份和生命周期状态。
3. `active` 与 `relevant` 已完全分离，不相关 Package 不被自动加载。
4. Catalog -> Activation -> Payload -> Output 四层渐进式装载真实工作，模型不能越权加载或扩容。
5. `hard_boundary / generation_context / candidate_only / review_only / eval_only / excluded_from_raw` 阶段边界由代码和测试 fail-closed 守护。
6. 每个 Package 的 selected、activated、rendered、delivered、consumed、skipped、rejected 和 failed 均有可回放证据。
7. required 失败无 silent degrade，optional 失败有完整 trace，所有失败进入现有 FailureEnvelope 体系。
8. Package 行为变化必然改变 Package Set hash 和 bundleId；生产与 eval replay 使用同一冻结身份。
9. 生命周期晋级需要版本化 EvalManifest、真实证据和人工批准；Skill 和模型均不能改 production pointer。
10. 新 active 版本替换后，旧执行版本与平行 loader 已从生产依赖闭包物理删除。
11. clean checkout build/typecheck/相关测试、真实 workspace replay、依赖边界和 trace 重建全部通过。
12. 文学质量不由加载次数或机器总分宣称；文学类 Package 的正收益有同模型、同资料、相近预算的真人匿名 A/B 证据。
