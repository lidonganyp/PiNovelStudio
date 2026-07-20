/**
 * PiNovelStudio — build-info 生成器
 *
 * P34: 在 npm run build 前生成本扩展的 build-info.json，包含：
 *   - buildTimestamp：构建时刻（ISO-8601）
 *   - gitHash：当前 git HEAD commit hash（无 git 环境则 "unknown-no-git"）
 *   - nodeVersion：构建时 Node.js 版本
 *
 * QualityTraceRecorder 在模块加载时读取 build-info.json 并写入 trace 顶层 buildInfo 字段。
 * 用途：生成服务重启后复测时，可从 trace 确认当前运行的是哪次构建，避免长驻进程仍跑旧 dist。
 *
 * 用法：
 *   node scripts/generate-build-info.mjs          # 生成真实值
 *   node scripts/generate-build-info.mjs --placeholder  # 生成占位值（仅调试用）
 */

import { writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");

const placeholder = process.argv.includes("--placeholder");

let gitHash = "unknown-no-git";
if (!placeholder) {
  try {
    gitHash = execSync("git rev-parse HEAD", {
      cwd: EXTENSION_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    gitHash = "unknown-no-git";
  }
}

const buildInfo = {
  buildTimestamp: placeholder ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
  gitHash: placeholder ? "placeholder" : gitHash,
  nodeVersion: process.version,
};

const outputPath = join(EXTENSION_ROOT, "build-info.json");
writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf-8");

if (!placeholder) {
  console.log(`[build-info] 写入 ${outputPath}`);
  console.log(`[build-info] buildTimestamp=${buildInfo.buildTimestamp}`);
  console.log(`[build-info] gitHash=${buildInfo.gitHash}`);
  console.log(`[build-info] nodeVersion=${buildInfo.nodeVersion}`);
}
