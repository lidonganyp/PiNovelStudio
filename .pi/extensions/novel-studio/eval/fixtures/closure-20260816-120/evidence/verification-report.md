# Eval 闭环证据 2026-08-16（rel-prod-120）

绑定：

- 当前 active_prod: `rel-prod-120`（2026-08-16T06:53:52 已切换；当时门禁尚未强制四臂）
- candidate release: `rel-prod-120` / status=`active_prod` / activatedAt=`2026-08-16T06:53:52.294Z`
- codeCommit: `57486b915e437015d86ef34401f29a0dfad51aa2`
- fpHash: `bf1880e76acd3896ffd00c07b011b7f504ba655cfdc20b75c3b3b623cdc99e3d`
- bundleId: `aa83d08c22a65bfe7e1cf05d9a02064d4611a6bb8bc5d41f03acd2fb5e1e60c7`
- capabilityPackageSetHash: `e5c8b475e2f3d988cec494fcc192680b32d2d2fa70ec16f2838ed05dbafe4017`
- 干净 worktree: `D:\CODE\pns-eval-120@57486b9`（capture/verify 时 worktreeDirty=false）

## 真实审批

- artifact: `approval-rel-prod-120-1786859687887-7a8aca3e`
- `forward=APPROVE_DEV` / `reverse=APPROVE_DEV` / `finalVerdict=APPROVE_DEV`
- `reviewTransport=network`
- 版本化副本：`evidence/governance/`（manifest、state-events、approval、fingerprint、eval-pending-review）

## candidate_like

- runId: `closure-candidate-like-120`
- CLI: FAIL（2/3 completed）
- 失败样本: `fixture.closure-candidate-like-003`
  - 首次：FactGuard `封印`
  - 重试 `closure-candidate-like-120-s3`：`story_preservation` 骨架漂移；当时归档归因为 `unclassified`
  - 代码已补 `rule:gate=story_preservation` → `model`；旧归档不会自动改写
- isolation=0；当时 P6 按 R1 deterministic-only 给出 `EVAL_EVIDENCE_APPROVED`
- 2026-08-16 门禁收口后：R0-R3 一律要求四臂 + pass^3=1，本 run 无 matrix-report，**不得再作为晋级依据**

## production_like（晋级依据）

- runId: `closure-production-like-120`
- 外部归档: `D:\CODE\pns-eval-archives-120\closure-production-like-120`
- CLI: PASS，`ok=true`（3/3）
- 现门禁复验：`REJECTED / EVAL_EVIDENCE_ARM_GRADER_FAILED`
- 原因：baseline `closure-production-like-f8e0040c` 的确定性 grader 失败（`model_call_evidence`：manifest.modelCalls=0，trace 实际 3 次）
- 指标层 `compareMatrixArms` 仍可能给出 `verdict=pass` / `pass^3=1`；P6 不再据此批准
- summary: completed=3/3，failed=0，isolation=0，traceRetentionRate=1，unclassified=0
- 每样本 2 次 Gemini 31：`v2_rawstage2_gemini31` + `v2_amplified_gemini31`
- 每样本 `approvalRef` 均为 `approval-rel-prod-120-1786859687887-7a8aca3e`，`devMode=false`
- 模型调用: [2, 2, 2]，tokenCost: [12661, 11454, 12992]

## 四臂矩阵

- 报告：`evidence/production-like/matrix-report.json`（hash `09f3f3f1…e086a26`，生成器已因 baseline grader 标 `reject`）
- P6：四臂 grader 全量重跑；baseline 失败 → 不得 `EVAL_EVIDENCE_APPROVED`
- 同一章条件（`ws-verify-01` / chapter-002）：
  - baseline：`rel-prod-115` / `closure-production-like-f8e0040c`（1/1 真实 Gemini；**不是** 3 连）
  - candidate：`rel-prod-120` / `closure-production-like-120`（3/3 真实 Gemini，pass^3=1）
  - raw_direct：`rel-prod-120` / `closure-recorded-120`（3/3 recorded，回放 candidate 三份正文）
  - recovery：`rel-prod-120` / `closure-synthetic-120`（3/3 synthetic，同夹具故障计划）
- 仍不能当作“相对 115 的 3 连真实 A/B”：baseline 只有 1 个样本；raw_direct 是 candidate 正文的确定性回放，不是独立裸写

## CLI 口径

- 当前：`evidence/production-like/cli-verdict.json`（四臂 + pass^3=1）
- 历史：`evidence/production-like/cli-verdict.pre-matrix.json`（晋级前 R1 deterministic-only，勿作现行 P6 理由）

## 生产指针

- 已于 2026-08-16T06:53:52 切到 `rel-prod-120`（用户授权 promote；当时 R1 尚可不带四臂过门）
- `rel-prod-115` 已 held
- 本次未再次 promote

## 未做

- 未把外部 scratch 整包进仓库
- 可复核索引：`evidence/trace-index.json`
- 活治理根仍被 `.git/info/exclude` 排除；仓库收 `evidence/governance` 快照
