# 批量章节生成模式用户指南

> 版本: P0 + P1 | 更新日期: 2026-07-22
>
> 批量章节生成是 `novel_generate_chapter` 工具的 `mode: "batch"` 分支，支持按大纲连续生成第 N 章到第 M 章。批量能力作为该工具的内部分支，**不新增第二个正文生成工具**——每章仍逐章调用统一主链路（Preflight → ContextCompiler → NovelOS Agentic → 作者风格整章优化 → FactGuard → StoryPreservation → FinalFactRecheck → FinalStateCommit → AtomicSave）。

---

## 1. 快速开始

### 1.1 生成第 1-10 章

```json
{
  "mode": "batch",
  "action": "start",
  "workspaceId": "my-novel",
  "chapterId": "1",
  "chapterNumber": 1,
  "startChapter": 1,
  "endChapter": 10
}
```

调用后同步阻塞，直到全部 10 章完成（或失败暂停 / 被取消）。

### 1.2 从第 5 章续写到第 20 章

```json
{
  "mode": "batch",
  "action": "start",
  "workspaceId": "my-novel",
  "chapterId": "5",
  "chapterNumber": 5,
  "startChapter": 5,
  "endChapter": 20
}
```

> **前提**: `startChapter > 1` 时，workspace 必须已有 `narrative-state-store.json`（前章状态），否则在 preflight 阶段阻断。

---

## 2. API 参考

### 2.1 公共必填字段（保持单章兼容）

| 字段 | 类型 | 说明 |
|------|------|------|
| `workspaceId` | string | 目标 workspace ID |
| `chapterId` | string | 章节标识（批量模式中使用 `startChapter` 对应值即可） |
| `chapterNumber` | number | 章节号（批量模式中使用 `startChapter` 对应值即可） |

> 以上三个字段是 `novel_generate_chapter` 工具的 `required` 字段，批量模式也必须传入以保持接口兼容。

### 2.2 批量模式字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | `"batch"` | — | **必填**。传入 `"batch"` 走批量分支；不传则走单章生成（默认行为） |
| `action` | `"start"` \| `"resume"` \| `"status"` \| `"cancel"` | — | **必填**。批量操作类型 |
| `startChapter` | number | — | `action="start"` 必填，`≥ 1` |
| `endChapter` | number | — | `action="start"` 必填，`≥ startChapter` |
| `seedSource` | `"workspace_or_planner"` \| `"workspace_only"` | `"workspace_or_planner"` | ChapterSeed 来源策略 |
| `stopOnFailure` | boolean | `true` | 单章失败时是否暂停（`true`=暂停可恢复，`false`=直接标记 error） |
| `confirmLargeBatch` | boolean | `false` | 超过 100 章时需设为 `true` 确认 |
| `jobId` | string | 自动生成 | `action="resume"`/`"status"`/`"cancel"` 必填；`action="start"` 可选 |

### 2.3 章节范围上限

| 上限类型 | 值 | 说明 |
|----------|-----|------|
| 默认上限 | 100 章 | 超过需 `confirmLargeBatch: true` |
| 硬上限 | 1000 章 | 即使 `confirmLargeBatch: true` 也不可超过 |

---

## 3. 四种 Action 详解

### 3.1 `action: "start"` — 创建并执行批量任务

```json
{
  "mode": "batch",
  "action": "start",
  "workspaceId": "my-novel",
  "chapterId": "1",
  "chapterNumber": 1,
  "startChapter": 1,
  "endChapter": 10,
  "seedSource": "workspace_or_planner",
  "stopOnFailure": true
}
```

**执行流程**:
1. 范围校验（整数、`≥1`、`end ≥ start`）
2. 上限校验（默认 100 / 硬上限 1000）
3. **扩展 preflight 检查**（P1-04）：世界观 / 角色档案 / 前章状态
4. **ChapterSeed 检查 + 可选规划**（P1-03）
5. 获取 workspace 级锁
6. 创建 `BatchJobState`，写入 checkpoint
7. 串行执行：逐章调用统一主链路
8. 释放锁

**同步阻塞**: 调用后阻塞直到任务完成 / 暂停 / 取消。

**返回示例**:
```json
{
  "status": "completed",
  "jobId": "batch-20260722-153000-a1b2",
  "currentChapter": null,
  "completedChapters": 10,
  "totalChapters": 10,
  "failedChapter": null,
  "checkpointPath": "workspaces/my-novel/batch-jobs/batch-20260722-153000-a1b2.json",
  "summary": {
    "totalChapters": 10,
    "completedChapters": 10,
    "failedChapters": 0,
    "totalDurationMs": 125000,
    "totalModelCalls": 20,
    "failureEnvelopes": []
  }
}
```

### 3.2 `action: "resume"` — 从 checkpoint 恢复

```json
{
  "mode": "batch",
  "action": "resume",
  "workspaceId": "my-novel",
  "chapterId": "1",
  "chapterNumber": 1,
  "jobId": "batch-20260722-153000-a1b2"
}
```

