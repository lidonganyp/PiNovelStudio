# Eval 闭环证据 2026-08-15（rel-prod-115 + Gemini production_like）

绑定：

- 当前 active_prod: `rel-prod-115`
- 生产代码提交: `f8e0040e9135a7e23adb94bc55b3b8f91e53bbb4`
- 回放修复提交: `eeaf704`（优先扩展 invoke 脚本，避免仓库根脚本默认锁 GLM）
- bundleId: `a76eda83d0a231ba95b2e3e65e400e82259b980c6d7d9f38c5c75be22d2cdfc7`
- environmentFingerprint: `9c4229ac…`
- 干净 worktree: `D:\CODE\pns-fp-align-4a80960`（detached `f8e0040`，worktreeDirty=false）

## production_like

- fixture: `eval/fixtures/closure-20260815-115/production-like.json`
- 结果: PASS
- completed=1, isolation=0, traceRetentionRate=1, unclassified=0
- deterministic grader: pass
- P6: `EVAL_EVIDENCE_APPROVED`
- 路由: `v2_rawstage2_gemini31` + `v2_amplified_gemini31`
- runId: `closure-production-like-115b`

前一轮失败原因已关闭：仓库根 `scripts/invoke-generate-chapter.mjs` 默认 `modelTestRoute=glm`。回放改为优先扩展脚本后，进入 Gemini 生产路由。

## recorded / synthetic

此前已在 `ae7d047` / `rel-prod-114` 上通过。当前 active 为 `rel-prod-115`；本轮只补 `production_like` 模型链路证据。

## 当前标记

生产等价回放已进入 Gemini 主链路并通过门禁与样本完成条件。`rel-prod-114` 已 held，唯一 active_prod 为 `rel-prod-115`。
