# 多代理协作边界化 — 波次完成记录（再修订）

**日期**：2026-08-12  
**计划**：`docs/multi-agent-collaboration-development-plan-20260812.md`  
**判定**：**受控开发验证可用**；stub multi-agent boundary replay 已入 CI。文学质量与付费真实模型批跑仍不宣称。

## 完成范围

| Wave | 状态 | 说明 |
|---|---|---|
| 0 基线 | 完成 | 只读盘点报告 |
| 1 工作包/契约 | 完成 | create/validate/adapt + trace 摘要 |
| 2 权限 | 基本完成 | autonomy + **runtime beforeToolCall 工作包门闩** |
| 3 最小上下文 | 基本完成 | **编排器各代理调用前 `requireWorkPackageInput`** + 工具路径 scope |
| 4 编排裁决 | 完成 | decision 优先级 + preCommit 守卫；**禁止手动 push completedStages 伪装** |
| 5 血缘 | 基本完成 | `agentLineageIndex` + 反馈路径 `isLineageCompleteForStrategyUpdate` 门闩 |
| 6 Eval | 基本完成 | 15 项契约 Eval + **stub workspace multi-agent boundary replay CI 门禁** |
| 7 文档 | 完成 | runbook + 本记录（无夸大） |

## 关键收口

1. **契约 fail-closed**（含漂移重试）：适配失败 → hardBlock，不得伪装 `completedStages`。  
2. **MA-3.2 生产调用点**：`requireWorkPackageInput` 接到 agentic_style 主路径六阶段。  
3. **策略反馈血缘门闩**：公共反馈路径在存在 index 时强制 `isLineageCompleteForStrategyUpdate`。  
4. **MA-6.4 stub replay CI**：
   - 脚本：`.pi/extensions/novel-studio/scripts/multi-agent-boundary-replay.mjs`
   - npm：`replay:multi-agent-boundary`（根与 workspace 均有）
   - CI：`.github/workflows/ci.yml` 增加 Multi-agent boundary replay step
   - 门槛：trace 留存率 100%、agentCollaboration 100%、agentLineageIndex 100%、machine judge=0、one-shot raw=0
   - 模式：`V2_FORCE_STUB=1` + `PINOVEL_DEV_MODE=1`（无真实 API 成本）
   - 实测：2 sample `overallPass=true`，status=ok，trace/collab/lineage 全覆盖

## 验证命令

```bash
cd .pi/extensions/novel-studio
npm run build:prod
node --import ./tests/setup-test-env.mjs --test --test-concurrency=1 \
  tests/multi-agent-work-package-contracts.test.mjs \
  tests/multi-agent-eval-matrix.test.mjs \
  tests/multi-agent-closure-gaps.test.mjs \
  tests/multi-agent-boundary-replay-ci.test.mjs
npm run replay:multi-agent-boundary
```

## 明确不宣称

- 文学质量提升  
- 付费真实模型长程 replay 已作为 CI 硬门（当前是 stub 边界 replay）  
- 所有历史学习路径 100% 已切到 AgentLineageIndex（旧 trace 无 index 时兼容放行 canonical lineage）