**行为**:
- 只允许 `status="paused"` 的任务 resume
- 已完成的章节**不会重复调用模型**（幂等性双校验：checkpoint 记录 + 章节文件 + state store entry）
- 从 `frontier`（第一个未完成章节）继续执行
- `status="completed"` 的任务 resume → 幂等返回 completed（不重复生成）

### 3.3 `action: "status"` — 查询进度（不获取锁、不执行生成）

```json
{
  "mode": "batch",
  "action": "status",
  "workspaceId": "my-novel",
  "chapterId": "1",
  "chapterNumber": 1,
  "jobId": "batch-20260722-153000-a1b2"
}
```

**行为**: 加载 checkpoint 返回当前状态，不获取锁，不执行任何生成。

### 3.4 `action: "cancel"` — 请求停止

```json
{
  "mode": "batch",
  "action": "cancel",
  "workspaceId": "my-novel",
  "chapterId": "1",
  "chapterNumber": 1,
  "jobId": "batch-20260722-153000-a1b2"
}
```

**行为**:
- 设置 `cancelRequested: true`，原子保存
- 运行中的任务在下一章开始前检测到 cancel 标志后停止
- `paused` 状态的任务直接升级为 `cancelled`
- **不删除任何已完成章节文件**——cancel 不破坏已有成果

---

## 4. Preflight 前置条件（P1-04）

批量生成前会执行扩展 preflight 检查。任一不满足 → 阻断（不调用模型）。

| 检查项 | 要求 | 阻断原因示例 |
|--------|------|-------------|
| 世界观（genre） | `config.json` 含非空 `genre` 字段 | `config.json 缺少 genre（世界观）字段` |
| 角色档案 | `characters/` 目录存在且含 `.md` 或 `.json` 文件 | `characters/ 目录为空，缺少角色档案` |
| 前章状态 | `startChapter > 1` 时，`narrative-state-store.json` 必须存在 | `缺少 narrative-state-store.json（前章状态）` |

> **设计理由**: 世界观、角色档案和前章状态是不可规划的前置条件——种子可以自动规划，但这些必须由用户/前序生成提供。

---

## 5. ChapterSeed 规划阶段（P1-03）

### 5.1 两种 seedSource 模式

| 模式 | 行为 |
|------|------|
| `workspace_or_planner`（默认） | 先检查 workspace 是否有 ChapterSeed；无则自动规划结构化种子 |
| `workspace_only` | 只使用 workspace 已有种子；无种子直接阻断（不规划） |

### 5.2 ChapterSeed 来源检查顺序

1. `config.json` 含非空 `chapterSeeds` 对象
2. `series/ch{startChapter}-outline-explicit.md` 存在

两者都不满足时：
- `workspace_or_planner` → 触发规划阶段
- `workspace_only` → 阻断

### 5.3 规划阶段输出

规划阶段在 `workspaces/{id}/batch-jobs/planned-seeds/ch{N}.json` 生成结构化种子文件：

```json
{
  "chapterNumber": 1,
  "chapterId": "ch1",
  "chapterFunction": "setup",
  "chapterTheme": "故事开始",
  "characters": [
    { "id": "protagonist-1", "name": "叶尘", "role": "protagonist" }
  ],
  "worldConstraint": {
    "genre": "玄幻",
    "subGenres": ["东方玄幻"]
  },
  "intent": {
    "primary": "故事开始",
    "_source": "chapterSeed"
  },
  "plannedAt": "2026-07-22T15:30:00.000Z"
}
```

**chapterFunction 推断规则**（按章节在批量范围中的位置）:

| 位置 | chapterFunction |
|------|-----------------|
| 第 1 章（开头） | `setup` |
| 倒数第 2 章 | `payoff` |
| 最后一章 | `climax` |
| 其余 | `escalation` |
| 单章（total=1） | `payoff` |

> **严禁正文**: 规划阶段只输出结构化 JSON，不包含 `prose` / `text` / `body` 等正文字段。正文由统一主链路逐章生成。

---

## 6. Checkpoint 与故障恢复

### 6.1 Checkpoint 文件

每次批量任务的状态持久化在：

```
workspaces/{workspaceId}/batch-jobs/{jobId}.json
```

包含：`jobId` / `workspaceId` / `status` / `startChapter` / `endChapter` / `frontier`（当前进度指针）/ `completedChapters` / `failedChapter` / `chapters`（每章详细结果）/ `cancelRequested` / `summary`。

### 6.2 故障恢复流程

```
第 N 章失败
    │
    ├── stopOnFailure=true → status="paused" → 可 resume
    │
    └── stopOnFailure=false → status="error" → 不可 resume（需重新 start）
```

**恢复步骤**:
1. 用 `action: "status"` 查询失败原因（`failureEnvelope`）
2. 修复问题（补全 workspace 配置、修复模型路由等）
3. 用 `action: "resume"` 从断点继续

### 6.3 幂等性双校验

resume 时，已完成章节通过**双校验**确认不重复生成：

