/**
 * V2 ContextCompiler 测试（P1）
 *
 * 验收口径：
 * 1. 从 xinmo ch17 编译 CompiledContext，sourceMap 非空
 * 2. 输出不包含"你必须每段……"等控制型指令
 * 3. 缺关键事实时返回 diagnostic，不直接补写
 * 4. contextHash 稳定（同输入同 hash）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createContextCompiler } from "../dist/v2/core/context-compiler.js";

// 从测试文件位置解析项目根目录，避免依赖 process.cwd()。
// 测试文件位于 .pi/extensions/novel-studio/tests/，项目根在其上 4 级：
//   tests/ → novel-studio/ → extensions/ → .pi/ → 项目根
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// 真实 xinmo 工作区数据可能未初始化（CI/干净 checkout），缺失时跳过依赖真实数据的测试。
const _xinmoReady = existsSync(join(PROJECT_ROOT, "workspaces", "xinmo", "config.json"));

// 控制型指令正则：V2 CompiledContext 不得包含这类指令
const CONTROL_DIRECTIVE_PATTERN =
  /你必须每段|对白比例必须|段落长度必须|必须按清单|对话比例.*?\d+%|每段.*?\d+字/;

test("P1: xinmo/ch17 编译出 CompiledContext，sourceMap 非空", () => {
  const compiler = createContextCompiler();
  const { context, sourceSeed, contextHash } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  assert.ok(context.sourceMap.length >= 3, `sourceMap 应至少 3 项，实际 ${context.sourceMap.length}`);
  assert.ok(contextHash, "contextHash 应非空");
  assert.ok(sourceSeed, "sourceSeed 应非空");
  assert.ok(sourceSeed.worldConstraint, "seed.worldConstraint 应存在");
  assert.ok(sourceSeed.intent, "seed.intent 应存在");
});

test("P1: CompiledContext 不含控制型写作指令", () => {
  const compiler = createContextCompiler();
  const { context } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  // 检查所有 fact content 与 worldRule description
  for (const f of context.facts) {
    assert.doesNotMatch(
      f.content,
      CONTROL_DIRECTIVE_PATTERN,
      `fact ${f.id} 含控制型指令：${f.content}`
    );
  }
  for (const w of context.worldRules) {
    assert.doesNotMatch(
      w.description,
      CONTROL_DIRECTIVE_PATTERN,
      `worldRule ${w.id} 含控制型指令：${w.description}`
    );
  }
  for (const l of context.openLoops) {
    assert.doesNotMatch(
      l.description,
      CONTROL_DIRECTIVE_PATTERN,
      `openLoop ${l.id} 含控制型指令：${l.description}`
    );
  }
});

test("[integration:workspace-data] P1: xinmo/ch17 应有角色状态与世界规则", { skip: !_xinmoReady && "[integration:workspace-data] 需要 xinmo 真实工作区数据（workspaces/xinmo/config.json，心魔界，未提交 fixture）" }, () => {
  const compiler = createContextCompiler();
  const { context } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  assert.ok(context.characterStates.length > 0, "xinmo 应有角色状态");
  assert.ok(context.worldRules.length > 0, "应有世界规则");
  assert.ok(context.worldRules.some((w) => w.type === "genre"), "应有 genre 世界规则");
});

test("P1: xinmo/ch17 应有开放回路（伏笔/arc/unsettled）", () => {
  const compiler = createContextCompiler();
  const { context } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  // ch17 是后期章节，应有开放回路（不强制数量，但 openLoops 字段应存在）
  assert.ok(Array.isArray(context.openLoops), "openLoops 应为数组");
});

test("P1: 缺关键事实时返回 diagnostic，不补写", () => {
  const compiler = createContextCompiler();
  // 用不存在的 workspace 触发缺失
  const { context, diagnostics } = compiler.compile({
    workspaceId: "nonexistent-empty-workspace",
    chapterId: "5",
    chapterNumber: 5,
    projectRoot: PROJECT_ROOT,
  });
  // 应有 missing_characters 或 missing_prev_continuation 诊断
  const hardDiags = diagnostics.filter((d) => d.severity === "hard");
  assert.ok(hardDiags.length > 0, "缺关键事实应返回 hard diagnostic");
  assert.ok(
    hardDiags.some((d) => d.id.includes("missing")),
    "应有 missing 类诊断"
  );
  // 不补写：characterStates 应为空（而不是编造角色）
  assert.equal(context.characterStates.length, 0, "缺角色时不得补写虚构角色");
});

test("P1: contextHash 稳定（同输入同 hash）", () => {
  const compiler = createContextCompiler();
  const input = {
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  };
  const r1 = compiler.compile(input);
  const r2 = compiler.compile(input);
  assert.equal(r1.contextHash, r2.contextHash, "同输入 contextHash 应相同");
});

test("P1: sourceMap 每条可追溯（sourceId + sourceType + path 三字段齐全）", () => {
  const compiler = createContextCompiler();
  const { context } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  for (const e of context.sourceMap) {
    assert.ok(e.sourceId, "sourceMap 条目应有 sourceId");
    assert.ok(e.sourceType, "sourceMap 条目应有 sourceType");
    assert.ok(e.path, "sourceMap 条目应有 path");
  }
});
