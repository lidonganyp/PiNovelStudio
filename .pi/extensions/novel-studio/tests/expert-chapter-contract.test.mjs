/**
 * 专家章节契约桥测试（EXPERT-GROUP-R14）
 *
 * 锁定「专家契约提案 → 校验 → 显式章纲」链路：
 * - 必需项布尔检查（缺项即 error，评分不能覆盖必需项）
 * - 硬事实 ID 必须已登记（禁止编造 FACT-99）
 * - 新书不得引用 PROMISE-*（promise_id_on_new_book）
 * - 无事件级契约时 toExplicitOutlineMarkdown 返回 null（拒绝编造事件）
 *
 * 依赖边界：只依赖 dist-test；真实链路校验只在临时目录写 fixture，不写任何 workspace。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExpertChapterContract,
  validateExpertChapterContract,
  toExplicitOutlineMarkdown,
} from "../dist-test/novelos/experts/chapter-contract-bridge.js";
import { parseExplicitOutline } from "../dist-test/craft/explicit-outline-parser.js";
import { buildChapterSeed } from "../dist-test/craft/chapter-seed-builder.js";

const BASE_CONTRACT = [
  "## 章节功能",
  "- chapterNumber: 12",
  "- 职能：推进",
  "- 缺失后果：不写这章，师门线索就断了",
  "",
  "## 意图",
  "- 主意图：主角第一次主动追查师门线索",
  "- 次意图：揭开笔记少一页的部分真相",
  "- 关键词：师门、笔记、主动",
  "",
  "## 不可违背事实",
  "| 类型 | ID | 内容 | 违反后果 |",
  "|---|---|---|---|",
  "| FACT | FACT-03 | 复苏之眼每日唤醒一次 | 世界观硬冲突 → FactGuard 阻断 |",
  "| OOC | OOC-02 | 林默不会出卖同伴 | 角色失真 |",
  "",
  "## 章末目标",
  "- 读者状态：读者应意识到苏雨一直在隐瞒",
  "- 主角位置：主角从被动挨打转为主动布局",
  "- 新问题：笔记为何少一页",
  "- 强制召回：无",
  "",
  "## 缺口自检",
  "| 项目 | 是否齐备 | 缺失时补什么 |",
  "|---|---|---|",
  "| 方向 | 是 | — |",
  "| 冲突 | 是 | — |",
  "| 状态 | 是 | — |",
  "",
  "status: ready",
].join("\n");

const EVENTS_BLOCK = [
  "",
  "## 事件",
  "### 事件 1：藏书阁受阻",
  "- **参与角色**：林默、守门人",
  "- **必须包含**：守门人索要身份令牌",
  "- **内容摘要**：林默被拦在藏书阁门外",
  "- **事件结果**：林默决定夜间潜入",
].join("\n");

test("完整契约：必需项齐全时 ok，且评分不参与判定", () => {
  const proposal = parseExpertChapterContract(BASE_CONTRACT);
  assert.equal(proposal.chapterNumber, 12);
  assert.equal(proposal.chapterFunction, "推进");
  assert.equal(proposal.primaryIntent, "主角第一次主动追查师门线索");
  assert.equal(proposal.facts.length, 2);
  assert.equal(proposal.gapStatus, "ready");

  const result = validateExpertChapterContract(proposal, { knownFactIds: ["FACT-03", "OOC-02"], knownPromiseIds: [] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("缺必需项必须 error；评分不能覆盖必需项", () => {
  const broken = BASE_CONTRACT
    .replace("- 主意图：主角第一次主动追查师门线索", "- 主意图：")
    .replace("- 读者状态：读者应意识到苏雨一直在隐瞒", "- 读者状态：")
    .concat("\n\n总分：9");

  const proposal = parseExpertChapterContract(broken);
  const result = validateExpertChapterContract(proposal, { knownFactIds: ["FACT-03", "OOC-02"], knownPromiseIds: [] });
  assert.equal(result.ok, false);
  const codes = result.errors.map((issue) => issue.code);
  assert.ok(codes.includes("primary_intent_missing"));
  assert.ok(codes.includes("ending_reader_state_missing"));
  assert.equal(result.scoreAdvisory, 9);
  assert.ok(result.warnings.some((issue) => issue.code === "score_cannot_override_required_items"));
});

test("blocked 与缺 status 都阻断生成", () => {
  const blocked = BASE_CONTRACT.replace("status: ready", "status: blocked");
  const proposal = parseExpertChapterContract(blocked);
  const result = validateExpertChapterContract(proposal);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.code === "gap_status_blocked"));

  const noStatus = BASE_CONTRACT.replace("status: ready", "");
  const proposal2 = parseExpertChapterContract(noStatus);
  const result2 = validateExpertChapterContract(proposal2);
  assert.ok(result2.errors.some((issue) => issue.code === "gap_status_missing"));
});

test("编造 ID 被拒绝：FACT-99 与 PROMISE-01（新书）", () => {
  const fabricated = BASE_CONTRACT
    .replace("| FACT | FACT-03 |", "| FACT | FACT-99 |")
    .replace("- 强制召回：无", "- 强制召回：PROMISE-01");
  const proposal = parseExpertChapterContract(fabricated);
  const result = validateExpertChapterContract(proposal, { knownFactIds: ["FACT-03", "OOC-02"], knownPromiseIds: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.code === "fabricated_fact_id"));
  assert.ok(result.errors.some((issue) => issue.code === "promise_id_on_new_book"));
});

test("无事件级契约返回 null；有事件时转换为显式章纲", () => {
  const proposal = parseExpertChapterContract(BASE_CONTRACT);
  assert.equal(toExplicitOutlineMarkdown(proposal), null);

  const withEvents = parseExpertChapterContract(`${BASE_CONTRACT}\n${EVENTS_BLOCK}`);
  assert.equal(withEvents.events.length, 1);
  assert.equal(withEvents.events[0].title, "藏书阁受阻");
  assert.deepEqual(withEvents.events[0].characters, ["林默", "守门人"]);
  assert.equal(withEvents.events[0].eventResult, "林默决定夜间潜入");

  const markdown = toExplicitOutlineMarkdown(withEvents);
  assert.ok(markdown.includes("## 章节定位"));
  assert.ok(markdown.includes("- **本章功能**：推进"));
  assert.ok(markdown.includes("### 事件 1：藏书阁受阻"));
  assert.ok(markdown.includes("- **事件结果**：林默决定夜间潜入"));

  const requireEvents = validateExpertChapterContract(proposal, { requireEvents: true });
  assert.ok(requireEvents.errors.some((issue) => issue.code === "events_required"));
});

test("R14 · 专家提案经真实解析器与 Seed 构建器后，事实/事件/章末目标实际到达", () => {
  const withEvents = parseExpertChapterContract(`${BASE_CONTRACT}\n${EVENTS_BLOCK}`);
  const validated = validateExpertChapterContract(withEvents, {
    knownFactIds: ["FACT-03", "OOC-02"],
    knownPromiseIds: [],
    requireEvents: true,
  });
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));

  const markdown = toExplicitOutlineMarkdown(withEvents);
  assert.ok(markdown);

  // 1) 现有唯一解析器必须能消费桥接产物
  const parsed = parseExplicitOutline(markdown);
  assert.equal(parsed.parseError, null, "桥接产物不得被现有解析器判为解析失败");
  assert.equal(parsed.outlineEventCount, 1);
  assert.equal(parsed.events[0].title, "藏书阁受阻");
  assert.deepEqual(parsed.events[0].characters, ["林默", "守门人"]);
  assert.ok(parsed.events[0].mandatoryElements.includes("守门人索要身份令牌"));
  assert.equal(parsed.events[0].summary, "林默被拦在藏书阁门外");

  // 2) 现有 Seed 构建器必须把显式章纲转成 authorChapterContract
  const workspacePath = mkdtempSync(join(tmpdir(), "expert-contract-"));
  try {
    mkdirSync(join(workspacePath, "series"), { recursive: true });
    writeFileSync(join(workspacePath, "series", "ch12-outline-explicit.md"), markdown, "utf8");
    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: "temp-workspace",
      chapterId: "ch12",
      chapterNumber: 12,
    });
    const contract = seed.authorChapterContract;
    assert.equal(contract.available, true);
    assert.equal(contract.chapterFunction, "推进");
    assert.ok(contract.mustInclude.includes("守门人索要身份令牌"));
    assert.ok(contract.eventSummaries.includes("林默被拦在藏书阁门外"));
    assert.ok(contract.relevantCharacters.includes("林默"));
    assert.ok(contract.relevantCharacters.includes("守门人"));
    assert.match(String(contract.endingTarget), /笔记为何少一页/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
