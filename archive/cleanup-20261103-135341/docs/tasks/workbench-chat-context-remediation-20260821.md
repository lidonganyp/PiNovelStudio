# Workbench 聊天上下文与章节生成链路整改任务

> 项目：PiNovelStudio
> 适用页面：`/projects/128/workbench` 聊天面板及其调用的规划、任务、Novel Runtime 链路
> 编制日期：2026-08-21
> 执行方式：开发完成后提交代码、迁移报告和验证证据，由本助手按本文“最终核验清单”复核；在核验通过前不得宣称问题已解决。

## 1. 任务目标

修复 Workbench 聊天界面“聊天报错不清晰、章节种子污染全书大纲、生成第二章时上下文边界失控、角色/伏笔/长期状态没有稳定传入、状态 hash 失配导致重生成失败”等问题。

整改后必须满足：

1. 聊天助手明确区分全书规划、章节规划、资料查询、正文生成四类动作。
2. 全书大纲、当前章节大纲/章节种子、角色状态、世界观、伏笔承诺、CanonState、前章续接状态和证据片段分层传递，不能混成一段自由文本。
3. 正式章节生成默认不得把完整上一章正文传给模型或 Runtime；需要原文时只能通过有上限、可审计的证据片段检索获取。
4. 聊天助手和正式章节生成共用同一套 `ContextCompiler` 及来源、版本、hash、token 预算规则。
5. 所有失败都有结构化阶段、错误码、证据和恢复建议；前端向用户展示可理解的错误，不展示 stack、内部路由或敏感配置。
6. 章节正文仍只能通过公开入口 `novel_generate_chapter` 的统一主链路生成，不得恢复 legacy、one-shot raw 或聊天直写正文的旁路。
7. 项目 128 的污染数据和第一章状态 hash 得到可追溯修复；第二章只有在预检通过后才能重新生成。

## 2. 当前问题与已确认证据

以下证据来自 2026-08-21 对本地代码、数据库和运行结果的只读检查。文件行号以当前工作树为准，开发修改后应在交付报告中更新实际锚点。

| 问题 | 证据 | 影响 |
|---|---|---|
| 聊天请求只提交用户文字 | `platform/apps/web/src/api/assistant.ts` 的 `sendMessageStream` 请求体只有 `{ content }` | 后端只能猜测用户意图，无法稳定区分规划、查询和生成 |
| 章节种子污染全书大纲 | `platform/apps/api/src/modules/assistant/assistant-artifacts.ts` 会从模型文本识别大纲并写入 `story_outline`；项目 128 的 `story_outline` 含 `[[CHAPTER_SEED_START]]` 与 `[[GENERATE_CHAPTER:2]]` | 当前章节输入会被当成全书规划，后续章节上下文失真 |
| 正式生成读取上一章全文 | `platform/apps/api/src/modules/jobs/jobs.service.ts` 的 `buildRuntimeWorkspaceInput` 查询上一章 `content`，并返回 `previousChapterText` | 第二章生成边界不清晰，可能把整章正文送入 Runtime/模型；上下文和成本不可控 |
| Runtime 仍支持整章正文输入 | `platform/services/novel-runtime/src/workspace-manager.ts` 定义并落盘 `previousChapterText` | 即使上层部分压缩，底层接口仍允许整章串入，无法形成硬约束 |
| 项目资料不完整 | 项目 128 类型、简介、世界关键词为空；角色的 goals/motivation/currentState/relationships 基本为空；promise 数量为 0 | 模型没有可靠的作者内容契约，容易依赖猜测 |
| narrative state 含整章证据且 hash 过期 | 项目 128 `narrative_state.canon` 存有约 5.9 万字符的第一章接受稿；重生成 job `65e6e316-d9a4-4970-9057-997e93c08547` 因 `previous_state_store_invalid` / `state-store-hash-mismatch` 失败；数据库引用 hash `39e1530b9e06`，当前第一章正文 hash 前 12 位为 `6a762891b807` | 第二章无法进入可靠生成；旧状态还会污染上下文 |
| 聊天错误没有按阶段区分 | `platform/apps/web/src/components/workspace/AssistantPanel.vue` 将 SSE 错误、网络错误等拼成聊天气泡；历史加载失败没有独立错误态 | 用户无法判断是规划模型、保存、任务提交、Runtime 预检还是正文生成失败 |
| 当前工作树已有用户改动 | 现有改动涉及 `platform/apps/api/src/modules/assistant/*`、`platform/apps/api/src/modules/jobs/*`、`platform/services/novel-runtime/*`，另有未跟踪测试和 `book-context.ts` | 开发不得覆盖、恢复、删除、暂存或清理这些改动，必须先审阅并在交付报告中说明取舍 |

