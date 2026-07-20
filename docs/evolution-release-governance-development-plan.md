# PiNovelStudio 进化环境与版本发行治理开发计划

**版本**：v1.0
**日期**：2026-07-16
**状态**：已确认方向，待工程实施
**架构上位真相源**：`docs/top-tier-chinese-novel-system-development-plan.md`
**当前执行状态真相源**：`docs/remaining-development-dispatch-plan-20260715.md`
**适用范围**：代码、模型路由、prompt、上下文策略、质量规则、学习策略、数据集、评测协议与生产默认配置的迭代治理

## 1. 决策与目标

本计划解决一个核心风险：局部功能、局部指标和单项测试持续改善，但组合后的完整系统反而退化，最终出现“越迭代越难用”。

治理目标不是阻止快速开发，而是把每次进化变成可捕获、可比较、可审批、可撤销的候选版本：

```text
定义进化方向
  -> 冻结候选环境
  -> 捕获完整行为版本
  -> 与当前批准版本和 raw 基线对照
  -> gpt5.6-sol 开发期代理审批
  -> 通过后晋级开发生产默认
  -> shadow/canary 观察
  -> 失败时一键回滚
```

### 1.1 已确认的审批模式

1. **开发阶段**：`gpt5.6-sol` 作为 `validated_human_proxy`，替代日常人工执行系统候选版本审批，加速开发。
2. **正式使用阶段**：每章先由 `gpt5.6-sol` 对 raw/editorial 候选执行匿名审批，只向用户提交一份“代理审批稿”；用户基于该稿修改、接受、否决或要求重生成，不承担常规多候选评选工作。
3. `gpt5.6-sol` 的身份必须始终记录为 `validated_human_proxy`，不得写成 `natural_person`。
4. 开发期代理审批针对的是“系统版本是否可晋级”，不是替用户永久决定作品审美。
5. 无冻结环境、无对照版本、无可回滚目标、证据污染或结论不明确时，代理不得批准。
6. 用户对代理审批稿的实际修改、接受、否决和回退是正式使用阶段的最高权重质量证据。

### 1.2 治理根不可自我审批

以下变更会改变“谁有权批准、什么算通过”，不得由新的审批逻辑自行批准：

- `gpt5.6-sol` 审批者身份、模型版本或替换方案；
- 代理审批 prompt、输出 schema、匿名协议和反向复判协议；
- release 准入阈值、eligible/excluded 规则和 veto 条件；
- human-equivalent provenance 规则；
- CreativeConstitution 锁定字段范围；
- rollback、证据撤销、quarantine 和 production pointer 逻辑。

这些治理根变更必须由用户明确批准；工程测试和旧版代理审批只能提供建议证据。

## 2. 两类环境必须分离

### 2.1 作品创作环境

回答“这一本书想成为什么”，由以下资产定义：

- `CreativeConstitution`；
- CanonState / CharacterState / PromiseLedger / PatternMemory；
- ChapterIntent；
- 用户明确偏好和已接受修改。

自动学习不得修改 CreativeConstitution 核心锁定字段，只能提出 proposal。

### 2.2 系统进化环境

回答“本次候选与当前版本是否在可比较的环境中运行”，必须冻结：

- Git commit、dirty worktree 状态和实际运行文件 hash；
- 构建产物 hash、TypeScript 配置和依赖锁文件 hash；
- 生成模型、裁判模型、代理审批模型及精确版本；
- 模型路由配置、非秘密行为开关和预算配置；
- prompt bundle hash、工具 schema hash 和上下文编译策略版本；
- CreativeConstitution schema/hash 与测试作品快照；
- active 策略集合、信誉分区和 evidence artifact hash；
- 数据集、NovelBench case、golden baseline 和评测协议 hash；
- 随机 seed、调用预算、超时和 fallback 策略；
- 当前批准版本和目标 rollback 版本。

密钥值不得写入 manifest；影响行为的非秘密配置必须保存规范化值，秘密仅保存变量名、是否存在和安全指纹。

## 3. 统一发行单元

新增 `EvolutionReleaseManifest`，一个 manifest 表示一个完整、可复现的系统行为版本，而不是单独的 Git commit。

建议路径：

```text
reports/evolution-releases/{releaseId}/
  manifest.json
  environment.json
  baseline-comparison.json
  proxy-review.json
  test-report.json
  artifacts/

config/evolution-release/
  active-development.json
  active-production.json
  rollback-history.jsonl
```

建议核心结构：

```ts
interface EvolutionReleaseManifest {
  schemaId: "pinovel.evolution-release";
  schemaVersion: 1;
  releaseId: string;
  status:
    | "draft"
    | "candidate"
    | "frozen"
    | "evaluated"
    | "approved_dev"
    | "active_dev"
    | "candidate_prod"
    | "active_prod"
    | "held"
    | "rejected"
    | "quarantined"
    | "revoked"
    | "retired";
  parentReleaseId: string | null;
  rollbackReleaseId: string;
  changeClass: "R0" | "R1" | "R2" | "R3";
  claims: string[];
  environmentFingerprint: string;
  artifactRefs: string[];
  approvalRef: string | null;
  createdAt: string;
  activatedAt: string | null;
}
```

生产与开发入口只读取 pointer 指向的 manifest，不直接读取“目录里最新文件”或未审批策略。

## 4. 版本状态机

```text
draft
  -> candidate
  -> frozen
  -> evaluated
  -> approved_dev | held | rejected | quarantined
  -> active_dev
  -> candidate_prod
  -> active_prod

active_dev / active_prod
  -> held | revoked | retired
  -> rollbackReleaseId
```

规则：

- `candidate` 不能进入默认生产链路；
- `frozen` 后不得原地修改，任何修改创建新 `releaseId`；
- `evaluated` 必须绑定完整评测 artifact；
- `approved_dev` 必须绑定有效的 `gpt5.6-sol` 代理审批 artifact；
- `active_dev` 只能由 promotion 命令原子切换 pointer；
- `active_prod` 在正式使用阶段必须由用户明确批准系统版本；
- 章节级用户评审不能直接、自动修改全局生产规则，只能追加反馈证据；
- revoked evidence 或整体回归可使版本自动进入 `held`，但恢复 active 必须重新审批。

