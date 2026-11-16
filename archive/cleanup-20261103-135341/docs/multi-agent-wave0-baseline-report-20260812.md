# Multi-Agent Wave 0 基线报告

**日期**：2026-08-12  
**任务**：MA-0.1 / MA-0.2 / MA-0.3  
**状态**：完成（只读盘点，未修改用户既有生产逻辑/未恢复工作树改动）

## 1. 基线快照

| 项 | 值 |
|---|---|
| HEAD | `84a276e` |
| 分支 | `main` |
| 生产入口 | `novel_generate_chapter`（`tools/register-tools.ts` 共 6 公开工具） |
| 统一入口 | `v2/core/unified-entry.ts` → `unified-orchestrator.ts` |
| 工作树 | 已有大量用户进行中修改 + 未跟踪 audit/recovery/protocol 文件；本波次不覆盖 |

## 2. 统一主链路现有资产（MA-0.1）

| 领域 | 路径 | 状态 |
|---|---|---|
| 统一编排 | `v2/core/unified-entry.ts`, `unified-orchestrator.ts`, `orchestrator-types.ts` | reuse |
| 控制面 | `control-plane.ts`, `control-types.ts`, `action-catalog.ts`, `autonomy-policy.ts` | reuse |
| 权限 | `novelos/security/permission-policy.ts` | adapt（角色枚举与 ActorType 未统一） |
| 候选隔离 | `novelos/agent/candidate-workspace.ts` | reuse（6 文件命名已齐） |
| Agentic | `narrative-agent-loop.ts`, `agentic-raw-candidate-source.ts`, `AgentLoopResult` | adapt → DraftAgentResult |
| FactGuard | `orchestrator-factguard.ts` → `{ok,errors,report}` | adapt → FactGuardResult |
| 作者风格 | `author-style-optimizer.ts` → `AuthorStyleOptimizationResult` | adapt → EditorialResult |
| 故事保持 | `editorial-story-preservation-gate.ts` → `StoryPreservationGateReport` | adapt |
| 状态提交 | `final-state-commit.ts` / `orchestrator-commit-save.ts` | adapt → CommitResult |
| 失败治理 | `failure-types.ts`, `failure-envelope.ts`, recovery/* | reuse |
| 审计 | `v2/core/audit/*` | reuse / 扩展 lineage 索引 |
| 轨迹 | `novelos/trajectory/*` | adapt 关联 run/candidate |
| 策略学习 | `v2/learning/*` | reuse（bundle 归因已有测试草稿） |

## 3. 目标契约差异矩阵（MA-0.2）

| 目标字段/契约 | 现有实现 | 标记 | 说明 |
|---|---|---|---|
| `AgentWorkPackage` | `NovelTaskPacket`（任务级） | missing | 缺代理级 work package（role/session/parentCandidate/input whitelist） |
| `DraftAgentResult` | `AgentLoopResult` + Candidate | adapt | 有 text/lineage/session；缺统一 status/candidateId/actionsTaken 契约层 |
| `FactGuardResult` | `{ok,errors,report}` | adapt | 有 passed 语义；缺 candidateId/sourceRefs 统一字段 |
| `EditorialResult` | `AuthorStyleOptimizationResult` | adapt | 有 status 语义（failureKind）；缺 sourceCandidateId/preservationRisk 统一字段 |
| `StoryPreservationResult` | `StoryPreservationGateReport` | adapt | 字段丰富；需包装为统一 contract + candidate 关联 |
| `CommitResult` | `{committed,rejected}` / chapterFilePath | adapt | 缺授权证据摘要字段 |
| `AgentLineage` | `AgentLoopLineage` + audit events | adapt | 缺统一 orchestratorRunId/agentRole/strategyBundleId 索引 |
| `OrchestratorDecision` | stageResults ad-hoc | missing | 需 evidence/proposal/decision 三分与固定优先级 |
| `ActorType` | control-types 已有 model/orchestrator/user/system | reuse | |
| `ActionName` | action-catalog 10 动作 | reuse | |
| `PermissionPolicy` Role | agent/orchestrator | conflict | 与 ActorType/AgentRole 并存；Wave 2 对齐 profile，不删旧 API |
| `FailureEnvelope` | UnifiedProductionFailureEnvelope | reuse | gate 已含 autonomy/approval/commit_authorization |
| 输入白名单 | ContextCompiler 紧凑工作集 | missing | 缺按角色字段白名单强制 |
| 阶段转移守卫 | 编排器过程式 | adapt | 行为已有，缺显式 decision record |

## 4. 冻结协议版本（MA-0.3）

| 项 | 冻结值 |
|---|---|
| schema 版本 | `pinovel.agent-work-package@1.0.0` / `pinovel.agent-result@1.0.0` / `pinovel.orchestrator-decision@1.0.0` |
| 角色枚举 `AgentRole` | `preflight` `context_compiler` `chapter_intent` `novelos_agentic` `fact_guard` `author_style` `story_preservation` `final_fact_recheck` `final_state_commit` `audit` |
| ActorType | `model` `orchestrator` `user` `system`（不变） |
| ActionName | 见 `action-catalog.ts`（不变；未知动作 fail-closed） |
| 模型最高权限 | `bounded_execute`；禁止 `chapter.save`/`state.commit`/`release.promote`/`baseline.replace` |
| FailureClass | `preflight` `recoverable` `interrupted` `blocked` `fatal` |
| FailureEnvelope.gate（代理边界） | `autonomy` `approval` `commit_authorization` `agent_work_package` `agent_result_schema` `orchestrator_decision` `context_scope` |
| 裁决优先级 | 硬事实 > 权限/安全 > 状态事务 > 作者契约 > 故事保持 > 风格建议 > 机械指标 |

## 5. 验收（Wave 0）

- [x] 基线报告落盘
- [x] 未修改/删除/暂存/覆盖用户现有工作树改动
- [x] 生产入口仍仅为 `novel_generate_chapter`

## 6. 下波次入口

批次 A：`MA-1` 工作包 + 结果契约（本会话继续实现）。
