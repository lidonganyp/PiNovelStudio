---
name: novel-write
description: |
  章节生成行为铁律。当用户说"生成第X章/写下一章/走创作流程/生成正文/写一章/继续写/来一章"时，
  必须调用 novel_generate_chapter 工具，严禁 AI 自行撰写正文或大纲。
  本 Skill 定义 PI 创作界面 AI 在章节生成场景的唯一行为剧本。
---

# Novel Write — 章节生成行为铁律

> 本 Skill 取代旧 Writer's Room 阶段0-8 流程。legacy Stage0-8 已随 LEGACY-RUNTIME-REMOVAL-1 物理删除；
> 旧流程中"先列大纲 / 构建 ChapterSeed 展示 / 感知锚点搜索 / 阶段0→8 顺序执行"等步骤均已废止，不得执行。

## 唯一行为剧本（不可绕过）

当用户意图是"生成章节正文"时（触发词包括但不限于：生成第X章、写下一章、走创作流程、生成正文、写一章、继续写、来一章），AI 必须且只能执行以下三步：

1. **确认参数**：`workspaceId`、`chapterNumber`。用户未给则从当前 workspace 上下文推断，或询问用户。
2. **调用 `novel_generate_chapter` 工具**：传入 `workspaceId` + `chapterNumber`（+ 可选 `writerModel`）。这是章节生成唯一公开入口，走统一主链路（NovelOS Agentic → 作者风格整章优化 → 事实复检 → 状态提交/原子保存）。
3. **转告工具结果**：把工具返回的 `status` / `selectedSource` / `tracePath` / 章节文件路径 / `failureEnvelopes` 原文转告用户。

完成。**不许在调用工具前输出章节正文、章节大纲、ChapterSeed 内容、角色动机清单、事件列表、章末目标等任何"写前契约"作为最终产物展示给用户**——这些是工具内部输入，不是给用户看的"生成结果"。

## 严禁清单（违反任一条即等于绕过工具）

- ⛔ 严禁 AI 自行撰写章节正文（任何"第X章"标题下的正文段落）。
- ⛔ 严禁 AI 自行撰写章节大纲/章纲并作为生成产物展示。角色列表、意图、必须包含的事件、动机、章末目标这一类写作契约，是 `novel_generate_chapter` 内部 ChapterSeed 的输入，不是给用户看的"生成结果"。
- ⛔ 严禁在未调用 `novel_generate_chapter` 的情况下，输出"第一章生成即将开始""章节正在生成中，请稍候"等暗示已生成或正在生成的文案。
- ⛔ 严禁调用已删除的 legacy 工具：`novel_anchor_search` / `novel_narrator` / `novel_critic` / `novel_style_shaper` / `novel_emotion_metronome` / `novel_anti_ai_detector` / `novel_skeleton_consistency` / `novel_detail_ledger` / `novel_reader_expectation` / `novel_world_presenter` 等。这些已退役，由统一编排器内部调用，不作为外部入口。
- ⛔ 严禁按"阶段0→阶段8"顺序执行任何前置流程。legacy Stage0-8 已物理删除。
- ⛔ 严禁把"构建 ChapterSeed""感知锚点搜索""骨架抽取"等工具内部阶段当成对用户可见的步骤来展示。

## 工具失败时的处理（必须如实转告）

- 工具返回 `status: "blocked"` → 把 `report.blockingItems` / `failureEnvelopes` 原文转告用户，并附 `fixInstruction`。不要自己编"生成中"安抚用户。
- 工具返回 `status: "error"` → 把错误信息转告用户。不要自己重试生成正文。
- 工具未返回（调用超时/未发出）→ 明确告诉用户"工具未响应"，不要用自己写的文本冒充生成结果。

## workspace 不存在或未就绪时

如果 `workspaces/{workspaceId}/` 不存在或 `config.json` 缺失：
1. 调用 `novel_workspace_manager` 创建/确认 workspace（写入 `config.json` + 角色档案 + 世界观）。
2. 调用 `novel_plan_story_outline`（可选）生成 `series/outline.md` 高层背景。
3. 调用 `novel_preflight_workspace` 预检。
4. **然后必须调用 `novel_generate_chapter` 生成正文。**

严禁在 workspace 未就绪时，自己编一份"大纲"交差。

## 预检阻断时

`novel_preflight_workspace` 返回 `status: "blocked"` 时：
- 把 `report.blockingItems` 原文转告用户，附 `fixInstruction`。
- 不要绕过预检自行生成正文。
- 用户补齐缺失项后，重新调用 `novel_generate_chapter`。

## 用户评价或修改已交付章节时

当用户对刚交付的章节给出明确评价（满意/不满意/评分/选择）或提供修改稿时，调用 `novel_strategy_feedback` 把反馈接入作品级策略信誉：

1. 至少传 `workspaceId` + `chapterId`；普通自然语言评价传 `naturalLanguageFeedback`。
2. 用户给出修改稿时，同时传 `userFinalText` 与系统交付的 `deliveredText`，让工具自动计算修改差分。
3. 通常不需要手填 `modelVersion`、`selectedStrategyIds`、`sourceChapter`：工具会从该章成功 trace 推断；只有 trace 缺失或损坏时才向用户说明并补充明确上下文。
4. `novel_workspace_manager action="ingest_reader_feedback"` 仍是 advisory-only 读者信号，不能替代 `novel_strategy_feedback` 的策略学习记录。

不要把沉默或未表达的偏好自动推断成反馈；只有用户明确评价、选择或提交修改稿时才调用。

---

## 附录：历史 craft 知识参考（仅供理解上下文，不作为执行流程）

> 以下内容来自 legacy Writer's Room，正收益资产已迁移到统一主链路 `v2/core/` 的 craft 模块。
> AI **不需要执行**这些阶段；它们仅作为"什么是好小说"的背景知识保留，用于理解工具内部在做什么。
> 生成正文时由统一主链路内部消费，AI 不需要在生成前手动套用。

### 六条必删模式（AntiAIDetector 叙事策略层）

| # | 模式 | 描述 |
|---|---|---|
| 1 | 提前定性读者感受 | `[代词]+[感知动词]+[情绪名词]` |
| 2 | 先结论后证据 | 段落首句为抽象判断，后续句为细节铺陈 |
| 3 | 行为动机即时解释 | `[行为]，因为[原因]` |
| 4 | 多余的感知确认 | `他看见了/她听到了/他闻到了` |
| 5 | 情绪形容词堆叠 | 连续≥2个修饰性形容词在同一短语内 |
| 6 | 过渡句 | `就在这时/与此同时/事情发生了转折` |

> 如果一个句子删掉之后，读者感受到的东西反而更强——那这个句子必须删。

### 写作纪律参考（10条）

1. 从锚点细节开头，而非从"氛围"或"情绪概括"开头
2. 前三句内禁止命名任何情绪
3. 前三句内禁止使用感知确认动词
4. 禁止使用"因为"解释角色行为动机
5. 禁止使用"就在这时/与此同时"等过渡句
6. 禁止堆叠形容词
7. 每段至少含一个可被触摸/闻到/听到的具体细节
8. 情绪通过身体反应和外化行动传递
9. 章末不允许使用总结句
10. 悬念通过未完成的细节悬置实现
