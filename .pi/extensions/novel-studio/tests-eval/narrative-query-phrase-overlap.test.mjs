/**
 * Regression test for Chinese function-word-omission query matching (Phase 4.2.2).
 *
 * 根因：中文模型构造检索查询时常省略句法功能词（如「有」），导致
 * 「青鱼嘴水域暗流」无法作为「青鱼嘴水域有暗流」的连续子串命中，检索返回
 * ranked:no-match。修复：searchRanked 增加 ≥4 字中文连续片段重叠回退。
 *
 * 验证：
 * - 省略功能词的查询仍能命中 canon（confirmed_state）
 * - 短词（<4 字，如单个人名）不触发过度匹配，保持既有精确包含行为
 * - 任意字符集合（非连续片段）不会误命中
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";

let tmpRoot;
const workspaceId = "test-phrase-overlap-ws";
let searchService;

function setupWorkspace() {
  tmpRoot = mkdtempSync(join(tmpdir(), "novelos-phrase-overlap-"));
  const wsDir = join(tmpRoot, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });

  // LegacyStateAdapter 从 skeleton.json 的 events 构建 canon 条目
  // （event.summary → canon:event:{eventId}，event.location → canon:location:{location}）
  writeFileSync(join(wsDir, "skeleton.json"), JSON.stringify({
    chapterId: "ch2",
    events: [
      {
        eventId: "e1",
        type: "discovery",
        summary: "青鱼嘴水域有暗流",
        characters: ["林川"],
        location: "青鱼嘴",
      },
      {
        eventId: "e2",
        type: "discovery",
        summary: "老周有潜水装备",
        characters: ["老周"],
      },
    ],
    locations: ["青鱼嘴"],
  }), "utf-8");

  writeFileSync(join(wsDir, "narrative-state.json"), JSON.stringify({
    pendingCosts: [],
    characterUpdates: [],
  }), "utf-8");

  writeFileSync(join(wsDir, "unsettled-details.json"), JSON.stringify([]), "utf-8");
  writeFileSync(join(wsDir, "arc-registry.json"), JSON.stringify({ arcs: [] }), "utf-8");

  const chapterDir = join(wsDir, "chapters", "chapter-02");
  mkdirSync(chapterDir, { recursive: true });
  writeFileSync(join(chapterDir, "final.md"),
    [
      "林川站在青鱼嘴水域的岸边。",
      "老周说这水底有暗流。",
    ].join("\n"), "utf-8");
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

describe("NovelOS 中文功能词省略修复（Phase 4.2.2）", () => {
  it("省略「有」的查询仍能命中 canon（青鱼嘴水域暗流 → 青鱼嘴水域有暗流）", () => {
    // 旧实现：("青鱼嘴水域有暗流").includes("青鱼嘴水域暗流") === false → no-match
    const results = searchService.searchRanked("青鱼嘴水域暗流");
    const canonHits = results.filter((e) => e.origin === "canon" && e.sourceRef === "canon:canon:event:e1");
    assert.ok(canonHits.length >= 1, "应命中 canon:canon:event:e1（青鱼嘴水域有暗流）");
    assert.equal(canonHits[0].evidenceLevel, "confirmed_state");
    assert.equal(canonHits[0].excerpt, "青鱼嘴水域有暗流");
  });

  it("省略「有」的查询仍能命中 canon（老周潜水装备 → 老周有潜水装备）", () => {
    const results = searchService.searchRanked("老周潜水装备");
    const canonHits = results.filter((e) => e.origin === "canon" && e.sourceRef === "canon:canon:event:e2");
    assert.ok(canonHits.length >= 1, "应命中 canon:canon:event:e2（老周有潜水装备）");
    assert.equal(canonHits[0].evidenceLevel, "confirmed_state");
  });

  it("短词（<4 字）不触发短语重叠，保持既有精确包含行为", () => {
    // 独立出现的 3 字词「青鱼嘴」仅靠精确包含命中，不应因短语重叠扩散
    const results = searchService.searchRanked("青鱼嘴");
    assert.ok(results.length >= 1, "青鱼嘴 应命中 location canon");
    // 3 字词仍应命中含「青鱼嘴」的 event:e1（精确包含）
    const e1 = results.filter((e) => e.sourceRef === "canon:canon:event:e1");
    assert.ok(e1.length >= 1, "青鱼嘴 应命中含「青鱼嘴」的 event:e1");
  });

  it("任意字符集合（非连续片段）不会误命中", () => {
    // 「岸是老周」不是任何 canon 事实的连续子串，也不是 ≥4 字连续片段
    const results = searchService.searchRanked("岸是老周");
    const canonHits = results.filter((e) => e.origin === "canon");
    assert.equal(canonHits.length, 0, "不应靠任意字符集合误命中 canon");
  });

  it("无匹配 query（含 <4 字拉丁串）→ 返回空列表", () => {
    // 拉丁串不在中文正则捕获范围内，不触发短语重叠
    const results = searchService.searchRanked("不存在的关键词XYZ");
    assert.equal(results.length, 0, "无匹配应返回空列表");
  });
});