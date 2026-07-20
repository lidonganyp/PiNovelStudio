# DAG 规范参考

> 详细说明 StoryDAG 数据结构的每个字段含义和使用规范

## 概述

DAG (Directed Acyclic Graph) 是故事因果骨架，每个节点是事件，每条边代表因果关系。

## 核心原则

1. **无循环依赖** - 因果边必须是单向的
2. **前置条件明确** - 每个事件的前置条件必须可验证
3. **效果可追踪** - 事件的效果必须可被后续事件引用
4. **情绪曲线连贯** - 事件之间的情绪转换必须平滑

## 事件节点规范

### 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识，格式：`E{数字}`，如 `E1`、`E2` |
| name | string | 事件名称，简短描述性 |
| type | enum | 事件类型：scene, dialogue, action, revelation, transition |
| preconditions | string[] | 前置条件，如 `["E1.completed"]` |
| effects | string[] | 产生的影响，如 `["trigger_E2"]` |
| characters | string[] | 参与角色 ID 列表 |
| location | string | 场景地点 |
| narrativeBeat | enum | 叙事节拍 |
| conflictLevel | number | 冲突等级 1-5 |
| wordCountTarget | object | 字数目标 `{ min: number, max: number }` |

### 可选字段

| 字段 | 类型 | 说明 |
|------|------|------|
| hooks | string[] | 埋设的钩子 |
| worldbuildingReveal | string | 揭示的世界观信息 |
| powerAdvancement | string | 实力提升描述 |
| keyEmotion | string | 核心情绪 |
| emotionalArc | object | 情绪弧线 `{ from: string, to: string }` |

### 事件类型说明

- **scene**: 场景描写，环境、氛围
- **dialogue**: 对话为主，推进剧情
- **action**: 动作场面，战斗、冲突
- **revelation**: 信息揭示，真相揭露
- **transition**: 过渡段落，场景切换

### 叙事节拍说明

- **establishment**: 建制，介绍当前状态
- **rising**: 上升，张力逐渐增加
- **revelation**: 揭示，关键信息揭露
- **crisis**: 危机，最大冲突点前
- **climax**: 高潮，核心冲突爆发
- **resolution**: 解决，冲突平息
- **cliffhanger**: 悬念，章末钩子

## 因果边规范

### 边类型

| 类型 | 说明 | 示例 |
|------|------|------|
| temporal | 时间顺序 | `E1 → E2` (E1先于E2发生) |
| causal | 因果关系 | `E1 → E2` (E1导致E2) |
| motivational | 动机驱动 | `E1 → E2` (E1的角色动机导致E2) |
| informational | 信息传递 | `E1 → E2` (E1的信息被E2使用) |

### 前置条件语法

```
格式: {eventId}.{requirement}

示例:
- "E1.completed" - E1已完成
- "E1.executed" - E1已执行
- "E1.effect:xxx" - E1产生了包含xxx的效果
```

## 章节功能

| 类型 | 说明 | 事件数 | 字数目标 |
|------|------|--------|----------|
| setup | 建制 | 4-5 | 3000-3500 |
| escalation | 升级 | 6-8 | 4000-5000 |
| payoff | 收获 | 5-6 | 3500-4500 |
| climax | 高潮 | 4-5 | 4500-5500 |

## 字数分配建议

| 节拍 | 占比 | 示例 (4000字) |
|------|------|--------------|
| establishment | 15% | 600字 |
| rising | 25% | 1000字 |
| crisis | 20% | 800字 |
| revelation | 15% | 600字 |
| climax | 15% | 600字 |
| resolution | 5% | 200字 |
| cliffhanger | 5% | 200字 |

## 情绪曲线规范

### 标准情绪类型

燃、爽、紧张、压抑、好奇、感动、愤怒、释然、寒意、温馨

### 情绪转换规则

1. 同一情绪不超过3个连续事件
2. 紧张后必须有释放
3. 高潮前必须有压抑蓄能
4. 章末情绪影响下一章开局

### 黄金节奏

- 每 3000-5000 字至少 1 个明确爽点
- 连续压抑不超过 3000 字
- 每章至少 3 种情绪
- 章末必须有钩子

## DAG 验证规则

### 规则 1: 前置条件满足性

```typescript
forall event in DAG.events:
  forall precondition in event.preconditions:
    exists sourceEvent in DAG.events:
      sourceEvent.id 能推导出 precondition
```

### 规则 2: 无循环依赖

拓扑排序必须成功，无环。

### 规则 3: 角色一致性

角色的状态在所有事件中连续、无矛盾。

### 规则 4: 世界规则遵守

事件不能违反 `worldConstraints` 中的任何约束。

### 规则 5: 伏笔完整性

所有已埋设的钩子必须有对应的回收计划。

## 伏笔规范

### 伏笔类型

1. **明线伏笔** - 明确提示但不过早揭示
2. **暗线伏笔** - 无意识埋设，回收时恍然大悟
3. **连环伏笔** - 多个伏笔相互关联，逐一回收

### 伏笔生命周期

1. **埋设** - 在 `foreshadowing.planted` 中记录
2. **等待** - 在 `foreshadowing.pending` 中追踪
3. **回收** - 揭示真相，移动到 `foreshadowing.resolved`

### 伏笔设计原则

1. 伏笔必须合理，不能刻意
2. 回收必须有逻辑支撑
3. 单章内回收不超过 2 个重要伏笔
4. 跨章节伏笔必须在 5 章内回收