1. **Checkpoint 记录**: `BatchJobState.completedChapters` 含该章节号
2. **文件 + 状态校验**: `chapters/{N}.md` 存在 AND `narrative-state-store.json` 含 `sourceChapter=ch{N}` 的 `#finalText:` anchored entry

两者都满足才跳过该章，否则重新生成。

### 6.4 进程重启恢复

如果批量执行期间进程崩溃：
1. 锁文件含 PID + 30 分钟超时
2. 重启后 `action: "start"` 新任务时，旧锁若 PID 已死亡或超时 30 分钟则自动清除
3. 对旧任务用 `action: "resume"` 继续执行

---

## 7. Summary Trace 文件（P1-02）

任务结束（`completed` / `paused` / `cancelled` / `error`）时写入：

```
workspaces/{workspaceId}/traces/batch-{jobId}-summary.json
```

**内容**:

```json
{
  "jobId": "batch-20260722-153000-a1b2",
  "workspaceId": "my-novel",
  "status": "completed",
  "startChapter": 1,
  "endChapter": 10,
  "summary": {
    "totalChapters": 10,
    "completedChapters": 10,
    "failedChapters": 0,
    "totalDurationMs": 125000,
    "totalModelCalls": 20,
    "failureEnvelopes": []
  },
  "chapters": [
    {
      "chapterNumber": 1,
      "status": "completed",
      "startedAt": "2026-07-22T15:30:00.000Z",
      "completedAt": "2026-07-22T15:32:30.000Z",
      "durationMs": 15000,
      "modelCalls": 2,
      "stateCommitResult": { "ok": true },
      "failureEnvelope": null,
      "chapterFilePath": "workspaces/my-novel/chapters/1.md",
      "tracePath": "workspaces/my-novel/traces/1-quality-trace.json"
    }
  ],
  "createdAt": "2026-07-22T15:30:00.000Z",
  "updatedAt": "2026-07-22T15:45:00.000Z"
}
```

每章记录: `durationMs` / `modelCalls` / `stateCommitResult` / `failureEnvelope` / `chapterFilePath` / `tracePath`。

> trace 写入失败不阻断主链路（advisory）。

---

## 8. Workspace 级锁（BATCH-P0-09）

- 同一 workspace 同一时间只允许一个批量任务运行
- 锁文件: `workspaces/{workspaceId}/batch-jobs/.lock`
- 锁信息: `jobId` / `pid` / `acquiredAt` / `expiresAt`（30 分钟超时）
- 锁判定: PID 存活（`process.kill(pid, 0)`）AND 未超时
- 锁释放: 任务结束（无论成功/失败/暂停）后自动释放
- 锁冲突: 新任务 `action: "start"` 遇到有效锁 → 返回 `error` + `failureEnvelope`

---

## 9. 守卫与约束

| 约束 | 说明 |
|------|------|
| 唯一公开入口 | `novel_generate_chapter` 是章节生成唯一公开入口；批量模式是其内部分支 |
| 逐章统一主链路 | 每章调用统一主链路，不绕过 Preflight / FactGuard / FinalStateCommit |
| 禁止机器文学裁判 | 批量生产流程不调用 pairwise judge / opportunity judge |
| 禁止 AI 直接写正文 | AI 不直接撰写章节正文；所有正文经统一编排产出 |
| 串行执行 | 严格串行：第 N 章成功后才推进第 N+1 章 |
| 失败不跳章 | 第 N 章失败时不会自动生成第 N+1 章 |
| 状态事务 | 长期状态只在最终正文经事实复检后提交；章节保存是原子操作 |
| 单编排在限 | 批量编排模块不超过约 800 行 |

---

## 10. 常见问题

### Q: 批量生成中断了，已完成章节会丢失吗？

A: 不会。每章成功后立即原子保存章节文件 + 提交长期状态 + 更新 checkpoint。cancel 也不删除已完成章节。resume 时通过幂等性双校验跳过已完成章节。

### Q: 100 章以上怎么生成？

A: 设置 `confirmLargeBatch: true`，上限放宽到 1000 章。1000 章以上不可生成（硬上限）。

### Q: 没有 ChapterSeed 可以批量生成吗？

A: 可以。默认 `seedSource: "workspace_or_planner"` 模式下，无种子时自动规划结构化种子（从 `outline.md` 提取章节主题 + 从 `config.json` 提取角色/世界观）。如需强制使用 workspace 已有种子，设 `seedSource: "workspace_only"`。

### Q: 如何查看某章为什么失败？

A: 用 `action: "status"` 查询 `failureEnvelope`，或查看 `traces/batch-{jobId}-summary.json` 中对应章节的 `failureEnvelope` 字段。每章的详细 trace 在 `traces/{N}-quality-trace.json`。

### Q: 同一 workspace 能同时跑两个批量任务吗？

A: 不能。workspace 级锁保证同一时间只有一个批量任务运行。第二个任务会收到锁冲突 error。如需并行，请使用不同 workspace。
