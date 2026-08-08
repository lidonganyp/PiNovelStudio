/**
 * PHASE4-TOOL-AB-REAL-REPORT-AUTH：report CLI 显式授权 + route allowlist（fix 5）
 *
 * 验证 tool-ab-real-report.mjs 在 real 模式下的安全门：
 * 1. real 模式未传 --require-auth 显式授权开关 → 拒绝执行（exit 1）
 * 2. real 模式路由不在 GLM/Doubao 测试 allowlist 内 → 拒绝执行（exit 1）
 * 3. dry-run 模式无需授权也能运行（exit 0，输出到临时目录，避免污染真实报告目录）
 *
 * 授权边界：real 模式在授权/allowlist 检查失败时于创建 modelFn 之前退出，
 * 不触发任何真实模型计费调用。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const SCRIPT = join(EXTENSION_ROOT, "scripts", "tool-ab-real-report.mjs");

function runReal(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });
}

describe("PHASE4-TOOL-AB-REAL-REPORT-AUTH：real 模式显式授权与 route allowlist", () => {
  it("real 模式未传 --require-auth 拒绝执行（exit 1）", () => {
    const r = runReal(["--mode", "real"]);
    assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}`);
    assert.ok(r.stderr.includes("--require-auth"), `应提示缺少 --require-auth，实际=${r.stderr}`);
  });

  it("real 模式非 allowlist 路由拒绝执行（exit 1）", () => {
    const r = runReal(["--mode", "real", "--require-auth", "--route", "narrator_testing_gpt"]);
    assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}`);
    assert.ok(r.stderr.includes("allowlist"), `应提示路由不在 allowlist，实际=${r.stderr}`);
  });

  it("dry-run 模式无需授权也能运行（exit 0，输出到临时目录）", () => {
    const outDir = join(tmpdir(), `phase4-report-auth-${Date.now()}`);
    const r = runReal(["--mode", "dry-run", "--samples", "1", "--output", outDir]);
    assert.equal(r.status, 0, `dry-run 应 exit 0，实际 ${r.status}，stderr=${r.stderr}`);
    assert.ok(r.stdout.includes("报告完成。") || r.stderr.includes("报告完成。"), "应完成报告生成");
  });
});