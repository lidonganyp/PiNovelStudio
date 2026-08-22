# Workbench 聊天上下文整改交付报告

日期：2026-08-21
任务单：`docs/tasks/workbench-chat-context-remediation-20260821.md`
契约：`docs/tasks/workbench-chat-context-contract-20260821.md`

## 1. 工作树保护

开始前未执行 reset / checkout / clean / stash drop。已有用户改动全部保留并被本轮接续：

- `book-context.ts` 及其测试：污染大纲过滤、narrative compact、前章末句摘录
- Jobs 注入全书工作集、openPromises 伏笔
- Runtime `chapter-{N}.md` 路径修正、continuity 目录
- Assistant prompt 注入 bookContext

取舍：Runtime 不再把 `previousChapterText` 写成章节全文，也不再静默重锚 hash。Hash 失配改在平台 ContextCompiler 生成前阻断；项目 128 的重锚由受控修复脚本完成。

## 2. 代码与契约

- 动作：`plan_story_outline` / `plan_chapter` / `query_project` / `generate_chapter`
- 前端必须显式传 `action`；`generate_chapter` 必须 `confirmGeneration=true` 且有章节号
- marker 只作结构化解析，不再单独触发保存或生成
- `story_outline` 与 `novelChapterSeed` 按动作白名单隔离
- 统一 `compileProjectContext()`：AssistantService 与 JobsService 共用
- 生产 invoke 不再传 `previousChapterText`；改为 `previousChapterContinuation` + `contextManifest`
- Runtime 只写 `chapter-continuity/{N}.json`，不写上一章全文
- NovelOS preflight 可用 continuity hash 代替章节全文文件
- SSE：`delta` / `artifact` / `job_submitted` / `failure` / `done`
- 前端动作选择器、历史加载失败、失败横幅、任务已提交提示

## 3. 项目 128 数据修复

快照：`docs/tasks/project-128-snapshots/snapshot.json`

| 项 | 修复前 | 修复后 |
|---|---|---|
| story_outline id=83 | 486 字，含 `[[CHAPTER_SEED_START]]` / `[[GENERATE_CHAPTER:2]]` | `story_outline_isolated`，生产编译器排除 |
| narrative_state id=84 | 58976 字，含第一章接受稿 | compact + 去掉 accepted-chapter 全文 |
| ch1 hash | DB sourceRef `39e1530b9e06` | 重锚为当前正文 `6a762891b807` |
| 第二章种子 | 独立存在（id=197） | 未覆盖 |
| 类型/简介 | 空 | 未用模型猜测填充 |

**未执行**：重新提交第二章 `novel_generate_chapter`。第二章已有 2798 字正文；真实模型回放需授权和预算。链路已用 spy 验证无全文串入。

## 4. 测试与构建

```text
cd platform/apps/api && npx vitest run src/modules/context src/modules/assistant src/modules/jobs
# 9 files, 55 tests, pass

cd platform/services/novel-runtime && npm test
# 121 tests, pass

cd platform/apps/api && npm run typecheck   # pass
cd platform/apps/web && npm run typecheck   # pass
cd platform/services/novel-runtime && npm run typecheck  # pass
```

Novel-studio preflight 新增 continuity snapshot 用例；需 `npm run build:test` 后再跑 `.pi/extensions/novel-studio` 套件（本次未跑完整 extension replay）。

前端无独立单测；Workbench UI 未在浏览器端到端点击验证。

## 5. P1 续修（2026-08-21 晚）

已补 4 个核验缺口：

1. 规划生产输出改为 JSON envelope；marker 只在禁止说明中出现，不再作为保存/生成控制面。
2. 聊天规划加载 constitution / worldbuilding / style / seed / 章纲 / 证据片段；`generate_chapter` 才强制 state hash。
3. `bookBrief` 只拼 clipped 区块并再次受总预算约束。项目 128 预检 `bookBriefTokens=775`，`previousChapterFullTextInBrief=false`。
4. SSE 走 `envelopeFromUnknown`；消息保存/历史加载有错误码；前端重试使用 `lastPayload`，不再发送空输入。

项目 128 第二章预检见 `docs/tasks/project-128-snapshots/chapter-2-preflight.json`：hash 检查通过，但类型/简介/大纲/角色状态/canon/伏笔仍缺作者确认，**未提交生成**。

## 6. 任务 FailureEnvelope 贯通（2026-08-21 夜）

- `novel_generation_jobs.failure` JSONB 已迁移并 deploy。
- Runtime 阻断 / hash mismatch / state commit 失败写入 `{stage,gate,code,severity,reason,recoverable,retryPlan}`。
- `getJob()` 返回 `failure`；任务面板展示 code/stage/gate、修复说明，仅 `recoverable !== false` 时显示重试。
- 回归：`job-failure.spec.ts` 4 项 + jobs.service 26 项通过。

A9 与浏览器登录验证仍未做。作者资料缺口仍在，未提交第二章生成。

## 7. 已知未完成

1. 项目 128 的 `genre` / `description` / 角色动机仍为空，Preflight 应继续提示补资料，不得冒充作者设定。
2. 第一章种子 `intent` 仍夹带旧 marker 文本，未在本次改写（避免覆盖用户种子）。
3. 未做真实模型的第二章生产回放；状态为 **链路已验证、模型结果未验证**。
4. 全书大纲隔离后生产输入为“缺少全书大纲”，需用户确认后才能恢复真正大纲。
5. E2E Playwright 仍依赖 `E2E_BASE_URL`，本次未跑浏览器。