## 3. 根因判断

### 3.1 动作与文本耦合

系统依赖模型自由输出 `[[OUTLINE_START]]`、`[[CHAPTER_SEED_START]]`、`[[GENERATE_CHAPTER:n]]` 再从文本猜动作。聊天文本、结构化产物、任务提交没有明确边界，导致“回答用户”与“修改项目数据/提交生成任务”混在同一次调用中。

### 3.2 文档类型边界不足

`story_outline` 被同时当成全书大纲、章节规划容器和模型输出回收站。章节种子实际已有 `novelChapterSeed` 记录，却仍可能通过文本回写污染 `story_outline`。

### 3.3 上下文编译不统一

聊天助手有自己的项目摘要逻辑，JobsService 又有另一套工作区拼接逻辑，Runtime 还保留 `previousChapterText` 这种宽接口。各层没有统一的来源、hash、版本和 token 预算，也没有强制禁止整章正文。

### 3.4 长期状态没有成为可靠输入契约

角色字段、CanonState、PromiseLedger、PatternMemory 和前章续接状态没有稳定、分层、可验证地编译；状态 hash 失配时也没有在生成前完成可解释阻断和修复。

### 3.5 失败契约和用户体验断裂

后端内部错误没有统一映射为 `stage/gate/code/evidence/recoverable/fixInstructions`，前端只能把字符串塞进聊天气泡，无法提供正确的重试、补资料或修复动作。

## 4. 目标架构

### 4.1 四类明确动作

聊天助手必须使用结构化动作，不再以模型文本 marker 作为系统动作的唯一依据：

| 动作 | 允许修改的数据 | 是否可提交正文生成 |
|---|---|---|
| `plan_story_outline` 全书规划 | `story_outline`（只包含全书/卷级规划） | 否 |
| `plan_chapter` 章节规划 | 指定章节的 `novelChapterSeed`，如需章节大纲则使用独立的章节规划字段/文档 | 否 |
| `query_project` 资料查询 | 不写入作品数据 | 否 |
| `generate_chapter` 正文生成 | 只能创建/提交章节任务，正文由 `novel_generate_chapter` 统一链路产出 | 是，但必须通过正式任务入口 |

前端应允许用户显式选择动作；在未选择动作时可以提供“待确认的意图识别”，但模型不能直接凭自由文本修改大纲、创建章节或提交生成任务。正文生成应有明确确认状态，避免普通聊天误触发。

### 4.2 统一结构化请求/响应

建议将接口契约收敛为以下形态（字段名可按现有 API 风格调整，但语义必须保留）：

```ts
type AssistantAction =
  | 'plan_story_outline'
  | 'plan_chapter'
  | 'query_project'
  | 'generate_chapter';

interface AssistantRequest {
  content: string;
  action: AssistantAction;
  chapterNumber?: number;
  confirmGeneration?: boolean;
}

interface AssistantResult {
  reply: string;
  action: AssistantAction;
  artifacts: Array<{
    type: 'story_outline' | 'chapter_seed' | 'query_answer';
    id?: string | number;
    version?: number;
    saved: boolean;
  }>;
  generationRequest?: {
    chapterNumber: number;
    jobId: string;
    publicEntry: 'novel_generate_chapter';
  };
  contextManifest?: ContextManifest;
}
```

模型输出必须先经过 schema 校验，再由服务端应用 artifact。marker 可以仅作为一次性旧数据导入兼容格式，不能继续作为生产动作控制面，也不能让聊天消息副作用决定生成流程。

### 4.3 统一 `ProjectContext` / `ContextCompiler`

聊天规划和正式章节生成都必须调用同一编译器；每个区块要带来源、版本/hash、是否作者确认、字符/token 预算和是否允许发送给模型。

```text
ProjectContext
├── CreativeConstitution
├── StoryOutline                 # 仅全书/卷级规划
├── CurrentChapterOutline        # 当前章节规划
├── ChapterSeed                  # 当前章节种子
├── CharacterStates              # 角色目标、动机、当前状态、关系、弧线
├── CanonState                   # 已确认事实，不含整章正文
├── PromiseLedger                # 未结伏笔、承诺、兑现状态
├── PatternMemory                # 长期叙事模式（按策略授权）
├── PreviousChapterContinuation  # 前章末态/变化/悬念，不是全文
├── StyleProfile
└── SelectedEvidenceSpans       # 受限检索得到的原文片段
```

