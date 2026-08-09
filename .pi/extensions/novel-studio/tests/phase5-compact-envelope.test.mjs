/**
 * Phase 5 紧凑结果 envelope — renderCompactEnvelope 边界 focused 测试
 *
 * 覆盖 docs/phase4-tool-ab-test-design.md §10 的四类字段边界：
 * 1. 摘要（summary）：一行 ≤ ENVELOPE_SUMMARY_MAX_CHARS，含命中数/最高等级/最强 ref；
 *    空结果给「无匹配/无结果」。
 * 2. 来源（sourceRef）：只输出最强前 ENVELOPE_MAX_REFS 条 ref，不贴全文 excerpt。
 * 3. 证据等级（evidenceLevel）：每条 ref 前缀 [等级]，按证据强度排序。
 * 4. 继续查询提示（nextQueryHint）：仅 truncated=true 时透传；未截断不输出。
 *
 * 完整性底线：envelope 只剪裁「模型可见 content」；details 的 sourceRef/evidenceLevel/
 * resultKind/returnedCount/truncated/nextQueryHint 必须原样保留（由 facade execute 保证，
 * 本测试验证 renderCompactEnvelope 纯函数渲染边界）。
 *
 * 依赖边界：只依赖生产闭包（dist/），不依赖 eval-only 模块。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderCompactEnvelope,
  ENVELOPE_MAX_REFS,
  ENVELOPE_SUMMARY_MAX_CHARS,
  ENVELOPE_CONTENT_MAX_CHARS,
} from "../dist/novelos/tools/tool-protocol.js";

// ============================================================================
// 构造 details 的辅助
// ============================================================================

function makeDetails(overrides = {}) {
  return {
    sourceRef: "ch17#final.md:1-10",
    evidenceLevel: "confirmed",
    resultKind: "ranked_evidence",
    returnedCount: 3,
    truncated: false,
    nextQueryHint: null,
    rankedEvidences: [
      { sourceRef: "ch17#final.md:120-180", evidenceLevel: "exact_chapter_span" },
      { sourceRef: "canon:evt-003", evidenceLevel: "confirmed_state" },
      { sourceRef: "ch17#final.md:200-210", evidenceLevel: "confirmed" },
    ],
    ...overrides,
  };
}

// ============================================================================
// 1. 摘要边界
// ============================================================================

describe("PHASE5-COMPACT-ENVELOPE-1：摘要边界", () => {
  it("摘要含命中数 / 最高等级 / 最强 ref，且一行 ≤ 120 字符", () => {
    const text = renderCompactEnvelope(makeDetails());
    const firstLine = text.split("\n")[0];
    assert.ok(firstLine.length <= ENVELOPE_SUMMARY_MAX_CHARS, `摘要应 ≤ ${ENVELOPE_SUMMARY_MAX_CHARS} 字符`);
    assert.match(firstLine, /命中 3 条/);
    assert.match(firstLine, /confirmed_state/); // 最强等级
    assert.match(firstLine, /canon:evt-003/); // 最强 ref
  });

  it("空结果（returnedCount=0）给「无匹配/无结果」摘要", () => {
    const text = renderCompactEnvelope(
      makeDetails({ returnedCount: 0, rankedEvidences: [], resultKind: "no_match" }),
    );
    assert.match(text, /无匹配\/无结果/);
    assert.ok(!text.includes("命中"));
  });

  it("空条目（returnedCount=0 且无 rankedEvidences）归为无结果", () => {
    const text = renderCompactEnvelope(
      makeDetails({ returnedCount: 0, rankedEvidences: [], resultKind: "no_match" }),
    );
    assert.match(text, /无匹配\/无结果/);
    assert.ok(!text.includes("命中"));
  });
});

// ============================================================================
// 2. 来源边界：只输出最强前 ENVELOPE_MAX_REFS 条 ref
// ============================================================================

describe("PHASE5-COMPACT-ENVELOPE-2：来源边界（最多 N 条 ref）", () => {
  it("只输出最强前 ENVELOPE_MAX_REFS 条 ref，不贴全文 excerpt", () => {
    const text = renderCompactEnvelope(makeDetails());
    const lines = text.split("\n").filter((l) => l.startsWith("["));
    assert.equal(lines.length, ENVELOPE_MAX_REFS, `应有 ${ENVELOPE_MAX_REFS} 条 ref`);
    // 每条 ref 都必须是 [等级] ref 形式，不能是全文 excerpt
    for (const line of lines) {
      assert.match(line, /^\[(confirmed_state|exact_chapter_span|confirmed|inferred|profile_only)\] /);
    }
  });

  it("ref 数量受 min(returnedCount, ENVELOPE_MAX_REFS) 限制", () => {
    const text = renderCompactEnvelope(makeDetails({ returnedCount: 1 }));
    const lines = text.split("\n").filter((l) => l.startsWith("["));
    assert.equal(lines.length, 1, "returnedCount=1 时只应输出 1 条 ref");
  });
});

// ============================================================================
// 3. 证据等级边界：按强度排序，最强在前
// ============================================================================

describe("PHASE5-COMPACT-ENVELOPE-3：证据等级边界（强度排序）", () => {
  it("证据按 confirmed_state > exact_chapter_span > confirmed 排序，最强在前", () => {
    const text = renderCompactEnvelope(makeDetails());
    const lines = text.split("\n").filter((l) => l.startsWith("["));
    assert.match(lines[0], /^\[confirmed_state\] canon:evt-003/);
    assert.match(lines[1], /^\[exact_chapter_span\] ch17/);
    assert.match(lines[2], /^\[confirmed\] ch17/);
  });

  it("条目证据等级缺失时回退到 details.evidenceLevel", () => {
    const details = makeDetails();
    details.rankedEvidences = [
      { sourceRef: "ch17#final.md:300-320" }, // 无 evidenceLevel
    ];
    const text = renderCompactEnvelope(details);
    assert.match(text, /\[confirmed\] ch17#final\.md:300-320/);
  });
});

// ============================================================================
// 4. 继续查询提示边界：仅 truncated=true 时透传
// ============================================================================

describe("PHASE5-COMPACT-ENVELOPE-4：继续查询提示边界", () => {
  it("未截断（truncated=false）时不输出 nextQueryHint", () => {
    const details = makeDetails({ nextQueryHint: "换一个更精确的短语重查" });
    const text = renderCompactEnvelope(details);
    assert.ok(!text.includes("提示："), "未截断时不应输出继续查询提示");
  });

  it("截断（truncated=true）时透传系统生成的 nextQueryHint", () => {
    const details = makeDetails({ truncated: true, nextQueryHint: "可用「more precise」重查" });
    const text = renderCompactEnvelope(details);
    assert.ok(text.includes("提示：可用「more precise」重查"), "截断时应透传 hint");
  });

  it("截断但无 hint 时只出摘要与 ref，不补占位", () => {
    const details = makeDetails({ truncated: true, nextQueryHint: null });
    const text = renderCompactEnvelope(details);
    assert.ok(!text.includes("提示："), "无 hint 时不应输出占位提示");
  });
});

// ============================================================================
// 5. guard N4：returnedCount>0 但条目数组缺失时不得误报「无结果」
// ============================================================================

describe("PHASE5-COMPACT-ENVELOPE-5：guard N4（returnedCount>0 条目缺失不误报）", () => {
  it("returnedCount>0 但条目数组字段不在已知集内 → 只出摘要，不误报「无结果」", () => {
    // resultKind 的数组字段不在 rankedEvidences/spans/entries 已知集内（数据畸形/未知字段名）
    const text = renderCompactEnvelope({
      sourceRef: "ch17#final.md:1-10",
      evidenceLevel: "confirmed",
      resultKind: "custom_kind",
      returnedCount: 5,
      truncated: false,
      nextQueryHint: null,
      customItems: [{ sourceRef: "custom:1", evidenceLevel: "confirmed" }],
    });
    assert.ok(!text.includes("无匹配/无结果"), "returnedCount>0 不得误报「无结果」");
    assert.ok(text.includes("命中 5 条"), "应输出命中摘要（以 returnedCount 为权威）");
    assert.ok(!text.includes("[confirmed] custom:1"), "不得伪造未知字段的 ref 行");
  });

  it("returnedCount>0 但条目数组为空数组 → 有命中但无可提取条目，只出摘要", () => {
    const text = renderCompactEnvelope(
      makeDetails({ returnedCount: 3, rankedEvidences: [] }),
    );
    assert.ok(!text.includes("无匹配/无结果"), "有命中但空条目数组不得误报「无结果」");
    assert.ok(text.includes("命中 3 条"), "应输出命中摘要");
  });

  it("returnedCount 缺失但条目数组存在 -> 以条目数兜底", () => {
    const details = makeDetails();
    delete details.returnedCount;
    const text = renderCompactEnvelope(details);
    assert.ok(text.includes("命中 3 条"), "returnedCount 缺失时应以条目数兜底");
  });
});

// ============================================================================
// Phase 5.3.1 回归测试：envelope 内容摘要（防止 stopRate=0%、duplicateQueries 激增）
// ============================================================================

describe("PHASE5-3-1-ENVELOPE-CONTENT：内容摘要回归", () => {
  it("rankedEvidences 条目的 excerpt 出现在 ref 行中", () => {
    const details = {
      sourceRef: "ch1#final.md:10-20",
      evidenceLevel: "confirmed",
      resultKind: "ranked_evidence",
      returnedCount: 1,
      truncated: false,
      nextQueryHint: null,
      rankedEvidences: [
        { sourceRef: "ch1#final.md:10-20", evidenceLevel: "confirmed", excerpt: "老周说这水底有暗流" },
      ],
    };
    const text = renderCompactEnvelope(details);
    assert.ok(text.includes("老周说这水底有暗流"), "envelope 应包含 excerpt 内容摘要");
    assert.ok(text.includes("[confirmed] ch1#final.md:10-20"), "ref 行格式正确");
  });

  it("entries 条目的 value/field 出现在 ref 行中", () => {
    const details = {
      sourceRef: "narrative-state.json#characterUpdates",
      evidenceLevel: "confirmed",
      resultKind: "character_state",
      returnedCount: 1,
      truncated: false,
      nextQueryHint: null,
      entries: [
        { sourceRef: "narrative-state.json#characterUpdates", field: "desire", value: "想找到失踪的弟弟" },
      ],
    };
    const text = renderCompactEnvelope(details);
    assert.ok(text.includes("desire: 想找到失踪的弟弟"), "envelope 应包含 field: value 内容摘要");
  });

  it("canon entries 的 fact 出现在 ref 行中", () => {
    const details = {
      sourceRef: "canon:evt-003",
      evidenceLevel: "confirmed",
      resultKind: "canon_entries",
      returnedCount: 1,
      truncated: false,
      nextQueryHint: null,
      entries: [
        { sourceRef: "canon:evt-003", fact: "血玉是上古遗物" },
      ],
    };
    const text = renderCompactEnvelope(details);
    assert.ok(text.includes("血玉是上古遗物"), "envelope 应包含 fact 内容摘要");
  });

  it("内容摘要截断到 ENVELOPE_CONTENT_MAX_CHARS", () => {
    const longExcerpt = "A".repeat(200);
    const details = {
      sourceRef: "ch1#final.md:1-100",
      evidenceLevel: "confirmed",
      resultKind: "chapter_span",
      returnedCount: 1,
      truncated: false,
      nextQueryHint: null,
      spans: [
        { sourceRef: "ch1#final.md:1-100", excerpt: longExcerpt },
      ],
    };
    const text = renderCompactEnvelope(details);
    const aCount = text.match(/A/g)?.length ?? 0;
    assert.equal(aCount, ENVELOPE_CONTENT_MAX_CHARS, `内容摘要应截断到 ${ENVELOPE_CONTENT_MAX_CHARS} 字符`);
  });

  it("无内容字段的条目不附加内容摘要", () => {
    const details = {
      sourceRef: "unknown:1",
      evidenceLevel: "inferred",
      resultKind: "unknown",
      returnedCount: 1,
      truncated: false,
      nextQueryHint: null,
      entries: [
        { sourceRef: "unknown:1" },
      ],
    };
    const text = renderCompactEnvelope(details);
    assert.ok(!text.includes(" - "), "无内容时不应附加 ' - ' 分隔符");
  });
});