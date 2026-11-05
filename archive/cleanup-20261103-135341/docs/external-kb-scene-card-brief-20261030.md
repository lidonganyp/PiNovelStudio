# 外挂知识库检索失效问题 + 场景卡推荐方案（外部评审用）

> 本文为可独立阅读的技术简报，供外部 AI 评审。读者无需访问代码仓库。
> 日期：2026-10-30；系统：PiNovelStudio（中文网文整章生成）。

---

## 0. 一句话请求

我们要把外部网文语料作为「参考知识库」接进章节生成，但**检索环节在当前实现下几乎恒为零命中**，且注入「优秀范文」曾触发一致性硬阻断。请你评审第 6 节「场景卡（Scene Card）」方案，或提出更好的替代方案，并回答第 8 节的问题。

---

## 1. 系统背景（决定方案边界）

生成链路（单一主链路，无多模式旁路）：

```
novel_generate_chapter
→ Preflight → ContextCompiler → ChapterIntent（作者内容契约）
→ NovelOS Agentic（ReAct 检索 + 初稿 + verify/patch）
→ Agentic FactGuard
→ 作者风格整章优化（必经阶段）
→ StoryPreservationGate（一致性硬门）
→ FinalFactRecheck → Completeness → FinalStateCommit → 原子保存 + Trace
```

上下文装配为 `ContextPackage`，按优先级分槽：

| 槽位 | 内容 | 权威 |
|---|---|---|
| P0 `SYSTEM_AUTHORITY` / P1 `AUTHOR_CONTRACT` / `IMMUTABLE_FACTS` / `COMMITTED_STATE` | 系统与作者契约、不可违背事实、已提交状态 | 硬约束 |
| **P4 `REFERENCE_MATERIAL`**（标题：「参考资料（无指令权，不得覆盖以上硬约束）」） | few-shot 范文、**外挂知识库条目** | **无指令权** |
| `DIAGNOSTIC_EVIDENCE` / `UNTRUSTED_DRAFT` / `USER_FEEDBACK` | 诊断证据、草稿、用户反馈 | 无指令权 |

不可违反的产品约束：

1. 作者契约优先：写前必须给出剧情方向、章节功能、人物动机、伏笔/承诺、因果关系、章末目标。
2. **正文表达归模型**：开头、感官、词汇、句式、修辞、对白、段落节奏不得由系统机械指定；禁止机械配额。
3. 事实硬门、文学软诊断：空文/截断/实体幻觉/连续性断裂/世界观硬冲突可阻断；风格、AI 腔、节拍只能做 diagnostic。
4. Agentic 初稿不得直接交付，必须过「作者风格整章优化」。
5. **文学评价权归用户**：生产路径不调用任何机器文学裁判（judge/pairwise/selection policy 均为离线评测资产）。
6. 长期叙事状态（Canon/Character/Promise/Pattern）只在最终正文确定后提交。
7. 每次生成必须有可回放 trace；被丢弃的知识条目必须留痕，禁止静默丢弃。

---

## 2. 当前外挂知识库实现（关键事实）

模块：`v2/core/external-knowledge-base.ts`；生产调用点：`v2/core/unified-entry.ts`。

| 项 | 当前值 |
|---|---|
| 开关 | `PINOVEL_EXTERNAL_KB=1`（缺省关闭，关闭时不读文件、零副作用） |
| 数据 | `data/external-distilled/slices.json`：10 条「蒸馏判断切片」，含 `rule / anti_pattern / applicable_when / scene_type / chapter_phase / emotion_target`，**外层无原文**；已补结构化标签 `scene_function / beat / pressure_type / decision_tradeoff / cost_type / state_delta` |
| 检索键 | `deriveStructuredRetrievalKey(ChapterIntent)`：由章节功能、压力、阻力、选择/代价、预期不可逆变化、目标情绪派生枚举标签，**不拼接长散文、不取专名** |
| 检索算法 | 硬过滤（scene_type / avoid_when）→ **结构化准入**（≥2 个独立维度命中 + 至少一个主维度 + 绝对最低分）→ **结构化主排序** → 字面余弦只做 tie-break（权重 0.2，待离线校准）→ Top-K |
| 空结果 | 结构化 key 无法派生、或没有卡片达到准入时返回空选集（`selectionMode=none`），不按章节阶段兜底 |
| 注入形态 | P4 参考槽，`kind=style_advisory`，`canAffectHardGate=false`，**生产默认 1 条 × ≤520 字** |

---

## 3. 四个实际问题（均带实测数字）

### P1 切片「零注入」：相似度门槛相对查询形态过高

真实章节的 `queryPreview`（80 字截断）由**专名 + 散文化长串**主导，例如：

```
沈游与设计局林觉真相与解放工业化接口前六次样本与苏念调查同盟齐墨与碎片市场反向路线
```

- 该查询与 10 条判断切片的字面二元余弦实测 **0.0199 – 0.0710**，**全部 < 0.08**。
- 硬过滤通过 **10/10**（不是内容不足、不是切片损坏、不是链路断裂）。
- 严格模式下 `delivered = 0`，`droppedByRelevance = 10`。

结论：**链路是通的，是打分口径与查询形态不匹配**，导致「知识库挂载成功但一次都没交付」。

### P2 检索键错位（P1 的结构性根因）

- 查询侧：专名、事件散文、承诺描述 —— 高信息量但**低重叠**。
- 切片侧：抽象判断（「先让读者看到规则代价，再解释规则」）—— 抽象但**与查询几乎不共用字面二元组**。
- 两侧都"正确"，但处于不同抽象层，二元余弦天然极低。**这不是调阈值能修的**（见第 4 节）。

### P3 「原文范文」通道根本不是 RAG

对照实验用的原文范文通道（`PINOVEL_EXTERNAL_EXCERPTS=good|bad`）：

- 读取 `data/external-distilled/excerpts-good.json`（6 条，每条 **267–316 字**整段原文，含具体人物与情节）。
- **不排序、不算相关性、不减阈值**：`minScore = 0`，直接「按文件顺序取前 3 条」。
- 原因（代码注释原文）：整段范文与作者契约查询的字面余弦实测 **≈0.0002**，沿用阈值会让对照臂 100% 零注入、退化成无外挂基线。
- 因此：**用户以为"RAG 选最相关 3-5 条"，实际是"固定前 3 条"**。

### P4 整段范文注入曾触发一致性硬阻断（骨架漂移）

- 注入内容是 P4【参考资料】，但**带具体人物/事件的整段正文**。
- 作者风格整章优化阶段把这些外部情节吸进正文。
- 随后 `StoryPreservationGate` 以 **`full_entities` 覆盖率**（`replacedSimilarityThreshold=0.25`，`lowSimilarityReplacementThreshold=3`）+ **动作反转（反义词对）检测**（`replacedEventThreshold = 1`，单个反义词对即阻断）比对「初稿 vs 优化稿」。
- 历史轮次结果：B 臂 3/3 被 `story_preservation` 硬阻断，原因文本「故事骨架漂移：检测到 1 个动作反转（反义词对，阈值 1）」。

即：**漂移不是"RAG 选错了条目"造成的，而是"注入形态 = 整段可仿写正文"造成的**。

### P5 「范文是否伤害自然度」至今无判定样本

- 阻断（P4）与长请求超时（单请求预算 300s、链路预算 300s 误杀 289–690s 的正常生成）长期混在一起，无法形成同章同渠道对照。

---

## 4. 已尝试且无效的方案（请勿重提）

| 尝试 | 实测结果 | 为什么无效 |
|---|---|---|
| 降低 `minScore` 阈值 | 依然大面积丢弃，或注入噪声 | 余弦整体落在 0.02–0.07 的低带内，阈值只能"全给"或"全不给"，无法区分优劣 |
| 把查询侧余弦改为**切片侧覆盖率**（query 字元组被切片覆盖的比例） | `cover = 0.0667` vs `cos = 0.0679` | 两者同量级、同方向，换指标不改变抽象层错位 |
| 结构化兜底（**已删除**） | 曾用「严格零命中 + 阶段精确匹配」兜底（写 `selectionMode=structural_fallback`），真实数据 delivered 2 条（`rule-copy-probe`、`world-rule-via-consequence`） | 只解决"有东西可注入"，**不解决"选得准"**；阶段匹配但零相关，违反 RAG 相关性约束，已按评审结论物理删除 |
| 抬高链路超时（300s → 单请求 600s / 链路 900s） | D 臂成功，135s 交付 | 只排除了"超时误杀"这一混杂因素 |