初始预算建议（按实际模型 tokenizer 计算，不能只用字符数）：

| 区块 | 默认上限 | 规则 |
|---|---:|---|
| CreativeConstitution + worldbuilding | 2,000 tokens | 缺失时按预检阻断或明确提示，不用模型猜作者设定 |
| StoryOutline | 4,000 tokens | 只保留与当前章节相关的卷/章摘要 |
| CurrentChapterOutline + ChapterSeed | 2,000 tokens | 当前章唯一写作意图和硬约束 |
| CharacterStates | 3,000 tokens | 只传当前章相关角色，保留来源 |
| CanonState + PromiseLedger + PatternMemory | 4,000 tokens | 去掉整章证据、重复事件日志和无关历史 |
| PreviousChapterContinuation | 800 tokens | 末态、人物变化、未结悬念、必要尾部短摘录 |
| SelectedEvidenceSpans | 2,000 tokens | 默认最多 3 段，每段有来源章节、offset、hash、用途 |
| 总输入预算 | 16,000 tokens（初始值） | 与输出预算、模型上下文窗口一起由 Preflight 校验 |

预算应集中配置并在 `contextManifest`、trace 和测试中可见。超预算必须压缩、缩小检索或阻断，不能静默把全文塞入。

### 4.4 前章续接与原文证据边界

正式生成接口删除或废弃生产路径的 `previousChapterText`。替换为：

```ts
interface PreviousChapterContinuation {
  chapterNumber: number;
  endingState: string;
  lastSceneSummary: string;
  changedCharacters: string[];
  unresolvedPromises: string[];
  tailExcerpt?: string;
  sourceChapterHash: string;
}
```

若生成确实需要查看前章原文，必须调用受限的 `search_chapter_span`（或等价接口），强制设置 `maxChars/maxTokens`、章节范围、查询目的和 trace 记录。禁止为了方便把全文写入 workspace input、prompt、trace 或 narrative state。

### 4.5 正式生成主链路边界

`generate_chapter` 只负责确认并提交 `novel_generate_chapter`；实际链路继续遵循项目统一主链路：

`Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → Agentic FactGuard → 作者风格整章优化 → StoryPreservation → FinalFactRecheck → Completeness → FinalStateCommit → AtomicSave + Trace`

不得新增聊天直写正文、one-shot raw 回退、legacy Stage0-8 回退或机器文学裁判旁路。

## 5. 分阶段开发任务

### Phase 0：基线、保护和契约冻结（P0）

- [ ] 在开始修改前记录当前工作树状态，保留所有已有用户改动；不得执行 reset、checkout、clean、stash drop 或覆盖式复制。
- [ ] 补充接口契约文档和错误码表，先冻结动作、artifact、context manifest、failure envelope 的字段语义。
- [ ] 为项目 128 导出只读快照/校验报告，后续数据修复必须可追溯、可回放。
- [ ] 建立本任务专用测试 fixture，包含“正常全书大纲 + 独立章节种子 + 角色/伏笔 + 第一章正文 + 过期 state hash”。

### Phase 1：数据边界与动作分类（P0）

- [ ] 明确 `story_outline` 只允许保存全书/卷级大纲；章节种子只写入 `novelChapterSeed`，章节大纲如需持久化必须有独立 document type 或明确的章节关联字段。
- [ ] 改造 assistant DTO、服务端和前端 API，显式传递 `action`、`chapterNumber`、生成确认状态。
- [ ] 将模型返回改为 schema 校验后的结构化 envelope；`artifacts` 由服务端按 action 白名单应用。
- [ ] marker 仅保留旧数据导入兼容，不得作为生产动作控制；普通聊天内容不得因为“像大纲”就写入 `story_outline`。
- [ ] 章节规划与全书规划必须有互斥保存测试；生成 marker 不得成为聊天消息中的隐式任务触发器。
- [ ] 对非法 action、缺章号、未确认生成、artifact 类型与 action 不匹配返回明确错误码。

### Phase 2：统一 ContextCompiler（P0）

