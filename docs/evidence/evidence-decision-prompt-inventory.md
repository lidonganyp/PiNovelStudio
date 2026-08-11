# Evidence Decision Prompt Inventory

> 状态：**盘点中**（2026-08-11）。本盘点仅用于识别 prompt 压缩机会，不修改生产 prompt。
> 数据来源：baseline v2 真实 trace（ch22 xinmo-eval / ch2 fuben-eval）+ 源码分析。

## 1. evidence_decision 调用概述

`novelos_evidence_decision` 是统一主链路中固定每章一次的结构化决策回合。它在 NovelOS Agentic 的 ReAct 检索循环之前运行，由 `runEvidenceDecisionRound`（[evidence-decision.ts](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/novelos/agent/evidence-decision.ts)）编排。

**调用位置**：`agentic-raw-candidate-source.ts` 第 468-476 行，在 `createEvidencePlan` 之后、agent loop 之前。

**模型参数**：`maxTokens=512`，`temperature=0.72`（复用 `v2_rawstage2_gemini31` 路由）。

### 1.1 baseline v2 实际消耗

| 章节 | workspace | 输入 token | 输出 token | 耗时(ms) |
|------|-----------|-----------|-----------|---------|
| ch22 | xinmo-eval | 16,773 | 1,401 | 16,151 |
| ch2 | fuben-eval | 8,385 | 1,356 | 16,494 |

> 输出 token（1,234-2,932）远超 `maxTokens=512`，证实隐藏 thinking token 被计入 completion。capability probe 已确认当前代理端点无法通过 API 参数控制。

### 1.2 prompt 构造代码

```
systemPrompt: EVIDENCE_DECISION_SYSTEM_PROMPT  （~100 字符）
userPrompt: buildEvidenceDecisionPrompt(input)  （主要 token 成本）
```

`buildEvidenceDecisionPrompt` 构造的 user prompt 结构：

```
[角色指令]          ← ~100 字符
【本章意图】         ← chapterIntentStr（来自 buildChapterIntentString）
【种子上下文】       ← seedContextStr（来自 buildContractContextString）
【已知事实】         ← known[]（来自 extractKnownFromContext）
【必须验证点】       ← mustVerify[]（来自 extractMustVerifyFromIntent）
【可选工具】         ← systemAllowedTools[]（来自 inferAllowedToolsFromIntent）
[JSON 输出 schema]  ← ~300 字符
```

## 2. 逐段盘点

### 2.1 角色指令

**内容**：
```
你是本章的证据检索规划者。请基于给定的本章意图、种子上下文、已知事实与必须验证点，
输出一份检索决策（JSON）。不要生成正文，不要修改已知事实真值。
```

- **估算 token**：~50 token
- **分类**：流程指导
- **必须保留**：是。定义模型角色和输出约束。
- **可压缩**：`"不要生成正文，不要修改已知事实真值"` 与 system prompt 重复（system 已说"不生成正文、不修改已知事实、不执行工具"）。

### 2.2 system prompt

**内容**：
```
你是证据检索规划助手。你只输出一份结构化 JSON 检索决策，
不生成正文、不修改已知事实、不执行工具。输出必须是一个合法 JSON 对象。
```

- **估算 token**：~40 token
- **分类**：流程指导
- **必须保留**：是。定义输出格式约束。
- **重复**：`"不生成正文、不修改已知事实"` 在 user prompt 角色指令中重复。

### 2.3 【本章意图】（chapterIntentStr）

**来源**：`buildChapterIntentString(intent: ChapterIntent)`（[agentic-raw-candidate-source.ts](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/novelos/agent/agentic-raw-candidate-source.ts) 第 818-870 行）

**包含字段**：
| 字段 | 说明 | ch22 示例 |
|------|------|---------|
| `chapterFunction` | 本章功能 | "setting" |
| `readerExperience` | 读者体验目标 | "主角是主动选择者..." |
| `currentPressure` | 当前压力 | 来自 intent |
| `meaningfulChoices` | 有意义的选择 | 来自 intent |
| `selectedPromisesToAdvance` | 本章推进的伏笔（≤3条） | F-01/F-06/N-10-02 |
| `causalEndPressure` | 章末因果压力 | 来自 intent |
| `relevantCharacters` | 相关角色 | 李一凡、李强、小妖... |
| `inviolableFacts` | 不可破坏的事实 | 铁山已死亡、禁止被动失败者... |
| `authorEventSummaries` | 作者事件摘要 | 来自 intent |
| `authorMustInclude` | 作者必须包含 | 来自 intent |
| `authorStateChanges` | 作者状态变更 | 来自 intent |
| `endingTarget` | 章末目标 | 来自 intent |

