/**
 * Regression test for multi-token narrative evidence queries.
 * The model commonly emits queries such as "苏明 弟弟"; the tool must still
 * recover confirmed evidence when the exact joined query is not indexed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createNarrativeTools } from "../dist/novelos/tools/narrative-tools.js";

test("search_narrative_evidence falls back to meaningful query tokens", async () => {
  const calls = [];
  const searchService = {
    searchRanked(query) {
      calls.push(query);
      if (query === "苏明") {
        return [{
          sourceRef: "canon:suming",
          excerpt: "苏明是否真的是苏婉的弟弟",
          evidenceLevel: "confirmed_state",
          relevanceScore: 1,
          origin: "canon",
        }];
      }
      if (query === "弟弟") {
        return [{
          sourceRef: "canon:suming",
          excerpt: "苏明是否真的是苏婉的弟弟",
          evidenceLevel: "confirmed_state",
          relevanceScore: 1,
          origin: "canon",
        }];
      }
      return [];
    },
  };
  const tool = createNarrativeTools({ searchService }).find(
    (candidate) => candidate.name === "search_narrative_evidence",
  );
  assert.ok(tool);

  const result = await tool.execute("token-fallback", {
    query: "苏明 弟弟",
    maxResults: 5,
  });

  assert.deepEqual(calls, ["苏明 弟弟", "苏明", "弟弟"]);
  assert.equal(result.details.sourceRef, "canon:suming");
  assert.equal(result.details.evidenceLevel, "confirmed_state");
  assert.match(result.content[0].text, /找到/);
});