- [ ] 新建或收敛一个被 AssistantService、JobsService 和 Runtime adapter 共同使用的 `ContextCompiler`。
- [ ] 按本文 `ProjectContext` 分层读取并编译全书大纲、当前章节种子、角色状态、worldbuilding、canon、promise、pattern、style 和前章 continuation。
- [ ] 所有区块附带 `sourceType/sourceId/sourceVersion/sourceHash/authorConfirmed/tokenBudget`；编译结果生成 `contextManifest`。
- [ ] 采用 tokenizer 计算预算；超过预算时执行确定性压缩或返回可解释 preflight failure，禁止静默截断关键字段。
- [ ] 过滤 `acceptedChapterEvidence`、整章正文、重复 event log、无关历史和 marker 污染；保留事实来源而不丢失必要的 sourceRef。
- [ ] 查询类动作可以按需检索证据，但仍必须受 span、token 和 trace 限制；不能绕过编译器直接查库拼 prompt。

### Phase 3：修复 JobsService 与 Novel Runtime（P0）

- [ ] 从生产调用路径移除 `previousChapterText` 全文参数，改为 `previousChapterContinuation` + `selectedEvidenceSpans`。
- [ ] 更新 `platform/services/novel-runtime` 的 workspace input 类型、落盘逻辑、HTTP invoke 适配和相关测试；生产 workspace 不得生成包含上一章全文的隐式文件。
- [ ] 保留 `novel_generate_chapter` 为唯一公开正文入口；内部工具不能被聊天面板直接调用。
- [ ] 在 Preflight 检查 context manifest 完整性、来源 hash、token 预算、角色/世界观必要资料、ChapterSeed 可生长性和 narrative state 一致性。
- [ ] 生成前发现 state hash mismatch 必须返回结构化阻断和修复建议，不能拿旧状态继续生成，也不能 silently degrade。
- [ ] 生成成功后按“正文原子保存 → 最终状态复检/提交”的事务边界更新 narrative state，并把新正文 hash 写回关联 sourceRef。
- [ ] trace 中记录 context manifest、证据范围和预算结果，但禁止记录整章前文或敏感凭据。

### Phase 4：聊天错误契约与前端体验（P1）

- [ ] 后端统一返回 `FailureEnvelope`：`stage/gate/code/severity/reason/evidence/recoverable/retryPlan/userActionRequired/fixInstructions`。
- [ ] 至少区分：历史加载失败、聊天消息保存失败、规划模型调用失败、artifact 保存失败、章节任务提交失败、Runtime 预检失败、正文生成失败、narrative state 提交失败、SSE 中断。
- [ ] SSE 事件采用稳定类型（delta、artifact、job_submitted、failure、done），失败事件保留错误码和 jobId；HTTP 非 2xx 也返回同一错误契约。
- [ ] `AssistantPanel.vue` 为历史加载、发送中断、任务已提交但正文未完成、可重试失败、需补资料阻断分别展示明确状态和下一步动作。
- [ ] 用户可见文案不得包含 stack、模型 provider、内部 URL、数据库字段、密钥或原始异常对象；完整证据只写服务端 trace。
- [ ] 失败消息不应伪装成正常助手回答；重新发送、重试同阶段和跳转资料页的行为要有明确边界。

### Phase 5：项目 128 数据修复与重生成（P0，必须在前四阶段可回放后执行）

- [ ] 先保存项目 128 当前 `story_outline`、`narrative_state`、第一章正文、第二章种子和相关 job/trace 快照；污染内容不得无审计删除。
- [ ] 将含 `[[CHAPTER_SEED_START]]`/`[[GENERATE_CHAPTER:2]]` 的错误大纲标记为历史污染/隔离产物，不得继续作为 `story_outline` 生产输入。
- [ ] 从用户确认的来源恢复真正的全书大纲；如果没有可靠来源，保持“缺少全书大纲”的可解释状态，不得让模型凭空补写为事实。
- [ ] 确认第二章 `novelChapterSeed` 独立存在，字段完整且与全书大纲无反向污染；章节规划页面只能读取该记录。
- [ ] 依据当前第一章正文重新计算正文 hash，修复 narrative state 的 `sourceRef`/hash；对整章接受稿 canon 做可审计压缩，只保留事实、角色变化和未结承诺。
- [ ] 从第一章提炼的角色状态、伏笔和 canon 只能作为待确认/有来源的状态写入；不确定信息不得直接升级为作者确认事实。
- [ ] 重新执行项目 128 Preflight；确认上下文清单包含大纲、章节种子、角色、canon、promise、style 和前章 continuation，且没有前章全文。
- [ ] 仅在预检通过后重新提交第二章任务；保存 jobId、contextManifest、trace、最终 state hash 和失败/恢复记录。