**ch22 估算**：~4,000-5,000 字符 → ~3,000-3,500 token
**ch2 估算**：~2,000-3,000 字符 → ~1,500-2,000 token

- **分类**：混合（事实输入 + 流程指导）
- **必须保留**：`chapterFunction`、`selectedPromisesToAdvance`、`relevantCharacters`、`endingTarget`。这些是模型判断检索需求的关键输入。
- **重复**：
  - `inviolableFacts` **与 mustVerify 大量重复**。ch22 的 mustVerify 8 条中，至少 6 条直接来自 inviolableFacts（铁山已死亡、禁止被动失败者、禁止渐进式突破...）。
  - `readerExperience` 与 seedContext 中的 `长期读者承诺` 重复。
- **可删除**：`currentPressure`、`meaningfulChoices` 对证据检索决策无直接价值（它们是写作指导，不是事实查证目标）。
- **可压缩**：`inviolableFacts` 如果已在 mustVerify 中列出，此处可只引用编号。

### 2.4 【种子上下文】（seedContextStr）

**来源**：`buildContractContextString(intent, context, characterNames, targetWordCount, fewshotSelection, writerPromptProfile)`（第 890-982 行）

**包含内容**：
| 段 | 说明 | ch22 估算字符 |
|----|------|-------------|
| ChapterContract（renderContract 渲染） | 作品身份、长期读者承诺、类型承诺、主角核心冲突、长期主题问题、禁止偏离、整体剧情方向 | ~8,000 |
| `context.openLoops` | 未结伏笔列表 | ~1,000 |
| `context.worldRules` | 世界规则 | ~500 |
| `context.bridgeContext` | 前章悬置状态（最后事件/结尾情绪/开放钩子/未解张力/引入角色） | ~1,500 |
| `characterNames` | 角色名列表 | ~300 |
| `targetWordCount` | 字数软目标 | ~50 |
| `fewshotSelection` | Few-shot 黄金示例（2个完整章节片段） | ~5,000 |

**ch22 估算**：~16,000 字符 → ~10,000-11,000 token
**ch2 估算**：~8,000 字符 → ~5,000-5,500 token

- **分类**：混合（事实输入 + 写作指导 + Few-shot）
- **这是 input token 的最大成本项**，占 evidence_decision 总输入的 ~60-65%。
- **必须保留**：
  - `bridgeContext`（前章悬置状态）：模型需要验证时间线衔接。
  - `openLoops`（未结伏笔）：模型需要判断哪些伏笔本章推进。
  - `worldRules`：模型需要验证世界观一致性。
- **可删除/不必要**：
  - `fewshotSelection`（Few-shot 黄金示例）：**与证据检索决策完全无关**。Few-shot 是给正文 writer 的写作参考，不是给检索规划者的输入。ch22 包含 2 个完整章节片段（~5,000 字符），是纯粹的噪声输入。
  - `长期读者承诺`、`类型承诺`、`主角核心冲突`、`长期主题问题`、`禁止偏离`：这些是写作哲学指导，不是事实查证目标。evidence_decision 只需要判断"哪些事实需要检索"，不需要"怎么写好小说"。
  - `整体剧情方向`：全书剧情大纲，对单章检索决策过于高层。
- **可压缩**：
  - `ChapterContract` 的渲染可以只保留 `bridgeContext` + `worldRules` + `openLoops` 三段，删除写作哲学段。

### 2.5 【已知事实】（known[]）

