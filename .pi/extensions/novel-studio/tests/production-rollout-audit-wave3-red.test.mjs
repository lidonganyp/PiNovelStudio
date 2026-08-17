/**
 * PRODUCTION-ROLLOUT-AUDIT-1 Wave 3 RED
 *
 * Source-level, deterministic. No model calls. No dist rebuild required.
 * These cases must fail on the Wave 2 baseline and turn green only after
 * the matching Wave 4 repair.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..");

function readUtf8(relativePath) {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

function pathExists(relativePath) {
  return existsSync(join(PROJECT_ROOT, relativePath));
}

describe("PRODUCTION-ROLLOUT-AUDIT-1 Wave 3 RED", () => {
  it("P0-REPLAY-01: documented replay matrix script exists or package scripts name one replacement", () => {
    const agents = readUtf8("AGENTS.md");
    const rootPkg = JSON.parse(readUtf8("package.json"));
    const extPkg = JSON.parse(readUtf8(".pi/extensions/novel-studio/package.json"));
    const documented = /scripts\/replay-generation-matrix\.mjs/.test(agents);
    const fileExists =
      pathExists("scripts/replay-generation-matrix.mjs")
      || pathExists(".pi/extensions/novel-studio/scripts/replay-generation-matrix.mjs");
    const namedReplacement =
      typeof rootPkg.scripts?.["replay:generation-matrix"] === "string"
      || typeof extPkg.scripts?.["replay:generation-matrix"] === "string";
    assert.ok(
      fileExists && (documented || namedReplacement),
      "AGENTS.md still names scripts/replay-generation-matrix.mjs, but the file is missing and no replay:generation-matrix package script exists",
    );
  });

  it("P0-HARNESS-01: a production invoker exists that rejects mock/preview/eval/qualityExperiment/modelTestRoute", () => {
    const candidates = [
      "scripts/production-generate-chapter.mjs",
      ".pi/extensions/novel-studio/scripts/production-generate-chapter.mjs",
    ];
    const invoker = candidates.find((relativePath) => pathExists(relativePath));
    assert.ok(
      invoker,
      "no production-generate-chapter.mjs; invoke-generate-chapter.mjs defaults to GLM and is not an acceptance invoker",
    );
    const source = readUtf8(invoker);
    for (const flag of ["modelTestRoute", "fullPipelinePreview", "qualityExperiment", "mockAgent", "evalMode"]) {
      assert.match(
        source,
        new RegExp(`${flag}[\\s\\S]{0,240}(reject|forbidden|not allowed|must not)`, "i"),
        `${invoker} must reject ${flag}`,
      );
    }
    assert.doesNotMatch(
      source,
      /DEFAULT_MODEL_TEST_ROUTE[^\n]*=[^\n]*["']glm["']/,
      "production invoker must not default modelTestRoute to glm",
    );
  });

  it("P0-DOC-01: test-portfolio-manifest must not protect Pairwise Judge or raw fallback as production coverage", () => {
    const manifest = readUtf8("docs/test-portfolio-manifest.md");
    const afterHeading = manifest.split("## 7. 覆盖保护清单")[1] ?? "";
    const protectionTable = afterHeading.split("## 8.")[0] ?? afterHeading;
    assert.doesNotMatch(
      protectionTable,
      /Pairwise Judge/,
      "docs/test-portfolio-manifest.md §7 still lists Pairwise Judge as a production protection",
    );
    assert.doesNotMatch(
      protectionTable,
      /raw fallback/,
      "docs/test-portfolio-manifest.md §7 still lists raw fallback as a production protection",
    );
  });

  it("P0-SMOKE-01: phase5 smoke must not require judgeEvidence or allow rawStage2 as a production selected source", () => {
    const smoke = readUtf8(".pi/extensions/novel-studio/tests/phase5-unified-default-path.test.mjs");
    assert.doesNotMatch(
      smoke,
      /judgeEvidence/,
      "phase5-unified-default-path.test.mjs still requires judgeEvidence on the production smoke path",
    );
    assert.doesNotMatch(
      smoke,
      /\["rawStage2", "v2_amplified"\]/,
      "phase5-unified-default-path.test.mjs still treats rawStage2 as an acceptable production selected source",
    );
  });

  it("ROUTE-07: invoke-generate-chapter.mjs must not be the production acceptance path", () => {
    const invoke = readUtf8("scripts/invoke-generate-chapter.mjs");
    assert.match(
      invoke,
      /DEFAULT_MODEL_TEST_ROUTE[^\n]*=[^\n]*["']glm["']/,
      "expected current GLM default so this case stays a negative production-acceptance lock",
    );
    assert.equal(
      pathExists("scripts/production-generate-chapter.mjs")
        || pathExists(".pi/extensions/novel-studio/scripts/production-generate-chapter.mjs"),
      true,
      "production acceptance must use a separate invoker that does not inject GLM",
    );
  });
});
