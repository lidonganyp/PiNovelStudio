# Eval 闭环证据 2026-08-15（ae7d047 干净树 + 匿名真实审批）

绑定：

- 当前 active_prod: `rel-prod-114`
- fixture provenance bundleId: `a76eda83d0a231ba95b2e3e65e400e82259b980c6d7d9f38c5c75be22d2cdfc7`
- 回放代码提交: `ae7d0471a4aea15c6b8790348b7a91f3f67d780a`
- 干净 worktree: `D:\CODE\pns-holdfix-ae7d047`（detached HEAD，worktreeDirty=false）
- environmentFingerprint: `18bdc22505c346d0…`（verify YES）

## 真实审批

- `rel-prod-114`：干净树 capture（fpHash `18bdc225…`，verify YES）→ 匿名评审包（无发布号）→ 真实 gpt5.6-sol
- `forward=APPROVE_DEV` / `reverse=APPROVE_DEV` / `finalVerdict=APPROVE_DEV`
- `reviewTransport=network`，artifact `approval-rel-prod-114-1786795619374-d7f01249`
- 已切换 active production pointer（旧 `rel-prod-111` 转 held，证据保留）

## recorded

- 结果: PASS
- completed=1, isolation=0, traceRetentionRate=1, unclassified=0
- P6: `EVAL_EVIDENCE_APPROVED`
- runId: `closure-recorded-ae7d047`

## synthetic

- 结果: PASS
- completed=1, isolation=0, traceRetentionRate=1, unclassified=0
- P6: `EVAL_EVIDENCE_APPROVED`
- runId: `closure-synthetic-ae7d047`

## production_like

- 生产门禁: PASS（读到 `rel-prod-114`，fingerprint `18bdc225…` 一致，isolation=0，trace 留存=1）
- 模型生成: FAIL
- runId: `closure-production-like-ae7d047c`
- invoke 未传 `modelTestRoute`，但运行时锁到 `nb4_generate_glm`；GLM 拒绝 `thinking.type=disabled`
- CLI 因未分类失败未过；P6 grader 对已完成样本为 approved
- 不得宣称生产等价模型链路已跑通

## 当前标记

代码实现与生产治理晋级已完成；`recorded` / `synthetic` 已绑定最终提交。`production_like` 已越过原先的指针/指纹门禁，但生成路由仍误入 GLM 评测锁，正式生产等价回放尚未完成。