## 5. 变更风险分级

| 级别 | 典型变更 | 最低验证要求 | 审批 |
|---|---|---|---|
| `R0` | 文档、诊断文案、无行为 schema 补充 | build、聚焦测试、边界测试 | 可自动形成 candidate；无需模型质量审批 |
| `R1` | 单一编辑策略、advisory、局部 prompt、局部检索排序 | 至少 5 个 eligible pair、至少 2 部作品、反向匿名复判、无 veto | `gpt5.6-sol` |
| `R2` | raw 生成、ContextCompiler、FactGuard、Judge、状态提交、模型路由 | B0-B4、至少 8 个 eligible pair、至少 2 部作品和 3 类章节位置、完整回归 | `gpt5.6-sol`，结论不清则 hold |
| `R3` | 审批协议、准入阈值、human proxy 身份、生产 pointer、rollback、宪法锁 | 全量工程验证、迁移/回滚演练、旧新协议并行审计 | 用户明确审批 |

“章节位置”至少覆盖开篇、连续中段、承诺兑现/高压章节；不能只用同一部作品同一类型章节证明整体正收益。

## 6. 代理审批协议

本节包含两种相互独立的代理审批：

- `ReleaseProxyApproval`：开发阶段审核完整系统候选版本能否晋级；
- `ChapterProxyApproval`：正式使用阶段审核单章候选并产出一份建议提交给用户的代理审批稿。

两类审批必须使用不同 schema、artifact 和 prompt，禁止用单章胜负直接证明系统版本晋级，也禁止用 release 审批替代逐章内容审批。

### 6.1 输入必须匿名且冻结

`gpt5.6-sol` 接收：

- 当前批准版本与候选版本的匿名 A/B 结果；
- raw baseline；
- 预登记 claims、风险和唯一变量；
- FactGuard、状态一致性、成本和延迟报告；
- 可引用正文 span，但不暴露候选身份、实现名称或开发者预期；
- 正向顺序与反向顺序复判结果。

不得把代码作者的“修复说明”“预期候选胜出”或历史裁判答案注入审批 prompt。

### 6.2 输出状态

代理只能返回：

- `APPROVE_DEV`：候选整体明确胜出且无 veto；
- `HOLD`：证据不足、胜负不清、不同作品方向不一致或成本权衡不明确；
- `REJECT`：候选整体退化；
- `QUARANTINE`：发现数据污染、身份泄露、provenance 不一致或协议违规。

输出必须包含：

- decisive dimensions；
- winning/losing spans；
- 作品宪法对齐判断；
- 整体回退风险；
- 是否值得替换当前版本；
- 审批模型、版本、prompt hash、输入 artifact hash；
- 正反顺序一致性。

`slight`、`uncertain`、顺序敏感或不同评审轮冲突一律映射为 `HOLD`，不能批准。

### 6.3 正式章节代理审批

正式使用时，`gpt5.6-sol` 必须在统一编排器完成 raw/editorial 候选、FactGuard 和 pairwise selection 后，对可交付候选执行独立匿名复核：

- 输入至少包含 raw、系统选定稿和必要时的其他 eligible editorial 候选；
- 不暴露候选类型、系统 winner、策略名称和生产 judge 结论；
- 使用正向与反向顺序复判；
- 明确胜出时输出一份 `proxy_approved_draft`；
- 结论不清、顺序敏感或所有候选有明显问题时输出 `HOLD_FOR_REGENERATION`，不得把多个候选直接转交用户评选；
- 若 raw 胜出，则代理审批稿可以是 raw，但必须记录原因；
- 代理不得直接提交长期状态或覆盖正式章节文件。

`ChapterProxyApproval` 至少记录：

- `releaseId`、workspace、chapterId、candidateIds；
- 匿名映射与正反顺序 verdict；
- `recommendedCandidateId` 和 `recommendedSource`；
- winning/losing spans、风险、rationale；
- reviewerModel/version、prompt hash、输入 artifact hash；
- `status=PROXY_APPROVED | HOLD_FOR_REGENERATION`。

### 6.4 整体 veto

以下任一项出现即不得晋级，即使局部文学指标改善：

- 事实、实体、时间线、知识边界或跨章状态回退；
- 最终文本可能低于 raw，或 raw fallback 被绕过；
- `novel_generate_chapter` 唯一入口和生产依赖边界被破坏；
- state commit 与最终正文不一致；
- provenance 不可复现、dirty worktree 未被完整 hash 捕获或 artifact 缺失；
- 只证明单个 scanner 指标改善，没有证明完整章节体验改善；
- 只在单作品、单章节或单 seed 上胜出；
- 评审身份泄露、reviewer shopping、事后换阈值或选择性删除负样本；
- 成本或延迟超过预登记预算且没有明确整体收益；
- 审批者正在审批自身治理根变更。

## 7. 正式使用阶段的代理初审与用户定稿闭环

正式使用后的单章流程是：

```text
novel_generate_chapter
  -> raw/editorial candidates
  -> FactGuard + system judge/select
  -> gpt5.6-sol ChapterProxyApproval
  -> proxy_approved_draft checkpoint
  -> 只向用户展示代理审批稿、审批摘要和必要风险
  -> 用户接受 / 修改 / 否决 / 要求重生成
  -> 对用户定稿重新执行 FinalFactRecheck + 状态派生
  -> 用户确认提交
  -> FinalStateCommit + AtomicChapterSave
```

用户不需要常规比较多个候选。默认界面只展示代理审批稿；raw、其他候选和完整 A/B 证据保留在可展开的审计视图中，供用户质疑代理判断时查看。

用户对代理审批稿执行：

