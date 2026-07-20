---
name: novel-brainhole-mine
description: |
  从多部作品挖掘脑洞模式。

  触发条件: "挖掘脑洞"、"提取反转模式"、"brainhole mine"
---

# Novel Brainhole Mine — 脑洞模式挖掘

## 功能说明

从已有作品中发现和提取创意反转模式，丰富脑洞模式库。

## 脑洞模式分类

### 1. 反转类 (reversal)

| 模式 | 说明 |
|------|------|
| identity | 身份反转（废物=大佬） |
| truth | 真相反转（世界是假的） |
| morality | 道德反转（反派是对的） |
| scale | 尺度反转（你以为的大=其实很小） |

### 2. 设定类 (setting)

| 模式 | 说明 |
|------|------|
| rule-inversion | 翻转一条规则 |
| cross-domain | A领域规则→B领域 |
| scale-shift | 尺度跃迁 |
| hidden-layer | 隐藏层级 |

### 3. 伏笔类 (foreshadow)

| 模式 | 说明 |
|------|------|
| double-track | 明暗双线 |
| iceberg | 冰山法则（10%/90%） |
| upgrade-recycle | 伏笔回收升级 |
| domino | 多米诺连锁 |

### 4. 人物类 (character)

| 模式 | 说明 |
|------|------|
| mirror-enemy | 镜像对立 |
| fate-knot | 命运羁绊 |
| mask-layer | 面具之下 |
| growth-paradox | 成长悖论 |

### 5. 结构类 (structure)

| 模式 | 说明 |
|------|------|
| parallel-weaving | 多线并进 |
| time-loop | 时间循环 |
| nested-reveal | 套娃揭示 |
| pov-surprise | 视角惊喜 |

## 执行流程

### 1. 收集案例

从 `corpus/clean/{作品名}/` 读取文本，识别包含以下特征的场景：
- 意外转折点
- 真相揭露点
- 设定反转点
- 人物揭示点

### 2. 提取模式

对每个识别的案例，提取：
- **核心公式**: 模式的核心逻辑
- **强度等级**: Lv1/Lv2/Lv3
- **应用条件**: 什么情况下适用
- **注入时机**: 章内/卷末/全书记
- **反平庸过滤**: 避免的俗套写法

### 3. 生成模式文档

输出 `brainholes/patterns/{category}/{pattern}.md`：

```markdown
# 脑洞模式：真相反转

## 核心公式
"读者相信的A → 其实是B → B背后还有C"

## 强度等级
- Lv1: 单层反转 (A→B)
- Lv2: 双层反转 (A→B→C)
- Lv3: 颠覆性反转 (A→B→C→A')

## 经典案例
《诡秘之主》...

## 应用条件
- ≥3章的铺垫空间
- ≥5个可被重新解释的前文线索

## 注入时机
- 章末（钩子）：小反转
- 卷末（高潮）：大反转

## 反平庸过滤
❌ "原来他竟然是..."
❌ "其实这一切都是梦"
✅ 让角色通过环境线索自行推断
```

## 输出位置

```
brainholes/patterns/{category}/{pattern}.md
brainholes/patterns/{category}/index.json
```

## 优先级

建议优先挖掘以下模式（基于《心魔界》需求）：

1. **identity-reversal** - 都市异能核心
2. **iceberg** - 悬疑必备
3. **mirror-enemy** - 势力博弈
4. **mask-layer** - 人物深度
