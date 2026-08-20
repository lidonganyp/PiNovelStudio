/**
 * P0-1（第二轮 P0 修复）：execute → invoke 适配器测试
 *
 * 验证：
 * - adaptExecuteToInvoke 把 { execute } 工具包装成 { invoke }
 * - invoke 调用 execute 并返回其 details 字段（PiNovelStudio wrapLegacyTool 返回形状）
 * - 已有 invoke 的工具原样返回（兼容）
 * - 既无 invoke 也无 execute 的工具原样返回（fail-closed 让下游守卫拒绝）
 * - makeLoadedToolsForTest 对测试桩也做适配
 * - 真实 PiNovelStudio 工具形状（6 个工具，每个只有 execute）适配后全有 invoke
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  adaptExecuteToInvoke,
  makeLoadedToolsForTest,
  type LoadedTools,
} from "../src/extension-loader.js";
import type { PiTool } from "../src/pi-extension-api-stub.js";
import type { ToolLike } from "../src/tool-whitelist.js";

const SIX_TOOL_NAMES = [
  "novel_generate_chapter",
  "novel_preflight_workspace",
  "novel_workspace_manager",
  "novel_plan_story_outline",
  "novel_strategy_policy_view",
  "novel_strategy_feedback",
];

/** 模拟 PiNovelStudio wrapLegacyTool 产出的工具形状：只有 execute，无 invoke。 */
function makeExecuteOnlyTool(name: string, detailsResult: unknown): PiTool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: "object" },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      assert.equal(toolCallId, "invoke-call", "execute 应收到 invoke-call 作为 toolCallId");
      return {
        content: [{ type: "text", text: "stub execute content" }],
        details: detailsResult,
      };
    },
  };
}

describe("P0-1 adaptExecuteToInvoke", () => {
  test("execute-only 工具被包装出 invoke，invoke 返回 details 字段", async () => {
    const expectedDetails = { status: "ok", chapterId: "ch-1", text: "正文..." };
    const tool = makeExecuteOnlyTool("novel_test", expectedDetails);
    const adapted = adaptExecuteToInvoke(tool);

    assert.equal(typeof adapted.invoke, "function", "适配后应有 invoke 函数");
    assert.equal(typeof adapted.execute, "function", "原 execute 保留");

    const invokeResult = await adapted.invoke!({ workspaceId: "ws-1" });
    assert.equal(invokeResult, expectedDetails, "invoke 返回 execute 的 details 字段");
  });

  test("已有 invoke 的工具原样返回（不重新包装）", async () => {
    const tool: PiTool = {
      name: "novel_existing_invoke",
      async invoke(input) {
        return { echo: input };
      },
    };
    const adapted = adaptExecuteToInvoke(tool);
    assert.equal(adapted.invoke, tool.invoke, "原 invoke 引用保留，不重新包装");

    const result = await adapted.invoke!({ x: 1 });
    assert.deepEqual(result, { echo: { x: 1 } });
  });

  test("既无 invoke 也无 execute 的工具原样返回（让下游 fail-closed）", () => {
    const tool: PiTool = {
      name: "novel_broken",
      description: "既无 invoke 也无 execute",
    };
    const adapted = adaptExecuteToInvoke(tool);
    assert.equal(adapted, tool, "原对象引用返回");
    assert.equal(adapted.invoke, undefined, "invoke 仍为 undefined");
    assert.equal(adapted.execute, undefined, "execute 仍为 undefined");
  });

  test("execute 返回无 details 字段时，invoke 返回整个 execute 结果", async () => {
    const tool: PiTool = {
      name: "novel_no_details",
      async execute() {
        // 故意返回不带 details 的形状
        return {
          content: [{ type: "text", text: "no details here" }],
        };
      },
    };
    const adapted = adaptExecuteToInvoke(tool);
    const result = await adapted.invoke!({});
    assert.deepEqual(result, {
      content: [{ type: "text", text: "no details here" }],
    });
  });

  test("execute 返回 details=null 时，invoke 返回 null", async () => {
    const tool: PiTool = {
      name: "novel_null_details",
      async execute() {
        return {
          content: [{ type: "text", text: "blocked" }],
          details: null,
        };
      },
    };
    const adapted = adaptExecuteToInvoke(tool);
    const result = await adapted.invoke!({});
    assert.equal(result, null);
  });

  test("whitelisted tools without an executable handler fail readiness", () => {
    const tools: PiTool[] = SIX_TOOL_NAMES.map((name) => ({
      name,
      inputSchema: { type: "object" },
    }));

    assert.throws(
      () => makeLoadedToolsForTest(tools),
      /not executable|FAIL_CLOSED/i,
    );
  });
});

describe("P0-1 makeLoadedToolsForTest 适配", () => {
  test("6 个 execute-only 工具经 makeLoadedToolsForTest 后全有 invoke", () => {
    const tools: ToolLike[] = SIX_TOOL_NAMES.map((name, i) =>
      makeExecuteOnlyTool(name, { index: i, status: "ok" }),
    );

    const loaded: LoadedTools = makeLoadedToolsForTest(tools as PiTool[]);

    assert.equal(loaded.byName.size, 6, "应通过白名单 6 个工具");
    for (const name of SIX_TOOL_NAMES) {
      const tool = loaded.byName.get(name);
      assert.ok(tool, `${name} 应在 byName 中`);
      assert.equal(
        typeof tool!.invoke,
        "function",
        `${name}.invoke 应被适配为 function`,
      );
    }
  });

  test("6 个 invoke-only 工具经 makeLoadedToolsForTest 后 invoke 保持原引用", () => {
    const tools: PiTool[] = SIX_TOOL_NAMES.map((name) => ({
      name,
      async invoke() {
        return { stub: true };
      },
    }));

    const loaded = makeLoadedToolsForTest(tools);
    for (const name of SIX_TOOL_NAMES) {
      const tool = loaded.byName.get(name)!;
      assert.equal(typeof tool.invoke, "function");
    }
  });

  test("真实 PiNovelStudio 工具形状冒烟：6 工具全有 execute 无 invoke，适配后全有 invoke", async () => {
    // 模拟真实 wrapLegacyTool 产出的工具形状
    const tools: PiTool[] = SIX_TOOL_NAMES.map((name) => ({
      name,
      description: `PiNovelStudio ${name}`,
      inputSchema: { type: "object", properties: {} },
      async execute(toolCallId, params) {
        assert.equal(toolCallId, "invoke-call");
        return {
          content: [{ type: "text", text: `${name} executed` }],
          details: { tool: name, status: "ok", echo: params },
        };
      },
      // 注意：没有 invoke
    }));

    const loaded = makeLoadedToolsForTest(tools);

    // 验证：所有工具的 invoke 现在是 function
    for (const name of SIX_TOOL_NAMES) {
      const tool = loaded.byName.get(name)!;
      assert.equal(
        typeof tool.invoke,
        "function",
        `${name} 应被 adaptExecuteToInvoke 包装出 invoke`,
      );
    }

    // 验证：调用 invoke 实际触发 execute 并返回 details
    const genTool = loaded.byName.get("novel_generate_chapter")!;
    const result = await genTool.invoke!({ workspaceId: "ws-1", chapterId: "ch-1" });
    assert.deepEqual(result, {
      tool: "novel_generate_chapter",
      status: "ok",
      echo: { workspaceId: "ws-1", chapterId: "ch-1" },
    });
  });
});
