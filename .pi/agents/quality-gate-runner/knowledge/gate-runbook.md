# 交付质检手册（Gate Runbook）

> 本文件是 `quality-gate-runner` 的唯一知识库，合并原「交付质检手册 + FailureEnvelope 样本库」两份资料，已去重。

## 1. trace 字段核对表

路径：`workspaces/{workspaceId}/traces/{chapterId}-quality-trace.json`

| 阶段 | 应记录内容 | 缺失后果 |
|---|---|---|
| Preflight | 风格档案存在、config/角色/前章状态 | 无阻断证据，无法解释失败 |
| ContextCompiler | 上下文包字段、裁剪记录 | 无法确认是否静默丢弃 |
| NovelOS Agentic | 检索调用、初稿、verify/patch | 无法回放 |
| Agentic FactGuard | 硬事实判定结果 | 可能交付事实错误正文 |
| 作者风格整章优化 | 是否执行、候选结果 | 可能交付未优化初稿 |
| StoryPreservation | 实体覆盖率、相似度 | 可能"留名换事" |
| FinalFactRecheck | 复检结果 | 同上 |
| Completeness | 完整性判定 | 可能交付截断正文 |
| FinalStateCommit | 提交的四类状态 | 状态与正文不一致 |
| 保存 | 临时文件 → rename | 非原子写入 |

## 2. FailureEnvelope 字段释义与读取顺序

| 字段 | 含义 | 对作者的说法 |
|---|---|---|
| stage | 出错的阶段 | "卡在哪一步" |
| gate | 具体门禁 | "哪道检查没过" |
| severity | `preflight` / `recoverable` / `hard_block`（公开信封只有这三值） | "能不能自动恢复" |
| reason | 原因原文 | 原样转述，不改写 |
| evidence | 证据（片段/数值/ID） | "依据是什么" |
| recoverable | 是否可恢复 | "要不要重试" |
| retryPlan | 恢复计划 | "下一步做什么" |

读 envelope 的正确顺序：`stage` → `gate` → `severity` → `reason`（原样转述）→ `evidence`（拿证据给作者看）→ `retryPlan`（下一步动作）。

## 3. gate × severity × 修复责任对照

| gate | severity | 典型 reason | 作者应做什么 | 谁修 |
|---|---|---|---|---|
| `preflight` | preflight | 缺 `config.json` / 角色档案 / 前章状态 | 按 `blockingItems` 补齐 | 作者 |
| `model_timeout` | recoverable | 模型请求超时 | 等工具层同阶段重试一次；仍失败 → 检查网络/密钥 | 作者/运维 |
| `style_optimization` | hard_block | 风格档案缺失或类型不匹配 | 生成或替换 `kind=fingerprint` 档案 | style-guardian |
| `story_preservation` | hard_block | 实体被大量替换、疑"留名换事" | 回退候选，核对 canon 术语 | continuity-auditor |
| `fact_guard` | hard_block | 违反 `FACT-*` | 修正正文事实或补 canon（需作者裁决） | world-builder |
| `completeness` | hard_block | 正文截断、结尾缺失 | 重新生成（不可手工补写） | novel-director |
| `tool_error_streak` | recoverable | 连续工具调用失败达阈值 | 检查检索工具参数与数据源 | 作者 |

## 4. 常见误判

| 误判 | 事实 |
|---|---|
| 把 `recoverable` 当成功 | 只是可重试，仍需报告 |
| 手工补写截断段落 | 违反铁律，必须重新生成 |
| 认为风格优化失败可交付 raw | 不可；blocked 时 `selectedSource=null` |
| 把 advisory 当 blocking | 严重度不可升级，除非有双侧证据 |

## 5. 四项自检

稳定性门槛：

- [ ] 所有阻断都有 `FailureEnvelope`（无 silent degrade）
- [ ] 没有无限等待（超时有界，`PINOVEL_MODEL_REQUEST_TIMEOUT_MS` 生效）
- [ ] 每条失败能定位到 `stage/gate/reason/evidence`
- [ ] trace 已留存且可回放

交付前硬核对：

- [ ] `status`（`"ok"` / `"blocked"`）/ `selectedSource` / `isPreviewRun` 已原样记录
- [ ] `stageResults.chapterFilePath` 与 `stageResults.tracePath` 已原样记录（不是顶层 `chapterPath` / `tracePath`）
- [ ] 顶层单数 `failureEnvelope` 已原样记录（不是 `failureEnvelopes` 数组）；`severity` 只出现 `preflight` / `recoverable` / `hard_block`
- [ ] `stageResults.stateCommit` 已提交（`committed === true`），否则不可交付
- [ ] trace 阶段序列完整
- [ ] 章节文件非空且与 `selectedSource` 对应
- [ ] 所有 envelope 已解释并给出责任人与复检人

## 6. 二值化结论规则

- 可交付：`status="ok"` + `isPreviewRun=false` + 正文非空 + 风格优化已执行 + `stageResults.stateCommit.committed===true` + trace 完整。
- 不可交付：其余全部情况，必须写明缺哪一项。
- 禁止表述："基本没问题""应该可以了""看起来正常"。

报告模板：

```markdown
- 可否交付：可 / 不可
- 不可交付的唯一原因：<一项>
- 解除条件：<作者/专家需完成的具体动作>
```
