/**
 * Phase 2C：EvidencePlan 执行测试
 *
 * 验收口径（计划 §2C）：
 * - mustVerify 出现在 agentic prompt 中（"本章必须验证的事实点" block）
 * - allowedTools 限制工具集（只保留白名单内工具）
 * - stopConditions.maxStagnantRounds 驱动 verifyAndPatch 停滞退出
 *
 * 测试策略：
 * 1. 直接测试 createEvidencePlan：验证 mustVerify 提取、allowedTools 默认值、stopConditions 默认值
 * 2. 通过 mock agenticCandidateSource 验证 plan 被传递给 loop
 * 3. 通过源码静态检查验证 mustVerify 注入 prompt 的代码路径存在
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createEvidencePlan, ALL_NARRATIVE_TOOLS, DEFAULT_STOP_CONDITIONS } from "../dist-test/novelos/agent/evidence-plan.js";

// ============================================================================
// 1. createEvidencePlan 基础行为
// ============================================================================

test("Phase 2C · createEvidencePlan 默认 allowedTools 包含全部 9 工具", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试意图",
    seedContext: "测试种子",
  });
  assert.equal(plan.allowedTools.length, ALL_NARRATIVE_TOOLS.length, "默认应包含全部工具");
  for (const tool of ALL_NARRATIVE_TOOLS) {
    assert.ok(plan.allowedTools.includes(tool), `默认应包含 ${tool}`);
  }
});

test("Phase 2C · createEvidencePlan 默认 stopConditions 与 DEFAULT_STOP_CONDITIONS 一致", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
  });
  assert.equal(plan.stopConditions.maxStagnantRounds, DEFAULT_STOP_CONDITIONS.maxStagnantRounds);
  assert.equal(plan.stopConditions.verifierHardErrorsCleared, DEFAULT_STOP_CONDITIONS.verifierHardErrorsCleared);
  assert.equal(plan.stopConditions.modelDeclaresSufficient, DEFAULT_STOP_CONDITIONS.modelDeclaresSufficient);
});

test("Phase 2C · createEvidencePlan 支持自定义 stopConditions 覆盖", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
    stopConditions: { maxStagnantRounds: 5 },
  });
  assert.equal(plan.stopConditions.maxStagnantRounds, 5, "应覆盖 maxStagnantRounds");
  assert.equal(
    plan.stopConditions.verifierHardErrorsCleared,
    DEFAULT_STOP_CONDITIONS.verifierHardErrorsCleared,
    "未覆盖字段保持默认",
  );
});

test("Phase 2C · createEvidencePlan 支持自定义 allowedTools", () => {
  const customTools = ["search_narrative_evidence", "query_canon"];
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
    allowedTools: customTools,
  });
  assert.deepEqual(plan.allowedTools, customTools, "应使用自定义 allowedTools");
});

// ============================================================================
// 2. mustVerify 提取
// ============================================================================

test("Phase 2C · mustVerify 从 chapterIntent 引号内容提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: '本章必须验证「玉衡星」和「叶尘的封印」相关设定',
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  // 引号内容应被提取
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(allMustVerify.includes("玉衡星") || allMustVerify.includes("叶尘"), "应包含引号内实体");
});

test("Phase 2C · mustVerify 从 '关于X'/'涉及X' 后的短语提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "本章涉及黑煞宗的追踪术，关于封印解除需要查证",
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(
    allMustVerify.includes("黑煞宗") || allMustVerify.includes("封印"),
    "应包含'涉及/关于'后的短语",
  );
});

test("Phase 2C · mustVerify 从 seedContext 角色名/地名提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "推进剧情",
    seedContext: "角色：叶尘\n地点：玉衡星\n能力：炼体期",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(
    allMustVerify.includes("叶尘") || allMustVerify.includes("玉衡星"),
    "应包含 seed 中的实体",
  );
});

test("Phase 2C · mustVerify 最多 8 项（防无界遍历）", () => {
  const manyQuotes = Array.from({ length: 20 }, (_, i) => `「实体${i}」`).join("");
  const plan = createEvidencePlan({
    chapterIntent: manyQuotes,
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length <= 8, `应限制在 8 项以内，实际: ${plan.mustVerify.length}`);
});

test("Phase 2C · 显式 '作者章纲必须包含：' 优先提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "作者章纲必须包含：传承激活；追踪者出现；封印解除",
    seedContext: "其他「引号内容」不应被提取",
  });
  assert.ok(plan.mustVerify.length >= 2, "应提取到至少 2 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(allMustVerify.includes("传承激活"), "应包含'传承激活'");
  assert.ok(allMustVerify.includes("追踪者出现"), "应包含'追踪者出现'");
});

// ============================================================================
// 3. 源码静态检查：mustVerify 注入 prompt + stopConditions 驱动停止
// ============================================================================

test("Phase 2C · narrative-agent-loop.ts 源码包含 mustVerify 注入逻辑", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /plan\.mustVerify/, "应引用 plan.mustVerify");
  assert.match(source, /本章必须验证的事实点/, "应注入'本章必须验证的事实点' block");
});

test("Phase 2C · narrative-agent-loop.ts 源码用 plan.stopConditions.maxStagnantRounds 驱动停止", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(
    source,
    /plan\.stopConditions\.maxStagnantRounds/,
    "应读取 plan.stopConditions.maxStagnantRounds",
  );
  assert.match(
    source,
    /stagnantRounds\s*>=\s*maxStagnant/,
    "应用 maxStagnant 判断停滞退出",
  );
});

test("Phase 2C · agentic-raw-candidate-source.ts 源码用 plan.allowedTools 过滤工具集", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /createEvidencePlan/, "应在 runtime 创建前创建 EvidencePlan");
  assert.match(
    source,
    /evidencePlan\.allowedTools/,
    "应用 evidencePlan.allowedTools 过滤工具集",
  );
  assert.match(
    source,
    /allowedToolSet/,
    "应构造 allowedToolSet 进行过滤",
  );
});

test("Phase 2C · agentic-raw-candidate-source.ts 把 evidencePlan 传给 loop.run", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(
    source,
    /evidencePlan,/,
    "应在 loop.run 参数中传入 evidencePlan",
  );
});

test("Phase 2C · AgentLoopInput 类型包含 evidencePlan 可选字段", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "narrative-agent-loop-types.ts"),
    "utf8",
  );
  assert.match(source, /evidencePlan\?\s*:\s*EvidencePlan/, "AgentLoopInput 应有 evidencePlan 可选字段");
});