---

## 5. 最新同渠道对照数据（必须按"样本不足"读）

条件：同一 builder、同一渠道（solov，`gemini-4-argon`）、同一工作区副本、同一章节 ch1、每臂最多 3 次取首个成功。

| 臂 | 外挂注入 | 结果 | 正文字数 | AI 腔/翻译腔千字密度 | 判定 | findings | 4-gram 越界率（越界仿写） | 注入条目 |
|---|---|---|---|---|---|---|---|---|
| A | 无 | ok | 4648 | **1.29** | pass | 6 | 0.0011 | — |
| B | 优秀范文（6 条池，固定前 3） | ok（try1 因上游 524 失败，try2 成功 84s） | 5459 | 2.02 | pass | 11 | **0.0002** | `excerpt-怪谈游戏设计-c2-1 / c3-2 / c3-3` |
| C | 劣质范文 | ok | 5961 | 1.85 | pass | 11 | 0.0010 | 3 条 |
| D | 判断切片（结构化兜底） | ok（135s） | 4580 | 2.18 | pass | 10 | 0.0008 | `rule-copy-probe / world-rule-via-consequence` |

指标定义：

- **千字密度** = AI 腔/翻译腔命中数 / 千字，`<3` pass、`3–5` repair、`>5` block、3+ 连续独句成段直接 block。**越低越好**。
- **4-gram 越界率** = 正文与注入条目的字符 4-gram 交集 / 正文 4-gram 总量，用来测"是否照抄范文"。

可读出的结论（以及不能读出的结论）：

- 能读出：B 臂 4-gram 越界率 **最低（0.0002）**，说明模型**没有照抄**注入的整段范文；四臂自然度判定全部 pass；本轮 **B 未被 story_preservation 阻断**（历史阻断应归因于当时的注入形态与配置，而非普适规律）。
- 不能读出：单章单次样本下，A(1.29) < C(1.85) < B(2.02) < D(2.18) 的密度排序**不足以证明**"范文伤害自然度"——劣质范文臂反而低于优秀范文臂，说明该指标在本样本量下噪声主导。
- 缺失：无人工/盲测文学评级（因为产品约束 5：机器裁判不进生产，文学评价权归用户）。

---

## 6. 推荐方案：场景卡（Scene Card）

### 6.1 核心思想

把"检索键"从**长查询 × 整段文本**改成**结构化场景描述 × 抽象卡片**，用**同一抽象层的共同词汇**做匹配；范文只以**短 span**形态出现，避免实体与情节污染。

用户原始提法「当前场景 → 角色选择 → 最终结果」是卡片主体，我们在此基础上补两层：**抽象骨架（检索键）** 与 **短 span 范文（表达参考）**。

### 6.2 卡片 schema

```jsonc
{
  "id": "scene-card-0007",
  "scene_type": "foreshadow_reveal",       // 复用现有 12 类场景分类
  "chapter_phase": "opening|middle|ending|any",
  "source_work": "怪谈游戏设计师959",       // 溯源（不进 prompt）
  "source_span": { "start": 3626, "end": 3940 },

  "pressure": "夜里有陌生人敲门，主角必须决定是否开门，且时限由门外人掌握",
  "choice": "主角装作受伤、主动邀请对方进屋，同时把真正的防备藏在动作里",
  "result": "入侵者因'毫无防备'而放松警觉并暴露恶意，主角获得观察机会",

  "pattern": "压力源压迫→示弱式试探→诱使对方暴露动机→信息更新",   // 抽象骨架，无专名
  "tactic": ["以退为进", "视角偏向入侵者的欲望"],
  "emotion_target": ["不安", "期待"],
  "anti_pattern": "直接硬抗或靠旁白解释威胁",

  "excerpt_span": "……（≤120 字，去专名/去具体情节的短片段）"
}
```

要点：

- `pressure / choice / result` 必须是**动作级、可判定**（"他做了什么、随即发生了什么"），不是心理概括。
- `pattern` 是**检索主键**：抽象化、无专名，与作者声明字段共用词汇（规则/试探/代价/漏洞/队友连累/线索/钩子）。
- `excerpt_span` 是**可选**表达参考，≤120 字、去专名，仅进 P4。

### 6.3 检索与打分

```
查询键（由 ChapterIntent 派生，不拼接长散文）
  = scene_type（作者声明/章节功能派生）
  + chapter_phase
  + emotion_target
  + 压力源/选择/结果的短关键词

score = 结构化匹配(phase, scene_type, emotion)          // 主导
      + 字面相似(仅 pattern/pressure/choice/result 短字段) // 辅助，不看整段原文
门槛 = 相对门槛（Top-1 得分的比例）+ 绝对下限，两者同时满足才入选
```

- 丢弃必须留痕：`droppedIds` / `droppedByRelevanceIds` / `selectionMode`。
- 注入仍为 P4（无指令权），默认 2–3 张卡 + 至多 1 条 `excerpt_span`。

### 6.4 数据来源（现成，不需要重新切分）

`novelbag-v0/scenes/` 已有 12 类场景库，共 **5,418 条场景片段**（两本书 `怪谈游戏设计师959`、`神秘复苏`）：

| 类别 | 片段数 | 类别 | 片段数 |
|---|---|---|---|
| cliffhanger | 1083 | breakthrough | 294 |
| daily_life | 1040 | world_setting | 250 |
| combat | 717 | gamble | 210 |
| sacrifice | 598 | foreshadow_reveal | 206 |
| team_gathering | 472 | face_slapping | 104 |
| romance | 341 | faction_conflict | 103 |

每条片段已带 `word_count / quality_score / tags / start_pos / end_pos`。因此卡片只需**离线蒸馏一次**（建议每类抽 3–6 条高质量片段 → 40–60 张卡），无需重新切片。

### 6.5 预期收益与风险

预期收益：

1. 检索命中从"≈0 或靠兜底"变为"稳定相关"，因为匹配发生在同一抽象层。
2. 提供**可迁移的情境结构**（压力→选择→结果），而不是抽象原则；这正是当前 10 条判断切片缺失的。
3. 短 span 范文满足"参考优秀范文"，同时剥离专名与整段情节，降低 `story_preservation` 误阻断风险。
4. 场景类型对齐链路上已有的 `chapter_phase` / `emotion_target` 派生，无需新增模型调用。

风险与代价：

- 蒸馏质量决定上限：`choice/result` 写得含糊就退化回"抽象原则"。
- 抽象化去专名会损失一部分表达细节，可能与"范文越像越好"的直觉冲突。
- 卡片是**静态资产**，需要重建机制（新增语料 → 重新蒸馏），否则覆盖面停滞。

---

## 7. 备选方案与权衡

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **B1 场景卡全套（推荐）** | 蒸馏 40–60 张卡 + 改检索（结构化+短字段）+ 短 span 范文 | 命中稳定、可迁移、抑制漂移 | 一次性蒸馏 + 改两处代码 |
| B2 只扩量现有判断切片 | 10 → 60 条通用判断 | 改动最小、最快 | 仍缺场景结构；余弦低靠兜底，覆盖仍窄 |
| B3 只做短 span 范文通道 | 把 267–316 字整段压成 ≤120 字去专名片段 | 最快拿到自然度结论 | 不解决检索匹配 |
| B4 换检索模型（向量库 / embedding API） | 语义向量检索替代二元余弦 | 跨抽象层匹配能力强 | 引入外部依赖、破坏离线可回放与零新增依赖约束；语料需嵌入+存储 |
| B5 结构先于检索：先扩查询结构 | 仅重构查询键（用场景元数据而非散文拼接） | 零数据成本 | 仍是"判断文本"池，选得准但内容薄 |

---

## 8. 请你回答的问题

