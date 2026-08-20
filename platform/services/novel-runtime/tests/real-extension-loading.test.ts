/**
 * 真实 PiNovelStudio 扩展加载测试（P0-1 + P0-7 端到端覆盖）
 *
 * 验证：从真实 PiNovelStudio dist/index.js 加载的 6 个工具，
 * 经 adaptExecuteToInvoke 适配后，全部暴露 invoke 函数（不是 execute）。
 *
 * 前置：CI 在跑此测试前必须先构建 PiNovelStudio dist：
 *   cd D:/CODE/PiNovelStudio/.pi/extensions/novel-studio && npm run build:prod
 *
 * 本测试通过 NOVEL_STUDIO_DIST_PATH env 指向真实 dist；若 dist 不存在则 skip。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNovelStudioExtension } from "../src/extension-loader.js";
import { makeConfigForTest } from "../src/config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PNOVEL_DIST =
  process.env.NOVEL_STUDIO_DIST_PATH ??
  "D:/CODE/PiNovelStudio/.pi/extensions/novel-studio/dist/index.js";

describe("real PiNovelStudio extension loading", { skip: !existsSync(resolve(PNOVEL_DIST)) }, () => {
  const originalEnv = { ...process.env };

  before(() => {
    // 覆盖 config 必填 env（makeConfigForTest 不走 env，但 loadNovelStudioExtension 内部可能读）
    process.env.PLATFORM_API_BASE_URL = "http://test.invalid";
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = "test-hmac";
    process.env.NOVEL_STUDIO_DIST_PATH = PNOVEL_DIST;
    process.env.NOVEL_STUDIO_PROJECT_ROOT = "D:/CODE/PiNovelStudio";
  });

  after(() => {
    // 恢复 env
    for (const k of Object.keys(originalEnv)) process.env[k] = originalEnv[k];
    for (const k of [
      "PLATFORM_API_BASE_URL",
      "INTERNAL_API_SECRET",
      "NOVEL_TASK_TOKEN_HMAC_KEY",
      "NOVEL_STUDIO_DIST_PATH",
      "NOVEL_STUDIO_PROJECT_ROOT",
    ]) {
      if (!(k in originalEnv)) delete process.env[k];
    }
  });

  it("loads 6 tools, all expose invoke function after adapter", async () => {
    const config = makeConfigForTest({ novelStudioDistPath: PNOVEL_DIST });
    const loaded = await loadNovelStudioExtension(config);
    assert.equal(loaded.byName.size, 6);
    for (const [name, tool] of loaded.byName) {
      assert.equal(typeof tool.invoke, "function", `${name}.invoke should be function`);
    }
  });

  it("healthz filterResult contains novel_generate_chapter", async () => {
    const config = makeConfigForTest({ novelStudioDistPath: PNOVEL_DIST });
    const loaded = await loadNovelStudioExtension(config);
    const names = loaded.filterResult.allowed.map((t) => t.name);
    assert.ok(names.includes("novel_generate_chapter"), "should contain novel_generate_chapter");
    assert.equal(names.length, 6);
  });
});
