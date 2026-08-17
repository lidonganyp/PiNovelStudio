/**
 * MA-6.4 — multi-agent boundary replay CI gate (stub, no real model)
 *
 * 验证：
 * 1. 脚本可执行并产出 report
 * 2. trace 留存率 / agentCollaboration / agentLineageIndex 门槛
 * 3. 无 machine judge / one-shot raw
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..");
const SCRIPT = join(EXT_ROOT, "scripts", "multi-agent-boundary-replay.mjs");
const REPORT = join(
  PROJECT_ROOT,
  "reports",
  "multi-agent-boundary-replay",
  "report.json",
);

test("MA-6.4: multi-agent boundary replay 脚本通过 stub 门禁", () => {
  assert.ok(existsSync(SCRIPT), `脚本应存在: ${SCRIPT}`);

  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--samples=2"],
    {
      cwd: EXT_ROOT,
      env: {
        ...process.env,
        V2_FORCE_STUB: "1",
        PINOVEL_DEV_MODE: "1",
        // 强制 agentic_style 生产流（不要 legacy 评测编排）
        PINOVEL_TEST_LEGACY_PRODUCTION_FLOW: "",
      },
      encoding: "utf8",
      timeout: 180_000,
    },
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
  }
  assert.equal(result.status, 0, `replay 脚本应 exit 0，stderr=${result.stderr}`);

  assert.ok(existsSync(REPORT), `应产出 ${REPORT}`);
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  assert.equal(report.schema, "pinovel.multi-agent-boundary-replay");
  assert.equal(report.overallPass, true, JSON.stringify(report.gateFailures));
  assert.equal(report.gates.traceRetentionRate, 1);
  assert.equal(report.gates.agentCollaborationRate, 1);
  assert.equal(report.gates.agentLineageIndexRate, 1);
  assert.equal(report.gates.machineJudgeCalls, 0);
  assert.equal(report.gates.oneShotRawCalls, 0);
  assert.ok(report.samples.length >= 2);
  for (const sample of report.samples) {
    assert.equal(sample.ok, true, JSON.stringify(sample));
    assert.ok(
      sample.hasTracePath || sample.hasTraceArchivePath,
      "每条 sample 必须有 tracePath 或 archive",
    );
    assert.equal(sample.hasAgentCollaboration, true);
    assert.equal(sample.hasAgentLineageIndex, true);
  }
});
