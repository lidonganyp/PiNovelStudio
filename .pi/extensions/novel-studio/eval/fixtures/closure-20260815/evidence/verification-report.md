# Eval 闭环收尾证据 2026-08-15

绑定：

- releaseId: `rel-prod-111`
- bundleId: `0d5f0c70b7ffc96b174f58f2c5cc0c0467d5b4230f495cf84415cb41a6dbafd9`
- codeCommit: `0d623fc0d4c082336b5391ec2399f2d253f3a1c7`（工作树含本轮未提交收尾补丁）

## recorded

- fixture: `eval/fixtures/closure-20260815/recorded.json`
- 结果: PASS
- completed=1, isolation=0, traceRetentionRate=1, unclassified=0
- deterministic grader: pass
- P6: `EVAL_EVIDENCE_APPROVED`（R1 deterministic-only）
- 报告: `recorded/report.json` / `recorded/cli-verdict.json`

## synthetic

- fixture: `eval/fixtures/closure-20260815/synthetic.json`
- 结果: PASS
- completed=1, isolation=0, traceRetentionRate=1, unclassified=0
- deterministic grader: pass
- P6: `EVAL_EVIDENCE_APPROVED`（R1 deterministic-only）
- 报告: `synthetic/report.json` / `synthetic/cli-verdict.json`

## production_like

- fixture: `eval/fixtures/closure-20260815/production-like.json`
- 结果: 未完成（fail-closed，符合当前门禁）
- status: `skipped_isolation_violation`
- 原因: `evaluateProductionReleaseGate` 在 extension `projectRoot` 上报告
  `no active production release set`
- 未发起真实模型调用
- 归因: `replay_environment`
- 报告: `production-like/report.json`

`config/evolution-release/active-production.json` 指向 `rel-prod-111`，
但 production_like runner 的主仓 gate 未读到该 pointer。
这是剩余的生产等价冒烟阻断，不是 stub 伪造成功。
