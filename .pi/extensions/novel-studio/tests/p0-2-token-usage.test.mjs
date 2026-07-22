/**
 * P0-2（第二轮 P0 修复）：tokenUsage 真实计量测试
 *
 * 验证：
 * - createStubModelGenerateFn 返回 tokenUsage: {in, out}（不再是 undefined）
 * - 不同 kind 的 stub 调用都返回真实 tokenUsage
 * - 不再硬编码 "unknown"（actualCharge=0 根因）
 *
 * 注意：测试从 dist/ 加载编译产物（与 candidate-generator.test.mjs 同约定），
 * 跑前需先 `npm run build:prod`。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createStubModelGenerateFn } from "../dist/v2/adapters/legacy-model-route-adapter.js";

describe("P0-2 stub ModelGenerateFn 返回真实 tokenUsage", () => {
  test("createStubModelGenerateFn 返回 tokenUsage 对象，非 undefined", async () => {
    const fn = createStubModelGenerateFn();
    const input = {
      route: "v2_rawstage2",
      systemPrompt: "test",
      userPrompt: "test",
      kind: "raw_chapter",
    };
    const output = await fn(input);

    assert.ok(output.tokenUsage, "stub 应返回 tokenUsage（非 undefined）");
    assert.notEqual(output.tokenUsage, "unknown", "stub 不应返回 'unknown'");
    assert.equal(typeof output.tokenUsage, "object");
    assert.equal(output.tokenUsage.in, 100, "stub 输入 token = 100");
    assert.equal(output.tokenUsage.out, 200, "stub 输出 token = 200");
  });

  test("不同 kind 的 stub 调用都返回 tokenUsage", async () => {
    const fn = createStubModelGenerateFn();
    for (const kind of [
      "raw_chapter",
      "opportunity_judge",
      "editorial_amplified",
      "literary_judge",
      "direct_baseline",
    ]) {
      const output = await fn({
        route: "v2_rawstage2",
        systemPrompt: "test",
        userPrompt: "test",
        kind,
      });
      assert.ok(
        output.tokenUsage && output.tokenUsage !== "unknown",
        `kind=${kind} 应返回真实 tokenUsage`,
      );
    }
  });
});
