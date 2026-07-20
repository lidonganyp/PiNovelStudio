---
name: novel-write
description: |
  PiNovelStudio 历史创作流程参考文档。
  当前章节生成唯一公开入口为 novel_generate_chapter；
  本文仅保留 Writer's Room 阶段设计与内部 Agent 调用说明。

  不作为公开入口触发；"生成第X章"、"写下一章"、"走创作流程"
  均应路由到 novel_generate_chapter。
---

# Novel Write — 历史阶段流程参考

> **文档状态**：历史主流程 Skill 文档。当前章节生成唯一公开入口为 `novel_generate_chapter`；下文出现的 `novel_narrator` / `novel_critic` 均指统一编排器内部阶段调用，不代表外部独立入口。
>
> 核心理念：从"信息层流水线"升级为"感知层驱动的回写闭环"
> 大纲是写完之后的总结，不是写之前的蓝图

## 前置条件

开始前必须确认：
1. 当前 workspace 已初始化 (`workspaces/{current}/config.json` 存在)
2. ChapterSeed 可构建（角色档案、前章 `skeleton.json`、`narrative-state.json`、未结账细节等种子源就绪；第 1 章例外，不需要前章 skeleton）
3. 出场角色档案存在于 `characters/`
4. SeedReadinessChecker 通过（`ready` 或 `warning`）

`series/outline.md` 若存在，仅作为高层背景/主题/不可违背事实参考，不作为生成前置条件，也不编译为事件蓝图。

不满足时，提示用户补充种子源（角色状态、当前压力、未结账细节、世界约束、候选感知锚点），不得要求用户"补章纲"。

## 执行流程

严格按以下阶段顺序执行。每个阶段完成后检查产物是否合格。

### 阶段0: 上下文加载 + ChapterSeed 构建

使用 `read` 工具加载:
- `workspaces/{current}/config.json`
- `workspaces/{current}/series/unsettled-details.json` (细节资产库)
- `workspaces/{current}/series/skeleton.json` (前章骨架；第 1 章例外)
- `workspaces/{current}/series/narrative-state.json`
- `workspaces/{current}/series/foreshadowing-tracker.json` / `arc-registry.json`
- `workspaces/{current}/characters/` (角色档案)
- `styles/{target}/profile.json` (风格指纹)
- `data/fewshots/` (与场景类型相关的黄金示例)
- `workspaces/{current}/series/outline.md` (可选，仅高层背景参考)

构建 ChapterSeed（由 `ChapterSeedBuilder` 聚合上述来源）：
- `worldConstraint` / `characters` / `previousChapterContinuation` / `currentPressure` / `unsettledDetails` / `candidateAnchors` / `intent`

通过 `SeedReadinessChecker` 门禁：
- `ready` / `warning` → 继续
- `blocked` → 阻断，提示补种子源（不提示补章纲）

### 阶段1: 感知锚点搜索（Architect.searchAnchors）

调用 `novel_anchor_search` 工具，基于四步法生成 5-15 个感知锚点：
1. **步骤1**：从角色档案和场景描述中提取身体层面感官触点
2. **步骤2**：检查世界观规则 → 找出可能被打破的规则
3. **步骤3**：检索前文章节中与该场景相关的重复意象
4. **步骤4**：检查世界中"不变的事物" → 标记其中可被破坏的项

产物：锚点清单（替代原 DAG 蓝图）

### 阶段1.5: 读者预期写前规划（章节≥5时启用）

**调用工具**：`novel_reader_expectation`

章节编号 ≥ 5 时，在锚点搜索后自动调用 REM Agent 进行写前规划：
- 加载 `expectation-ledger.json`（预期债账本）
- 识别本章需要兑现的预期债（`debts_to_repay`）
- 识别本章可以新建的预期（`new_borrows`）
- 确定禁止的钩子类型（多样性保护）
- 生成 `<rem_chapter_directive>` XML 约束块

**产物**：
```json
{
  "chapterId": "ch_XXX",
  "lifecycleStage": "build|maintain|fulfill|return",
  "chapterType": "climax|transition|cooling|return",
  "debtsToRepay": [...],
  "newBorrows": [...],
  "forbiddenHookTypes": [...],
  "targetExitEmotion": "紧张+期待（强度7-8）",
  "hookFloorMin": 7.0
}
```

### 阶段1.6: 世界观投放策略规划（章节≤20时启用）

**调用工具**：`novel_world_presenter`

章节编号 ≤ 20 且世界观条目存在时，调用 WorldPresenter 进行投放策略规划：
- 加载 `world-items.json`（世界观条目库）
- 生成 `release-map.json`（信息释放地图）
- 识别本章应投放的世界观信息
- 分配嵌入技法（冲突暴露/信息不对称/道具暗示等）

> 世界观展示与构建必须分离——两评判视角混在一起产生目标冲突。

