/**
 * outline-planner 生产 Prompt 五要素审计（AGENTS.md Prompt 编写规范）
 *
 * 锁定 novel_plan_story_outline 的两个模型调用分支：
 * - system 与 user 消息都按【角色】【指令】【约束】【示例】【输出格式】固定顺序组织；
 * - 不得回退到 `# 任务` / `# 用户创意` / `# 输出要求` 等旧小标题；
 * - 不得出现机械配额（对白比例、每段字数等）。
 *
 * 依赖边界：生产模块，直接从 dist/ 导入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTLINE_PROMPT_SECTIONS,
  buildChapterOutlinePrompts,
  buildFullOutlinePrompts,
} from "../dist/craft/outline-planner.js";
import { auditPrompt } from "../dist/v2/core/prompt-constraint-audit.js";

const LEGACY_HEADINGS = [
  "# 任务",
  "# 用户创意",
  "# 输出要求",
  "# Workspace 配置",
  "# 单章总纲段落",
  "# 严格输出格式",
];

function assertFiveSections(text, label) {
  const positions = OUTLINE_PROMPT_SECTIONS.map((section) => {
    const marker = `【${section}】`;
    const index = text.indexOf(marker);
    assert.ok(index >= 0, `${label} 缺少 ${marker}`);
    return index;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i] > positions[i - 1],
      `${label} 五要素顺序错误：【${OUTLINE_PROMPT_SECTIONS[i]}】必须位于【${OUTLINE_PROMPT_SECTIONS[i - 1]}】之后`,
    );
  }
}

function assertNoLegacyHeadings(text, label) {
  for (const heading of LEGACY_HEADINGS) {
    assert.ok(!text.includes(heading), `${label} 仍包含旧小标题 ${heading}`);
  }
}

function assertNotControlPrompt(systemPrompt, userPrompt, label) {
  const audit = auditPrompt(systemPrompt, userPrompt);
  assert.equal(
    audit.containsMechanicalMetric,
    false,
    `${label} 命中机械配额（${JSON.stringify(audit)}）`,
  );
}

test("总纲生成：system 与 user 均符合五要素顺序", () => {
  const { systemPrompt, userPrompt } = buildFullOutlinePrompts({
    idea: "都市悬疑：主角被卷入连环失踪案",
    totalChapters: 12,
    configSummary: "类型：都市悬疑；读者承诺：强悬念与反转。",
  });

  assertFiveSections(systemPrompt, "full-outline.system");
  assertFiveSections(userPrompt, "full-outline.user");
  assertNoLegacyHeadings(systemPrompt, "full-outline.system");
  assertNoLegacyHeadings(userPrompt, "full-outline.user");
  assert.equal(auditPrompt(systemPrompt, userPrompt).containsControlChecklist, false);
  assertNotControlPrompt(systemPrompt, userPrompt, "full-outline");

  // 作者输入与配置必须进入【指令】资料区，且章节数写入任务。
  assert.ok(userPrompt.includes("都市悬疑：主角被卷入连环失踪案"));
  assert.ok(userPrompt.includes("类型：都市悬疑"));
  assert.ok(userPrompt.includes("12 章"));
});

test("章纲拆分：system 与 user 均符合五要素顺序", () => {
  const { systemPrompt, userPrompt } = buildChapterOutlinePrompts({
    chapterNumber: 3,
    eventCount: 4,
    chapterSection: "## 第3章：旧案重启——主角发现失踪案与十年前的旧案同源。",
    configSummary: "类型：都市悬疑；读者承诺：强悬念与反转。",
  });

  assertFiveSections(systemPrompt, "chapter-outline.system");
  assertFiveSections(userPrompt, "chapter-outline.user");
  assertNoLegacyHeadings(systemPrompt, "chapter-outline.system");
  assertNoLegacyHeadings(userPrompt, "chapter-outline.user");
  assertNotControlPrompt(systemPrompt, userPrompt, "chapter-outline");

  // 单章段落与配置必须进入资料区；事件模板字段必须保留，供 OutlineReadinessChecker 消费。
  assert.ok(userPrompt.includes("旧案重启"));
  assert.ok(userPrompt.includes("类型：都市悬疑"));
  for (const field of ["类型", "内容", "冲突等级", "情绪弧", "感知锚点", "参与角色", "伏笔埋设", "字数目标"]) {
    assert.ok(userPrompt.includes(`**${field}**`), `章纲输出模板缺少字段 ${field}`);
  }
  assert.ok(userPrompt.includes("#### 事件1：事件标题"));

  // AGENTS.md：不得用机械字数/句数配额诱导凑量；只保留下游解析必需的字段契约。
  for (const banned of ["不少于30字", "1-3 句", "模板字段不得省略或合并", "连续输出"]) {
    assert.ok(!userPrompt.includes(banned), `章纲 user prompt 不得含机械配额措辞：${banned}`);
  }
  assert.ok(
    userPrompt.includes("参考规模约 4 个"),
    "事件数量应为可增减的软参考，而不是固定配额",
  );
});
