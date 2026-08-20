/**
 * 工具白名单测试（plan §1 T1-2）
 *
 * 验证：
 * - 只允许 6 个 novel_* 工具
 * - 禁止 Shell/代码执行/文件/Git/MCP/URL 等能力
 * - 严格断言：工具数不符或命中禁止模式时 fail closed
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_TOOL_NAMES,
  filterToWhitelist,
  assertStrictWhitelist,
  isAllowedTool,
  isForbiddenToolName,
  WhitelistViolationError,
  type ToolLike,
} from "../src/tool-whitelist.js";

const SIX_NOVEL_TOOLS: ToolLike[] = [
  { name: "novel_generate_chapter" },
  { name: "novel_preflight_workspace" },
  { name: "novel_workspace_manager" },
  { name: "novel_plan_story_outline" },
  { name: "novel_strategy_policy_view" },
  { name: "novel_strategy_feedback" },
];

describe("T1-2 工具白名单", () => {
  test("允许恰好 6 个 novel_* 工具", () => {
    assert.equal(ALLOWED_TOOL_NAMES.length, 6);
    assert.deepEqual(
      [...ALLOWED_TOOL_NAMES].sort(),
      [
        "novel_generate_chapter",
        "novel_plan_story_outline",
        "novel_preflight_workspace",
        "novel_strategy_feedback",
        "novel_strategy_policy_view",
        "novel_workspace_manager",
      ].sort(),
    );
  });

  test("filterToWhitelist 保留白名单工具，丢弃其余", () => {
    const tools: ToolLike[] = [
      ...SIX_NOVEL_TOOLS,
      { name: "shell" },
      { name: "novel_unknown_tool" },
      { name: "execute_code" },
    ];
    const result = filterToWhitelist(tools);
    assert.equal(result.allowed.length, 6);
    assert.equal(result.dropped.length, 1); // novel_unknown_tool
    assert.equal(result.dropped[0].name, "novel_unknown_tool");
    // shell 命中 /^shell$/、execute_code 命中 /^exec/，两者都进入 forbidden
    assert.equal(result.forbidden.length, 2);
    assert.deepEqual(
      result.forbidden.map((f) => f.tool.name).sort(),
      ["execute_code", "shell"],
    );
  });

  test("禁止能力模式检测", () => {
    const forbidden: ToolLike[] = [
      { name: "shell" },
      { name: "bash" },
      { name: "exec_node" },
      { name: "eval" },
      { name: "run_command" },
      { name: "git_commit" },
      { name: "file_read" },
      { name: "fs_write" },
      { name: "read_file" },
      { name: "write_file" },
      { name: "delete_file" },
      { name: "install_plugin" },
      { name: "mcp_call" },
      { name: "plugin_load" },
      { name: "fetch_url" },
      { name: "http_get" },
      { name: "url_open" },
      { name: "network_scan" },
      { name: "system_exec" },
      { name: "process_kill" },
      { name: "cmd_run" },
      { name: "command_exec" },
    ];
    for (const tool of forbidden) {
      assert.ok(isForbiddenToolName(tool.name), `expected '${tool.name}' to be forbidden`);
    }
  });

  test("禁止工具即使试图伪装成 novel_ 前缀也拒绝", () => {
    const disguised: ToolLike[] = [
      { name: "novel_shell_escape" }, // 不命中模式（shell 在中间），但不在白名单
      { name: "novel_run_arbitrary" }, // 不命中 run_ 模式（前缀 novel_）
    ];
    const result = filterToWhitelist(disguised);
    // 都不在白名单，进入 dropped
    assert.equal(result.dropped.length, 2);
    assert.equal(result.forbidden.length, 0);
  });

  test("assertStrictWhitelist 通过：恰好 6 个白名单工具", () => {
    const result = assertStrictWhitelist(SIX_NOVEL_TOOLS);
    assert.equal(result.allowed.length, 6);
    assert.equal(result.forbidden.length, 0);
    assert.equal(result.dropped.length, 0);
  });

  test("assertStrictWhitelist fail closed：工具数少于 6", () => {
    const partial = SIX_NOVEL_TOOLS.slice(0, 5);
    assert.throws(
      () => assertStrictWhitelist(partial),
      (err: unknown) => {
        assert.ok(err instanceof WhitelistViolationError);
        assert.equal(err.code, "WHITELIST_COUNT_MISMATCH");
        return true;
      },
    );
  });

  test("assertStrictWhitelist fail closed：工具数多于 6（含禁止能力）", () => {
    const withShell = [...SIX_NOVEL_TOOLS, { name: "shell" } as ToolLike];
    assert.throws(
      () => assertStrictWhitelist(withShell),
      (err: unknown) => {
        assert.ok(err instanceof WhitelistViolationError);
        assert.equal(err.code, "FORBIDDEN_TOOL_DETECTED");
        return true;
      },
    );
  });

  test("assertStrictWhitelist fail closed：缺失某个白名单工具", () => {
    // 缺 novel_strategy_feedback
    const missingOne = SIX_NOVEL_TOOLS.filter((t) => t.name !== "novel_strategy_feedback");
    // 补一个非白名单工具凑数 6 个
    const withExtra = [...missingOne, { name: "novel_unknown_extra" } as ToolLike];
    assert.throws(
      () => assertStrictWhitelist(withExtra),
      (err: unknown) => {
        assert.ok(err instanceof WhitelistViolationError);
        assert.equal(err.code, "WHITELIST_COUNT_MISMATCH");
        assert.ok(err.message.includes("novel_strategy_feedback"), "missing tool name in error");
        return true;
      },
    );
  });

  test("isAllowedTool 路由层校验", () => {
    assert.equal(isAllowedTool("novel_generate_chapter"), true);
    assert.equal(isAllowedTool("novel_preflight_workspace"), true);
    assert.equal(isAllowedTool("shell"), false);
    assert.equal(isAllowedTool("novel_unknown"), false);
    assert.equal(isAllowedTool(""), false);
  });
});