### 阶段2: 锚点驱动生长叙事（Narrator 逐步生成）

由 `novel_generate_chapter` 内部调用 `novel_narrator`:
- Narrator 选择锚点开始写作
- 每次写完一个场景单元（~500字）
- 立即调用 `novel_anti_ai_detector` 扫六条必删模式
- 不通过则重写当前单元（最多2轮）
- 叙事状态机注入：`buildEventPrompt()` 自动注入叙事状态卡片
- StateObserver 回调：状态敏感型事件自动触发状态提取

**【嵌入 REM 约束】**
将阶段1.5生成的 `<rem_chapter_directive>` XML 块注入 Narrator System Prompt 末尾

**四步感知锚点生成法：**
1. 锚点定位：从当前事件中提取一个感知锚点
2. 感知展开：从锚点出发，按感知链展开描写
3. 行为注入：在感知展开中插入角色行为
4. 收束留白：段落结尾收束到一个未完成的感知

**写作纪律（10条）：**
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

### 阶段3: 局部骨架抽取 + 一致性验证

**调用工具**：`novel_skeleton_consistency`

**阶段3a: 骨架抽取**
- 调用 `Architect.extractSkeleton()` 从章节文本生成 ChapterSkeleton
- 提取内容：事实列表、状态变化、悬而未决的问题

**阶段3b: 一致性检查**
- 加载全局骨架 `skeleton.json`（累积的历史骨架）
- 调用 `SkeletonConsistencyChecker.checkConsistency()` 执行四项检查：
  1. **事实矛盾检测**（FACT_CONTRADICTION）：与前文章节事实对比
  2. **状态逆转检测**（STATE_REVERSAL）：状态突变是否有铺垫
  3. **世界规则违规检测**（RULE_VIOLATION）：硬规则不可违背
  4. **角色一致性检查**（RELATIONSHIP_INCONSISTENCY）：能力/关系/位置

**阶段3c: 冲突处理**
- 通过 → 增量更新 `skeleton.json`，进入阶段4
- 失败 → 生成重写约束，返回阶段2重写（最多2轮）

**产物**：
```json
{
  "status": "blocked" | "success",
  "skeleton": { "facts": [], "stateChanges": [], "activeDilemmas": [] },
  "conflicts": [{ "type": "FACT_CONTRADICTION", "severity": "critical", ... }],
  "rewind": { "action": "rewrite_segment", "constraints": [], "maxRounds": 2 }
}
```

**冲突回退机制**：
- `novel_skeleton_consistency` 返回 `status: "blocked"` 时
- 从 `rewind.constraints` 获取具体冲突描述
- 将约束作为额外上下文传入内部 `novel_narrator` 阶段，要求针对冲突段落重写

### 阶段4: 未结账细节更新

调用 `novel_detail_ledger`:
- `scan` 操作：入库新细节（信息密度超标 + 孤立未处理）
- `checkResolution`：检查是否有旧细节被唤回
- 增量更新 `unsettled-details.json`

### 阶段4.5: 读者预期写后评分 + 章末钩子质检

**调用工具**：`novel_reader_expectation`

章节编号 ≥ 5 时，在细节更新后调用 REM Agent 进行写后评分：
- 提取章末最后500字进行钩子强度评分
- 计算 HI（钩子强度）× EM（预期匹配度）× WV（窗口合理度）
- 检测钩子类型多样性（香农熵）
- 生成综合评分（A+/S 等）
- 更新 `expectation-ledger.json`（兑现预期、注册新预期）
- 执行章末 AntiAI 专项检测

**产物**：
```json
{
  "hookScore": {
    "hookIntensity": 7.5,
    "expectationMatch": 0.85,
    "windowValidity": 0.92,
    "diversity": { "shannonEntropy": 2.1, "consecutiveSameType": 1 },
    "compositeScore": 8.2,
    "grade": "A"
  },
  "antiAiScore": 0.95,
  "debtsRepaid": [...],
  "debtsAdded": [...],
  "overdueAlerts": [...]
}
```

**章末钩子最低强度门槛**（H_min = 1 + ln(D) × 2.3）：
- 日更(D=1) → H_min = 3.0
- 隔日更(D=2) → H_min = 4.6
- 周更(D=7) → H_min = 7.7

### 阶段4.6: 世界观展示质量后置扫描

**调用工具**：`novel_world_scan`

章节编号 ≤ 20 且存在世界观条目时，调用 WorldPresenter 进行展示质量扫描：
- Infodump 检测：说明段落 ≤ 150字、连续说明 ≤ 300字
- 四维判定：角色感知绑定 + 冲突相关性 + 感官密度 + 读者悬念贡献
- 生成 `WorldPresentationReport`
- 报告推送给 Narrator（下章参考）和 Critic（审稿基准）

### 【人工审阅点1】骨架 + 细节资产库 + 情绪曲线