- `accept_proxy_draft`：接受代理审批稿并进入最终提交确认；
- `accept_with_edits`：在代理审批稿上修改，保存 diff 后进入重新复检；
- `reject_and_regenerate`：否决代理审批稿，本轮不提交状态，按明确反馈重新生成；
- `inspect_alternatives`：仅在需要时展开 raw/其他候选，不作为默认工作流；
- `rollback_committed_chapter`：对已提交章节执行正文与状态一起回退。

代理审批稿不是正式最终版。用户修改后必须基于用户稿重新运行最终事实、连续性和状态派生；用户最终确认前，`FinalStateCommit` 和正式章节原子保存均不得执行。允许保存只读、可恢复的 pending checkpoint，但不得推进下一章 frontier。

每次评审写入 append-only `ChapterReviewEvent`，至少记录：

- `releaseId`、workspace、chapterId；
- 代理推荐来源、候选 ID 和 `ChapterProxyApproval` 引用；
- 用户选择；
- 用户修改 diff/hash；
- 修改涉及的策略与问题类型；
- 是否撤销已写入状态；
- 时间和来源。

用户反馈的治理规则：

1. 单章反馈只更新该章和策略证据，不自动修改 CreativeConstitution 核心字段。
2. 同类退化重复出现时，active release 自动进入 `held` 候选状态并提示回滚，但不静默切换作品版本。
3. `reject_and_regenerate`、大幅改稿、主动查看并改选其他候选、rollback 是高权重负面证据。
4. 用户直接接受代理审批稿、低改稿距离和连续章节状态正确是高权重正面证据。
5. 正式使用产生的真实用户证据优先级高于开发期 `ReleaseProxyApproval` 和正式章节 `ChapterProxyApproval`。
6. 用户修改暴露的偏差应同时反馈给章节审批校准和系统 release 健康度，但不得自动修改 CreativeConstitution 核心字段。

## 8. 工程实施阶段

### Phase G0：真相源与冻结边界

**目标**：消除任务文档漂移，明确谁管理架构、执行状态和版本治理。

- 修正不存在的任务真相源引用；
- 将本计划登记为系统版本治理真相源；
- 冻结 `gpt5.6-sol` 开发期代理身份和 R3 用户审批边界；
- 定义 release schema、状态机和目录边界。

**验收**：文档引用存在；无两份冲突的 active release 规则。

### Phase G1：Manifest 与 Registry

建议新增：

```text
.pi/extensions/novel-studio/v2/governance/
  evolution-release-types.ts
  evolution-release-schema.ts
  evolution-release-registry.ts
  release-pointer-store.ts
```

- manifest schema 校验；
- append-only 状态事件；
- active-development / active-production 单指针；
- frozen manifest 不可变；
- parent、supersedes 和 rollback 链校验；
- 原子 pointer 切换。

**负向验收**：未知 schema、缺 rollback、双 active、原地修改 frozen manifest 必须失败。

### Phase G2：环境捕获生产化

复用 NovelBench `runtime-provenance-collector.ts`，抽取共享、无 eval 依赖的环境指纹能力：

- Git、dirty、runtime/build hash；
- lockfile、tsconfig、model-routing、prompt bundle、工具 schema；
- active 策略和 evidence hash；
- constitution、dataset、case 和环境配置；
- 敏感信息 redaction。

**验收**：同环境生成相同 fingerprint；任一行为资产改变都会产生新 fingerprint；生产构建不依赖 NovelBench eval 模块。

### Phase G3：候选捕获与预登记

建议命令：

```text
npm run evolution:capture
npm run evolution:status
npm run evolution:verify
```

- 根据 git diff 和 owner map 生成 R0-R3 风险建议；
- 开发者声明 claims、唯一变量、预算、样本和停止条件；
- 创建 candidate/frozen manifest；
- 缺少 clean build、测试或 baseline 时不得进入 evaluated。

### Phase G4：整体回归与代理审批

建议命令：

```text
npm run evolution:evaluate
npm run evolution:proxy-review
```

- 自动执行分级工程测试；
- R1/R2 运行冻结的 NovelBench 对照；
- 生成匿名正反顺序审批包；
- 通过现有 `human-proxy-provenance` 规范化 `gpt5.6-sol` verdict；
- 输出 `APPROVE_DEV/HOLD/REJECT/QUARANTINE`；
- 审批 artifact 与 manifest hash 双向绑定。

**预算边界**：每次代理审批必须有固定调用数、超时和停止条件；不得为了得到批准自动增加 reviewer 或重复抽样。

### Phase G5：晋级、Canary 与回滚

建议命令：

```text
npm run evolution:promote
npm run evolution:hold
npm run evolution:rollback
```

- 只有 `APPROVE_DEV` 可晋级 `active_dev`；
- pointer 切换前自动备份当前 active 和状态摘要；
- 晋级后先 shadow，再按风险等级进入 bounded canary；
- canary 只影响明确授权的开发工作区；
- 回滚同时恢复 release pointer、策略集合和兼容的状态版本；
- 不删除失败版本和负面证据。

### Phase G6：生产入口绑定

- `novel_generate_chapter` preflight 读取 active release；
- trace 写入 `releaseId/environmentFingerprint/approvalRef`；
- manifest 与当前运行环境不一致时 hard block 或显式进入非生产开发模式；
- 未审批策略、prompt 和 dirty build 不得静默进入生产；
- eval/test 模式不得修改 active pointer。

### Phase G7：正式章节代理初审、用户定稿与反馈

- 新增 `ChapterProxyApproval` schema、匿名正反复判和代理审批稿 checkpoint；
- Review Surface 默认只展示代理审批稿、审批摘要和风险，候选对比放入可展开审计视图；
- 增加 accept_proxy_draft/accept_with_edits/reject_and_regenerate/inspect_alternatives/rollback_committed_chapter；
- 用户修改后重新执行 FinalFactRecheck、状态派生和提交前确认；
- 保存用户修改 diff、代理判断偏差和状态回滚结果；
- 将真实用户反馈追加到策略证据与 release 健康报告；
- 只有用户最终确认的版本才能执行 FinalStateCommit、原子保存并成为下一章 frontier。