**来源**：`extractKnownFromContext(intent, compiledContext)`（[evidence-plan.ts](file:///D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/novelos/agent/evidence-plan.ts) 第 289-334 行）

**包含内容**：从 CompiledContext 提取的已知摘要（≤12条，每条≤80字）：
- 角色 state 摘要（relevantCharacters 中的角色）
- worldRules 摘要（与 inviolableFacts 有重叠的）
- openLoops 摘要（selectedPromisesToAdvance 中的）

**ch22 实际**：9 条，每条是角色 JSON 摘要（`李一凡：{"role":"protagonist","aliases":["一凡"],"narrativeProfile":{"personality":["配...`）

- **估算 token**：~800-1,200 token
- **分类**：必须保留的事实输入
- **必须保留**：是。模型需要已知事实来区分"已知"和"未知"。
- **可压缩**：当前格式是 JSON 片段截断（`{"role":"protagonist","aliases":["一凡"],"narrativeProfile":{"personality":["配`），不完整且信息密度低。可改为结构化摘要（`李一凡：主角，别名[一凡]，性格[配...]`）。

### 2.6 【必须验证点】（mustVerify[]）

**来源**：`extractMustVerifyFromIntent(intent)`（evidence-plan.ts 第 210-232 行）

**提取优先级**：
1. `authorMustInclude`（作者章纲明确要求包含的）
2. `inviolableFacts`（不可破坏的事实，P0 风险）
3. `factAndCharacterKnowledgeForbiddenZones`（角色知识禁区，P0 风险）
4. `selectedPromisesToAdvance`（本章推进的伏笔，P1 风险）
5. `expectedIrreversibleChange`（预期不可逆变化，P1 风险）

**ch22 实际**：8 条，其中 6+ 条与 chapterIntent 中的 inviolableFacts 完全重复。

- **估算 token**：~400-600 token
- **分类**：必须保留的事实输入
- **必须保留**：是。这是系统强制模型必须检索覆盖的安全边界。
- **重复**：与 chapterIntent 的 `inviolableFacts` 大量重复。模型在 prompt 中看到同一组禁止规则两次。
- **可压缩**：如果 chapterIntent 中保留 inviolableFacts，此处可只列出 mustVerify 独有的项（如 `authorMustInclude`、`expectedIrreversibleChange`）。

### 2.7 【可选工具】（systemAllowedTools[]）

**来源**：`inferAllowedToolsFromIntent(intent, bridgeContextAvailable)`（evidence-plan.ts 第 246-278 行）

**ch22 实际**：7 个工具
```
- search_narrative_evidence
- query_pattern_memory
- query_canon
- query_character_knowledge_boundary
- query_character_state
- query_promise_ledger
- search_chapter_span
```

**ch2 实际**：8 个工具（多了 `query_voice_evidence`）

- **估算 token**：~150-200 token
- **分类**：结构化输出约束
- **必须保留**：是。模型只能从中选择，系统后续做交集校验。
- **可压缩**：当前只列工具名，没有工具描述。但工具 schema 由 agent loop 的 tool registry 注入，evidence_decision 不需要工具 schema（它只输出工具名，不执行工具）。当前格式已经足够精简。

### 2.8 JSON 输出 schema

**内容**：
```json
{
  "needRetrieval": "boolean：是否有需要检索的未知点",
  "unknown": "string[]：你判定为未知、可能改变事实/人物状态/因果关系的点（最多8条）",
  "selectedTools": "string[]：从可选工具中选择你计划使用的工具（可为空数组）",
  "queries": "string[]：建议的检索 query（最多6条）",
  "retrievalDepth": "number：0-3，0=不检索，3=深度检索"
}
```

- **估算 token**：~150-200 token
- **分类**：结构化输出约束
- **必须保留**：是。定义模型输出格式。
- **可压缩**：字段说明可精简（如 `"needRetrieval": "bool"` 代替 `"boolean：是否有需要检索的未知点"`），但收益很小（~50 token）。

## 3. token 成本汇总

### 3.1 ch22（xinmo-eval）估算

| 段 | 估算字符 | 估算 token | 占比 | 分类 |
|----|---------|----------|------|------|
| system prompt | ~100 | ~40 | 0.2% | 流程指导 |
| 角色指令 | ~100 | ~50 | 0.3% | 流程指导（与 system 重复） |
| 【本章意图】 | ~4,500 | ~3,000 | 17.9% | 混合（含重复） |
| 【种子上下文】 | ~16,000 | ~10,500 | 62.6% | 混合（含不相关内容） |
| ├ ChapterContract 写作哲学 | ~6,000 | ~4,000 | 23.8% | **可删除** |
| ├ bridgeContext + worldRules + openLoops | ~3,000 | ~2,000 | 11.9% | 必须保留 |
| ├ fewshotSelection | ~5,000 | ~3,300 | 19.7% | **可删除** |
| ├ characterNames + targetWordCount | ~350 | ~230 | 1.4% | 可压缩 |
| ├ 前章正文摘录 | ~1,650 | ~1,070 | 6.4% | 可评估 |
| 【已知事实】 | ~1,200 | ~800 | 4.8% | 必须保留（可改善格式） |
| 【必须验证点】 | ~600 | ~400 | 2.4% | 必须保留（与意图重复） |
| 【可选工具】 | ~250 | ~170 | 1.0% | 必须保留 |
| JSON schema | ~400 | ~200 | 1.2% | 必须保留 |
| **合计** | ~23,150 | ~16,760 | 100% | 与实际 16,773 吻合 |

### 3.2 ch2（fuben-eval）估算

| 段 | 估算字符 | 估算 token | 占比 |
|----|---------|----------|------|
| system + 角色指令 | ~200 | ~90 | 1.1% |
| 【本章意图】 | ~2,500 | ~1,700 | 20.3% |
| 【种子上下文】 | ~8,000 | ~5,300 | 63.2% |
| 【已知事实】 | ~1,000 | ~700 | 8.3% |
| 【必须验证点】 | ~600 | ~400 | 4.8% |
| 【可选工具】 | ~280 | ~190 | 2.3% |
| JSON schema | ~400 | ~200 | 2.4% |
| **合计** | ~12,980 | ~8,580 | 与实际 8,385 吻合 |

### 3.3 9 章汇总（来自 baseline v2）

| 指标 | 值 |
|------|------|
| evidence_decision 调用数 | 9 |
| 总输入 token | 136,106 |
| 总输出 token | 12,816 |
| 平均输入 token/章 | 15,123 |
| 平均输出 token/章 | 1,424 |
| 平均耗时/章 | 16,052ms |

## 4. 9 工具 schema

evidence_decision prompt 中的【可选工具】只列工具名，不含 schema。工具 schema 由 agent loop 的 tool registry 注入（`NARRATIVE_TOOL_FACTORIES`），evidence_decision 不消费工具 schema。

| # | 工具名 | parameters schema | 说明 |
|---|--------|------------------|------|
| 0 | `search_narrative_evidence` | `{query: string, maxResults?: number}` | 全文叙事证据检索 |
| 1 | `search_chapter_span` | `{query: string, maxChapters?: number, maxResults?: number}` | 跨章检索 |
| 2 | `query_canon` | `{category?: "timeline"\|"location"\|"entity"\|"ability_rule"}` | 世界观查询 |
| 3 | `query_character_state` | `{characterId?: string}` | 角色状态查询 |
| 4 | `query_timeline` | `{}` | 时间线查询 |
| 5 | `query_character_knowledge_boundary` | `{characterId?: string}` | 角色知识边界查询 |
| 6 | `query_promise_ledger` | `{status?: "open"\|"advancing"\|"fulfilled"\|"broken"}` | 伏笔台账查询 |
| 7 | `query_pattern_memory` | `{patternType?: "trope"\|"imagery"\|"sentence_risk"\|"conflict_resolution"\|"hook_type"}` | 模式记忆查询 |
| 8 | `query_voice_evidence` | `{characterId?: string}` | 声音证据查询 |

> evidence_decision 只需工具名列表（当前 ~170 token），不需要完整 schema。当前实现已经正确。

## 5. 重复说明汇总

| 重复项 | 位置 A | 位置 B | 严重程度 |
|--------|--------|--------|---------|
| `inviolableFacts` 内容 | 【本章意图】 | 【必须验证点】 | **高**：8 条 mustVerify 中 6+ 条与 inviolableFacts 逐字重复，浪费 ~400 token |
| `不生成正文/不修改事实` 指令 | system prompt | 角色指令 | 低：~50 token，但语义完全重复 |
| `长期读者承诺` | 【本章意图】`readerExperience` | 【种子上下文】ChapterContract | 中：~300 token |
| `禁止偏离` 规则 | 【本章意图】`inviolableFacts` | 【种子上下文】ChapterContract `禁止偏离` | 中：~500 token |
| 角色列表 | 【本章意图】`relevantCharacters` | 【种子上下文】`characterNames` | 低：~200 token |
| 伏笔列表 | 【本章意图】`selectedPromisesToAdvance` | 【种子上下文】`openLoops` | 低：~200 token |

## 6. 可删除项汇总

| 可删除项 | 位置 | 估算节省 token | 理由 |
|----------|------|---------------|------|
| **`fewshotSelection`** | 【种子上下文】 | ~3,300 (ch22) | Few-shot 是正文 writer 的写作参考，与证据检索决策完全无关 |
| **ChapterContract 写作哲学段** | 【种子上下文】 | ~4,000 (ch22) | `作品身份`、`长期读者承诺`、`类型承诺`、`主角核心冲突`、`长期主题问题`、`整体剧情方向` 是写作指导，不是事实查证目标 |
| **`currentPressure`** | 【本章意图】 | ~200 | 写作压力指导，不是事实查证目标 |
| **`meaningfulChoices`** | 【本章意图】 | ~200 | 写作选择指导，不是事实查证目标 |
| **`readerExperience`** | 【本章意图】 | ~300 | 读者体验目标，不是事实查证目标（且与 seedContext 重复） |
| **角色指令中的重复约束** | 角色指令 | ~50 | 与 system prompt 重复 |

**总估算节省**：ch22 ~8,050 token / 16,773 = **~48%**；ch2 ~4,000 token / 8,385 = **~48%**

## 7. 必须保留项汇总

| 必须保留项 | 位置 | 估算 token | 理由 |
|-----------|------|----------|------|
| `chapterFunction` | 【本章意图】 | ~20 | 定义本章功能，影响检索优先级 |
| `selectedPromisesToAdvance` | 【本章意图】 | ~200 | 本章推进的伏笔，必须检索覆盖 |
| `relevantCharacters` | 【本章意图】 | ~150 | 相关角色列表，影响角色状态查询 |
| `endingTarget` | 【本章意图】 | ~100 | 章末目标，影响检索方向 |
| `bridgeContext` | 【种子上下文】 | ~1,000 | 前章悬置状态，验证时间线衔接 |
| `openLoops` | 【种子上下文】 | ~800 | 未结伏笔，判断哪些本章推进 |
| `worldRules` | 【种子上下文】 | ~500 | 世界规则，验证世界观一致性 |
| `known[]` | 【已知事实】 | ~800 | 已知事实，区分"已知"和"未知" |
| `mustVerify[]` 独有项 | 【必须验证点】 | ~200 | `authorMustInclude`、`expectedIrreversibleChange` |
| `allowedTools[]` | 【可选工具】 | ~170 | 工具集约束 |
| JSON schema | 输出约束 | ~200 | 结构化输出格式 |

**必须保留总估算**：~4,140 token（ch22），占当前 16,773 的 ~25%。

## 8. 结构化输出约束

当前 evidence_decision 的输出约束：

| 约束 | 实现方式 | 有效性 |
|------|---------|--------|
| 输出格式为 JSON | system prompt + schema 示例 | **部分有效**：capability probe 显示 JSON 有效率 baseline=2/3，部分配置 1/3 |
| `selectedTools` 限定在 `allowedTools` 内 | 系统校验 `validateEvidenceDecision` | **有效**：系统级交集校验，模型无法越界 |
| `mustVerify` 不可删除 | 系统兜底（空工具集时回退） | **有效**：系统级强制 |
| `unknown` 上限 8 条 | 系统裁剪 `slice(0, MAX_MODEL_UNKNOWN)` | **有效** |
| `queries` 上限 6 条 | 系统裁剪 | **有效** |
| `retrievalDepth` clamp [0,3] | 系统裁剪 | **有效** |
| `maxTokens=512` | API 参数 | **无效**：completion 实际 1245-1805，隐藏 thinking token 不受限 |

> **关键发现**：结构化输出约束中，系统级校验全部有效（交集/裁剪/兜底），但 API 级 `maxTokens` 约束无效（隐藏 thinking token 不受限）。prompt 级 JSON 格式约束部分有效（~67% JSON 有效率）。

## 9. 下一步：最小 prompt 压缩候选

基于以上盘点，最小压缩候选的方向：

1. **从 seedContext 中删除 fewshotSelection**（~3,300 token）- 与证据检索决策完全无关
2. **从 seedContext 中删除写作哲学段**（~4,000 token）- 只保留 bridgeContext + openLoops + worldRules
3. **消除 inviolableFacts 重复**（~400 token）- 在 chapterIntent 中删除 inviolableFacts，只保留 mustVerify
4. **从 chapterIntent 中删除写作指导字段**（~700 token）- currentPressure / meaningfulChoices / readerExperience
5. **合并 system prompt 和角色指令**（~50 token）

**约束**：
- 保持工具面不变（9 工具 + allowedTools 推断逻辑）
- 保持调用次数不变（每章 1 次 evidence_decision）
- 保持长期状态不变（CanonState / CharacterState / PromiseLedger / PatternMemory）
- 保持 writer prompt 不变（ChapterContract 完整渲染只用于 agent loop，evidence_decision 用精简版）
- 同模型、同 seed、同 9 章样本做 eval-only A/B

**门禁**：
- JSON 有效率 ≥ baseline（当前 ~67%）
- 非法工具选择率 = 0（系统校验保证）
- mustVerify 覆盖率 = 100%（系统兜底保证）
- sourceRef 不劣化（agent loop 检索结果引用率）
- timeout/error 率 = 0
- 最终章节成功率 ≥ 100%（与 baseline v2 一致）
- token 成本降幅 ≥ 40%