## 6. 数据迁移与兼容策略

1. 迁移必须是可重复、可审计、默认不破坏原证据的脚本或受控 service action；先快照，再变更，再校验。
2. 污染的 `story_outline` 不得直接覆盖为模型新输出；应保留原文和 `migrationSource/migrationReason`，生产编译器将其排除。
3. 旧 marker 解析器可以用于一次性导入，但不得继续让 marker 控制动作、保存或生成；代码中必须有测试证明生产路径不会依赖 marker。
4. 不保留 legacy/新链路双生产模式；迁移完成后生产只保留统一主链路，旧格式仅作为显式导入资产。
5. 对没有可靠来源的类型、世界观、角色动机、伏笔等字段，不得用默认文本冒充作者设定；应由 Preflight 返回补资料清单。
6. 任何删除或覆盖动作都必须先由迁移报告列出影响记录，并支持按项目/文档/章节回放验证。

## 7. 测试要求

### 7.1 单元测试

- [ ] action schema、动作与 artifact 白名单匹配、生成确认校验。
- [ ] 全书大纲与章节种子解析/保存互斥；污染 marker 不会进入 `story_outline`。
- [ ] `ContextCompiler` 的来源/hash、区块预算、确定性压缩、敏感字段过滤。
- [ ] `previousChapterText` 在生产生成请求、workspace manifest、prompt 和 trace 中均不存在；允许的 continuation 和 evidence span 受上限约束。
- [ ] narrative state hash 与正文不一致时返回指定 `state_store_hash_mismatch` 阻断；修复后可以通过。
- [ ] FailureEnvelope 的阶段、错误码、可恢复性和用户修复建议映射稳定。

### 7.2 API/集成测试

- [ ] `plan_story_outline` 只保存全书大纲，不创建章节生成任务。
- [ ] `plan_chapter` 只保存指定章节种子/章节大纲，不改写全书大纲。
- [ ] `query_project` 不写入作品数据，证据片段有长度、章节和 offset 限制。
- [ ] `generate_chapter` 只提交 `novel_generate_chapter`，不允许聊天服务直接生成正文。
- [ ] 角色、世界观、canon、promise、style 和前章 continuation 出现在 `contextManifest`，字段缺失时 Preflight 可解释阻断。
- [ ] 规划模型失败、保存失败、任务提交失败、Runtime 失败和 SSE 中断分别返回不同错误码，并正确关闭 billing/job 状态。

### 7.3 产品级/E2E 测试

- [ ] 使用隔离 fixture 模拟 Workbench：发送全书规划、章节规划、资料查询、生成第二章四种操作，检查 UI 状态、artifact 和任务状态。
- [ ] 生成第二章的 spy/trace 证明没有整章第一章正文进入 Runtime；如触发检索，只出现受限 span。
- [ ] 项目 128 修复后执行一次真实注册的 `novel_generate_chapter` 生产调用器回放，保存 trace 和最终状态。
- [ ] 现有 assistant/jobs/runtime 相关测试、typecheck、build 和项目规定的生产 replay 全部通过。
- [ ] 测试不得用 mock/preview/eval 路径冒充生产验收；若真实模型不可用，必须明确标记为“链路已验证、模型结果未验证”。

## 8. 验收标准

以下均为硬性验收项，任一不满足则状态为“未完成”：

| 编号 | 验收标准 | 证据要求 |
|---|---|---|
| A1 | 聊天动作显式、artifact 结构化，marker 不再控制生产动作 | API 契约、代码、单测、请求/响应样例 |
| A2 | `story_outline` 与 `novelChapterSeed` 完全隔离 | 数据库查询、迁移报告、隔离测试 |
| A3 | 正式生成请求不含完整上一章正文 | runtime spy、context manifest、trace、负向测试 |
| A4 | 角色、世界观、大纲、章节种子、canon、promise、style、前章 continuation 分层传入 | manifest 字段和来源/hash 证据 |
| A5 | 每个上下文区块受 token 预算控制，超限可解释阻断 | 预算测试和 Preflight failure |
| A6 | state hash mismatch 在生成前可解释阻断，修复后可通过 | 回归测试、项目 128 修复前后 hash |
| A7 | 聊天错误按阶段显示，历史/SSE/任务失败状态清楚 | 前端测试或录屏/截图 + 错误码映射 |
| A8 | 正文仍只经 `novel_generate_chapter` 统一主链路 | 工具注册、调用 trace、禁止旁路测试 |
| A9 | 项目 128 第二章重新生成前 Preflight 通过且无污染输入 | job、trace、manifest、最终 state 记录 |
| A10 | 现有用户改动未被覆盖，相关测试/build/typecheck/replay 通过 | `git diff`、测试报告、构建报告 |

