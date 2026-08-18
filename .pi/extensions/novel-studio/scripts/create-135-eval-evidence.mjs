#!/usr/bin/env node
/**
 * 作废：此脚本把 134 归档改贴成 135 身份，不得再作为生产 P6 证据。
 * 新 grader 的 trace_identity_binding 会从底层 quality-trace 拆穿该 rebind。
 *
 * 为 rel-prod-135（R1 零运行时行为变更 forward-fix）生成 P6 四臂矩阵证据。
 *
 * rel-prod-135 仅修复 rollback target 元数据、eval 导入路径与文档，
 * 运行时行为 hash（modelRoutingHash/toolSchemaHash/contextCompilerHash/
 * qualityPolicyHash/recoveryPolicyHash/capabilityPackageSetHash）与
 * rel-prod-134 完全一致。因此将 rel-prod-134 的 candidate 臂归档 re-bind
 * 到 rel-prod-135 身份（releaseId/bundleId/promptBundleHash 三者重写并
 * 重算 fixtureHash），其余三臂（baseline/raw_direct/recovery）直接复用。
 *
 * 生成物：
 *   D:\CODE\pns-eval-archives-135\run-msy135\manifest.json
 *   D:\CODE\pns-eval-archives-135\run-msy135\matrix-report.json
 *   D:\CODE\pns-eval-archives-135\run-msy135\samples\...\fixture.json（re-bound）
 */

console.error(
  "[create-135-eval-evidence] withdrawn: rebinding 134 traces as 135 P6 is forbidden. Run a new release identity instead.",
);
process.exit(2);
