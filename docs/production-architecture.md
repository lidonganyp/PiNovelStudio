# 生产架构说明

**状态**：生产基线
**核对日期**：2026-08-19
**路由真相源**：[`config/model-routing.json`](../config/model-routing.json)（v4.32.0）

本文只描述当前生产代码。旧 Stage0–8、固定多候选、机器文学裁判和 one-shot raw 流程属于隔离评测或历史资料，不是生产章节生成路径。

生产入口还受 G6 发布治理门禁保护：运行时优先读取部署环境的 `active-production.json`，指针缺失时仅允许读取已密封的 production identity pack；随后验证对应 release 的审批、行为身份和环境指纹。仓库里的 Git 忽略状态文件不是版本控制文档的真相源。

## 1. 唯一入口

生产章节只能经由 `novel_generate_chapter`：

```text
novel_generate_chapter
  → handlers/public-handlers.ts:handleGenerateChapter
  → v2/core/unified-entry.ts:runUnifiedPipeline
  → v2/core/unified-orchestrator.ts
```

`index.ts` 只注册生产公开工具；生产编译目标是 `dist/`。`dist-eval/` 和 `dist-test/` 分别承载评测与测试闭包，不能被生产入口导入。依赖边界由 `tests/dependency-boundary.test.mjs` 守护。

## 2. 生产阶段

```text
G6 Production Release Gate
  → active_prod / approval / behavior identity / environment fingerprint
  → 不通过则 preflight hard block（不调用模型、不写章节）

Preflight
  → ContextCompiler
  → ChapterIntentBuilder
  → NovelOS Agentic（检索、起草、验证/修补）
  → Agentic FactGuard
  → 作者风格整章优化
  → Story Preservation
  → FinalFactRecheck
  → Completeness
  → FinalStateCommit
  → Atomic Chapter Save + Trace
```

关键语义：

- Agentic 初稿是内部证据，不能直接交付或保存。
- 作者风格整章优化是必经阶段；缺少风格档案、无有效优化稿或事实/故事保持失败都会阻断。
- 模型超时、连接异常等可恢复失败带有 `severity=recoverable` 和 `gate=model_timeout`，工具层最多按策略重试一次；不在同一运行中换正文模型。
- 生产不调用 `EditorialOpportunityJudge`、`PairwiseJudge`、`SelectionPolicy` 或 GPT 文学裁判。文学质量由用户通过最终正文和反馈评价。
- 所有失败都形成 `FailureEnvelope`，并写入工作区 trace；不会静默交付未优化初稿。
- G6 门禁失败使用 `stage=g6_release_gate`、`severity=preflight`、`degradedTo=hard_block`；生产不会读取未审批 candidate，也不会因环境指纹漂移自动接受当前工作树。

## 3. 模型与 API 路由

| 用途 | 路由 | provider / model | 端点 | fallback |
|---|---|---|---|---|
| 默认 Agentic 初稿 | `v2_rawstage2_gemini31` | `gemini31 / gemini-3.7-flash` | `GOOGLE_GEMINI_BASE_URL`（当前 Aimagichub） | `[]` |
| 默认作者风格优化 | `v2_amplified_gemini31` | `gemini31 / gemini-3.7-flash` | 同上 | `[]` |
| 显式 Claude 正文 | `v2_rawstage2` / `v2_amplified` | `claude / claude-opus-4-6` | 按配置与 `.env` | `[]` |
| 文学 judge | `v2_opportunity_judge` / `v2_literary_judge` | `gpt / gpt-5.6-sol` | 评测/回放 | 生产禁用 |

生产默认使用 `gemini-3.7-flash`。配置仍保留 `gemini31` 这个 provider/route 名称，是为了兼容既有 trace 和协议字段，不表示仍在调用 Gemini 3.1 Pro。

默认 Gemini 的环境变量为：

```env
GEMINI_API_KEY=...
GOOGLE_GEMINI_BASE_URL=https://aimagichub.xyz/v1
GEMINI_MODEL=gemini-3.7-flash
```

`GEMINI_SOLOV_*`、`GEMINI_AIMAGICHUB_*` 只是 `.env` 中的预留比较变量；当前生产路由只读取 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL`，不会自动在 Aimagichub 与 Solov 之间切换。故障时本次运行阻断，用户显式重新发起另一 writer 运行才会换模型/线路。

## 4. Workspace 前置条件

`novel_preflight_workspace` 与生成入口共享预检逻辑。生产至少需要：

- `workspaces/{id}/config.json`：可解析，包含 `genre`、`subGenres`、`characters`；字数预算必须合理。
- `workspaces/{id}/characters/`：至少一个角色 Markdown 档案。
- 风格档案：优先 `workspaces/{id}/styles/profile.json`，否则使用 `styles/profiles/{config.styleProfile}.json`；两者都没有会阻断。
- 第 2 章及以后：`narrative-state-store.json` 必须能证明上一章已提交且章节文件 hash 一致。旧 workspace 可暂时使用 `series/skeleton.json` 兼容回退。
- `ChapterSeed` 必须达到可生长性要求；不足时补充种子源，而不是用空章纲硬写。

以下不是必需前置：

- `series/outline.md`：只作为高层背景参考，缺失不阻断。
- `series/ch{N}-outline-explicit.md`：存在时必须能解析事件、内容摘要和参与角色；不存在时走默认 ChapterSeed 链路。
- `data/runtime/manifest.json`：缺失只产生警告，检索能力相应减少。

## 5. 提交、回滚与可观测性

成功提交的顺序是：

1. 对 `chapters/{chapterId}.md` 做临时文件写入后 rename 的原子保存。
2. 根据最终正文重锚定并提交 `narrative-state-store.json` 的四类长期状态：CanonState、CharacterState、PromiseLedger、PatternMemory。
3. 状态提交失败时恢复原章节文件并返回阻断；不会留下“正文已更新、状态未更新”的成功结果。
4. 状态桥接、收尾和 progression 文件是可重建的 advisory cache，失败写入 trace/warning，不改变权威状态。

每次运行至少应能在 `workspaces/{id}/traces/{chapterId}-quality-trace.json` 找到路由锁、模型调用、阶段结果、失败 envelope、保存和状态提交证据。生产入口还会保留必要的作者风格人工审阅包，供用户反馈回流。

## 6. 构建隔离

```text
tsconfig.prod.json  → dist/       生产入口及其传递依赖
tsconfig.eval.json  → dist-eval/ NovelBench / 回放
tsconfig.test.json  → dist-test/ 测试专用模块
```

生产发布只需要验证 `dist/` 闭包；评测结果不能自动改变生产路由。

发布前还必须在同一干净提交、同一构建产物和同一运行环境下重新 capture/verify release。`PINOVEL_DEV_MODE=1` 只用于开发、测试或隔离评测，不得作为生产运行配置。
