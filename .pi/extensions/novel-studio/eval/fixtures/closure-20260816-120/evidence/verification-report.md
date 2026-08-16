# Eval 闭环证据 2026-08-16（rel-prod-120）

绑定：

- 当前 active_prod: `rel-prod-115`（未切换）
- candidate release: `rel-prod-120` / status=`approved_dev`
- codeCommit: `57486b915e437015d86ef34401f29a0dfad51aa2`
- fpHash: `bf1880e76acd3896ffd00c07b011b7f504ba655cfdc20b75c3b3b623cdc99e3d`
- bundleId: `aa83d08c22a65bfe7e1cf05d9a02064d4611a6bb8bc5d41f03acd2fb5e1e60c7`
- capabilityPackageSetHash: `e5c8b475e2f3d988cec494fcc192680b32d2d2fa70ec16f2838ed05dbafe4017`
- 干净 worktree: `D:\CODE\pns-eval-120@57486b9`（capture/verify 时 worktreeDirty=false）

## 真实审批

- artifact: `approval-rel-prod-120-1786859687887-7a8aca3e`
- `forward=APPROVE_DEV` / `reverse=APPROVE_DEV` / `finalVerdict=APPROVE_DEV`
- `reviewTransport=network`

## candidate_like

- runId: `closure-candidate-like-120`
- CLI: FAIL（2/3 completed）
- 失败样本: `fixture.closure-candidate-like-003`
  - 首次：FactGuard `封印`
  - 重试 `closure-candidate-like-120-s3`：`story_preservation` 骨架漂移，归因仍为 `unclassified`
- isolation=0；当时 P6 按 R1 deterministic-only 给出 `EVAL_EVIDENCE_APPROVED`
- 2026-08-16 门禁收口后：R0-R3 一律要求四臂 + pass^3=1，本 run 无 matrix-report，**不得再作为晋级依据**

## production_like（晋级依据）

- runId: `closure-production-like-120`
- 外部归档: `D:\CODE\pns-eval-archives-120\closure-production-like-120`
- CLI: PASS，`ok=true`
- P6: `EVAL_EVIDENCE_APPROVED`（本机 `evolution:eval-gate` 复验通过）
- summary: completed=3/3，failed=0，isolation=0，traceRetentionRate=1，unclassified=0
- 每样本 2 次 Gemini 31：`v2_rawstage2_gemini31` + `v2_amplified_gemini31`
- 每样本 `approvalRef` 均为 `approval-rel-prod-120-1786859687887-7a8aca3e`，`devMode=false`
- 模型调用: [2, 2, 2]，tokenCost: [12661, 11454, 12992]

## 四臂矩阵

- 仓库与 120 归档仍无 baseline / candidate / raw_direct / recovery 四臂报告
- 现门禁：R0-R3 一律 `EVAL_EVIDENCE_MATRIX_MISSING` 直至补齐四臂且 pass^3=1

## 未做

- 未执行 `evolution:promote --target active_prod`（生产指针仍为 `rel-prod-115`，需用户明确授权）
- 未把 `D:\CODE\pns-eval-archives-120` 整包进仓库（scratch 副本过大；本目录只入库摘要）