1. 在「无指令权参考槽 + 表达归模型 + 用户是唯一文学裁判」的约束下，**场景卡的三段式（压力/选择/结果）+ 抽象 pattern** 是否是正确的检索单元？还有更合适的单元吗（例如"节拍-功能"单元、"冲突-代价"单元）？
2. `choice/result` 的**抽象化程度**如何取舍？过抽象→退化为原则；过具体→实体污染与漂移。有没有可操作的判定标准？
3. 检索打分里**结构化匹配与字面相似**应如何配比？是否需要相对门槛（Top-1 比例）替代固定绝对阈值？
4. 注入**短 span 范文**（≤120 字、去专名）是否足以传递"语感/句法"，还是必须给更长片段？如果更长，如何避免被整段搬用（4-gram 越界率作为监控指标够不够）？
5. 40–60 张卡是否足够覆盖一本长篇的章节？若不够，如何做**卡片组合**（多卡拼装成"本章场景序列"）而不产生机械配额？
6. 实验设计：在"单章单次、同渠道"现实约束下，**最小可行样本数与对照组**应如何设定，才能判定"范文是否伤害自然度"？（现有指标：千字 AI 腔密度、4-gram 越界率、findings 数）
7. 有没有我们没考虑的**更简方案**，能同时满足"命中稳定 + 不污染一致性 + 可回放审计"？

---

## 9. 附：可核对的关键事实

| 事实 | 位置 / 数值 |
|---|---|
| 外挂模块 | `v2/core/external-knowledge-base.ts` |
| 生产调用点 | `v2/core/unified-entry.ts`：`retrievalKey: deriveStructuredRetrievalKey(intent)`、`topK: EXTERNAL_KB_PRODUCTION_TOP_K`（=1）、**无 `allowStructuralFallback`** |
| 生产原文通道 | 不传 `allowExcerpts`；仅设置 `PINOVEL_EXTERNAL_EXCERPTS` 只留痕忽略，**生产永久不注入原文（含短 span）** |
| 相关性算法 | 结构化枚举匹配为主；字面 = 去空白 + 字符二元组 + 余弦，只做 tie-break（权重 0.2） |
| 结构化准入 | ≥2 个独立维度命中 + 至少一个主维度（scene_function/beat）+ `structuredScore ≥ 0.3` |
| 门槛 | `minScore = 0.08`（结构化模式下恒被满足，保留以便阈值审计），`contentMinScore = 0.08`（仅 content 模式） |
| 判断切片池 | `data/external-distilled/slices.json`（10 条，含结构化标签） |
| 优秀范文池 | `data/external-distilled/excerpts-good.json`（6 条，267–316 字/条，仅隔离评测） |
| 劣质范文池 | `data/external-distilled/excerpts-bad.json`（仅隔离评测） |
| 范文通道门槛 | `minScore = 0`，按文件顺序取前 3，**不做相关性**；仅隔离评测 |
| 一致性硬门参数 | `replacedSimilarityThreshold = 0.25`，`lowSimilarityReplacementThreshold = 3`，`replacedEventThreshold = 1` |
| 自然度指标 | 千字密度 `<3 pass` / `3–5 repair` / `>5 block` / 3+ 连续独句成段 block |
| 场景库 | `novelbag-v0/scenes/*.json`，12 类，5,418 条片段，两本书 |
| trace 审计字段 | `selectionMode`（structured/content/none）、`retrievalKey`、`structuredHitsById`、`marginGap`、`deliveredIds`、`droppedIds`、`droppedByHardFilterIds`、`droppedByRelevanceIds`、`droppedByStructuredAdmissionIds`、`poolSize`、`afterHardFilter`、`scoredCount` |

---

## 10. 外部评审结论与第一阶段落地（2026-10-31）

### 10.1 采纳的评审结论

评审认为第 6 节方向正确但**不能原样落地**，因为它把「检索单元 / 创作建议 / 原文表达样本」混在一张卡里。采纳的第一性原理：

```text
参考价值 = 场景相关性 × 机制可迁移性
         − 一致性污染风险
         − 上下文成本
```

- P4「无指令权」只降低权威级别，**不能阻止模型受内容影响**；整段范文与短 span 都不天然安全。
- 生产永久不注入外部小说原文（含 ≤120 字短 span）。
- 结构化成对匹配为主线，字面相似只做 tie-break；准入不能只看 Top-1 相对比例。
- 空结果优先，不用阶段兜底把零相关卡片塞进 prompt。

### 10.2 已落地的第一阶段（不新增卡片，先修表示错位）

1. `slices.json` 10 条卡片补齐 `scene_function / beat / pressure_type / decision_tradeoff / cost_type / state_delta`；`rule / anti_pattern / applicable_when` 保留为人类可读判据。
2. 新增 `deriveStructuredRetrievalKey(ChapterIntent)`：从章节功能、压力、阻力、选择/代价、预期不可逆变化、目标情绪派生枚举标签，不取专名、不拼长散文。
3. 检索改为 **硬过滤 → 结构化准入 → 结构化主排序 → 字面 tie-break → margin 观察 → 空结果**。
4. 结构化准入：≥2 个独立维度命中 **且至少一个主维度（scene_function / beat）** 且 `structuredScore ≥ 0.3`。
5. 删除结构化兜底（`allowStructuralFallback` / `selectionMode=structural_fallback` / `structuralFallbackIds`），生产不再有阶段兜底分支。
6. 生产默认只交付 1 条主 advisory（`EXTERNAL_KB_PRODUCTION_TOP_K=1`），原文通道仍只属隔离评测。
7. 丢弃全部留痕：`droppedByHardFilterIds` / `droppedByStructuredAdmissionIds` / `droppedIds` 之和 + `deliveredIds` = `poolSize`。
8. 复用现有 P4 预算与 provenance 路径（`buildExtraReferenceItems` → `compileContextSafety` → `compileProductionContextPackage`），不新增注入通道。

### 10.3 与评审建议的差异（需知悉）

- **增加「至少一个主维度」硬条件**：仅 `pressure_type + cost_type` 在同类题材里几乎恒命中，只靠它们等于没有筛选。
- **未引入 manifest 准入门槛**：当前池子是仓库内单一 `slices.json` 文件，加载成功即视为准入；若后续引入多来源/外部卡片，应补 manifest 审批。
- **`readerEffect` 复用现有 `emotion_target`**：不新增重复字段，情绪只作弱信号，不参与准入计数。
- **margin 只记录不拦截**：`marginGap` 写 trace 供消歧观察，不当硬门（评审也仅建议作为辅助）。

### 10.4 第二阶段触发条件

只有在离线 replay 显示**空结果率过高**或**机制覆盖不足**时，才从 `novelbag-v0/scenes/` 的 5,418 条片段蒸馏 30–60 张 Craft Pattern Card；不为凑数量预先蒸馏。

### 10.5 文档冲突已统一（2026-10-31）

`AGENTS.md` 原先写着「知识库范文属于【示例】的允许形态：≤520 字、P4 槽、无指令权」，与评审「生产永久不注入原文 span」冲突。现已按评审统一修改两处：

- 「Prompt 编写规范」第 4 条：外挂知识库只提交结构化 Craft Pattern Card，不提交外部小说原文（含 ≤120 字短 span）；内部 few-shot 的 ≤520 字约束保留不变。
- 「补充规则」：明确 P4 唯一形态为结构化卡片、生产默认 1 条、无合格候选返回空，并把 trace 审计字段更新为 `selectionMode` / `retrievalKey` / `structuredHitsById` / `marginGap` / `deliveredIds` + 四个丢弃通道（已删除 `structuralFallbackIds`）。

### 10.6 离线回放实测（2026-10-31，两轮）

脚本：`scripts/external-kb-replay.mjs`（不调用任何模型）；输出 `reports/external-kb-replay/structured-replay.json` 与 `summary.md`。
可复现标识：报告已写入 `replayScriptVersion`（`external-kb-replay@1`）与卡池 SHA-256（`data/external-distilled/slices.json`，本轮 `e47d3267…a803e036`）。数据文件被 `.gitignore` 排除，仅凭生成时间无法证明报告对应哪一版卡池，故以哈希绑定结论版本。
样本按 `作品 + 章节号` 去重（同作品副本合并、显式章纲优先），并按意图保真度分三层：

