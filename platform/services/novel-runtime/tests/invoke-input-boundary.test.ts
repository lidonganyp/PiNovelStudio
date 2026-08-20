import { test } from "node:test";
import assert from "node:assert/strict";
import { findReservedInternalInputFields } from "../src/routes/v1/invoke.js";

test("invoke DTO rejects runtime-only fields before workspace materialization", () => {
  assert.deepEqual(
    findReservedInternalInputFields({
      workspaceId: "safe",
      _projectRoot: "C:/attacker",
      callerOverride: { apiKey: "secret" },
      _mockGenerateChapter: () => undefined,
    }),
    ["_projectRoot", "callerOverride", "_mockGenerateChapter"],
  );
  assert.deepEqual(
    findReservedInternalInputFields({ workspaceId: "safe", chapterNumber: 1 }),
    [],
  );
});
