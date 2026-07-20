# 小说提示词公开来源审查与主链路落地报告

日期：2026-07-19

> 生产准入更新（2026-07-19）：15 个完整 A/B case 中，场景解法 B 相对普通 raw
> 为 10/15 胜、八维均分 +0.558；但绝对同档率仅 13.33%，核心三项平均增量
> +0.444，未通过任务卡严格准入。依据用户“相对正收益即可进入受控候选”的明确
> 授权，生产只启用 B：它仅在 raw 存在可引用编辑机会时生成，并继续经过
> FactGuard、异源 pairwise judge 和 raw 回退。提示模式 C 在旧 8-case 实验中低于
> B 0.125，且正文约为 raw 的 1.39 倍，现已休眠。正式记录见
> `reports/novel-quality-ceiling-20260719/production-positive-gain-admission.md`。

## 结论

公开资料没有支持“单条风格注入词稳定生成优秀长篇章节”的可靠证据。可读取的开源项目多数采用分阶段工作流：

```text
作品状态与前文
→ 本章目标/场景决策
→ 正文生成
→ 一致性与质量审查
→ 最小修订
→ 状态更新
```

这与《心魔界》第 18 章真实 A/B/C 结果一致：ordinary raw 的八维均值为 3.375；加入场景解法搜索后为 4.000；再加入可迁移工艺基因为 4.250。该结果是单章诊断证据，不足以批准生产默认策略。

因此本轮没有把“仿写某作者”或视频中的“神级指令”直接塞入普通生产 raw，而是落地了带来源、状态与准入审计的 `PromptPatternLibrary`。真实验证没有证明提示模式 C 在场景搜索 B 之上有增量，四条模式已转为 `dormant`；生产正收益来自独立的 B 候选源。

## 来源分级

