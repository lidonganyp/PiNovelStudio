# Workbench 聊天上下文契约（冻结稿）

> 配套任务单：`workbench-chat-context-remediation-20260821.md`
> 冻结日期：2026-08-21
> 字段名可按现有 API 风格微调，语义不得改变。

## 1. 动作

| `action` | 允许写入 | 可提交正文生成 |
|---|---|---|
| `plan_story_outline` | `story_outline`（全书/卷级） | 否 |
| `plan_chapter` | 指定章节 `novelChapterSeed` | 否 |
| `query_project` | 无作品数据写入 | 否 |
| `generate_chapter` | 仅提交 `novel_generate_chapter`；允许补当前章种子作为生成前置 | 是，且必须 `confirmGeneration=true` |

未选择动作时，HTTP 请求非法。模型自由文本、`[[OUTLINE_*]]` / `[[CHAPTER_SEED_*]]` / `[[GENERATE_CHAPTER:n]]` 不得单独决定保存或生成。

## 2. 请求 / 响应

```ts
interface AssistantRequest {
  content: string;
  action: AssistantAction;
  chapterNumber?: number;      // plan_chapter / generate_chapter 必填
  confirmGeneration?: boolean; // generate_chapter 必须为 true
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

## 3. SSE 事件

稳定 `type`：`delta` | `artifact` | `job_submitted` | `failure` | `done`。

失败事件与 HTTP 非 2xx 共用 `FailureEnvelope`：

```ts
interface FailureEnvelope {
  stage: string;
  gate: string;
  code: string;
  severity: 'preflight' | 'recoverable' | 'hard' | 'fatal';
  reason: string;            // 用户可见，无 stack / provider / 密钥
  evidence?: unknown;        // 服务端 trace 可含细节；响应体需消毒
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: string[];
  fixInstructions?: string[];
}
```

错误码（最低集）：

| code | stage |
|---|---|
| `history_load_failed` | assistant.history |
| `message_save_failed` | assistant.persist |
| `planner_failed` | assistant.planner |
| `artifact_save_failed` | assistant.artifact |
| `illegal_action` | assistant.action |
| `artifact_action_mismatch` | assistant.artifact |
| `generation_unconfirmed` | assistant.generate |
| `missing_chapter_number` | assistant.action |
| `job_submit_failed` | jobs.submit |
| `runtime_preflight_failed` | runtime.preflight |
| `state_store_hash_mismatch` | runtime.preflight |
| `generation_failed` | runtime.generate |
| `narrative_state_commit_failed` | runtime.commit |
| `sse_interrupted` | assistant.sse |

## 4. ContextManifest

每个区块：`sourceType / sourceId / sourceVersion / sourceHash / authorConfirmed / tokenBudget / tokensUsed / included`。

区块名：`creativeConstitution` `worldbuilding` `storyOutline` `currentChapterOutline` `chapterSeed` `characterStates` `canonState` `promiseLedger` `patternMemory` `previousChapterContinuation` `styleProfile` `selectedEvidenceSpans`。

默认预算见任务单 §4.3。超预算必须压缩或返回 preflight failure，禁止静默塞入全文。

## 5. 前章续接

生产路径禁止 `previousChapterText`。替换为：

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

原文检索最多 3 段，每段有章节号、offset、hash、用途和 token 上限。