### Phase G8：健康监控与退役

- 按 release 统计 raw fallback、用户 override、改稿距离、事实失败、状态回滚、成本和延迟；
- 连续负收益触发 `held`，长期负收益触发 `retired` 建议；
- revoked evidence 后重新计算 release eligibility；
- 保留最近稳定 active 和至少一个已验证 rollback 版本；
- 定期删除无引用临时 artifact，但永不删除审批、回滚和负面证据链。

## 9. 测试计划

### 9.1 单元测试

- manifest/schema/status transition；
- frozen 不可变和 append-only；
- pointer 原子切换与双 active 拒绝；
- environment fingerprint 稳定性和变更敏感性；
- approval artifact hash 绑定；
- R3 自我审批拒绝；
- rollback/supersedes/revoke。

### 9.2 集成测试

- candidate → freeze → evaluate → proxy approve → promote；
- HOLD/REJECT/QUARANTINE 不得进入 active；
- dirty worktree、缺 artifact、模型漂移、prompt hash 漂移阻断；
- 生产入口只消费 active manifest；
- eval/test 不改变生产 pointer；
- ChapterProxyApproval HOLD 不向用户推送多候选、不提交状态；
- 用户修改稿重新复检后才允许提交；
- reject/regenerate、inspect 后改选其他候选、rollback 正确写入负面证据。

### 9.3 产品级验证

- `npm run build`；
- 完整相关测试集；
- 生产依赖边界检查；
- 一次 R1 模拟晋级；
- 一次 R2 冻结 NovelBench 代理审批；
- 一次 active_dev → rollback 演练；
- 一次章节代理初审 → 用户修改 → 重新复检 → FinalStateCommit/反馈 round-trip；
- 一次代理 HOLD → 不提交状态、不推进 frontier 的负向演练。

测试通过只证明治理机制可运行，不证明候选版本质量正收益；质量晋级仍必须依赖冻结对照和审批 artifact。

## 10. 交付顺序与优先级

| 优先级 | 任务 | 依赖 | 完成标志 |
|---|---|---|---|
| P0 | G0 真相源修复 | 无 | 文档入口唯一、审批边界冻结 |
| P0 | G1 Manifest/Registry | G0 | 不可变候选、单 active pointer、rollback 链 |
| P0 | G2 环境捕获生产化 | G1 | 完整 environment fingerprint |
| P0 | G3 捕获与预登记 | G1-G2 | 可生成 frozen candidate |
| P0 | G4 代理审批 | G3 | `gpt5.6-sol` 审批 artifact 可验证 |
| P0 | G5 晋级与回滚 | G4 | active_dev 原子切换和一键回滚 |
| P1 | G6 生产入口绑定 | G5 | 未审批环境无法生产运行 |
| P1 | G7 章节代理初审与用户定稿 | Review Surface | 单一代理审批稿、用户修改复检、最终提交闭环 |
| P2 | G8 健康监控与退役 | G6-G7 | release 级长期健康治理 |

## 11. 完成定义

本计划只有同时满足以下条件才算完成：

- 任一生产行为都能追溯到唯一 `releaseId`；
- release 能还原代码、构建、模型、prompt、配置、策略、数据集和宪法环境；
- 未审批 candidate 无法进入开发或正式生产默认；
- 开发期 `gpt5.6-sol` 审批有匿名、反向、span、provenance 和预算证据；
- R3 治理根不能自我审批；
- 正式使用章节先经 `gpt5.6-sol` 代理初审，只向用户提交一份代理审批稿；
- 用户基于代理审批稿修改、评价和最终确认，不承担默认多候选评选；
- 用户最终确认前不提交长期状态、不写入正式章节、不推进下一章 frontier；
- 用户反馈能更新健康证据但不能单章污染全局规则；
- 当前 active 版本始终有已验证 rollback 目标；
- 整体退化能被 hold/revoke/rollback，而不是继续在局部细节上累积修补；
- 任何“质量已提升”声明都能指向冻结对照、审批 artifact 和后续真实使用证据。

## 12. 当前实施状态（2026-07-16）

### 12.1 已完成 L0

`EVOLUTION-RELEASE-GOVERNANCE-1A` 已完成并提交：RED `97322872`、GREEN `febe120d`。

- G1：manifest schema、状态机、frozen 不可变、parent/supersedes/rollback 链、append-only registry；
- G2：独立于 NovelBench/eval 的 environment fingerprint，覆盖 Git/dirty、行为资产、模型/seed/预算/策略/fallback 和秘密存在性脱敏；
- G3 基础入口：`evolution:capture`、`evolution:status`、`evolution:verify` 与本地 drill；
- development/production 单 pointer、原子切换、rollback history，以及 evaluation/test 禁止修改 production pointer。

验收证据：提交声明三构建、88 个治理测试、dependency boundary 19/19、drill 与 `git diff --check` 通过；2026-07-16 任务清单复核再次通过 `build:prod`、`build:test` 和聚焦测试 `88/88`。这些证据只证明 L0 治理机制，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-1B` 已完成：clean baseline `a5fbdb7` 含四模块 + 4 测试文件 + 70 测试；P0 绕过漏洞修复 RED `97aad46`、GREEN `78383f3`。

- `release-proxy-approval-schema.ts`：verdict 归一化、R3 自审批拒绝、manifest/hash 双向绑定、reviewer-shopping 检测；
- `approval-packet-builder.ts`：匿名 A/B 正反顺序、固定 case/model/seed/budget、FactGuard/状态/成本证据、身份与系统结论去泄露；
- `release-proxy-approval-registry.ts`：审批 artifact 原子落盘、append-only、按 releaseId 查询和重复/篡改拒绝；
- `proxy-approval-caller.ts`：仅 stub caller 的四 verdict 路径、预算约束和非 `APPROVE_DEV` 不晋级；
- P0 安全收口：reviewer shopping、R3 自审批、production pointer 绕过均已封堵。

验收证据：三构建（prod/test/eval）通过；1A + 1B + P0 安全回归 `170/170`、smoke `2/2`、dependency boundary `19/19`；FactGuard/语言风险聚焦 `17 pass / 2 skipped / 0 fail`（2 skip 因旧冻结 raw 已丢失，待 `RECOVERY-6`）；HEAD `78383f3` 工作树干净，`git diff --check` 通过。caller 仅 stub，未调用真实 `gpt5.6-sol`，未写 production pointer，未接 `novel_generate_chapter`。这些证据只证明 L0 代理审批数据契约与安全门禁，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-1C` 已完成：RED `4936334` + GREEN `5a2e504`。

