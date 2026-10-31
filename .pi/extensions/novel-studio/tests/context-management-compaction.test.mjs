/**
 * 上下文管理执行规范回归（AGENTS.md「上下文管理执行规范」第 3 条）
 *
 * 覆盖：
 * 1. digestToolResultText：远轮工具结果压缩为首行摘要 + 显式省略行数
 * 2. compactToolHistory：最近 TOOL_HISTORY_KEEP_FULL 条保留全文，更早只留摘要
 * 3. buildUserPromptWithContext：回灌文本只含压缩后历史，并声明压缩条数
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_HISTORY_KEEP_FULL,
  TOOL_HISTORY_DIGEST_MAX_CHARS,
  compactToolHistory,
  digestToolResultText,
  buildUserPromptWithContext,
} from "../dist/novelos/adapters/pi-agent-core-adapter.js";
import { createReactTextAdapter } from "../dist/novelos/protocol/adapters/react-text-adapter.js";

/** 构造一条多行工具结果 */
function makeResult(id, firstLine, detailLines = 2) {
  const lines = [firstLine];
  for (let i = 1; i <= detailLines; i++) {
    lines.push(`明细第 ${i} 行：第 ${id} 次检索的详情长文本。`);
  }
  return {
    toolCallId: `call-${id}`,
    toolName: "narrative_search",
    content: [{ type: "text", text: lines.join("\n") }],
    details: { sourceRef: `ref-${id}`, resultKind: "evidence", returnedCount: 1 },
    isError: false,
  };
}

test("digestToolResultText 只保留首行并声明省略行数", () => {
  const text = "找到 3 条证据\n明细一\n明细二";
  const digest = digestToolResultText(text);
  assert.ok(digest.startsWith("找到 3 条证据"), "首行摘要必须保留");
  assert.ok(digest.includes("省略 2 行明细"), "必须显式声明省略行数");
  assert.ok(!digest.includes("明细一\n"), "明细行不得进入摘要");
});

test("digestToolResultText 按上限截断首行", () => {
  const longLine = "长".repeat(TOOL_HISTORY_DIGEST_MAX_CHARS + 50);
  const digest = digestToolResultText(longLine);
  assert.equal(digest, `${"长".repeat(TOOL_HISTORY_DIGEST_MAX_CHARS)}…`);
});

test("digestToolResultText 对空文本给出显式占位", () => {
  assert.equal(digestToolResultText("   "), "（早期工具结果无文本内容）");
});

test("compactToolHistory 近期全文、早期摘要，details 不丢失", () => {
  const results = Array.from({ length: TOOL_HISTORY_KEEP_FULL + 3 }, (_, i) =>
    makeResult(i, `第 ${i} 次检索：找到 ${i} 条证据`),
  );

  const { results: compacted, summary } = compactToolHistory(results);

  assert.equal(compacted.length, results.length, "条数不变，只压缩文本");
  assert.deepEqual(summary, { keptFull: TOOL_HISTORY_KEEP_FULL, summarized: 3 });

  // 早期结果：只有摘要行
  assert.ok(compacted[0].content[0].text.includes("省略 2 行明细"));
  assert.ok(!compacted[0].content[0].text.includes("明细第 1 行"));

  // 近期结果：全文保留
  const last = compacted[compacted.length - 1];
  assert.ok(last.content[0].text.includes("明细第 2 行"), "最近结果必须保留全文");

  // 结构化 details 原样保留（来源引用不因压缩丢失）
  assert.equal(compacted[0].details.sourceRef, "ref-0");
  assert.equal(last.details.sourceRef, `ref-${results.length - 1}`);
});

test("compactToolHistory 少于保留窗口时不压缩", () => {
  const results = Array.from({ length: 3 }, (_, i) => makeResult(i, `第 ${i} 次检索`));
  const { results: compacted, summary } = compactToolHistory(results);
  assert.deepEqual(summary, { keptFull: 3, summarized: 0 });
  assert.equal(compacted[2].content[0].text, results[2].content[0].text);
});

test("compactToolHistory 支持显式窗口与摘要长度", () => {
  const results = Array.from({ length: 2 }, (_, i) => makeResult(i, `第 ${i} 次检索`));
  const { summary } = compactToolHistory(results, { keepFull: 0, digestMaxChars: 5 });
  assert.deepEqual(summary, { keptFull: 0, summarized: 2 });
});

test("buildUserPromptWithContext 回灌压缩历史并声明压缩条数", () => {
  const adapter = createReactTextAdapter();
  const overflow = TOOL_HISTORY_KEEP_FULL + 2;
  const messages = [{ role: "user", content: "请生成本章正文" }];
  for (let i = 0; i < overflow; i++) {
    const r = makeResult(i, `第 ${i} 次检索：找到 ${i} 条证据`);
    messages.push({
      role: "toolResult",
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      content: r.content,
      details: r.details,
      isError: false,
    });
  }

  const prompt = buildUserPromptWithContext({ messages }, adapter);

  assert.ok(prompt.startsWith("请生成本章正文"), "用户输入必须完整保留");
  assert.ok(prompt.includes("上下文压缩：2 条更早的工具结果仅保留摘要行"), "必须显式声明压缩条数");
  assert.ok(prompt.includes("第 0 次检索"), "早期结果的摘要行仍需回灌");
  assert.ok(!prompt.includes("明细第 1 行：第 0 次检索的详情长文本。"), "早期明细不得逐轮重灌");
  assert.ok(prompt.includes("明细第 1 行：第 7 次检索的详情长文本。"), "最近结果保留全文");
});
