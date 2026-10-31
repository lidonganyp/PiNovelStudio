/**
 * 专家群注册表测试（EXPERT-GROUP-R10/R11/R12/R13/R18）
 *
 * 锁定 `.pi/agents/*.md` 的加载契约：
 * - frontmatter 省略 `model`（写 `model: inherit` 必须被拒绝）
 * - tools 只允许实际注册名（小写只读工具 + 除生成入口外的 novel_*）
 * - knowledge 路径形如 `<role>/knowledge/<file>.md` 且可解析
 * - 正文五要素【角色】【指令】【约束】【示例】【输出格式】齐全且顺序固定
 * - 读取边界：`.env` / `chapters/` / `narrative-state-store.json` / 目录外路径一律拒绝
 *
 * 依赖边界：只依赖 dist-test（专家群模块不进生产闭包）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPERT_PROMPT_SECTIONS,
  EXPERT_FORBIDDEN_TOOLS,
  EXPERT_WRITE_TOOLS,
  EXPERT_ALLOWED_ACTIONS,
  loadExpertRegistry,
  checkExpertToolAllowed,
  checkExpertReadPath,
} from "../dist-test/novelos/experts/expert-registry.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(TESTS_DIR, "../../../agents");

test("真实 agents 目录：10 个专家、零 error、五要素齐全", () => {
  const registry = loadExpertRegistry(AGENTS_DIR);
  assert.equal(registry.ok, true, `注册表存在 error：${JSON.stringify(registry.issues.filter((i) => i.severity === "error"))}`);
  assert.equal(registry.experts.length, 10);

  const errors = registry.issues.filter((issue) => issue.severity === "error");
  assert.deepEqual(errors, []);

  for (const expert of registry.experts) {
    for (const section of EXPERT_PROMPT_SECTIONS) {
      assert.ok(expert.promptSections[section]?.trim(), `${expert.name} 缺少【${section}】`);
    }
    assert.equal(expert.model, null, `${expert.name} 不应写 model 字段`);
    assert.equal(expert.knowledge.length, 1, `${expert.name} 应恰好声明 1 份领域资料`);
    assert.match(expert.knowledge[0].declared, new RegExp(`^${expert.name}/knowledge/[^/]+\\.md$`));
    for (const tool of expert.tools) {
      assert.ok(!(EXPERT_FORBIDDEN_TOOLS).includes(tool), `${expert.name} 不得持有 ${tool}`);
    }
  }
});

test("每个专家都不得持有 novel_generate_chapter 与写权限工具", () => {
  const registry = loadExpertRegistry(AGENTS_DIR);
  for (const expert of registry.experts) {
    assert.equal(checkExpertToolAllowed(expert, "novel_generate_chapter").ok, false);
    assert.equal(checkExpertToolAllowed(expert, "write").ok, false);
    for (const tool of expert.tools) {
      // 带子操作的工具必须配合白名单内的只读 action 才放行。
      const action = EXPERT_ALLOWED_ACTIONS[tool] ? [...EXPERT_ALLOWED_ACTIONS[tool]][0] : undefined;
      assert.equal(checkExpertToolAllowed(expert, tool, action).ok, true, `${expert.name} 的 ${tool} 应被允许`);
    }
  }
});

test("action 级权限：写入工具一律拒绝，workspace_manager 只放行只读 action", () => {
  const registry = loadExpertRegistry(AGENTS_DIR);
  const director = registry.require("novel-director");

  // 真实定义里不得再声明写入工具（novel_plan_story_outline / novel_strategy_feedback）。
  const declaredTools = registry.experts.flatMap((expert) => expert.tools);
  for (const writeTool of EXPERT_WRITE_TOOLS) {
    assert.ok(!declaredTools.includes(writeTool), `专家定义不得声明写入工具 ${writeTool}`);
    const denied = checkExpertToolAllowed(director, writeTool);
    assert.equal(denied.ok, false, `${writeTool} 必须被拒绝`);
  }

  // novel_workspace_manager：只读/零写入 action 放行，写入/状态 action fail-closed。
  const allowedActions = EXPERT_ALLOWED_ACTIONS.novel_workspace_manager;
  for (const action of allowedActions) {
    assert.equal(
      checkExpertToolAllowed(director, "novel_workspace_manager", action).ok,
      true,
      `action=${action} 应被允许`,
    );
  }
  for (const action of [
    "init",
    "switch",
    "proxy_finalization",
    "proxy_review",
    "ingest_reader_feedback",
    "record_return_chapter",
    "handoff_chapter_contract",
  ]) {
    const denied = checkExpertToolAllowed(director, "novel_workspace_manager", action);
    assert.equal(denied.ok, false, `action=${action} 应被拒绝`);
    assert.equal(denied.code, "tool_action_not_allowed");
  }

  // 未声明 action 时不能默认放行。
  const missingAction = checkExpertToolAllowed(director, "novel_workspace_manager");
  assert.equal(missingAction.ok, false);
  assert.equal(missingAction.code, "tool_action_required");
});

test("读取边界：.env / chapters / 长期状态 / 目录外路径全部拒绝", () => {
  const agentsDir = AGENTS_DIR;
  const cases = [
    { path: resolve(agentsDir, "../.env"), code: "path_env_denied" },
    { path: resolve(agentsDir, "..", "workspaces", "w01", "chapters", "ch001.md"), code: "path_scope_denied" },
    { path: resolve(agentsDir, "..", "workspaces", "w01", "narrative-state-store.json"), code: "path_state_denied" },
    { path: resolve(agentsDir, "..", "config", "model-routing.json"), code: "path_state_denied" },
  ];
  for (const item of cases) {
    const result = checkExpertReadPath(item.path, { agentsDir });
    assert.equal(result.ok, false, `${item.path} 应被拒绝`);
    assert.equal(result.code, item.code);
  }
  const allowed = checkExpertReadPath(resolve(agentsDir, "novel-director/knowledge/director-playbook.md"), { agentsDir });
  assert.equal(allowed.ok, true);
});

test("不合规模板必须报 error（model: inherit / 大写工具名 / 知识路径缺失）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinovel-expert-bad-"));
  try {
    mkdirSync(join(dir, "bad-role", "knowledge"), { recursive: true });
    writeFileSync(
      join(dir, "bad-role.md"),
      [
        "---",
        "name: bad-role",
        "description: 测试用",
        "model: inherit",
        "tools:",
        "  - Read",
        "  - Grep",
        "  - novel_plan_story_outline",
        "knowledge:",
        "  - bad-role/knowledge/missing.md",
        "---",
        "",
        "## 【角色】",
        "测试",
        "## 【指令】",
        "测试",
        "## 【约束】",
        "测试",
        "## 【示例】",
        "测试",
        "## 【输出格式】",
        "测试",
      ].join("\n"),
      "utf-8",
    );
    const registry = loadExpertRegistry(dir);
    const codes = registry.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
    assert.equal(registry.ok, false);
    assert.ok(codes.includes("expert_model_inherit_rejected"));
    assert.ok(codes.includes("expert_tool_unknown"));
    assert.ok(codes.includes("expert_tool_write_denied"));
    assert.ok(codes.includes("expert_knowledge_missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