| 层 | 来源 | 章节数 | 说明 |
|---|---|---|---|
| `author` | `ch*-outline-explicit.md`（作者手写：`### 事件 N` + `**内容摘要**` + `冲突等级/情绪弧/必须包含`） | 7 | 最接近生产 `ChapterIntent` |
| `generated` | 系统从已保存前缀生成的章纲（`## 事件 N` + `内容摘要：` 后跟正文） | 7 | `本章功能` 是通用模板「推进本章冲突…」，只有事件正文可用 |
| `session` | 生产 session 的「作者章纲事件顺序」块 | 6 | 提示无章节级字段，只能整块文本代理 |

合计 **20 个不同章节**（候选 123 条，去重合并 103 条）。仓库内作者手写章纲实际只有 7 章，这是当前数据上限；不能把 `author` 层结论扩写成「20 章作者意图」。

**轮次 A（初测，仅 `author` 7 章，`sceneFunction` 只读 `chapterFunction`）**

| 指标 | 结构化模式（生产 topK=1） | 旧字面 content 模式 |
|---|---|---|
| 交付章节 | 5/7（71.4%） | 1/7 |
| 空结果 | 2/7（28.6%） | 6/7（85.7%） |
| 空因：结构化键为空 | 0 | — |
| 空因：无卡片达到准入 | 2 | — |

- `sceneFunction` 仅 4/7；关系/情感向章节（ch13）派生不到 `relationship_shift`。
- 实际交付卡片只有 3 种；10 张卡中 7 张从未命中。
- ch13 / ch16 空结果：`beat=payoff` 但池内**没有 payoff 节拍的卡**，且 `sceneFunction` 未派生 → 只剩 1 维，按准入被正确拒绝。

**轮次 B（扩样 20 章 + `sceneFunction` 第二层派生）**

| 层 | 章节 | 交付率 | sceneFunction 可派生 | pressureType / tradeoff / costType |
|---|---|---|---|---|
| `author` | 7 | **6/7（85.7%）** | **7/7** | 3 / 1 / 6 |
| `generated` | 7 | 0/7 | 6/7 | 0 / 0 / 0 |
| `session` | 6 | 0/6 | 5/6 | 0 / 0 / 0 |
| 合计 | 20 | 6/20（30%） | 18/20 | 3 / 1 / 6 |

- 旧字面 content 模式：19/20 零命中（95.0%）。
- 主维度缺失章节：0。

**本轮代码变更（方案 2，已落地）**：`deriveStructuredRetrievalKey` 的 `sceneFunction` 改为两层派生——优先 `chapterFunction`，派生不出时退化到 `authorEventSummaries + authorMustInclude`（都是作者写前契约的组成，不是内容推断）；两层都无关键词仍返回 `null`（空结果优先，不补默认值）。配套新增 3 条测试（兜底层生效 / 不被兜底层覆盖 / 两层皆空仍为 null），`tests/external-knowledge-base.test.mjs` 28/28 通过。
效果：`author` 层 `sceneFunction` 4/7 → 7/7，交付 71.4% → 85.7%，新增命中 `team-panic-chain`（ch13 群像/关系压力）。

**瓶颈重新定位（关键，取代轮次 A 的结论）**：`author` 层已稳定在 85.7%，`generated`/`session` 两层为 0%，原因**不是 `sceneFunction`**，而是两处结构性缺口：

1. **卡片池覆盖窄**：10 张卡只覆盖 **9 类 `scene_function`、6 类 `beat`**，回放中出现但池内无卡的至少有 `combat_approach`、`info_reveal`；同时**没有任何 `beat=payoff` 的卡**（`beat=close` 只有 1 张 `copy-end-hook`，其 `scene_function=hook_close`，只能匹配「章末钩子」类 close，不能覆盖 payoff，也不能匹配其他场景功能的 close 章节）。而 `generated`/`session` 章节大量是 `payoff` / `close` 节拍。
2. **压力/代价维度派生近乎为零**：`generated`/`session` 的 `currentPressure` / `resistance` / `choicesAndCosts` 为空（这些提示里没有对应字段），于是只剩 `sceneFunction + beat` 两维；命中不到卡片时连「≥2 个独立维度」都达不到，被准入正确拒绝——**没有错误放行**。

**结论**：第二阶段蒸馏清单应按 **`beat × scene_function` 双轴**补齐（重点 `payoff` / `close` 节拍与 `combat_approach` / `info_reveal` / `relationship_shift`），不能只扩数量；同时应评估 `currentPressure` / `resistance` 的派生来源是否也需要扩字段。是否扩这两类派生字段，需要在蒸馏清单确定后再决定，避免「扩了派生但池内仍无对应卡」的空转。

### 10.7 第二阶段：卡片覆盖补齐（2026-10-31）

> **状态说明**：本节记录补卡当轮的产物与哈希（当时 `poolSha256=4150eca3…`）。2026-10-31 验收整改已重生成资产与运行池，**当前唯一有效哈希与结论见 §10.8**；本节哈希仅作历史对照，不得作为当前验收口径。

**语料来源与指纹**

| 项 | 值 |
|---|---|
| 语料根目录 | `D:\pns-exp\novelbag-v0`（仓库外，不入库、不提交正文） |
| 场景切片 | `scenes/` 12 个 JSON，5,418 条片段，7,351,369 字节 |
| 来源作品 | 2 部（`怪谈游戏设计师959`、`神秘复苏`） |
| 来源清单 | [corpus-provenance.json](external-kb/corpus-provenance.json)：逐文件字节数 + SHA-256 + 片段数 + 作品 |
| 逐卡坐标 | [scene-cards-v2.json](external-kb/scene-cards-v2.json)：`sampleId` + `startPos/endPos` + `excerptSha256` |

卡片产物（`docs/external-kb/`）未落入 `.gitignore`，可入库审计；运行池 `data/external-distilled/slices.json` 被 `.gitignore` 排除，因此池内容必须能由脚本 + 来源清单重建，而不是只留本机文件。

**蒸馏脚本（确定性、离线）**

```bash
node scripts/distill-scene-cards.mjs --corpus D:\pns-exp\novelbag-v0 \
  [--drafts docs/external-kb/scene-card-drafts-v2.json] \
  [--verified docs/external-kb/scene-cards-v2.json] \
  [--provenance docs/external-kb/corpus-provenance.json] \
  [--pool data/external-distilled/slices.json]
```

- 语料路径与输出路径均为显式参数，不硬编码本机目录；
- 片段只用于「证据存在性」与「反抄袭（去空白标点后 12 字连续重合）」校验，校验完即丢弃，**不写出、不保存任何原文**；
- 输入文件按文件名排序、卡片按 id 排序、无时间戳；同输入重跑字节一致（`verifiedSha256` / `poolSha256` 不变）；
- 合并运行池时：同 id 同内容视为重跑跳过，同 id 不同内容直接失败（版本收敛原则，不并存两版）；
- 卡片字段按白名单显式构造，未知草稿字段（尤其原文）无法进入产物。

**新增卡片（9 张，每张都带真实坐标）**

| id | scene_function | beat | 证据样本（作品 文件#坐标） | confidence |
|---|---|---|---|---|
| `combat-role-brief-before-engagement` | combat_approach | setup | 怪谈游戏设计师959 scenes/combat.json#33975-34602 | medium |
| `combat-partial-suppression-then-leak` | combat_approach | payoff | 神秘复苏 scenes/combat.json#1283170-1283763 | medium |
| `combat-shrink-domain-approach` | combat_approach | escalation | 神秘复苏 scenes/combat.json#516714-517377 | medium |
| `info-reveal-bystander-withheld-question` | info_reveal | reveal | 神秘复苏 scenes/foreshadow_reveal.json#1394437-1395045 | medium |
| `info-reveal-trace-in-hand-close` | info_reveal | close | 怪谈游戏设计师959 scenes/cliffhanger.json#118815-119218 | medium |
| `info-reveal-archive-exception` | info_reveal | payoff | 怪谈游戏设计师959 scenes/sacrifice.json#546433-546980 | medium |
| `cost-payoff-itemized-ledger` | cost_payment | payoff | 怪谈游戏设计师959 scenes/breakthrough.json#754187-754602 | medium |
| `relationship-limited-alliance` | relationship_shift | escalation | 怪谈游戏设计师959 scenes/team_gathering.json#565458-566068 | medium |
| `team-pressure-discipline-list-close` | team_pressure | close | 怪谈游戏设计师959 scenes/cliffhanger.json#316020-316342 | medium |