## 9. 开发禁止事项

- 不得只修改 prompt 或增加一句“请不要传上一章全文”来声称完成；必须在类型、编译器、Runtime 输入和负向测试上形成硬边界。
- 不得继续依赖模型自由输出 marker 来触发保存、建章或生成任务。
- 不得把完整上一章正文放入 prompt、workspace input、narrative state、trace 或聊天历史上下文。
- 不得在缺少作者资料时用模型猜测填充事实、角色动机、世界观或伏笔，并将其标为已确认。
- 不得绕过 `novel_generate_chapter`，不得恢复 legacy/one-shot raw/机器文学裁判生产旁路。
- 不得把生成中的正文直接作为聊天回答交付；聊天只能展示任务状态和正式链路返回结果。
- 不得吞掉错误、静默回退或将内部异常原样显示给用户。
- 不得删除污染数据、旧 trace 或用户现有改动而不留快照和迁移证据。
- 不得修改与本任务无关的功能来“顺便清理”工作树。

## 10. 开发交付物

开发完成时必须同时提交：

1. 代码 diff 和数据库 schema/migration 说明。
2. API/事件契约文档及前端错误状态说明。
3. `ContextCompiler` 的区块、来源/hash、预算和过滤规则说明。
4. 项目 128 数据修复报告：变更前快照、变更后摘要、hash、被隔离的污染数据、人工待确认项。
5. 单元、集成、E2E、typecheck/build/replay 的命令和结果；失败项必须说明原因，不得只给“通过”结论。
6. 至少一份成功生成第二章的 `jobId`、`contextManifest`、quality trace 和最终 narrative state 校验结果。
7. 已知未完成项、残余风险和后续最小修复切片。

## 11. 开发完成后的核验清单（由本助手执行）

### 11.1 代码和架构核验

- [ ] 对照本文 A1-A10 逐项查找 live code、注册入口、调用链和测试，不以文档声明代替证据。
- [ ] 检查生产 `novel_generate_chapter` 依旧是唯一正文入口，内部工具没有被聊天 API 暴露为替代路径。
- [ ] 检查生产路径不存在 `previousChapterText` 全文传递；如保留历史类型，确认其不在生产构建/调用闭包中。
- [ ] 检查 AssistantService、JobsService、Runtime adapter 实际调用同一 `ContextCompiler`，而不是三套相似拼接逻辑。
- [ ] 检查 `story_outline`、章节种子和 artifact 保存的数据库边界及迁移测试。

### 11.2 数据和运行核验

- [ ] 查询项目 128 的全书大纲、第二章种子、角色、narrative state 和正文 hash；确认来源和版本一致。
- [ ] 回放一次第二章生成，查看 context manifest、Runtime 请求、trace 和 state commit；确认无整章前文、无污染大纲、无 hash mismatch。
- [ ] 复现至少一次模型失败、任务失败或 SSE 中断，确认前端错误可识别且 job/billing 不悬挂。
- [ ] 检查所有失败是否都有 FailureEnvelope；无 silent degrade、无内部敏感信息泄漏。

### 11.3 验证分级

核验报告必须把每项标记为：

- **Verified complete**：实现、测试和产品级证据均齐全。
- **Implemented but underverified**：代码存在，但缺少产品级回放或关键证据。
- **Partial**：只完成部分边界、数据或测试。
- **Blocked**：存在明确阻断项。
- **Not found**：没有找到 live implementation 证据。

重点检查“只通过 typecheck/单测但运行时仍串入全文”“只修了项目 128 但通用链路仍有同类问题”“错误文本变了但没有结构化错误码”这三类假完成。

## 12. 推荐执行顺序

`Phase 0 契约与快照 → Phase 1 动作/数据隔离 → Phase 2 ContextCompiler → Phase 3 Jobs/Runtime 硬边界 → Phase 4 错误 UX → Phase 5 项目 128 修复与真实回放 → 本助手核验`

在 Phase 1-4 的负向测试全部通过前，不得对项目 128 执行不可逆的数据覆盖或重新生成；否则新结果无法证明是整改链路产物。