向用户展示:
- 骨架概览（事实 + 状态变化 + 悬而未决的问题）
- 细节资产库（未结账细节 + 伏笔候选件）
- 情绪曲线图

等待用户: ✅确认 / 🔧修改 / 💡追加锚点

### 阶段5: 整章润色 + 弱细节标记

调用 `novel_style_shaper` 执行三条弱细节检测：
- 静态细节（只描述状态，不描述变化）
- 可替换细节（换个场景照样成立）
- 被命名的感受（细节后紧跟情绪解释）
- `novel_revision_planner` 基于 Critic 诊断结果生成重写指令

### 【中盘必检点】章节 ≥ 20 时的专项检测

章节编号 ≥ 20 时，在阶段5之后自动触发以下检测：

**调用工具**：`novel_mid_chapter_check`

必检清单（五维检测）：
1. **债务积压检测**：调用 `novel_debt_ledger` 执行 `check_net_positive`，确保悬念净增量为正
2. **弧线结算检测**：检查主角是否有超过 20 章未结算的弧线债务
3. **模式疲劳检测**：调用 `novel_fatigue_check` 执行 `detect`，检测重复动作类型和钩子类型
4. **战力体系一致性**：确保战斗力增长符合体系规则
5. **反派威胁度检测**：确保 boss 威胁度不低于主角成长幅度

**产物**：
```json
{
  "passed": true | false,
  "checks": [
    { "type": "debt_net_positive", "passed": true | false },
    { "type": "arc_settlement", "passed": true | false },
    { "type": "pattern_fatigue", "fatigue_level": "low" | "medium" | "high" },
    { "type": "power_consistency", "passed": true | false },
    { "type": "antagonist_threat", "passed": true | false }
  ],
  "violations": []
}
```

**处理规则**：
- `passed: false` 且有 `critical` 级别违规 → 阻断流程，返回阶段2重写
- `fatigue_level: high` → 调用 `novel_fatigue_check` 获取疲劳报告，针对性调整后续章节
- 债务净增量为负 → 调用 `novel_debt_ledger` 关闭部分悬念，重新打开新悬念

### 【模式疲劳检测】每 5 章自动触发

**调用工具**：`novel_fatigue_check`

检测模式：
- 连续 5 章相同主导动作类型（战斗/谈判/恋爱）→ 触发疲劳警告
- 连续 5 章相同钩子类型 → 建议轮换
- 情绪曲线重复度 > 70% → 建议调整情绪节奏

**调用工具**：`novel_revision_planner`

根据 `novel_fatigue_check` 报告生成修稿指令：
- 识别需要引入的新叙事动作类型
- 生成 Hook 类型轮换建议
- 生成情绪曲线调整方案

### 【悬置债务管理】章节生成全程跟踪

**调用工具**：`novel_debt_ledger`

债务类型：
- **悬念（suspense）**：信息缺口、关系未明、威胁悬置、认知冲突
- **张力（tension）**：双方对峙升级、资源争夺、情感拉扯

管理操作：
- `open_suspense`：打开新悬念，自动记录到 `narrative-debt.json`
- `close_suspense`：关闭悬念（必须在文本中有明确回应）
- `open_tension`：建立张力关系
- `close_tension`：解决张力（必须产生明确结果）
- `check_net_positive`：确保悬念净增量 ≥ 0

> 债务净增量为负意味着"挖坑少于填坑"，会导致读者疲劳。

**调用工具**：`novel_closure_tracker`

弧线闭合追踪（章节 ≥ 20 时启用）：
- 加载 `arc-registry.json`
- 执行六维完备性扫描（D1-D6）
- 计算烂尾风险评分
- 生成闭合优先级建议

### 阶段6: 情绪节拍验证

调用 `novel_emotion_metronome` 分析情绪曲线。
不达标 → 返回阶段5调整。

### 阶段7: 配角健康度检测

**内部阶段调用**：`novel_critic`（内置 `SupportingCharacterHealthReport`）

五维检测：
1. **功能暴露指数**：配角功能是否在文本中得到体现
2. **独立欲望活性**：配角是否有自主欲望驱动
3. **互动多样性**：配角与主角/其他角色的互动是否多样化
4. **弧线停滞检测**：配角弧线是否有进展
5. **代价载体前置**：配角是否承担过足够代价

扁平化风险评分：基于五维检测加权计算，生成修订建议。

### 阶段8: 最终把关

- `novel_anti_ai_detector`（升级版：六条必删 + 原有词汇检测）
- `novel_style_shaper` 最终风格匹配
- 偏差 > 30% → 定向修订

### 阶段8.5: 结局工艺专项检测（终章前5章启用）

**调用工具**：`novel_closure_completeness_scan`