每张卡由单一证据样本蒸馏，`confidence` 统一 `medium`：不得把单一样本包装成广泛规律。

**覆盖矩阵（卡池 beat × scene_function）**

| beat | 补卡前 | 补卡后 |
|---|---|---|
| test | boundary_test | boundary_test |
| reversal | rule_exploitation | rule_exploitation |
| escalation | cost_payment, info_asymmetry, team_pressure | + combat_approach, relationship_shift |
| reveal | info_asymmetry, horror_anomaly, deduction | + info_reveal |
| close | hook_close | + info_reveal, team_pressure |
| setup | world_reveal | + combat_approach |
| payoff | **（无）** | combat_approach, cost_payment, info_reveal |

卡池：10 → 19 张；`beat` 覆盖 **6 → 7 类**（原池 6 类：close/escalation/reveal/reversal/setup/test，新增 `payoff`）；`scene_function` 覆盖 **9 → 12 类**（原池 9 类：boundary_test/cost_payment/deduction/hook_close/horror_anomaly/info_asymmetry/rule_exploitation/team_pressure/world_reveal，新增 `combat_approach`／`info_reveal`／`relationship_shift`，`cost_payment`／`team_pressure` 密度 +1）。

**回放前后对比（同一脚本、同一口径、topK=1）**

| 指标 | 补卡前 | 补卡后 |
|---|---|---|
| 卡池 SHA-256 | `e47d3267…a803e036` | `4150eca3…1a5af01e` |
| 卡片总数 | 10 | 19 |
| 合计交付率 | 6/20（30.0%） | **11/20（55.0%）** |
| 空结果（无卡达准入） | 14 | 9 |
| 场景功能覆盖缺口 | 3 章 | **0** |
| `author` 层 | 6/7（85.7%） | **7/7（100%）** |
| `generated` 层 | 0/7 | 3/7（42.9%） |
| `session` 层 | 0/6 | 1/6（16.7%） |
| 旧字面 content 零命中 | 19/20 | 19/20 |

逐章变化（仅 5 章由空结果变为交付，其余 15 章不变）：

| 章节 | 层 | 新交付 | 命中维度 |
|---|---|---|---|
| 心魔界 ch16 | author | `combat-partial-suppression-then-leak` | beat + stateDelta（sceneFunction 不符） |
| p252 ch20 | generated | `info-reveal-trace-in-hand-close` | sceneFunction + beat |
| p587 ch3 | generated | `info-reveal-archive-exception` | beat + stateDelta（sceneFunction 未派生） |
| p587 ch1 | generated | `combat-partial-suppression-then-leak` | sceneFunction + beat |
| p252 ch430 | session | `team-pressure-discipline-list-close` | sceneFunction + beat |

**误命中检查**

- 补卡前已交付的 6 个 `author` 章节（ch1/ch2/ch13/ch17/ch18/ch22）交付卡片**逐字不变**，无回归。
- 唯一新增的 `author` 命中 心魔界 ch16（`world_reveal × payoff`）命中维度只有 `beat + stateDelta`，`sceneFunction` 与卡片不符。核对章纲：事件 2「大蛇不停步直接碾压雾隐兽群」（压制兑现）+ 事件 3「噬魂兽声逼近、砍伐会引来兽群」（未处理隐患），与卡片机制「压制量化 + 隐患保留」一致，判定为**可迁移的低配命中**，保留但标记为需人工复核。
- `generated`/`session` 的 3 次新增交付仅作敏感性观察，不作生产效果证明。
- 全部 11 次交付均满足「≥2 个独立维度 + 至少一个主维度 + 结构化分数 ≥0.3」，脚本核对 `violations = 0`；9 个空结果章节全部是「无卡片达到准入」，无 fallback、无阈值放宽。

**未发现合格样本的组合（记录留空，不补写）**

| 组合 | 检查方式 | 结论 |
|---|---|---|
| `world_reveal × payoff` | `world_setting` 关键词扫描 + 人工阅读高分片段 | 仅 1 段命中且为日常算账对话；`foreshadow_reveal` 相关片段属 setup → 不产卡 |
| `horror_anomaly × payoff` | 恐怖/异常类片段扫描 | 仅有 reveal 型（已由 `physical-anomaly-horror` 覆盖），payoff 型无清晰机制 → 不产卡 |
| `combat_approach × reveal` | `combat.json` 717 段关键词扫描（26 段命中），人工阅读高分前 3 段 | 均为对话式推理/指控，非「交锋中揭示」→ 不产卡 |
| `relationship_shift × 其他节拍` | `team_gathering`/`romance` 扫描 | 仅 escalation 一段「有限结盟」可迁移；其余节拍未见清晰机制 → 不产卡 |

上述 9 个空结果章节因此仍有 7 章停在 `horror_anomaly × payoff`、1 章 `combat_approach × reveal`、1 章 `team_pressure`（beat 未派生，仅 1 维）。

**为何是 9 张而非 30–60 张**

§10.4 的 30–60 是数量参考，本轮验收口径是「覆盖是否改善」。5,418 条片段中大量是同作品同机制重复；语料 `tags` 只有风格标签（对话丰富/动作描写/环境描写/热血向），**没有 beat/function 标注**，beat 归类只能人工阅读。因此只落「证据清晰 + 机制可迁移 + 与既有卡不重复」的组合，宁可留空也不为凑数补卡。该限制也意味着本轮覆盖是**有界扫描**，不等于对语料穷举。

**验证命令与结果**

| 命令 | 结果 |
|---|---|
| `node scripts/distill-scene-cards.mjs --corpus D:\pns-exp\novelbag-v0`（连续两次） | 两次 `verifiedSha256=0913a294…6d9`、`poolSha256=4150eca3…01e` 完全一致（幂等） |
| `node scripts/external-kb-replay.mjs` | 生成 `structured-replay.json` / `summary.md`，`poolSize=19`、`poolSha256=4150eca3…01e`、交付 11/20 |
| `node --import ./tests/setup-test-env.mjs --test tests/external-scene-cards-v2.test.mjs` | 6/6 通过（含语料坐标回读、片段 SHA-256 与 12 字反抄袭） |
| `node --import ./tests/setup-test-env.mjs --test tests/external-knowledge-base.test.mjs` | 28/28 通过 |
| `npm run verify:external-kb` | 退出码 0；19 条切片结构有效，loader ok |

- 未运行 `npm run build*`：本轮未改动任何 TypeScript，测试读取的 `dist/` 与改动前一致。
- `node --test` 在本机受限（历史 `spawn EPERM`），本次以直接运行测试文件替代，不宣称该项通过。
- 补卡前报告保留为 `reports/external-kb-replay/structured-replay-before.json` / `summary-before.md`，可逐章复核。

**边界声明**：交付率 30% → 55%、`author` 层 85.7% → 100% 只是**结构化检索可用性**的改善，不是文学质量提升；命中相关性仍需人工复核，文学收益必须由真实章节对照与用户评价证明。

### 10.8 验收整改与独立相关性验证（2026-10-31）

> 本节取代 §10.7 的交付结论。范围固定：**未新增卡片、未改生产检索算法/阈值/topK/fallback/意图派生/prompt**；未运行付费章节生成、未覆盖生产正文、未修改长期叙事状态。

**整改触发（用户复跑发现）**

1. 完整卡池不能从零重建：旧脚本读已有运行池再追加，空目录只出 9 张，「19 张可由脚本重建」不成立。
2. 部分卡片仍规定具体情节与表达（固定句位、机械数量、情节配方），12 字重合检查查不到。
3. ch16 只是交付成功，`world_reveal` 命中 `combat_approach` 卡不代表机制适用。