- `authorization-card.ts`：5 个校验函数（validate/isExpired/isValidForRelease/assertAuthorizes/loadFromFile）；
- `proxy-approval-provider-runner.ts`：`createProviderRunner`（stub 委托 + real 授权边界）；
- `proxy-review-runner.ts`：`runStubProxyReview` / `runRealProxyReview` 端到端 runner；
- `evolution-cli.mjs`：`evaluate`（frozen→evaluated）+ `proxy-review`（async + canPromote 治理映射）子命令；
- `evolution-release-registry.ts`：`transitionStatus` 方法（绕过 frozen immutability 守护，但校验 `isStatusTransitionValid` 状态机合法性）；
- `canPromote` 主导 verdict→status 映射：R3/shopping 阻断的 APPROVE_DEV → held，不自动批准；approvalRef 仅在 canPromote=true 时绑定。

验收证据：1C 聚焦测试 `51/51` 通过（authorization-card 21 + provider-runner 12 + cli 10 + proxy-review-runner 9，重叠计入）；dependency boundary `19/19`。真实 `gpt5.6-sol` API 集成抛 `NOT_IMPLEMENTED`，受 `REQUIRES_AUTH` 边界守护（无授权卡/过期/未覆盖 releaseId/预算不足均拒绝）。未调用真实模型，未切换 active pointer。这些证据只证明 L0 provider runner 与审批 CLI 机制，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-G6` 已完成：RED `83b05b2` + GREEN 在 `415cb36` 中提交（与 eval 测试目录迁移混合提交，非理想但代码完整）。

- `v2/governance/production-release-gate.ts`（333 行）：`evaluateProductionReleaseGate` + `captureDefaultEnvironmentFingerprint`；
- `v2/core/unified-entry.ts`（+42 行）：preflight 读取 active production release，manifest 与当前环境不一致时 hard block，`PINOVEL_DEV_MODE=1` 时 dev bypass；
- trace/stageResults 写入 `releaseId/environmentFingerprint/approvalRef`；
- eval/test 模式不修改 active pointer。

验收证据：G6 聚焦测试 `12/12` 通过（gate 单元 7 + runUnifiedPipeline 集成 3 + 生产闭包边界 2）；`PINOVEL_DEV_MODE=1` 时 bypass 门禁。未审批策略、prompt 和 dirty build 不得静默进入生产。这些证据只证明 L0 生产入口绑定门禁机制，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-G7`（schema/registry 切片）已完成：RED `6cc1e7b` + GREEN `5f1060d`。

- `chapter-proxy-approval-types.ts`：schema 常量（`CHAPTER_PROXY_APPROVAL_SCHEMA_ID="pinovel.chapter-proxy-approval"`）、verdict 枚举（`PROXY_APPROVED | HOLD_FOR_REGENERATION`）、`AnonymousMapping`（forward/reverse 双向）、`ChapterProxyApprovalArtifact` 接口；
- `chapter-proxy-approval-schema.ts`：`validateChapterApprovalArtifact`（reviewerType 必须 `validated_human_proxy`，不得 `natural_person`；reviewerModel 必须 `gpt5.6-sol`；forward≠reverse 时 finalStatus 必须 `HOLD_FOR_REGENERATION`）、`normalizeChapterVerdict`（slight/uncertain/order_sensitive/conflict 一律映射为 HOLD_FOR_REGENERATION）、`computeChapterApprovalArtifactHash`（排除 decidedAt 非行为字段）；
- `chapter-proxy-approval-registry.ts`：append-only fs 持久化（同 approvalId 拒绝覆盖）、`loadArtifact`（损坏 JSON / 未知 schemaId 明确抛错）、`listArtifactsByChapter` / `listArtifactsByRelease`、原子写入（temp → rename）；
- 与 1B ReleaseProxyApproval 物理隔离：独立 schemaId、独立 verdict 枚举、独立 registry 目录与索引文件。

