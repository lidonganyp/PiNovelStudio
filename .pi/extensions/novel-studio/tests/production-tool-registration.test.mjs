/**
 * Step 2 逻辑隔离回归测试：生产 registerTools 始终返回恰好 6 个公开工具
 *
 * Step 2 后，生产入口（tools/register-tools.ts）只含 6 个公开工具 spec，
 * 无 filter、无 NOVEL_TEST_TOOLS / NOVEL_DEBUG_TOOLS 门控。
 * legacy lab 构建（lab/、tsconfig.lab.json、register-lab-tools.ts）已于 #10 删除；
 * 测试/评测产物分别由 tsconfig.test.json（dist-test/）与 tsconfig.eval.json（dist-eval/）承载。
 *
 * 本测试直接调用生产 registerTools（dist/tools/register-tools.js），
 * 验证无论 NOVEL_TEST_TOOLS 设置如何，始终返回恰好 6 个公开工具。
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");

const EXPECTED_PUBLIC_TOOLS = [
  "novel_workspace_manager",
  "novel_generate_chapter",
  "novel_preflight_workspace",
  "novel_plan_story_outline",
  "novel_strategy_policy_view",
  "novel_strategy_feedback",
];

/**
 * 直接从生产 dist 加载 registerTools（绕过扩展入口的模块缓存），
 * 使每次调用都能读到调用前的 process.env 真实值。
 */
async function loadRegisterTools() {
  const mod = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "tools", "register-tools.js")).href
  );
  return mod.registerTools;
}

/**
 * 最小 handlers stub：registerTools 在注册阶段只存储 handler 引用，不调用它们，
 * 故 Proxy 返回空 async 函数即可满足结构。
 */
function makeStubHandlers() {
  return new Proxy({}, { get: () => async () => ({}) });
}

describe("Step 2：生产 registerTools 始终返回恰好 6 个公开工具", () => {
  const originalTestFlag = process.env.NOVEL_TEST_TOOLS;
  const originalDebugFlag = process.env.NOVEL_DEBUG_TOOLS;

  afterEach(() => {
    // 恢复 env，避免影响后续测试套件
    if (originalTestFlag === undefined) {
      delete process.env.NOVEL_TEST_TOOLS;
    } else {
      process.env.NOVEL_TEST_TOOLS = originalTestFlag;
    }
    if (originalDebugFlag === undefined) {
      delete process.env.NOVEL_DEBUG_TOOLS;
    } else {
      process.env.NOVEL_DEBUG_TOOLS = originalDebugFlag;
    }
  });

  it("无 NOVEL_TEST_TOOLS 时返回恰好 6 个公开工具", async () => {
    delete process.env.NOVEL_TEST_TOOLS;
    delete process.env.NOVEL_DEBUG_TOOLS;
    const registerTools = await loadRegisterTools();
    const tools = registerTools(makeStubHandlers());
    const names = tools.map((t) => t.name);

    assert.equal(names.length, 6, `生产工具数应为 6，实际: ${names.length}（${names.join(", ")}）`);
    for (const expected of EXPECTED_PUBLIC_TOOLS) {
      assert.ok(names.includes(expected), `应包含 ${expected}，实际: ${names.join(", ")}`);
    }
  });

  it("设 NOVEL_TEST_TOOLS=1 时仍返回恰好 6 个公开工具（无 legacy_test）", async () => {
    process.env.NOVEL_TEST_TOOLS = "1";
    const registerTools = await loadRegisterTools();
    const tools = registerTools(makeStubHandlers());
    const names = tools.map((t) => t.name);

    assert.equal(names.length, 6, `生产工具数应为 6（不受 NOVEL_TEST_TOOLS 影响），实际: ${names.length}`);
    assert.ok(
      !names.includes("novel_generate_chapter_legacy_test"),
      `生产 registerTools 不应注册 legacy_test，实际: ${names.join(", ")}`,
    );
  });

  it("设 NOVEL_DEBUG_TOOLS=1 时仍返回恰好 6 个公开工具（无诊断工具）", async () => {
    process.env.NOVEL_DEBUG_TOOLS = "1";
    const registerTools = await loadRegisterTools();
    const tools = registerTools(makeStubHandlers());
    const names = tools.map((t) => t.name);

    assert.equal(names.length, 6, `生产工具数应为 6（不受 NOVEL_DEBUG_TOOLS 影响），实际: ${names.length}`);
  });

  it("生产工具集不含 legacy_test 或诊断工具", async () => {
    delete process.env.NOVEL_TEST_TOOLS;
    delete process.env.NOVEL_DEBUG_TOOLS;
    const registerTools = await loadRegisterTools();
    const tools = registerTools(makeStubHandlers());
    const names = tools.map((t) => t.name);

    assert.ok(
      !names.includes("novel_generate_chapter_legacy_test"),
      "生产工具集不应含 novel_generate_chapter_legacy_test",
    );
    // 诊断工具以 novel_ 前缀但不在这 6 个公开工具中
    const unexpected = names.filter((n) => !EXPECTED_PUBLIC_TOOLS.includes(n));
    assert.equal(unexpected.length, 0, `生产工具集含非预期工具: ${unexpected.join(", ")}`);
  });
});