#### 10.8.1 卡池重建：来源验证与运行池生成分离

| 环节 | 实现 | 输入 → 输出 | 是否读旧运行池 |
|---|---|---|---|
| 来源验证 + 资产生成 | [distill-scene-cards.mjs](../../scripts/distill-scene-cards.mjs) | 草稿 9 张 + 旧卡 10 张 + 外部语料 → `docs/external-kb/scene-cards-v2.json`（schemaVersion 3） | 否 |
| 运行池生成 | [build-scene-card-pool.mjs](../../scripts/build-scene-card-pool.mjs) | 权威资产 → `data/external-distilled/slices.json` | 否 |

- 有原始语料时 `--corpus D:\pns-exp\novelbag-v0` 复核 9 张 verified 卡的文件指纹、坐标、片段 SHA-256 与 12 字重合；无 `--corpus` 时仍可从资产生成运行池，并输出 `verificationNote: 未重新核验语料`。
- 旧 10 张只保留旧版声明的作品与章节，`provenanceStatus=unverified`，**未补造坐标或 evidence**；不得据此宣称已核对出处。
- 运行池不含 `provenance`／`provenanceStatus`／`provenanceNote`／`evidence`（审计字段仅留在资产）。

**空目录重建验收（不依赖旧池，连续两次）**

```bash
# 临时空目录（脚本内 mkdtemp），两次生成后比较字节与哈希
node scripts/build-scene-card-pool.mjs --asset docs/external-kb/scene-cards-v2.json --pool <tmp>/a.json
node scripts/build-scene-card-pool.mjs --asset docs/external-kb/scene-cards-v2.json --pool <tmp>/b.json
```

| 项 | 结果 |
|---|---|
| 生成卡片数 | 19（verified 9 + unverified 10） |
| 两次 `poolSha256` | `652e40150683fa87…3818bce` 完全一致，字节相同 |
| 与正式池逐字节比较 | 一致（23203 bytes） |
| 权威资产 `assetSha256` | `9a12cf2f6ce082ea…d81e40fb` |
| 来源清单 `provenanceSha256` | `d04e49ce8e3f506e…8b2f6c`（未变） |
| 测试覆盖「运行池不存在」 | `external-scene-cards-v2.test.mjs` 第 4 项在空目录执行，6/6 通过、**0 skip** |

#### 10.8.2 19 张卡机制表达逐卡审查表

判定口径：只保留「有来源支持的机制 + 适用边界」；删除机械数量、固定句位、必须采用的表现方式。**无卡移出运行池**——所有卡的核心机制均可迁移，问题集中在表达约束，已逐条删除。

| # | 卡片 | 状态 | 发现的问题 | 处理 | 证据是否支持 |
|---|---|---|---|---|---|
| 1 | `combat-partial-suppression-then-leak` | verified | 原含固定句位/量化式表达 | 改为「压制程度可估算 + 保留一处未处理隐患」，删句位 | 支持机制（压制兑现 + 隐患保留），不支持句位 |
| 2 | `combat-role-brief-before-engagement` | verified | 以「职责或资格」指定动机 | 删除动机指定，保留分工/位置/补救责任落到具体角色 | 支持 |
| 3 | `combat-shrink-domain-approach` | verified | 原为强制收窄 | 改为「可收窄」，保留机制 | 支持 |
| 4 | `copy-end-hook` | unverified | 无机械要求（机制型） | 保留 | 旧记录未核验 |
| 5 | `cost-escalating-tool` | unverified | 损耗清单被读成枚举 | 改为「如」举例 | 保留，未核验 |
| 6 | `cost-payoff-itemized-ledger` | verified | 「涉及谁/多少/未处理」三件套枚举 | 删枚举，保留代价可清点 + 欠账保留 | 支持 |
| 7 | `fake-authority` | unverified | 「报价与术语」「藏在普通人身份」「早半步看穿」情节配方 | 删配方，保留冒充者误导与真实参与者低调的结构 | 旧记录未核验 |
| 8 | `info-asymmetry-tension` | unverified | 机制型，无机械要求 | 保留 | 未核验 |
| 9 | `info-reveal-archive-exception` | verified | 「先…再…」固定句序 + 指定输出「同类样本分布」 | 先删内容指定；**本轮再删残留的顺序表述**，改为「在可核对口径上给出与预期相反的例外」 | 支持机制，不支持句序 |
| 10 | `info-reveal-bystander-withheld-question` | verified | 机制型（旁观者承接 + 不解释原理） | 保留 | 支持 |
| 11 | `info-reveal-trace-in-hand-close` | verified | 原「章末最后一句」固定句位 | 删句位，保留「落点放在可检查物证」 | 支持机制 |
| 12 | `physical-anomaly-horror` | unverified | 举例式，无机械要求 | 保留 | 未核验 |
| 13 | `protagonist-cold-deduction` | unverified | 「超过六段」机械数量 | 改为「不打断当前节奏」 | 保留，未核验 |
| 14 | `relationship-limited-alliance` | verified | 「至少两条独立信息……才允许结盟」机械阈值 | 删数量阈值，保留可核对证据 + 共同威胁 + 保留距离 | 支持机制 |
| 15 | `rule-copy-probe` | unverified | 机制型 | 保留 | 未核验 |
| 16 | `rule-hidden-loophole` | unverified | 机制型 | 保留（开发集 fuben ch1/ch2 适用） | 未核验 |
| 17 | `team-panic-chain` | unverified | 固定角色分工配方（最先不信者 → 破坏者 → 最谨慎者） | **本轮改为「可追溯外溢路径：谁先不信 / 如何扩散 / 代价落在谁」**，删除固定分工 | 旧记录未核验 |
| 18 | `team-pressure-discipline-list-close` | verified | 「身份疑点/身份矛盾」情节配方 + 章末固定句位 | 删配方与句位，保留「可执行纪律 + 一处与前文对不上的细节」 | 支持机制 |
| 19 | `world-rule-via-consequence` | unverified | 举例式 | 保留 | 未核验 |

#### 10.8.3 11 次实际交付逐条相关性审查（开发集）

开发集 = 原回放 20 章（`outline` 14 + `session` 6）。下表逐条审查全部 11 次交付，判定依据是**作者写前契约**，不看生成正文反推意图。

| # | 作品·层·章 | 交付卡 | 命中维度 | 契约证据 | 适用条件成立 | 有无新增情节要求 | 结论 |
|---|---|---|---|---|---|---|---|
| 1 | fuben·author·ch1 | `rule-hidden-loophole` | sf+beat+pressure+cost（4） | `workspaces/fuben/series/ch1-outline-explicit.md:12,98` | 成立（核心反转即钻规则字眼） | 无 | **适用**，但 `sceneFunction=boundary_test` 与卡 `rule_exploitation` 不符，准入靠 beat + 次要维度 |
| 2 | fuben·author·ch2 | `rule-hidden-loophole` | sf+beat+cost（4） | 同上 `ch2:14,43,57-69` | 成立（设计师视角发现措辞漏洞 + 自指句验证） | 无 | **适用** |
| 3 | xinmo·author·ch13 | `team-panic-chain` | sf+beat+pressure+cost（4） | `workspaces/xinmo/series/ch13-outline-explicit.md:21-67` | 不成立（4 个事件为早餐/训练/聚餐/祭炼，无团队恐慌与规则不信） | 无 | **不适用** |
| 4 | xinmo·author·ch16 | `combat-partial-suppression-then-leak` | beat+stateDelta（2，sf 不符） | `workspaces/xinmo/series/ch16-outline-explicit.md:38-50,52-65` | 部分成立（压制主体是大蛇，非主角） | 卡片要求「同一段成立」，契约分属两个事件 | **证据不足（待用户复核）** |
| 5 | xinmo·author·ch17 | `fake-authority` | sf+decision+cost+state（4） | `workspaces/xinmo/series/ch17-outline-explicit.md:20-68` | 不成立（5 个事件无自称懂行的冒充者） | 无 | **不适用** |
| 6 | xinmo·author·ch18 | `fake-authority` | sf+beat+state（3） | `workspaces/xinmo/series/ch18-outline-explicit.md:21-69` | 不成立（无冒充者；事件 4 是真实情报揭示，不是诱饵） | 无 | **不适用** |
| 7 | xinmo·author·ch22 | `info-asymmetry-tension` | sf+cost+state（3） | `workspaces/xinmo/series/ch22-outline-explicit.md:12,57` | 成立（三层信息差 + 读者隐隐不安） | 无 | **适用** |
| 8 | p587·generated·ch3 | `info-reveal-archive-exception` | beat+state（2） | archive `p587/series/ch3-outline-explicit.md:6` | 不成立（雾隐兽救援/医院/父亲背影，无档案监控） | 无 | **不适用** |
| 9 | p252·generated·ch20 | `info-reveal-trace-in-hand-close` | sf+beat（2） | archive `p252/series/ch20-outline-explicit.md:6,7` | 不成立（章末落点是识海护罩裂缝，不是可检查物证） | 卡片要求「落点放在物证上」，与契约章末冲突 | **不适用** |
| 10 | p587·generated·ch1 | `combat-partial-suppression-then-leak` | sf+beat（2） | archive `p587/series/ch1-outline-explicit.md:7-80` | 不成立（主角被雾隐兽扑空、逃亡、入林，未取得压制优势） | 无 | **不适用** |
| 11 | p252·session·ch430 | `team-pressure-discipline-list-close` | sf+beat（2） | archive `p252/novelos-sessions/novelos-430-9beab4f2/trajectory-content.jsonl` | 不成立（章末是溶洞单人装备检查收束，无团队纪律要求） | 无 | **不适用** |

