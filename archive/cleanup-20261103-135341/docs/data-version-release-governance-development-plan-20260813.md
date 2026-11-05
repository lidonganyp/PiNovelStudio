# PiNovelStudio 数据版本、发布治理与单一生产基线开发计划

**版本**：v1.0  
**日期**：2026-08-13  
**状态**：待执行  
**适用范围**：统一主链路生产运行、Prompt/工具/路由/上下文/质量规则/恢复策略、知识数据快照、策略证据、发布指针与生产 trace。

## 1. 目标

把一次生产运行绑定到一份不可变、可重建的系统行为环境：

```text
active-production
  -> releaseId
  -> frozen EvolutionReleaseManifest
  -> bundleId / component hashes / evidence partition
```

生产只保留一个可执行的 `active_prod` 基线；候选、评测、trace、审批和审计证据可以长期保留，但不得成为默认生产输入。

## 2. 必须遵守的架构原则

1. 版本化对象是完整行为集合，不是单个 Prompt。
2. `EvolutionReleaseManifest` 是唯一系统行为发布单元；不新增并行发布体系。
3. 任一影响行为的组成项变化，都必须生成新的 `bundleId`；任何发布变更都必须生成新的 `releaseId`。
4. 生产运行只能读取 `active-production -> manifest`，不得扫描目录或分别读取多个独立 `active` 配置。
5. `active_prod` 同一时刻只能有一个；指针损坏、manifest 缺失或 hash 不匹配时必须 fail-closed。
6. 作品级 `CreativeConstitution`、CanonState、CharacterState、PromiseLedger、PatternMemory、正文和用户修改稿不纳入全局 Release 版本。
7. 收敛前允许候选保持旧生产指针；收敛后发现问题必须以前向修复创建新 Release，不保留旧逻辑作为长期 fallback。
8. 任何“质量提升”声明必须同时具备冻结对照、评测协议、策略证据和后续真实使用证据。

## 3. 当前基础与本计划边界

可复用的现有能力包括：

- `EvolutionReleaseManifest`、`EvolutionReleaseRegistry`、`ReleasePointerStore`；
- `config/model-routing.json` 与 `config/prompt-registry.json`；
- Prompt Bundle manifest/hash 与生产 trace `bundleId` 接入；
- production release gate、canary/health、策略晋级与用户反馈证据链；
- 现有 release 生命周期和相关测试集。

本计划不重写统一生成主链路，不恢复 legacy Stage0-8，不把 NarrativeState 并入 Release，也不把单次用户反馈直接变成 production pointer 切换。

## 4. 目标数据模型

在现有 `EvolutionReleaseManifest` 上收敛并补齐以下字段，不另建第二套生产身份：

```ts
interface EvolutionReleaseManifest {
  schemaId: "pinovel.evolution-release";
  schemaVersion: number;
  releaseId: string;
  status: ReleaseStatus;
  parentReleaseId: string | null;
  changeClass: "R0" | "R1" | "R2" | "R3";

  bundleId: string;
  modelVersion: string;
  promptBundleHash: string;
  modelRoutingHash: string;
  toolSchemaHash: string;
  contextCompilerHash: string;
  qualityPolicyHash: string;
  recoveryPolicyHash: string;
  knowledgeSnapshotHash: string;
  runtimeFingerprint: string;

  strategyEvidencePartition: {
    modelVersion: string;
    bundleId: string;
    strategyId: string;
    evalProtocolVersion: string;
  }[];
  evalProtocolVersion: string;
  approvalRef: string | null;
  createdAt: string;
  activatedAt: string | null;
}
```

`bundleId` 必须由所有行为组成项规范化后确定性派生；密钥值不得写入 manifest，只记录变量名、存在性和安全指纹。

## 5. 开发任务卡

### DG-0：真相源盘点与基线冻结（P0）

**目标**：确认当前实际生产基线，消除文档、配置和代码中的 active 语义冲突。

**工作内容**：

- 盘点所有 `active`、`active_dev`、`active_prod`、`bundleId`、`modelVersion` 的读写入口；
- 以运行时实际 pointer 和 manifest 为准生成当前 baseline capture；
- 标记 Prompt Registry、Model Routing、Strategy Policy 中不应再独立承担生产 active 语义的字段；
- 更新 `project-memory`、发布治理文档和运行手册，记录唯一真相源；
- 输出“允许读取/允许写入/仅审计”的 owner map。