终章前5章时启用，执行六维完备性扫描：
1. D1 主角弧完备性（核心问题回答/弱点改变/关系冻结）
2. D2 配角弧完备性（P1 弧线闭合率）
3. D3 世界观弧完备性（核心冲突解决/新平衡呈现）
4. D4 债务清偿完备性（P0 债务清偿率）
5. D5 伏笔唤回完备性（A/B/C 级伏笔唤回率）
6. D6 节奏结构合规（最后3章功能/无新债务/情感先于情节）

**调用工具**：`novel_rotting_ending_detector`

烂尾预警检测（R1-R6 六因子）：
- R1 高潮稀少：高潮密度 < 0.0003/字
- R2 债务积压：开放债务数 > 20
- R3 弧线断链：主角弧线 > 30 章无进展
- R4 角色蒸发：主要配角 > 10 章无出场
- R5 世界观停滞：世界观 > 50 章无深化
- R6 节奏单调：连续 20 章无情绪类型切换

**调用工具**：`novel_chapter_deflation_index`

回落段泄气指数检测：
- CDI（单章）：回落段情绪衰减率
- SDI（连续3章均值）：趋势因子修正
- CDI > 0.70 → CRITICAL 阻断

**调用工具**：`novel_descent_readiness_checker`

回落准备度检查（主弧高潮后自动触发）：
- 弧线过载检测：是否还有未闭合的高优先级弧线
- 弱高峰检测：是否达到真正的叙事高峰
- 债务超载检测：开放债务是否超过回落承载能力

### 【人工审阅点2】终稿确认

展示终稿 + 全部质量报告，等待用户决定发布/编辑/重写。

## 发布后

- 更新 `unsettled-details.json`（回写闭环）
- 更新 `skeleton.json`（增量累积全局骨架）
- 更新 `foreshadowing-tracker.json`
- 更新角色状态档案
- 归档 `skeleton.json`, `draft.md`, `review.md`, `final.md`
- **角色生命周期管理**：更新角色出场计数、情感锚点、欲望状态

## 角色生命周期管理

### 退场评估（章节生成后自动执行）

**评估维度**（满分 100）：
- 出场频率：最近 10 章出场次数（≤3次 → 0分，≥8次 → 20分）
- 功能剩余价值（0-30分）
- 叙事空间占用（0-20分）：当前章节中配角占比
- 情感锚点密度（0-10分）：情感锚点事件数量
- 剧情相关性（0-20分）：与当前/未来剧情的关联程度

**退场方式推荐**：
| 评估得分 | 推荐方式 | 说明 |
|---------|---------|------|
| ≥ 70 | 继续活跃 | 保持当前出场频率 |
| 40-69 | 降级为背景 | 减少出场次数 |
| 20-39 + ≥3 情感锚点 | 代价式退场 | 承担重大代价后退场 |
| < 20 | 终结退场 | 从剧情中永久移除 |

### 合并同类检测

检测是否存在功能重叠的角色（叙事功能相似 + 情感锚点相似）：
- 合并得分 ≥ 80 → 建议合并
- 合并时机分层：
  - 合并时机分级：章节≥20且锚点<3 → 立即合并
  - 章节≥20 → 标记待合并
  - 章节<20 → 禁止合并

### 角色回归验证

角色重新登场时，验证以下条件：
1. **动机充分性**：回归动机是否充分（死亡/隐退/失忆等）
2. **能力延续性**：能力状态是否与退场时一致
3. **叙事连贯性**：情感锚点是否得到延续

### 深度在乎维度管理

每个角色维护以下维度：
- **独立欲望**：角色自主追求的目标
- **信息盲区**：角色不知道的信息
- **错误信念**：角色持有的错误认知

每章限制激活维度 ≤ 2 个，防止角色过于复杂。
urgent 欲望角色除外，必须优先激活其 urgent 欲望。

## 回写闭环设计

- `unsettled-details.json` 作为可回写的资产库
- Narrator 每章可通过 `novel_detail_ledger` 的 `candidates` action 获取伏笔候选件
- 全局骨架在每次写完新章后增量更新
- 伏笔在"被唤回"时标记完成，不需要修改原文

## 六条必删模式（AntiAIDetector 叙事策略层）

| # | 模式 | 描述 |
|---|---|---|
| 1 | 提前定性读者感受 | `[代词]+[感知动词]+[情绪名词]` |
| 2 | 先结论后证据 | 段落首句为抽象判断，后续句为细节铺陈 |
| 3 | 行为动机即时解释 | `[行为]，因为[原因]` |
| 4 | 多余的感知确认 | `他看见了/她听到了/他闻到了` |
| 5 | 情绪形容词堆叠 | 连续≥2个修饰性形容词在同一短语内 |
| 6 | 过渡句 | `就在这时/与此同时/事情发生了转折` |

> 如果一个句子删掉之后，读者感受到的东西反而更强——那这个句子必须删。