> archive 根：`platform/.tmp/novel-runtime-archive/<隔离ID>/workspaces/`。p587 ch1=`fab6fb5b…`、p587 ch3=`0f2c0602…`、p252 ch20=`3cecfcdf…`、p252 ch430 会话=`a7952615…`。

**统计（相关性口径，独立于交付率）**

| 结论 | 数量 | 占比 |
|---|---|---|
| 适用 | 3 | 27.3% |
| 不适用 | 7 | 63.6% |
| 证据不足 | 1 | 9.1% |
| 合计交付 | 11 | 100% |

交付率 55%（11/20）只说明「有卡通过结构化准入」；相关性正确率 3/11（27.3%）说明**准入命中不等于机制适用**。不适用案例中多数由 `beat + 次要维度` 或弱 `sceneFunction` 组合放行，`avoid_when` 无语义判断，无法阻止。

#### 10.8.4 ch16 争议点（提交用户复核，开发不自行判定）

1. **主体错位**：契约事件 2 的压制来自大蛇，主角只是伏背观察；卡片机制是「主角刚取得一次可见优势」。
2. **「同一段成立」存疑**：契约把「碾压通过」（事件 2）与「砍伐招敌隐患」（事件 3）分开写，卡片要求优势与新压力在同一段成立。
3. **主维度错配**：`sceneFunction=world_reveal`，卡片 `combat_approach`；仅 `beat + stateDelta` 两维放行，属准入允许的最弱组合。
4. **判定问题**：是否算「可迁移的低配命中」，需用户确认；开发侧结论保持「证据不足」。

#### 10.8.5 独立验证集：样本不足（0/20）

要求「至少 20 个未用于本轮补卡的真实作者写前契约」。实际盘点：

| 项 | 结果 |
|---|---|
| `workspaces/**/series/ch*-outline-explicit.md` 文件数 | 19 个 |
| 按内容 SHA-256 去重后唯一「作品 + 章节」 | **7 个**：fuben ch1/ch2、xinmo ch13/16/17/18/22 |
| 副本来源 | `kbexp-off`/`kbexp-on`/`kv2-a`~`kv2-d` 的 ch1/ch2 与 `fuben` 字节完全相同（哈希 `48ab67ab…`/`40826241…`） |
| 可用于独立验证集的**新增**契约 | **0 个**（7 个已全部用于开发集） |
| `generated`/`session` 代理样本 | 不用于独立验证（字段派生不全，且非作者写前契约） |

**结论：独立验证集样本不足，任务 3 的独立部分无法完成，不以生成的/session 样本凑数，也不在看完结果后更换样本。**

#### 10.8.6 重跑结果（本次命令与真实输出）

| 命令（工作目录） | 结果 |
|---|---|
| `node scripts/distill-scene-cards.mjs --corpus D:\pns-exp\novelbag-v0`（仓库根） | 19 张（verified 9 / unverified 10），`assetSha256=9a12cf2f…`, `provenanceSha256=d04e49ce…` |
| `node scripts/build-scene-card-pool.mjs --asset docs/external-kb/scene-cards-v2.json --pool data/external-distilled/slices.json --corpus D:\pns-exp\novelbag-v0` | `corpusReverified=true`，`poolSha256=652e4015…`，23203 bytes，19 entries |
| 空目录两次重建（见 §10.8.1） | 两次哈希一致且与正式池逐字节一致 |
| `node --import ./tests/setup-test-env.mjs --test tests/external-scene-cards-v2.test.mjs`（`.pi/extensions/novel-studio`） | **6/6 通过，0 skip**（含空目录、真实语料回读、准入未放宽） |
| `node --import ./tests/setup-test-env.mjs --test tests/external-knowledge-base.test.mjs` | **28/28 通过，0 skip** |
| `npm run verify:external-kb`（`.pi/extensions/novel-studio`） | 退出码 0；`slices.json` 19 条、`sha256=652e4015…`、loader ok |
| `node scripts/external-kb-replay.mjs`（仓库根） | 20 章、11 次交付、`deliveredRate=0.55`、`poolSha256=652e4015…`、`coverageGap=0`、`primaryDimensionMissing=0`、`legacyZeroHitRate=0.95` |
| 回放分层 | author 7/7（1.0）、generated 3/7（0.4286）、session 1/6（0.1667） |

#### 10.8.7 边界声明与下一步

- 本轮只证明**资产可复现、检索按结构化规则可回放**；不证明「知识卡改善小说」。
- 交付率 55% 不是通过条件；相关性「适用 3 / 不适用 7 / 证据不足 1」是本轮真实结论，不因交付率达标而改写。
- 10 张 unverified 卡未核验出处，引用时不得声称已核对语料。
- 下一步才进入**知识卡开/关真实章节对照**：同模型、同作者契约、同初始状态，经唯一公开生成入口与必经风格优化，由用户盲评。届时结论才回答「知识卡是否改善小说」。

---

## §10.9 冻结卡池与必要前提三态门禁（开发集验收）

> 本轮按用户口径执行：**冻结现有卡池，把已发现的不适用案例作为反例；仅凭作者写前契约核对卡片必要前提，区分「成立／明确不成立／信息不足」，后两者不交付；不用章节编号白名单、专名、删除所有卡片等方式规避问题，也不简单提高标签阈值；用新增、未参与调整的真实契约验证，没有独立样本就只能报告开发集结果；先证明能减少错误交付，再生产接线和正文盲评。**
>
> 本轮**不生产接线、不运行付费生成、不覆盖正文、不改长期状态**；生产检索算法、`EXTERNAL_KB_STRUCTURAL_MIN_SCORE`、`topK`、`fallback`、意图派生与 prompt 全部未改。

### 10.9.1 冻结证明（资产层 + 运行池层 + 核对表层）

| 对象 | 路径 | SHA-256 |
|---|---|---|
| 权威卡资产（19 张：verified 9 / unverified 10） | `docs/external-kb/scene-cards-v2.json` | `9a12cf2f6ce082ea8bd1267f6a1edcb25cc0ba9d647e951cf40e1f0cd81e40fb` |
| 运行池 | `data/external-distilled/slices.json` | `652e40150683fa87090025d327dfc1858040405e8fd82ba0728374c2e3818bce` |
| 必要前提核对表 | `docs/external-kb/scene-card-preconditions.json` | `8a330d1be350b062b4865442063e6da86b7e47049d2290b121ff5804a6ebb1c8` |
| 反例标签集 | `docs/external-kb/scene-card-counterexamples.json` | `9490b1a5f9d0b3a93567324b4b80b3f38d4b962e55f93c12c641ecaf46e019c4` |

