/** Request-scoped chapter length must survive the public production path. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(join(EXT_ROOT, "dist", relativePath)).href);
}

describe("request-scoped target word count", () => {
  it("is declared by the public chapter tool and forwarded unchanged", async () => {
    const { registerTools } = await importDist("tools/register-tools.js");
    let forwarded;
    const handlers = new Proxy({}, {
      get: (_target, property) => property === "handleGenerateChapter"
        ? async (input) => {
            forwarded = input;
            return { status: "ok", text: "正文", stageResults: {} };
          }
        : async () => ({}),
    });
    const tool = registerTools(handlers).find((candidate) => candidate.name === "novel_generate_chapter");

    assert.ok(tool, "novel_generate_chapter 应注册");
    assert.equal(
      Object.hasOwn(tool.parameters.properties, "targetWordCount"),
      true,
      "公开参数必须声明 targetWordCount",
    );
    await tool.execute(
      "target-length",
      {
        workspaceId: "target-word-count",
        chapterId: "17",
        chapterNumber: 17,
        targetWordCount: { min: 2500, max: 2500 },
      },
      undefined,
      undefined,
      { cwd: EXT_ROOT },
    );
    assert.deepEqual(forwarded.targetWordCount, { min: 2500, max: 2500 });
  });

  it("prefers the current request over the workspace default", async () => {
    const root = join(EXT_ROOT, ".tmp-target-word-count-test");
    const workspace = join(root, "workspaces", "target-word-count");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "config.json"), JSON.stringify({
      targetWordCount: { perChapter: { min: 3000, max: 5000 } },
    }), "utf8");

    try {
      const { resolveTargetWordCount } = await importDist("v2/core/unified-entry.js");
      assert.equal(typeof resolveTargetWordCount, "function");
      assert.deepEqual(
        resolveTargetWordCount(
          { min: 2500, max: 2500 },
          "target-word-count",
          root,
        ),
        { min: 2500, max: 2500 },
      );
      assert.deepEqual(
        resolveTargetWordCount(undefined, "target-word-count", root),
        { min: 3000, max: 5000 },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
