#!/usr/bin/env node
/**
 * REFERENCE-HOLDOUT-SPLIT-1：冻结 reference 访问审计 CLI
 *
 * 任务卡 §6 验收：
 * - 调参程序无冻结测试集 reference 解封权限
 * - 任何查看冻结 reference 的行为写入审计日志并使本轮结果失效
 *
 * 子命令：
 *   record  --manifest <split-manifest.json> --reference-id <ID> --accessor <NAME> --reason <TEXT>
 *           记录一次冻结 reference 访问；写入 JSONL 行 + invalidatesRound=true
 *           若 referenceId 不在 frozenTestSet 中 → 错误退出（不允许审计非冻结访问）
 *           若 referenceId 未知（不在 manifest 任何集合中）→ 错误退出
 *
 *   check   --manifest <split-manifest.json>
 *           读取 audit log，输出 JSON { roundValid, accessCount, lastAccessAt }
 *           有任何访问记录 → roundValid=false, exit 1
 *           无访问记录 → roundValid=true, exit 0
 *
 * 审计日志路径：与 manifest 同目录的 frozen-access-audit.jsonl
 *
 * 授权边界：本 CLI 全程离线，不调用任何模型 API。
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const { values, positionals } = parseArgs({
  options: {
    manifest: { type: "string" },
    "reference-id": { type: "string" },
    accessor: { type: "string" },
    reason: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  process.stdout.write(`REFERENCE-HOLDOUT-SPLIT-1：冻结 reference 访问审计 CLI

用法：
  node scripts/novelbench/audit-frozen-access.mjs record \\
    --manifest <split-manifest.json> \\
    --reference-id <ID> --accessor <NAME> --reason <TEXT>

  node scripts/novelbench/audit-frozen-access.mjs check \\
    --manifest <split-manifest.json>

子命令：
  record    记录一次冻结 reference 访问（写入 JSONL 行 + invalidatesRound=true）
  check     读取 audit log，输出 JSON { roundValid, accessCount, lastAccessAt }

record 必填参数：
  --manifest <PATH>          split-manifest.json 路径
  --reference-id <ID>        被访问的 referenceId（必须在 frozenTestSet 中）
  --accessor <NAME>          访问者标识（如 tuning-script / evaluator）
  --reason <TEXT>            访问原因

check 必填参数：
  --manifest <PATH>          split-manifest.json 路径

权限规则：
  - record 仅允许记录 frozenTestSet 内的 referenceId 访问
  - 任何 record 调用都会使本轮结果失效（invalidatesRound=true）
  - 非冻结 referenceId 访问不允许通过本 CLI 记录（应直接报错退出）

授权边界：本 CLI 全程离线，不调用任何模型 API。
`);
  process.exit(0);
}

const subcommand = positionals[0];
if (subcommand !== "record" && subcommand !== "check") {
  process.stderr.write(
    `错误：未知子命令 '${subcommand ?? ""}'（应为 record 或 check）\n` +
      `使用 --help 查看完整用法\n`,
  );
  process.exit(1);
}

const manifestRaw = values.manifest;
if (!manifestRaw) {
  process.stderr.write(`错误：--manifest 为必填\n`);
  process.exit(1);
}

const manifestPath = resolve(PROJECT_ROOT, manifestRaw);
if (!existsSync(manifestPath)) {
  process.stderr.write(`错误：manifest 文件不存在：${manifestPath}\n`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const auditLogPath = join(dirname(manifestPath), "frozen-access-audit.jsonl");

// 加载 frozen 集合
const frozenIds = new Set(
  (manifest.frozenTestSet ?? []).map((e) => e.referenceId),
);
const allIds = new Set([
  ...(manifest.analysisSet ?? []).map((e) => e.referenceId),
  ...(manifest.validationSet ?? []).map((e) => e.referenceId),
  ...(manifest.frozenTestSet ?? []).map((e) => e.referenceId),
]);

// ─────────────────────────────────────────────────────────────────────────────
// record 子命令
// ─────────────────────────────────────────────────────────────────────────────

if (subcommand === "record") {
  const referenceId = values["reference-id"];
  const accessor = values.accessor;
  const reason = values.reason;

  if (!referenceId || !accessor || !reason) {
    process.stderr.write(
      `错误：record 子命令需 --reference-id、--accessor、--reason 均为必填\n`,
    );
    process.exit(1);
  }

  if (!allIds.has(referenceId)) {
    process.stderr.write(
      `错误：未知 referenceId '${referenceId}'（不在 manifest 任何集合中）\n`,
    );
    process.exit(2);
  }

  if (!frozenIds.has(referenceId)) {
    process.stderr.write(
      `错误：referenceId '${referenceId}' 不在 frozenTestSet 中\n` +
        `本 CLI 仅允许记录冻结 reference 访问；非冻结访问不应通过本 CLI 审计\n`,
    );
    process.exit(3);
  }

  // 追加 JSONL 行
  const entry = {
    timestamp: new Date().toISOString(),
    action: "view_frozen_reference",
    referenceId,
    accessor,
    reason,
    invalidatesRound: true,
  };

  appendFileSync(auditLogPath, JSON.stringify(entry) + "\n", "utf-8");

  process.stdout.write(
    JSON.stringify(
      {
        recorded: true,
        referenceId,
        invalidatesRound: true,
        auditLogPath,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// check 子命令
// ─────────────────────────────────────────────────────────────────────────────

if (subcommand === "check") {
  let records = [];
  if (existsSync(auditLogPath)) {
    const content = readFileSync(auditLogPath, "utf-8");
    records = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  const roundValid = records.length === 0;
  const lastAccessAt =
    records.length > 0 ? records[records.length - 1].timestamp : null;

  const summary = {
    roundValid,
    accessCount: records.length,
    lastAccessAt,
    auditLogPath,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (!roundValid) {
    process.exit(1);
  }
  process.exit(0);
}
