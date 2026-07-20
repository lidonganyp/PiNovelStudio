# Agent 交互协议

> **历史协议参考**：本文记录早期 12 Agent / DAG 流程的交互协议，保留作历史与局部接口参考。当前章节生成唯一公开入口为 `novel_generate_chapter`，由统一编排器内部调用 Narrator、Critic 等阶段 Agent；权威架构与阶段流程以 `docs/top-tier-chinese-novel-system-development-plan.md`（统一主链路，v1.1）为准。

## 协议概述

每个 Agent 遵循统一的交互协议，确保：
1. 输入输出格式标准化
2. Agent 之间无缝协作
3. 错误处理一致
4. 状态追踪完整

## 接口定义

### AgentInput

```typescript
interface AgentInput {
  workspaceId: string;       // 当前小说
  chapterId: string;         // 目标章节
  dag?: StoryDAG;            // 当前 DAG（不适用时为 null）
  text?: string;             // 当前文本（不适用时为 null）
  context: ChapterContext;   // 章节上下文
}
```

### AgentOutput

```typescript
interface AgentOutput {
  status: "success" | "needs_human" | "blocked" | "error";
  dag?: StoryDAG;           // 修改后的 DAG
  text?: string;            // 生成的文本
  report: AgentReport;      // 诊断、建议、评分
  artifacts: Artifact[];     // 产物列表
}
```

### AgentReport

```typescript
interface AgentReport {
  agentName: string;
  timestamp: string;
  findings: string[];        // 发现的问题
  suggestions: string[];     // 建议
  scores?: Record<string, { value: number; max: number; notes?: string }>;
  issues: Array<{
    severity: "critical" | "warning" | "info";
    message: string;
    location?: string;
  }>;
}
```

### Artifact

```typescript
interface Artifact {
  type: "file" | "json" | "text" | "markdown";
  path?: string;            // 文件路径
  content?: string;         // 内容
  description: string;      // 描述
}
```

## Agent 执行流程（历史参考）

### 基础 Agent（旧版阶段 1-6）

```
Architect → WorldBuilder → DramaCoach → DependencyChecker → Narrator → Critic
     ↓            ↓            ↓              ↓               ↓          ↓
   DAG构建    世界观注入    冲突优化     因果验证       文学生成    质量审查
```

### 壁垒注入 Agent（穿插执行）

```
Brainhole Injector  →  阶段1之后，阶段4之前
Emotion Metronome    →  阶段4之前（预检）+ 阶段6之后（后检）
Style Shaper         →  阶段7之后
Anti-AI Detector    →  阶段5之中（逐段）+ 阶段8（最终）
```

## 状态码定义

### success

Agent 成功完成任务，返回修改后的 DAG 或文本。

### needs_human

Agent 完成任务，但需要人工介入决策。

### blocked

Agent 无法完成任务，被阻塞。

### error

Agent 执行出错。

## 错误恢复策略

```
1. API 超时 → 重试 3 次
2. 验证失败 → 自动修正或返回 blocked
3. 文件读写错误 → 尝试创建目录或返回 error
```

## 产物管理

| Agent | 产物 |
|-------|------|
| Architect | blueprint-draft.json |
| DependencyChecker | validation-report.json |
| Narrator | draft-v1.md |
| Critic | review.md |
| Brainhole Injector | brainhole-injection-report.md |
| Style Shaper | style-match-report.json |
| Emotion Metronome | emotion-curve.json |
| Anti-AI Detector | ai-pattern-report.json |