验收证据：G7 聚焦测试 `14/14` 通过（schema 隔离 + validate + normalizeVerdict + registry append-only + hash 行为敏感性）；三构建通过；完整治理回归 `247/247`、smoke `2/2`、dependency boundary `19/19`；`git diff --check` 通过。未接入统一编排器、未实现 Review Surface 展示与用户定稿操作（G7 后续切片）。这些证据只证明 L0 章节代理审批 schema/registry 基础契约，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-G7`（runner 切片）已完成：RED `294f546` + GREEN `1da84b9`。

- `chapter-proxy-approval-packet-builder.ts`：章节级匿名 A/B packet builder（forward/reverse 双向映射、candidateId/类型/章节身份不进入 packet、spans 用 A/B 标签、候选数量限定 2、`computeChapterPacketHash` sha256、`verifyChapterPacketAnonymity` 检测候选 ID 泄露、`resolveRecommendedSource` 反查候选来源）；
- `chapter-proxy-approval-caller.ts`：`ChapterProxyApprovalCaller` 接口（identity: "stub" | "gpt5.6-sol"）+ `createStubChapterProxyApprovalCaller`（零网络调用、预算守护 maxCalls<2 抛错、`normalizeChapterVerdict` 归一化、forward≠reverse→HOLD_FOR_REGENERATION、recommendedCandidateId 为空抛错、holdReason 写入 rationale/risks）；
- `chapter-proxy-approval-executor.ts`：`executeChapterProxyApproval` 编排（build packet → caller.call → 反查 recommendedSource → 构造 artifact → append-only registry 写入 → 返回 finalStatus/artifact/canDeliverProxyDraft/blockReason，`canDeliverProxyDraft = (finalStatus === "PROXY_APPROVED")`）；
- `chapter-proxy-approval-runner.ts`：`runStubChapterProxyReview`（端到端 stub）+ `runRealChapterProxyReview`（REQUIRES_AUTH 边界：无授权卡路径/文件不存在抛 REQUIRES_AUTH，有效授权卡抛 NOT_IMPLEMENTED——真实 API 集成留待后续切片）。

验收证据：G7 聚焦测试 `39/39` 通过（14 schema/registry + 25 runner：packet builder 10 + stub caller 6 + executor 4 + runner 5）；三构建通过；dependency boundary `19/19`；smoke `2/2`；`git diff --check` 通过。stub caller 零网络调用；真实 `gpt5.6-sol` 调用 REQUIRES_AUTH。代理仅持久化 artifact，不写章节文件、不提交长期状态。与 1B ReleaseProxyApproval 物理隔离。未接入统一编排器、未实现代理审批稿 checkpoint、未实现 Review Surface 展示与用户定稿操作（G7 后续切片）。这些证据只证明 L0 章节代理审批 runner 机制，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-G7`（P0 审批绕过漏洞修复）已完成：RED `1fca418` + GREEN `5486f71`，专属测试 `12/12` 通过。

- 封堵 reviewer shopping、R3 自审批、production pointer 绕过等审批绕过路径；确保 `finalStatus=PROXY_APPROVED` 必须由合法审批路径产出，不得通过绕过审批流程获得。

`EVOLUTION-RELEASE-GOVERNANCE-G7`（P0 审批 artifact 真实性绑定修复）已完成：RED `85b63de` + GREEN `beda887`。

- 绑定 artifact 真实性证据，确保 artifact 记录的输入、prompt hash、候选 ID 与实际执行轨迹一致，防止事后伪造或篡改 artifact 内容。

`EVOLUTION-RELEASE-GOVERNANCE-G7-P0-ARTIFACT-INTEGRITY-1`（artifact 完整性与路径安全）已完成：RED `1808918` + GREEN `1d95c0d`，G7 聚焦测试 `51/51` 通过（26 schema/registry + 25 runner，含 12 个 P0 负向用例）。

- `chapter-proxy-approval-registry.ts`：新增 `assertSafeApprovalId` 目录穿越防护（字符集白名单 `/^[A-Za-z0-9_-]+$/` + `resolve`/`relative` 路径穿越检测），守护所有文件路径构造入口（`artifactPath`），防止 `approvalId='../escaped'` 等在 approvalsDir 外创建/读取文件；
- `chapter-proxy-approval-schema.ts`：新增 4 项 P0 安全校验——`proxy_approved_requires_both_approve`（两轮均 HOLD_FOR_REGENERATION 时不得伪造 PROXY_APPROVED）、`recommended_candidate_not_in_list`（recommendedCandidateId 必须属于 candidateIds，防 ghost 候选）、`anonymous_mapping_candidate_not_in_list`（anonymousMapping A/B 值必须属于 candidateIds）、`anonymous_mapping_not_reversed`（reverse 必须真正交换 forward A/B，防伪反向映射）；
- `chapter-proxy-approval-types.ts`：`ChapterApprovalValidationError.code` 联合类型新增 4 个错误码（`proxy_approved_requires_both_approve`、`recommended_candidate_not_in_list`、`invalid_anonymous_mapping`、`anonymous_mapping_candidate_not_in_list`、`anonymous_mapping_not_reversed`、`not_object`）。

验收证据：G7 聚焦测试 `51/51` 通过（含 12 个 P0 负向用例：approvalId 目录穿越 4 + 字符集 4 + 伪造 PROXY_APPROVED 1 + ghost 候选 2 + 伪反向映射 1）；三构建通过；dependency boundary `19/19`；smoke `2/2`；`git diff --check` 通过。未调用真实模型、未生成章节、未提交长期状态。这些证据只证明 L0 章节代理审批 artifact 完整性与路径安全机制，不证明候选版本质量正收益或已获生产晋级。

`EVOLUTION-RELEASE-GOVERNANCE-G7`（代理审批稿 pending checkpoint 切片）已完成：RED `1793659` + GREEN `097a6c5`，专属测试 `11/11` 通过。

- `chapter-proxy-approval-draft-checkpoint.ts`：新增代理审批稿 pending checkpoint 机制（`saveProxyApprovedDraft`/`loadProxyApprovedDraft`/`hasPendingProxyDraft`/`getPendingProxyDraft`/`clearPendingProxyDraft`/`resolveDraftCheckpointDir`）；落盘到 `workspaces/{id}/chapter-approvals/` 隔离目录（`{approvalId}.draft.md` 正文 + `{approvalId}.draft.meta.json` 元数据 + `{chapterId}.pending.json` sentinel），不写正式 `chapters/`；append-only 防篡改（同 approvalId 重复写入拒绝）；目录穿越防护（`assertSafeApprovalId` 字符集白名单 + resolve/relative 路径穿越检测，与 registry 同模式）；闭包自包含（仅依赖 `node:fs`/`node:path`），进入生产闭包 `dist/`；
- `orchestrator-commit-save.ts`：`commitAndSave` 起点添加 G7-Checkpoint 守护——`hasPendingProxyDraft` 返回 true 时拒绝执行（`ok=false`、`stateCommit=null`、`stageResults.atomicSave.blocked=true`），不写 `chapters/`、不提交状态、不推进 frontier；`clearPendingProxyDraft` 后恢复正常；
- `test/test-modules.ts`：添加 dist-test barrel import。