| 来源 | 已读取材料 | 许可 | 证据等级 | 可提炼信息 |
|---|---|---|---|---|
| [chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill/blob/master/SKILL.md) | `SKILL.md`、目录 | 未声明 | 中 | 先规划后逐章、行动/对白承载、章节承接；固定冲突/钩子要求不采纳 |
| [show-me-the-story](https://github.com/Nigh/show-me-the-story/blob/main/README.md) | README、目录、LICENSE | MIT | 中 | 结构化设定、叙事记忆、伏笔状态、事实检查、引用式最小修订 |
| [tianming-skill](https://github.com/zy-zmc/tianming-skill/blob/main/SKILL.md) | `SKILL.md`、LICENSE、根目录 | CC-BY-NC-SA-4.0 | 中 | 模块化提示、动态状态覆盖静态设定、成本/状态映射；不复制其文本 |
| [gptauthor](https://github.com/dylanhogg/gptauthor) | README、根目录、LICENSE | MIT | 中 | 长篇按阶段生成、先结构再章节 |
| [dreampowers](https://github.com/skyfiredao/dreampowers) | README、根目录、LICENSE | GPL-3.0 | 中 | draft/review/consistency 职责分离 |
| [StoryMemory-Studio](https://github.com/Jackeyhate9/StoryMemory-Studio/blob/main/README.md) | README、根目录、LICENSE | MIT | 中 | 结构化记忆、上下文预算、一致性与 AI 腔检查 |
| [novel-writing-skill](https://github.com/EchoAI-Design/novel-writing-skill/blob/main/SKILL.md) | `SKILL.md`、prompt 目录 | 未声明 | 中 | 项目/世界/角色/章节/审查/风格模块分离 |
| [ai-novel-writing-app](https://github.com/JamesFletty/ai-novel-writing-app/blob/main/ENHANCED_PROMPTING_GUIDE.md) | 提示指南、README、LICENSE | MIT | 中 | structure/character/prose 多阶段；固定段落、对白占比等指标不采纳 |
| 本地 A/B/C 报告 | 完整结果、judge 维度证据 | 项目内部 | 高但样本窄 | 场景搜索与工艺基因单章正增量；过早解释和模板句仍是瓶颈 |

说明：GitHub 匿名 API 在进一步读取具体文件时触发 rate limit。表中“已读取材料”仅列实际成功取得的内容；未取得的文件不用于结论。

## 视频平台核验

Bilibili 公开搜索接口可读取标题、作者、播放、收藏、标签和部分简介，但通常不能取得视频中展示的完整 prompt。以下只能作为市场线索，不能作为模式效果证据：

| 视频 | 搜索时公开数据 | 处理 |
|---|---|---|
| [BV1Qc6nBCEsa](https://www.bilibili.com/video/BV1Qc6nBCEsa) 从 0 到 1 拆解 AI 网文提示词 | 约 2.43 万播放、2183 收藏 | `video_metadata`，不推断未公开 prompt |
| [BV1Xo5D6TEaK](https://www.bilibili.com/video/BV1Xo5D6TEaK) 小说润色指令 | 约 4.43 万播放、4388 收藏 | `video_metadata`，营销性标题不作质量证据 |
| [BV1C9GU6CEbK](https://www.bilibili.com/video/BV1C9GU6CEbK) 去除小说 AI 味 | 约 1.13 万播放、471 收藏 | 只记录主题，不提炼具体规则 |
| [BV1ViQFBJEas](https://www.bilibili.com/video/BV1ViQFBJEas) 百万字生成经验 | 先前公开检索约 28.5 万播放、7300 收藏 | 仅元数据线索，未取得完整提示词 |
| [BV1dT5uzzEHL](https://www.bilibili.com/video/BV1dT5uzzEHL) 编辑点评 AI 开头 | 先前公开检索约 9.8 万播放 | 可作为人工审稿方向线索，非 prompt 证据 |

YouTube 在本轮环境连接失败。Gitee 搜索页可访问，前端显示使用 `so.gitee.com/v1` 和固定 widget，但公开查询契约未能可靠复现；旧 v5 搜索接口没有返回可用仓库字段。因此本轮没有将任何 Gitee/YouTube 结果写入运行时模式来源。

## 采纳模式

以下模式已进入 `data/runtime/prompt-pattern-library.json`。没有提示模式处于 `active`；四条旧 C 组合模式为 `dormant`，其余保持 `candidate`。场景搜索 B 由独立候选生成器接入，不通过提示模式库伪装成 prompt 增益：

| ID | 用途 | 当前证据 | 准入状态 |
|---|---|---|---|
| `scene_decision_evidence_cost_delta` | 选择→验证→代价→状态变化 | C 相对 A 有收益，但对 B 无增量 | dormant |
| `information_ownership_and_unknowns` | 角色已知/误判/未知影响选择 | C 相对 A 有收益，但对 B 无增量 | dormant |
| `previous_ending_to_first_scene` | 首场景承接前章悬置状态 | 多个长篇项目共同采用 | candidate；现有 bridgeContext 已部分覆盖 |
| `preserve_explanatory_gap` | 只确认局部规则，保留解释失败 | C 相对 A 有收益，但对 B 无增量 | dormant |
| `dialogue_changes_relationship_or_decision` | 对白承担试探、隐瞒、协商和施压 | C 臂同档，但未独立消融 | candidate |
| `causal_ending_pressure` | 章末压力来自本章选择后果 | C 相对 A 有收益，但对 B 无增量 | dormant |
| `generate_review_minimal_revision` | 生成/审查/最小修订分离 | 多个开源工作流交叉支持 | candidate；与现有主链路一致 |
| `bounded_search_for_high_value_chapters` | 高价值章节有限场景搜索 | 15-case B 相对 A 胜率 66.67%、均分 +0.558 | candidate 元策略；B 已由独立候选源接入 |

## 明确拒绝

以下公开提示写法不进入项目：

- “你是知名作家/白金作者”一类角色宣称，没有操作性输入。
- 模仿指定作者、作品、角色、设定、原句或所谓思维链。
- 每章固定反转、冲突、钩子数量。
- 固定对白比例、段落数量、段落字数或情绪曲线配额。
- 强制开头公式、强制章末空降黑影/声音。
- 只写“生动、细腻、无 AI 味”而不给证据、选择、代价和状态输入。
- 以视频播放量、收藏量、签约或收入宣称替代盲评和用户接受证据。

## 主链路实现

运行路径现在为：

```text
runUnifiedPipeline
→ loadPromptPatternLibrary
→ validate schema / provenance / bounded text
→ production 只选 active；当前 0 条 active，evaluation 可显式选择 candidate
→ buildRawPrompt 只消费抽象 promptBlock
→ stageResults.promptPatterns 记录 discovered / selected / dropped / reason
```

安全边界：

- 库缺失、JSON 损坏或 schema 非法时回退 ordinary raw。
- 作者/作品模仿词和机械配额在 schema 验证阶段被拒绝。
- 来源 URL、许可证、实验 reference、sourceId 不进入生成 prompt。
- 最多选择 4 个模式，每条文本和列表长度有上限。
- `active` 必须同时满足 `sampleSize >= 8`、`validatedWinRate >= 0.55`，并带高置信 `experiment_report` provenance；手改状态不能绕过准入。
- 当前库有 0 条 `active`。普通 raw 保持不注入；只有 raw 存在可引用编辑机会时才生成一个 B 候选，C 不生成。

## 提示词优化判断

项目现有 `ChapterContract` 已覆盖目标、已知事实、选择、代价、状态变化和因果章末压力，方向正确。当前更大的缺口不是增加通用形容词，而是 ChapterIntent 的真实输入常为空：`choicesAndCosts`、`expectedIrreversibleChange`、`causalEndPressure` 和人物知识边界缺少可靠 seed 证据。场景解法搜索现已在生产入口按可引用 raw span 机会受控运行，失败时回退 ordinary raw。最终 15-case A/B 结果证明相对增益存在，但绝对质量线未通过；下一步应改进方案卡选择与章节闭合，而不是恢复 C 或继续堆风格词。

下一轮有效验证应比较：

```text
A ordinary raw
B 场景解法搜索后 raw
C 场景解法搜索 + 显式 candidate 模式
```

下一轮应优先验证改进后的方案卡选择、不同章节类型和多个 seed，并同时记录八维盲评、人工选择、用户修改量与连续 3–5 章状态漂移。未完成这些验证前，不得宣称达到 reference 同档或把提示模式改为 active。

## 本轮验证

- `npm run build`：通过（prod / eval / test 三套 TypeScript 构建）。
- B 候选、准入、schema、prompt 状态与场景搜索聚焦测试：41/41 通过。
- 公开 `novel_generate_chapter` 生产入口 smoke：2/2 通过。
- `npm test`：2732 pass / 0 fail / 8 skipped。
- 生产依赖边界：20/20 通过；额外 `npm run typecheck` 通过。
- `git diff --check`：通过。
- 运行时库：0 条 active / 4 条 dormant / 4 条 candidate；production 不向 raw 或 B 注入 C 的提示模式。

这些代码结果证明来源审计、隔离、回退和 trace 机制已接入；真实 15-case 结果只证明 B 相对 raw 有正收益，不证明达到 reference 同档。
