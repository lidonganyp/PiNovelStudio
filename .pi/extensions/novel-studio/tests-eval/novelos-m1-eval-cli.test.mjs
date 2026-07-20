/**
 * NovelOS M1 Eval CLI 产品级测试（P0 配套）
 *
 * 验证 scripts/novelos-m1-eval.mjs 端到端可运行：
 * - 退出码 0
 * - JSON 报告非空、可解析、不为 {}（回归 P0 bug：未 await runFullEval）
 * - JSON 报告包含 totalFixtures/recommendation/summary 字段
 * - Markdown 报告非空、包含标题
 *
 * 用 --fixtures F1 单 fixture 快速运行，输出到临时目录。
 * 需要先 build（dist/ 存在）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");
// PROJECT_ROOT = D:\CODE\PiNovelStudio（从 novel-studio/ 上 3 级：novel-studio → extensions → .pi → PiNovelStudio）
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "novelos-m1-eval.mjs");

// 动态获取第一个 fixture ID（避免硬编码 F1，实际 ID 为 F1-historical-fact）
const fixturesUrl = pathToFileURL(join(DIST_ROOT, "novelos", "eval", "fixtures.js")).href;
const { EVAL_FIXTURES } = await import(fixturesUrl);
const FIRST_FIXTURE_ID = EVAL_FIXTURES[0].id;

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS M1 Eval CLI — 端到端产品级测试", () => {
  // 跳过条件：dist/ 不存在（未 build）
  const hasBuild = existsSync(join(DIST_ROOT, "novelos", "eval", "eval-harness.js"));
  const hasScript = existsSync(SCRIPT_PATH);

  test("CLI 运行单 fixture → 退出码 0 + 报告非空（回归 P0 await bug）", { skip: !hasBuild || !hasScript ? "dist/ 或 script 不存在，先 npm run build" : false }, () => {
    // 临时输出路径
    const tmpDir = join(tmpdir(), `novelos-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    const jsonOutput = join(tmpDir, "eval.json");
    const mdOutput = join(tmpDir, "eval.md");

    try {
      const result = spawnSync("node", [
        SCRIPT_PATH,
        "--fixtures", FIRST_FIXTURE_ID,
        "--output", jsonOutput,
        "--summary", mdOutput,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 120000, // 2 分钟超时
      });

      // 退出码 0
      assert.equal(result.status, 0, `CLI 应退出码 0，实际 ${result.status}。stderr: ${result.stderr?.slice(0, 500)}`);

      // JSON 报告存在且非空
      assert.ok(existsSync(jsonOutput), "JSON 报告文件应存在");

      const jsonContent = readFileSync(jsonOutput, "utf-8");
      assert.ok(jsonContent.length > 10, `JSON 报告应非空，实际长度 ${jsonContent.length}`);

      // 回归 P0：JSON 不应为 "{}"（未 await runFullEval 会导致 JSON.stringify(Promise) = {}）
      assert.notEqual(jsonContent.trim(), "{}", "JSON 报告不应为 {}（P0 await bug 回归）");

      // JSON 可解析
      const report = JSON.parse(jsonContent);

      // 包含关键字段
      assert.ok(report.timestamp, "报告应包含 timestamp");
      assert.ok(report.recommendation, "报告应包含 recommendation");
      assert.ok(report.summary, "报告应包含 summary");
      assert.equal(report.totalFixtures, 1, "单 fixture 运行，totalFixtures 应为 1");
      assert.ok(["go_candidate", "hold", "no_go"].includes(report.recommendation), `recommendation 应为 go_candidate/hold/no_go，实际 ${report.recommendation}`);
      assert.ok(report.recommendationReason?.length > 0, "recommendationReason 应非空");

      // Markdown 报告存在且非空
      assert.ok(existsSync(mdOutput), "Markdown 报告文件应存在");
      const mdContent = readFileSync(mdOutput, "utf-8");
      assert.ok(mdContent.length > 100, `Markdown 报告应非空，实际长度 ${mdContent.length}`);
      assert.ok(mdContent.includes("# NovelOS M1 评测报告"), "Markdown 应包含标题");
      assert.ok(mdContent.includes("HOLD") || mdContent.includes("GO") || mdContent.includes("NO_GO"), "Markdown 应包含决策结果");

      // 控制台输出包含摘要
      assert.ok(result.stdout?.includes("验收决策"), "stdout 应包含验收决策摘要");
    } finally {
      // 清理临时目录
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
    }
  });

  test("CLI --help → 退出码 0 + 显示帮助", { skip: !hasScript ? "script 不存在" : false }, () => {
    const result = spawnSync("node", [SCRIPT_PATH, "--help"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, "--help 应退出码 0");
    assert.ok(result.stdout?.includes("NovelOS M1 评测脚本"), "应显示帮助标题");
    assert.ok(result.stdout?.includes("--fixtures"), "应显示 --fixtures 选项");
  });
});