验收证据：G7 draft checkpoint 专属测试 `11/11` 通过（落盘隔离目录 + 不写 chapters/ + hasPendingProxyDraft save/clear + loadProxyApprovedDraft + getPendingProxyDraft + append-only 防篡改 + 目录穿越 7 类恶意 ID 拒绝 + commitAndSave 有 pending 拒绝 + 无 pending 正常 + clear 后恢复 + 隔离验证）；三构建（prod/eval/test）通过；dependency boundary `19/19`；smoke `2/2`；G7 chapter-proxy + orchestration-transaction + phase5-unified-orchestrator 回归 `91/91` 通过；`git diff --check` 通过。未调用真实模型、未生成章节、未提交长期状态。这些证据只证明 L0 代理审批稿 pending checkpoint 机制（用户最终确认前 FinalStateCommit 和正式章节保存均不得执行），不证明候选版本质量正收益或已获生产晋级。

### 12.2 当前实施任务

G7 已完成的本地切片：1A/1B/1C/G6 `COMPLETE_L0`；schema/registry、runner、P0 安全修复、pending checkpoint、Review Surface、用户定稿、反馈记录、approvalId 双重绑定、rollback 状态恢复、prod-binding、FinalFactRecheck/状态派生/最终提交 entry、反馈 ingestor/release health、内部定稿消费链 handler，以及反馈摄入/健康归集生产触发时机均已完成各自 L0 验收。生产入口消费链收口（用户第二轮核验后的"其他"方案，RED `b50576e` + GREEN `a7a9565`）：移除第 7 公开工具方案，改为 `novel_workspace_manager` action=`proxy_finalization` 委托 `handleChapterProxyFinalization`，生产严格保持 6 个公开工具，`novel_generate_chapter` 仍是唯一公开章节生成入口；handler 由 `tools/workspace-manager-handler.ts` import 进入生产闭包 `dist/`（不再仅由 `dist-test` 验证）。同一 GREEN 一并修复用户第二轮核验的 4 项阻断：P0 workspaceId 路径越界（改用 `resolveWorkspacePath`+`validateWorkspaceId` 替代直接 join）、P1 反馈重复摄入（持久化 `chapter-approvals/ingest-cursor.json` 传入 `alreadyIngestedApprovalIds`）、P1 失败反馈污染（`shouldRecordFeedback` 收紧为 accept/accept_with_edits 仅 `commit.ok=true` 才记录）、P1 6 工具契约回归（不再新增公开工具）。accept/accept_with_edits/rollback 增加显式 `confirm=true` 确认；accept/accept_with_edits 增加 `revision` 校验（与 pending sentinel.savedAt 比较）；所有定稿动作支持 `idempotencyKey`（`chapter-approvals/idempotency-keys.json`，同 key 重调返回 `idempotent=true`）。切片 3 GREEN 已完成：`createRealGpt56SolChapterProxyApprovalCaller` 工厂 + `callOpenAIChatCompletions` 内置 fetch 适配器 + `runRealChapterProxyReview` 真实 caller 调用链（替换 NOT_IMPLEMENTED 占位），19/19 测试通过。真实 `gpt5.6-sol` 调用仍受独立预算与授权卡约束（`REQUIRES_AUTH`），测试只用 mock/callerOverride，本轮未调用真实模型。反馈摄入/健康归集生产触发时机已接线（RED `78019e4` + GREEN `00de3ce`，7/7 测试通过；`chapter-proxy-approval-finalization-trigger.ts` 提供 `triggerFinalizationWithFeedbackAndHealth` 封装 `runFinalization` → `ingestProxyApprovalFeedbackToStrategy` → `aggregateReleaseHealth` 三段调用链为单一生产触发入口，模块通过 `review-surface-cli.ts` value import 进入生产闭包 `dist/`）。GREEN `a7a9565` 联合验收：handler 16/16 + workspace-manager round-trip 7/7 + production-tool-registration/dependency-boundary 23/23（6 工具契约 + 依赖边界）+ G7/P0/chapter-proxy 聚焦 238/238 + smoke 2/2 + 全量 2071 pass/0 fail/5 skipped（2076 tests）。