- 前提表与反例集各自绑定 `frozenPoolSha256`，脚本运行前强校验；不一致直接 `exit 2`，不产出结论。
- 前提表另绑定 `frozenAssetSha256`（本轮新增），对卡资产层同样强校验。
- 与既有回放逐章比对 `deliveredIds`，不一致 `exit 3`，防止卡池/采集口径漂移后仍复用旧结论。
- 19 张卡每张都必须有前提定义，缺定义即 `exit 2`（不允许「无核对依据仍交付」）。

### 10.9.2 必要性前提与三态规则

前提表按卡片自身 `applicable_when` / 机制描述逐条拆出「机制成立所必需的条件」，用**概念组**表达可核对证据（每组至少命中一个词才算命中）；`contradiction` 组命中即判「明确不成立」。不含章节编号、作品名、角色专名。

| 卡 | 必要前提（摘） |
|---|---|
| `combat-partial-suppression-then-leak` | 主角刚取得可见优势 + 场上存在未处理的次要威胁（反证：逃跑/败退） |
| `combat-role-brief-before-engagement` | 有队伍且仍处布置阶段（反证：单人/已正面交手） |
| `combat-shrink-domain-approach` | 对手无法正面对抗 + 需在未惊动前提下接近 |
| `copy-end-hook` | 章末落在未验证新规则/未解线索（作用域=章末） |
| `cost-escalating-tool` | 长线消耗型道具（道具词 + 损耗词，反证：一次性） |
| `cost-payoff-itemized-ledger` | 本章刚完成能力突破（反证：纯日常） |
| `fake-authority` | 场上有冒充者/伪专家（反证：无冒充） |
| `info-asymmetry-tension` | 角色间信息不对等（反证：信息完全公开） |
| `info-reveal-archive-exception` | 可复核记录来源 + 核对动作（反证：无可核对记录） |
| `info-reveal-bystander-withheld-question` | 场上有层级较低的旁观者 |
| `info-reveal-trace-in-hand-close` | 章末落在可检查物证（作用域=章末）+ 此前有对抗 |
| `physical-anomaly-horror` | 可核对的物理反常（反证：轻喜剧/日常线） |
| `protagonist-cold-deduction` | 需从线索推断规则 |
| `relationship-limited-alliance` | 双方互不信任 + 共同威胁 |
| `rule-copy-probe` | 首次进入且规则未明示 |
| `rule-hidden-loophole` | 规则条文已给出 + 生死攸关 |
| `team-panic-chain` | 多人团队 + 伤亡/恐慌（反证：单人/独自） |
| `team-pressure-discipline-list-close` | 章末团队纪律处境（作用域=章末；反证：单人/独自） |
| `world-rule-via-consequence` | 首次交代世界规则 |

三态判定：任一 `contradiction` 命中 → **明确不成立**；否则任一 `required` 组未命中 → **信息不足**；全部命中 → **成立**。卡级规则：只要有一条前提不是「成立」，该卡不交付。

作用域：`whole` 在整份作者写前契约内找证据；`ending` 只取章末字段本身（不再把字段之后的整段内嵌正文纳入）或契约末尾 20%，避免中段物证被误当章末落点（p252 ch20 首版假阳性由此修复）。

### 10.9.3 开发集前后对照（11 次真实交付）

| 指标 | 门禁前 | 门禁后 |
|---|---|---|
| 交付次数 | 11 | 3 |
| 错误交付 | 8 | 0 |
| 正确交付 | 3 | 3 |
| 三态分布 | — | 成立 3 / 明确不成立 2 / 信息不足 6 |
| 混淆矩阵 | — | TP 3 / FP 0 / FN 0 / TN 8 / 未标注 0 |

| 作品 | 章 | 卡片 | 人工标签 | 门禁三态 | 结果 | 关键证据 |
|---|---|---|---|---|---|---|
| 副本设计师 | 1 | `rule-hidden-loophole` | 适用 | 成立 | 交付 | 规则原文第一行 + 30 分钟死亡倒计时 |
| 副本设计师 | 2 | `rule-hidden-loophole` | 适用 | 成立 | 交付 | 至少三条规则 + 清算致死 |
| 心魔界 | 22 | `info-asymmetry-tension` | 适用 | 成立 | 交付 | 「三层信息差拉满（读者>小妖>李一凡）」 |
| 心魔界 | 13 | `team-panic-chain` | 不适用 | 信息不足 | 不交付 | 缺 伤亡/死亡/恐慌/崩溃/失控/不信 |
| 心魔界 | 16 | `combat-partial-suppression-then-leak` | 证据不足 | 信息不足 | 不交付 | 缺 可见优势词与未处理次要威胁 |
| 心魔界 | 17 | `fake-authority` | 不适用 | 信息不足 | 不交付 | 缺 冒充/伪专家/自称懂行 |
| 心魔界 | 18 | `fake-authority` | 不适用 | 信息不足 | 不交付 | 同上 |
| p587 | 3 | `info-reveal-archive-exception` | 不适用 | 信息不足 | 不交付 | 缺 核对/复核/查清/比对 |
| p252 | 20 | `info-reveal-trace-in-hand-close` | 不适用 | 信息不足 | 不交付 | 章末非可检查物证 |
| p587 | 1 | `combat-partial-suppression-then-leak` | 不适用 | **明确不成立** | 不交付 | 反证「朝反方向逃去」 |
| p252 | 430 | `team-pressure-discipline-list-close` | 不适用 | **明确不成立** | 不交付 | 反证「李一凡独自…」 |

逐章交付变化（仅列变化章）：

| 作品 | 章 | 保真度 | 门禁前 | 门禁后 |
|---|---|---|---|---|
| 心魔界 | 13 | author | `team-panic-chain` | 空 |
| 心魔界 | 16 | author | `combat-partial-suppression-then-leak` | 空 |
| 心魔界 | 17 | author | `fake-authority` | 空 |
| 心魔界 | 18 | author | `fake-authority` | 空 |
| p587 | 3 | generated | `info-reveal-archive-exception` | 空 |
| p252 | 20 | generated | `info-reveal-trace-in-hand-close` | 空 |
| p587 | 1 | generated | `combat-partial-suppression-then-leak` | 空 |
| p252 | 430 | session | `team-pressure-discipline-list-close` | 空 |

其余 12 章门禁前后均为空交付，未新增任何交付（门禁只会减少，不会新增卡片）。

### 10.9.4 局限（必须随结果一起读）

1. **只算开发集结果**：前提表的概念组由人编写，编写时已看过这 11 个案例；不构成独立验证。
2. **没有新增未参与调整的真实契约样本**：`workspaces/platform/reports` 全量盘点后，唯一「作品+章节」作者契约仍为 7 个（fuben ch1/ch2、xinmo ch13/16/17/18/22），且已全部用于开发集；独立验证集仍为 **0/20**。
3. **门禁保守**：契约未明确支持的前提一律按「信息不足」拦下，会存在正确交付被误拦的风险（开发集 FN 恰为 0，但这不能外推）。
4. **只回答一个问题**：本报告只证明「交付前核对必要前提能减少错误交付」，不回答「知识卡是否改善小说」，也不构成生产接线授权。

### 10.9.5 复跑命令与产物

```bash
# 仓库根，依赖已构建的 .pi/extensions/novel-studio/dist/
node scripts/external-kb-precondition-check.mjs
```

产物：

- `reports/external-kb-precondition/expectation-gate.json`（逐章 / 逐次交付 / 每条前提证据）
- `reports/external-kb-precondition/summary.md`（本报告对应的人类可读版本）

脚本特性：复用 `scripts/external-kb-replay.mjs` 的契约采集口径（不建第二套意图代理）；只读冻结资产与前提表；零新增依赖；任何哈希/回放不一致直接非零退出，不产出结论。

### 10.9.6 下一步（未执行）

- 生产接线（把三态门禁接进 `v2/core/external-knowledge-base.ts` 交付路径）：**未执行**，需用户授权。
- 知识卡开/关真实章节对照与正文盲评：**未执行**，需独立契约样本与付费生成预算。



