import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const PROJECT_ROOT = "D:/CODE/PiNovelStudio";
const envPath = resolve(PROJECT_ROOT, ".env");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}
const mod = await import(
  pathToFileURL(resolve(PROJECT_ROOT, ".pi/extensions/novel-studio/dist-test/v2/governance/environment-fingerprint.js")).href,
);

// replicate computeConstitutionHash
const extRoot = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const cands = [join(extRoot, "CORE-WRITING-PRINCIPLES.md"), join(extRoot, "WORLDBUILDING-CANON.md")];
const hashes = cands.filter((p) => existsSync(p)).map((p) => createHash("sha256").update(readFileSync(p, "utf-8"), "utf-8").digest("hex"));
const constitutionHash = hashes.length > 0 ? createHash("sha256").update(hashes.join("\n"), "utf-8").digest("hex") : "";

const base = {
  projectRoot: PROJECT_ROOT,
  modelRoutingPath: "config/model-routing.json",
  promptBundlePaths: [],
  toolSchemaPaths: [],
  runtimeFilePaths: [
    ".pi/extensions/novel-studio/index.ts",
    ".pi/extensions/novel-studio/tsconfig.prod.json",
    ".pi/extensions/novel-studio/tsconfig.eval.json",
    ".pi/extensions/novel-studio/tsconfig.test.json",
  ],
  buildArtifactPaths: [".pi/extensions/novel-studio/dist/index.js"],
  activeStrategyIds: [],
  constitutionHash,
  datasetHash: "",
  evalProtocolHash: "",
  seed: 0,
  budgetMaxCalls: 10,
  timeoutMs: 300000,
  fallbackPolicy: "hard_block",
  generationModel: "gemini-3.1-pro-preview",
  judgeModel: "gpt5.6-sol",
  proxyApprovalModel: "gpt5.6-sol",
  envSwitchNames: ["V2_FORCE_STUB","NOVEL_TEST_TOOLS","NOVEL_DEBUG_TOOLS","PINOVEL_UNIFIED_PIPELINE","PINOVEL_DISABLE_FALLBACK"],
  secretEnvNames: ["GLM_API_KEY","DEEPSEEK_API_KEY","QWEN_API_KEY","CLAUDE_API_KEY","GEMINI_API_KEY","GPT_API_KEY","ARK_API_KEY","ERNIE_API_KEY"],
};
const dirty = mod.collectEnvironmentFingerprint({ ...base });
const clean = mod.collectEnvironmentFingerprint({ ...base, mockGit: { codeCommit: dirty.codeCommit, worktreeDirty: false } });
const manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, ".pi/extensions/novel-studio/config/evolution-release/releases/rel-prod-100/manifest.json"), "utf8"));
console.log("constitutionHash:", constitutionHash);
console.log("manifest fingerprint:", manifest.environmentFingerprint);
console.log("repl current dirty  :", dirty.fingerprintHash);
console.log("repl mock-clean     :", clean.fingerprintHash);
console.log("manifest == repl-dirty ?", manifest.environmentFingerprint === dirty.fingerprintHash);
console.log("manifest == repl-clean ?", manifest.environmentFingerprint === clean.fingerprintHash);