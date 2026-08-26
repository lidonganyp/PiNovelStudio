import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("development default runner does not watch the generated extension dist", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: { dev?: string; "dev:watch"?: string } };

  assert.equal(packageJson.scripts?.dev, "tsx src/index.ts");
  assert.equal(packageJson.scripts?.["dev:watch"], "tsx watch src/index.ts");
});
