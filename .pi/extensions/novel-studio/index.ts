/**
 * PiNovelStudio — 生产内核入口（统一主链路）
 *
 * Step 2 逻辑隔离后，本文件仅保留：
 * - 模块级初始化（projectRoot / .env）
 * - 6 个公开工具注册
 * - 统一主链路唯一入口（novel_generate_chapter）
 *
 * Legacy Stage0-8 链路（legacy-index.ts / register-lab-tools.ts / lab/ 目录）已于
 * #9e/#10 删除；生产入口零 legacy 依赖，无 lab 构建回退路径。
 *
 * 生产入口不 import、不动态加载任何 legacy 模块。
 * 依赖边界测试（tests/dependency-boundary.test.mjs）自动验证此约束。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot, setProjectRoot } from "./utils/config.js";
import { registerTools } from "./tools/register-tools.js";
import {
  handleGenerateChapter,
  handlePreflightWorkspace,
  handlePlanStoryOutline,
  handleStrategyPolicyView,
  handleStrategyFeedback,
  handleWorkspaceManager,
} from "./handlers/public-handlers.js";

// ============================================================================
// 模块级初始化
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// index.ts 在 .pi/extensions/novel-studio/, 上三级即为项目根目录
const DETECTED_PROJECT_ROOT = resolveProjectRoot(__dirname);
setProjectRoot(DETECTED_PROJECT_ROOT);

// PI 不会自动加载 .env, 手动解析注入 process.env
const envPath = resolve(DETECTED_PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  // ============================================================================
  // 通知加载状态
  // ============================================================================
  pi.on("session_start", async (_event: any, ctx: any) => {
    // PI 中 process.cwd() 指向安装目录, ctx.cwd 才是项目目录
    if (ctx?.cwd) setProjectRoot(ctx.cwd);
    ctx.ui.notify("📖 PiNovelStudio loaded", "info");
    ctx.ui.notify("✅ PiNovelStudio loaded: 6 public tools (unified pipeline)", "success");
  });

  // ============================================================================
  // 工具注册 — 6 个公开工具
  // ============================================================================
  const tools = registerTools({
    handleGenerateChapter,
    handlePreflightWorkspace,
    handleWorkspaceManager,
    handlePlanStoryOutline,
    handleStrategyPolicyView,
    handleStrategyFeedback,
  });
  for (const tool of tools) {
    pi.registerTool(tool);
  }
}