**依赖**：无。  
**验收**：不存在两个相互冲突的生产基线声明；可从唯一 pointer 找到完整 manifest；所有独立 active 读取点均有迁移归属。

### DG-1：统一 Behavior Bundle 与 Manifest（P0）

**目标**：让 Release Manifest 成为完整行为身份的唯一容器。

**工作内容**：

- 扩展现有 release types/schema，加入组件 hash、`bundleId`、`evalProtocolVersion` 和策略证据分区；
- 建立规范化序列化和确定性 hash 规则；
- 校验 `releaseId`、`bundleId`、组件 hash、`modelVersion` 的一致性；
- 规定 frozen 后禁止原地修改，任何修改必须新建 release；
- 保留旧 manifest/trace 为审计对象，但禁止旧 manifest 作为默认生产输入。

**依赖**：DG-0。  
**验收**：Prompt、工具 schema、路由、上下文、质量规则、恢复策略、知识快照或 runtime 任一改变，均产生新 `bundleId`；同输入重复 capture 的 hash 完全一致。

### DG-2：运行环境与数据快照捕获（P0）

**目标**：形成不依赖 NovelBench 评测模块的生产级可重建指纹。

**工作内容**：

- 捕获 Git/dirty、构建产物、lockfile、tsconfig、运行时版本；
- 捕获 Prompt Bundle、Model Routing、Tool Contract、ContextCompiler、质量/恢复策略；
- 捕获风格档案、Few-shot、对比蒸馏、检索索引、世界观参考和 runtime rules 的规范化 hash、来源与构建时间；
- 对敏感信息做 redaction，仅保留变量名、存在性和安全指纹；
- 将 capture 结果写入 manifest/artifacts，并支持独立 verify。

**依赖**：DG-1。  
**验收**：同环境 fingerprint 一致；任一行为资产变化都会导致 fingerprint 或对应组件 hash 变化；生产构建不依赖 eval-only 模块。

### DG-3：统一生产入口与 Fail-Closed（P0）

**目标**：让生产只消费 active manifest。

**工作内容**：

- 在 `novel_generate_chapter` preflight 统一解析 `active-production -> manifest`；
- 禁止生产路径直接读取候选目录、未审批策略、独立 active Prompt/路由配置；
- 校验 manifest 与当前运行环境、构建和组件 hash；
- pointer 缺失、损坏、双 active、候选状态、hash 漂移时 hard block；
- 保留明确的测试/开发 bypass，但不得影响生产默认路径；
- trace/stageResults 统一写入 release 身份。

**依赖**：DG-1、DG-2。  
**验收**：无 manifest 的生产运行数为 0；candidate 误入生产为 0；pointer 损坏时 fail-closed；生产 trace 100% 含 `releaseId/bundleId/modelVersion` 及关键组件 hash。

### DG-4：策略证据按完整行为环境隔离（P1）

**目标**：阻止旧 Bundle 或旧评测协议污染新 Bundle 的策略信誉。

**工作内容**：

- 将策略证据键从 `modelVersion + strategyId` 扩展为：

  ```text
  modelVersion + bundleId + strategyId + evalProtocolVersion
  ```

- 迁移现有 evidence artifact，旧分区只保留审计读取；
- 任何 bundle、工具协议或 eval 协议变化都创建新分区；
- 晋级、撤销、held、retired 和 health 聚合均按新分区计算；
- 增加跨 Bundle 污染检测与拒绝逻辑。

**依赖**：DG-1、DG-3。  
**验收**：新 Bundle 不继承旧 Bundle 策略信誉；旧 evidence 可审计但不能作为新生产准入依据；跨分区污染测试为 0。

### DG-5：发布生命周期与权限收敛（P1）

**目标**：把候选、冻结、评测、审批、canary、active 和退役的权限写成强约束。

**工作内容**：

- 固化状态迁移和每个状态的可写字段；
- `candidate` 不得进入生产默认路径；`frozen` 不可变；
- `active_prod` 单例约束；
- canary 绑定授权范围、时限、退出条件和自动 hold；
- 代理只能产生准入建议，不能自行切换 production pointer；
- R2/R3 变更要求完整 Eval、Replay、人工批准；
- 单次用户反馈只能写入章节/策略证据和健康报告，不得直接切换生产基线。

**依赖**：DG-3、DG-4。  
**验收**：未批准 pointer 切换为 0；双 active 直接失败；越权 canary 直接阻断；R3 无用户批准不能晋级。

