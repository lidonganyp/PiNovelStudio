#!/usr/bin/env node
/**
 * NB-3R.5 监控脚本：等待 GLM + Doubao 提取完成后自动运行统计报告。
 *
 * 轮询 extract-glm-100.log 和 extract-doubao-100.log 中的 "完成" 标记，
 * 两者都完成后运行 calibration-stats.mjs，写入完成标记文件。
 *
 * 用法：node scripts/novelbench/wait-and-report.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const glmLog = join(PROJECT_ROOT, "extract-glm-100.log");
const doubaoLog = join(PROJECT_ROOT, "extract-doubao-100.log");
const doneMarker = join(PROJECT_ROOT, "extract-done.marker");
const statsScript = join(PROJECT_ROOT, "scripts", "novelbench", "calibration-stats.mjs");

function isDone(logPath) {
  if (!existsSync(logPath)) return false;
  return readFileSync(logPath, "utf-8").includes("完成：");
}

function getSummary(logPath) {
  if (!existsSync(logPath)) return "N/A";
  const content = readFileSync(logPath, "utf-8");
  const m = content.match(/完成：(\d+\/\d+ 成功[^]*)/);
  return m ? m[1].trim() : "N/A";
}

process.stderr.write("[wait-and-report] 等待 GLM + Doubao 提取完成...\n");

const startTime = Date.now();
const maxWaitMs = 6 * 60 * 60 * 1000; // 最多等 6 小时

while (Date.now() - startTime < maxWaitMs) {
  const glmDone = isDone(glmLog);
  const doubaoDone = isDone(doubaoLog);

  if (glmDone && doubaoDone) {
    process.stderr.write(`[wait-and-report] 两者都完成！\n`);
    process.stderr.write(`[wait-and-report] GLM: ${getSummary(glmLog)}\n`);
    process.stderr.write(`[wait-and-report] Doubao: ${getSummary(doubaoLog)}\n`);

    // 运行统计脚本
    process.stderr.write("[wait-and-report] 运行 calibration-stats.mjs...\n");
    const result = spawnSync("node", [statsScript], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 60000,
    });

    if (result.status !== 0) {
      process.stderr.write(`[wait-and-report] ⚠ 统计脚本退出码 ${result.status}\n`);
    }

    // 写完成标记
    const marker = {
      completedAt: new Date().toISOString(),
      glmSummary: getSummary(glmLog),
      doubaoSummary: getSummary(doubaoLog),
    };
    writeFileSync(doneMarker, JSON.stringify(marker, null, 2) + "\n", "utf-8");
    process.stderr.write(`[wait-and-report] ✓ 完成标记已写入 ${doneMarker}\n`);
    process.exit(0);
  }

  // 每 60 秒轮询
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  process.stderr.write(
    `[wait-and-report] ${elapsed}s | GLM ${glmDone ? "✓" : "..."} | Doubao ${doubaoDone ? "✓" : "..."}\n`,
  );
  await new Promise((r) => setTimeout(r, 60000));
}

process.stderr.write("[wait-and-report] 超时（6 小时），退出\n");
process.exit(1);
