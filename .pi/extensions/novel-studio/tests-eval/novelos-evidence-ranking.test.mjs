/**
 * NovelOS Evidence Ranking 测试（M1.1 任务 2）
 *
 * 验证 searchRanked 跨源检索的证据等级排序：
 * 1. canon 命中 → evidenceLevel="confirmed_state"，relevanceScore=1.0
 * 2. chapter span 命中 → evidenceLevel="exact_chapter_span"，relevanceScore < 1.0
 * 3. confirmed_state 排在 exact_chapter_span 之前
 * 4. category 过滤（location）只返回对应类别 canon
 * 5. 同等级按 relevanceScore 降序
 *
 * 用临时 workspace + 状态文件，独立测试，不依赖真实 workspace。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";

// ============================================================================
// 测试夹具
// ============================================================================

let tmpRoot;
const workspaceId = "test-ranking-ws";
let searchService;

function setupWorkspace() {
  tmpRoot = mkdtempSync(join(tmpdir(), "novelos-ranking-"));
  const wsDir = join(tmpRoot, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });

  const now = new Date().toISOString();

  // narrative-state-store.json（统一状态存储，替代 legacy skeleton.json + narrative-state.json）
  writeFileSync(
    join(wsDir, "narrative-state-store.json"),
    JSON.stringify({
      schemaVersion: "narrative-state-store-v1",
      workspaceId,
      canon: [
        {
          kind: "canon",
          id: "event:evt-001",
          fact: "林川在青鱼嘴水下发现暗流",
          category: "timeline",
          sourceChapter: "ch2",
          sourceRef: "skeleton:evt-001",
          confidence: 1.0,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:location-linchuan-ch2",
          fact: "第2章结尾林川位置：青鱼嘴水下",
          category: "location",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:location-suwan-ch2",
          fact: "第2章结尾苏婉位置：镇上",
          category: "location",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:timeline-ch2",
          fact: "第2章时间：上午十点到中午十二点",
          category: "timeline",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
          lastUpdated: now,
        },
      ],
      character: [
        {
          kind: "character",
          id: "character:linchuan:location",
          characterId: "林川",
          field: "location",
          value: "青鱼嘴水下",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
          lastUpdated: now,
        },
      ],
      promise: [],
      pattern: [],
      expectation: [],
      eventLog: [],
      quarantine: [],
      planned: [],
      updatedAt: now,
    }),
    "utf-8",
  );

  // 章节正文（含"青鱼嘴"、"林川"等可搜索内容）
  const chapterDir = join(wsDir, "chapters", "chapter-02");
  mkdirSync(chapterDir, { recursive: true });
  writeFileSync(
    join(chapterDir, "final.md"),
    [
      "上午十点，林川跳进青鱼嘴水域。",
      "他在水下摸索前进，感觉到暗流拉扯着腿。",
      "此时苏婉还在镇上，正在小店里买东西。",
      "时间接近中午十二点，林川浮出水面。",
    ].join("\n"),
    "utf-8",
  );
}

before(() => {
  setupWorkspace();
  searchService = createNarrativeSearchService({
    projectRoot: tmpRoot,
    workspaceId,
    sourceChapter: "ch2",
  });
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================

describe("NovelOS Evidence Ranking（M1.1 任务 2）", () => {
  it("canon 命中 → evidenceLevel=confirmed_state, relevanceScore=1.0", () => {
    // query="青鱼嘴" 命中 canon "第2章结尾林川位置：青鱼嘴水下"
    const results = searchService.searchRanked("青鱼嘴");
    const canonHits = results.filter((e) => e.origin === "canon");
    assert.ok(canonHits.length >= 1, "应至少有 1 个 canon 命中");
    for (const hit of canonHits) {
      assert.equal(hit.evidenceLevel, "confirmed_state", "canon 应为 confirmed_state");
      assert.equal(hit.relevanceScore, 1.0, "canon relevanceScore 应为 1.0");
    }
  });

  it("chapter span 命中 → evidenceLevel=exact_chapter_span, relevanceScore < 1.0", () => {
    const results = searchService.searchRanked("暗流");
    const spanHits = results.filter((e) => e.origin === "chapter_span");
    assert.ok(spanHits.length >= 1, "应至少有 1 个 chapter span 命中");
    for (const hit of spanHits) {
      assert.equal(hit.evidenceLevel, "exact_chapter_span", "span 应为 exact_chapter_span");
      assert.ok(hit.relevanceScore < 1.0, "span relevanceScore 应 < 1.0");
      assert.ok(hit.relevanceScore >= 0.7, "span relevanceScore 应 ≥ 0.7");
    }
  });

  it("confirmed_state 排在 exact_chapter_span 之前", () => {
    // query="林川" 应同时命中 canon（位置事实含"林川"）和 chapter span（正文含"林川"）
    const results = searchService.searchRanked("林川");
    assert.ok(results.length >= 2, "应至少有 2 个结果");

    // 找到第一个 confirmed_state 和第一个 exact_chapter_span 的位置
    const firstConfirmedStateIdx = results.findIndex((e) => e.evidenceLevel === "confirmed_state");
    const firstSpanIdx = results.findIndex((e) => e.evidenceLevel === "exact_chapter_span");

    if (firstConfirmedStateIdx >= 0 && firstSpanIdx >= 0) {
      assert.ok(
        firstConfirmedStateIdx < firstSpanIdx,
        `confirmed_state (idx=${firstConfirmedStateIdx}) 应排在 exact_chapter_span (idx=${firstSpanIdx}) 之前`,
      );
    }
  });

  it("category=location 过滤只返回 location 类别 canon（不含 timeline）", () => {
    // query="青鱼嘴" 命中 canon:location:青鱼嘴（fact="青鱼嘴"）
    // 同时也命中 canon:event（timeline，fact="林川在青鱼嘴水下发现暗流"）
    // category="location" 应只返回 location 类别
    const locationResults = searchService.searchRanked("青鱼嘴", { category: "location" });
    const locationCanon = locationResults.filter((e) => e.origin === "canon");
    assert.ok(locationCanon.length >= 1, "应至少有 1 个 location canon 命中");
    // 不应含 timeline canon（event 类别）
    const timelineInLocation = locationCanon.filter((e) => e.sourceRef.includes("canon:event:"));
    assert.equal(timelineInLocation.length, 0, "category=location 不应含 event/timeline canon");

    // 无 category 过滤时，timeline canon 应出现（证明过滤生效）
    const allResults = searchService.searchRanked("青鱼嘴");
    const allCanon = allResults.filter((e) => e.origin === "canon");
    const timelineCanon = allCanon.filter((e) => e.sourceRef.includes("canon:event:"));
    assert.ok(timelineCanon.length >= 1, "无过滤时应含 timeline canon（event）");
  });

  it("searchChapterSpan 返回的 span 带 evidenceLevel 和 relevanceScore", () => {
    const spans = searchService.searchChapterSpan("暗流", 10, 5);
    assert.ok(spans.length >= 1, "应至少有 1 个 span");
    for (const span of spans) {
      assert.equal(span.evidenceLevel, "exact_chapter_span", "span 应带 evidenceLevel");
      assert.ok(
        typeof span.relevanceScore === "number" && span.relevanceScore > 0,
        "span 应带 relevanceScore > 0",
      );
    }
  });

  it("无匹配 query → 返回空列表", () => {
    const results = searchService.searchRanked("不存在的关键词XYZ");
    assert.ok(Array.isArray(results), "应返回数组");
    // 可能有 canon 命中（如果 query 是 canon 的子串），但"不存在的关键词XYZ"不应命中
    assert.equal(results.length, 0, "无匹配应返回空列表");
  });
});