### DG-6：单一生产基线迁移与旧可执行逻辑收敛（P1）

**目标**：完成从现有多处 active 语义到唯一 manifest 语义的迁移。

**工作内容**：

- 从当前真实生产环境 capture 一个新的唯一 baseline release；
- 让 Prompt Registry、Model Routing、Strategy Policy 成为 manifest 引用的组成部分；
- 删除生产路径中独立 active 选择、目录扫描和隐式 fallback；
- 新基线确认正收益并正式启用后，物理删除旧可执行生产分支；
- 保留必要的 manifest、trace、评测和 state-events 审计证据；
- 更新部署、恢复和项目记忆文档。

**依赖**：DG-0 至 DG-5。  
**验收**：可执行生产基线只有一套；新旧生产逻辑并行存在为 0；旧 release 仅能审计读取；前向修复发布流程可演练。

### DG-7：验收矩阵、回放与发布演练（P0 验收）

**目标**：用自动化测试证明治理规则，而不是只证明类型和构建通过。

**必须覆盖**：

| 场景 | 期望结果 |
|---|---|
| 同一环境重复 capture | fingerprint、bundle hash 一致 |
| Prompt/工具/路由/上下文任一变化 | 产生新 `bundleId` |
| candidate release | 生产拒绝读取 |
| 两个 `active_prod` | 操作失败 |
| frozen manifest 原地修改 | 操作失败 |
| 旧模型 evidence 用于新 Bundle | 隔离并拒绝 |
| 单次用户反馈 | 不切换 production pointer |
| canary 越权或超时 | 阻断/自动 hold |
| pointer 损坏 | fail-closed |
| 生产 trace | 包含 release/bundle/hash 身份 |
| 新版本进入生产 | 旧可执行分支被移除 |
| 仅修改 Eval 协议 | 产生新 `evalProtocolVersion` |
| R3 变更 | 无用户批准不得晋级 |

**依赖**：DG-1 至 DG-6。  
**验收**：`npm run build`、`build:prod`、`build:test`、`typecheck` 和相关治理测试通过；完成一次 candidate→freeze→evaluate→approve→active_dev→candidate_prod→active_prod 演练，以及一次收敛后前向修复演练。

## 6. 建议执行波次

### 波次 0：先锁真相源

执行 `DG-0`。未完成前不新增生产版本、不迁移策略证据、不修改 active pointer。

### 波次 1：建立统一身份

并行执行 `DG-1`、`DG-2`；产出新的 manifest schema、bundle builder、capture/verify 和测试。

### 波次 2：接入生产主链路

执行 `DG-3`，再执行 `DG-4`。此波次完成后，所有生产 trace 必须具备完整行为身份。

### 波次 3：发布权限与迁移

执行 `DG-5`、`DG-6`。先完成准入约束，再切换真实 baseline；不得先切 pointer 再补治理。

### 波次 4：最终验收

执行 `DG-7`，完成回放、故障注入、收敛后前向修复和旧可执行逻辑清理检查。

## 7. 发布闸门

任何新 Release 进入 `active_prod` 前必须同时满足：

- manifest 已 frozen，且 hash 可验证；
- `bundleId`、`releaseId`、`modelVersion` 和 `evalProtocolVersion` 完整；
- 环境、Prompt、路由、工具、上下文、质量/恢复策略和知识快照均有 hash；
- 相关 Eval/Replay/人工批准 artifact 与 manifest 双向绑定；
- pointer 切换由有权限的用户操作并写入 append-only 事件；
- canary 范围、时限和退出条件已登记；
- 生产入口只会解析该 manifest；
- 旧生产逻辑的删除范围已明确，且不会形成隐式 fallback；
- 质量收益声明可以被完整证据链复现。

## 8. 完成定义

本计划完成的判断标准不是“新增了版本号”，而是：

1. 任一生产运行都能追溯并重建唯一行为环境；
2. 任一行为资产变化都不会沿用旧 Bundle 身份；
3. 生产永远只有一个 active baseline；
4. 候选、旧版本和审计证据可比较、可追溯，但不可偷偷进入生产；
5. 策略信誉不会跨模型、跨 Bundle、跨 Eval 协议污染；
6. 收敛后问题通过新 Release 前向修复，不维护旧生产并行分支；
7. 失败、损坏、越权和缺证据场景全部 fail-closed 或进入明确的 held 状态。

