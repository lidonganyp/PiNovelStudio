# 多代理协作边界 — 操作手册（Wave 7）

**版本**：v1.0  
**日期**：2026-08-12  
**对应计划**：`docs/multi-agent-collaboration-development-plan-20260812.md`

## 1. 角色与权限

| 角色 | 最高自主性 | 可写候选区 | 可 commit |
|---|---|---|---|
| novelos_agentic | bounded_execute | 是 | 否 |
| author_style | bounded_execute | 是 | 否 |
| fact_guard / story_preservation / final_fact_recheck | observe | 否 | 否 |
| final_state_commit | commit（仅 orchestrator actor） | 否 | 是 |
| audit | observe | 否 | 否 |

代码真相源：

- 角色：`v2/core/agent-roles.ts`
- 工作包：`v2/core/agent-work-package.ts`
- 结果契约：`v2/core/agent-result-contracts.ts`
- 裁决：`v2/core/orchestrator-decision.ts`
- 动作目录：`v2/core/action-catalog.ts`
- 自主性：`v2/core/autonomy-policy.ts`

## 2. 工作包字段

每次代理调用应有 `AgentWorkPackage`：

`taskId / orchestratorRunId / workspaceId / chapterId / agentRole / sessionId / parentCandidateId / allowedResources / forbiddenResources / allowedActions / forbiddenActions / contextHash / promptBundleHash / constraintManifestHash / packageHash`

校验失败 → fail-closed（`AgentWorkPackageError`），映射 `retry_gate`，**不重写正文**。

## 3. Trace 查询

生产 `stageResults.agentCollaboration`：

```json
{
  "schema": "pinovel.agent-collaboration-trace",
  "workPackages": { "<role>": { "packageId": "...", "packageHash": "..." } },
  "agentResults": { "<role>": { "status": "ok|recoverable|blocked", "candidateId": "..." } },
  "decisions": [ { "transition": "continue|block|retry_gate", "priority": "hard_fact|..." } ],
  "completedStages": ["novelos_agentic", "author_style", "..."],
  "preCommitGuard": { "ok": true, "missing": [] }
}
```

关联：

- Agentic trajectory：`stageResults.novelos.trajectoryPath`
- FailureEnvelope：`stageResults.failureEnvelope` / 输出 `failureEnvelope`
- Audit 事件：`v2/core/audit/*`（`AuditRunSession`）
- Control 决策：`ControlDecisionRecord`（`autonomy-policy` sink）

**不记录**：模型思维链、完整 prompt 原文、无关内部讨论。

## 4. 冲突裁决优先级

1. 硬事实  
2. 权限/安全  
3. 状态事务  
4. 作者契约  
5. 故事保持  
6. 风格建议  
7. 机械指标  

任一 `blocked` 不得被低优先级 `continue` 覆盖。

## 5. 发布前检查清单

- [ ] 公开工具仍为 6 个，章节入口仅 `novel_generate_chapter`
- [ ] `npm run build` 通过；`dependency-boundary` 无 legacy/eval 泄漏
- [ ] `tests/multi-agent-work-package-contracts.test.mjs` 与 `tests/multi-agent-eval-matrix.test.mjs` 通过
- [ ] 模型直接 `chapter.save/state.commit/release.promote/baseline.replace` = 0
- [ ] Agentic 初稿直接交付 = 0（`isAgenticDirectDeliveryAttempt` / 阶段守卫）
- [ ] 生产路径无 machine judge / pairwise judge
- [ ] 失败均有 FailureEnvelope（failureClass + recoveryAction）
- [ ] 真实 replay 样本含 `tracePath` 或 `traceArchivePath`（不以单次 build 宣称质量）

## 6. 明确禁止

- 恢复 legacy Stage0-8 / generationMode / 章节白名单
- 生产路径 opportunity/pairwise judge / SelectionPolicy
- 模型修改 CanonState / CreativeConstitution / NarrativeState / 正式章节
- 代理失败静默 raw 交付或跨代理伪装成功