- ~~代理审批稿 checkpoint（proxy_approved_draft 落盘，不提交长期状态、不覆盖正式章节文件）~~ 已完成（RED `1793659` + GREEN `097a6c5`，11/11 测试通过）；
- ~~Review Surface 默认只展示代理审批稿、审批摘要和风险，候选对比放入可展开审计视图~~ 已完成（RED `aa80a64` + GREEN `bce90bb`，11/11 测试通过；`renderChapterProxyDraft` 在 `v2/core/review-surface-cli.ts` 纯只读渲染，不调用模型、不修改 finalText、不提交状态；输出经 `redactSecrets` 过滤 API key/Bearer token/`<think>` 内部推理）；
- ~~用户定稿操作：accept_proxy_draft / accept_with_edits / reject_and_regenerate / inspect_alternatives / rollback_committed_chapter~~ 已完成（RED `df0575a` + GREEN `eb8a8d5`，9/9 测试通过；`chapter-proxy-approval-finalization.ts` 返回 `canCommit` 标志，不直接调用 `commitAndSave`；`acceptProxyDraftWithEdits` 用依赖注入 `rerunFactGuard` 函数避免重耦合 `UnifiedOrchestratorInput`；`rollbackCommittedChapter` 备份到 `chapter-approvals/{chapterId}.rollback-backup-{timestamp}.md` 并删除原 `chapters/` 文件，`narrativeStateRestoreRequired=true` 提示状态需单独恢复）；
- ~~approvalId 双重绑定 + pending sentinel fail-closed 修复~~ 已完成（RED `4d0c1f7` + GREEN `2eb4855`；`chapter-proxy-approval-draft-checkpoint.ts` 暴露 `PendingSentinelInfo`/`getPendingSentinel`/`verifyPendingApprovalId`；`hasPendingProxyDraft` 改为 fail-closed 语义——sentinel 损坏时返回 `true` 强制阻断 `commitAndSave`；三个定稿操作 `clearPendingProxyDraft` 前必须先通过 approvalId 双重绑定校验，防错误/陈旧 approvalId 清除他人 pending）；
- ~~P1 rollback 状态恢复闭环~~ 已完成（RED `ba608c7` + GREEN `7f78f0e`；`commitAndSave` 在 `narrative-state-store.json` 提交前备份到 `chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json`，备份失败不阻断提交；`rollbackCommittedChapter` `RollbackResult` 新增 `stateRestored?`/`stateBackupPath?`/`stateRestoreError?` 三字段，从最新备份恢复叙事状态，实现"章节文件 + 叙事状态"双恢复闭环；P1 专属测试 +27）；
- ~~编排器定稿接线 prod-binding~~ 已完成（commit `fc04083`；`v2/core/review-surface-cli.ts` 通过 value import + re-export 将 finalization 5 个定稿操作 + 7 个类型、feedback-recorder 3 个函数 + 6 个类型拉入生产闭包 `dist/`）；
- ~~用户修改后重新执行 FinalFactRecheck、状态派生和提交前确认~~ 已完成（`v2/governance/chapter-proxy-approval-finalization-entry.ts` 提供 `runFinalization` 完整调用链：accept -> `commitAndSave(draftText)`、accept_with_edits -> `checkCandidateFactGuard` 真实重跑 -> `commitAndSave(editedText)`、reject/rollback 不提交、inspect -> `inspectAlternatives`（只读，不 commitAndSave / 不 feedback / 不 clear pending）；每次操作追加 `recordProxyApprovalFeedback`；模块通过 review-surface-cli value import 进入生产闭包 `dist/`。缺口一/二修复（RED `caf93d8` + GREEN `e07dd98`）：inspect 入口统一到 `runFinalization`（5 种 action）；`orchestratorInput.stagedStateUpdate` 为 null 时注入空 `StagedStateUpdate`（`sourceChapter=ch{N}`），使 `commitAndSave` 进入状态提交分支并从 `finalText` 提取 pattern entries（基于最终稿重新派生，不再 skipped）；12/12 测试通过）；
- ~~保存用户修改 diff、代理判断偏差和状态回滚结果~~ 已完成反馈记录与 diff 计算（RED `383f4ae` + GREEN `0c27053`，10/10 测试通过；`chapter-proxy-approval-feedback-recorder.ts` append-only `feedback.jsonl` + `computeEditedTextDiff` + `ProxyJudgmentBias` 字段；`rollbackResult` 字段供回滚结果写入；`runFinalization` 入口已在每次定稿操作后自动追加反馈记录）；
- ~~真实用户反馈追加到策略证据与 release 健康报告的内部消费能力~~ 已完成（RED `c25b617` + GREEN `c531373`，11/11 测试通过；`chapter-proxy-approval-feedback-ingestor.ts` 把 feedback.jsonl 映射为 UserFeedbackIngestor evidence 写入 strategy-policy.json；`release-health-aggregator.ts` 只读聚合 release 健康报告；模块已进入生产闭包 `dist/`，内部 handler 可消费）。生产自动触发时机已接线（RED `78019e4` + GREEN `00de3ce`，7/7 测试通过；`chapter-proxy-approval-finalization-trigger.ts` 提供 `triggerFinalizationWithFeedbackAndHealth` 封装三段调用链为单一生产触发入口，模块通过 `review-surface-cli.ts` value import 进入生产闭包 `dist/`）；不新增公开工具；
- 只有用户最终确认的版本才能执行 FinalStateCommit、原子保存并成为下一章 frontier（已由 `orchestrator-commit-save.ts:commitAndSave` 的 `hasPendingProxyDraft` 守护强制执行；用户定稿操作 `clearPendingProxyDraft` 后才能继续）。

G7 本地 schema、Review Surface、finalization、反馈/健康内部消费能力、生产触发时机与生产入口消费链（"其他"方案，`novel_workspace_manager` action=`proxy_finalization` 委托 handler）已完成 L0 闭环；切片 3 GREEN 已完成 real-caller 本地调用链（`REQUIRES_AUTH`，真实 `gpt5.6-sol` 调用仍需独立预算与授权卡）。G7 总体仍为 `PARTIAL_L0`：生产入口消费链已收口（6 工具契约保持 + P0/P1 阻断修复 + confirm/revision/idempotencyKey 治理），但真实 `gpt5.6-sol` 章节代理审批仍 `REQUIRES_AUTH`；Canon/Character/Promise 状态派生仍只是注入空 `StagedStateUpdate`（仅 pattern entries 重新派生），与计划要求仍有差距，留待后续切片。"其他"方案不扩大公开 API 表面。

### 12.3 尚未实现

G5 晋级策略、G7 的真实 `gpt5.6-sol` 章节代理审批、G8 健康监控均未完成（G7 生产自动触发时机与生产入口消费链已收口，但真实 `gpt5.6-sol` 调用仍 `REQUIRES_AUTH`）。Canon/Character/Promise 状态派生仍只是注入空 `StagedStateUpdate`（仅 pattern entries 重新派生），与计划要求"基于最终稿重新派生四类长期叙事状态"仍有差距，留待后续切片。不得因为 G7 本地 schema/runner、安全修复、pending checkpoint、Review Surface、用户定稿、反馈记录、状态恢复、finalization entry、内部反馈/健康消费链、生产触发时机和生产入口消费链通过，就声称已经具备完整系统版本审批、生产发布或正式章节代理审批闭环。

当前可复用基础还包括：

- CreativeConstitution 和 proposal 边界；
- StrategyEvidence / Admission / revoke / dormant / retired；
- `gpt5.6-sol` validated human proxy provenance；
- Review Surface；
- NovelBench B0-B4、eligible pair 和 runtime provenance；
- UnifiedOrchestrator trace、atomic save、FinalStateCommit 和 raw fallback。

下一工程切片以 `docs/remaining-development-dispatch-plan-20260715.md` §0 为准。
