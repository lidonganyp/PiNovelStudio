---
name: novel-style-extract
description: |
  从参考作品中提取风格指纹。

  触发条件: "提取风格"、"分析文风"、"style extract"、"提取XX的风格"
---

# Novel Style Extract — 风格指纹提取

## 功能说明

从参考作品中提取完整的风格指纹，用于：
1. 精确控制生成文本的风格
2. 匹配目标读者的阅读偏好
3. 建立风格库

## 风格指纹维度

### 1. 句式特征 (sentence)

| 指标 | 说明 |
|------|------|
| avgLength | 平均句长 |
| lengthVariance | 句长方差 |
| shortBurstsContext | 短句爆发场景 |
| longFlowsContext | 长句流畅场景 |
| fragmentRatio | 碎片句比例 |
| commaDensity | 逗号密度 (每千字) |
| exclamationDensity | 感叹号密度 |
| signaturePatterns | 标志性句式 |

### 2. 词汇特征 (lexicon)

| 指标 | 说明 |
|------|------|
| richness | 词汇丰富度 (unique/total) |
| idiomDensity | 成语密度 (每千字) |
| colloquialRatio | 口语化比例 |
| adverbDensity | 程度副词密度 |
| specializedTerms | 专属术语库 |
| forbiddenWords | 禁止词汇 |
| preferredTransitions | 偏好过渡词 |

### 3. 叙事特征 (narrative)

| 指标 | 说明 |
|------|------|
| povStyle | POV风格描述 |
| povSwitchFreq | POV切换频率 |
| innerMonologueRatio | 内心独白比例 |
| showTellRatio | Show vs Tell比例 |
| dialogueRatio | 对话占比 |
| fightRatio | 战斗描写占比 |
| infoDumpStrategy | 信息释放策略 |
| chapterEndPattern | 章末收尾风格 |
| humorStyle | 幽默风格 |

### 4. 情绪特征 (emotion)

| 指标 | 说明 |
|------|------|
| primaryEmotions | 主要情绪类型 |
| satisfactionInterval | 爽点间隔 (字数) |
| oppressionMax | 最大连续压抑字数 |
| tensionWavePeriod | 紧张-释放周期 |
| climaxPattern | 高潮模式 |
| cliffhangerType | 悬念类型偏好 |

### 5. 意象特征 (imagery)

| 指标 | 说明 |
|------|------|
| colorPalette | 色彩体系 |
| powerVisualization | 力量视觉化风格 |
| environmentStyle | 环境描写风格 |
| fightChoreography | 战斗编排风格 |
| metaphorSource | 比喻来源偏好 |
| sensoryEmphasis | 感官侧重 |

### 6. 节奏特征 (rhythm)

| 指标 | 说明 |
|------|------|
| paragraphLength.avg | 平均段落长度 |
| paragraphLength.variance | 段落长度方差 |
| sceneLength.avg | 平均场景长度 |
| sceneLength.variance | 场景长度方差 |
| actionScenePace | 动作场景节奏 |
| dialogueScenePace | 对话场景节奏 |
| descriptionScenePace | 描写场景节奏 |

## 执行流程

### 1. 准备语料

从 `corpus/clean/{作品名}/` 读取清洗后的文本：
- 最低要求：≥5万字
- 推荐数量：≥10万字

### 2. 分析文本

使用 LLM 辅助分析以下方面：
- 句式统计（句长、标点密度）
- 词汇提取（成语、专业术语）
- 叙事风格（POV、对话比例）
- 情绪曲线（爽点、压抑段）
- 意象分析（色彩、比喻）

### 3. 生成指纹

输出完整的 `StyleFingerprint` JSON：

```json
{
  "name": "番茄流爽文",
  "referenceWorks": ["盘龙", "吞噬星空"],
  "sentence": { ... },
  "lexicon": { ... },
  "narrative": { ... },
  "emotion": { ... },
  "imagery": { ... },
  "rhythm": { ... }
}
```

### 4. 验证指纹

用提取的指纹反向约束生成测试文本，验证有效性。

## 输出位置

```
styles/{style-id}/profile.json
styles/{style-id}/extracted-from.md
styles/{style-id}/fewshots/  (预提取的黄金范例)
```

## 示例

```
输入: 《盘龙》完整文本
输出: styles/tomato-fresh/profile.json
```
