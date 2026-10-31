/**
 * R09：Prompt Registry 真实基线快照登记（显式命令，不晋级）。
 *
 * 用途：
 * - 逐 slot 核对“当前真实生产 prompt / 工具 schema / 上下文编译器 / 预算”与 registry 中
 *   active 版本记录的 hash、bundle fingerprint、模型身份差异。
 * - 为存在漂移的 slot 追加一个 **draft** 版本，内容取自当前真实生产常量与
 *   model-routing.json 解析出的真实身份，作为“当前真实基线”的待评测记录。
 * - 不修改 productionPointers、不改 active hash、不写评测证据、不晋级；晋级必须走
 *   真实评测 + 用户授权。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-registry-draft-current.mjs            # 只报告，不写
 *   node scripts/prompt-registry-draft-current.mjs --write    # 追加 draft（不改 active）
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REGISTRY_PATH = join(PROJECT_ROOT, "config", "prompt-registry.json");
const ROUTING_PATH = join(PROJECT_ROOT, "config", "model-routing.json");

const write = process.argv.includes("--write");

const registryMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry.js")}`
);
const driftMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry-drift-check.js")}`
);

const SLOT_PROMPTS = {
  novelos_agentic: registryMod.PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: registryMod.PRODUCTION_STYLE_PROMPT,
  writer_adapter: registryMod.PRODUCTION_WRITER_PROMPT,
  retrieval_eval: registryMod.EVAL_BASELINE_RETRIEVAL_PROMPT,
};

function actualHashes(slot) {
  return {
    promptHash: registryMod.computePromptHash(SLOT_PROMPTS[slot]),
    toolSchemaHash: registryMod.computeProductionToolSchemaHash(),
    contextHash: registryMod.computeProductionContextHash(),
    budgetHash: registryMod.computeProductionBudgetHash(),
  };
}

function nextVersionNumber(registry, slot) {
  const versions = registry.versions.filter((entry) => entry.slot === slot);
  return versions.reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
}

function latestDraft(registry, slot) {
  const drafts = registry.versions
    .filter((entry) => entry.slot === slot && entry.status === "draft")
    .sort((left, right) => right.version - left.version);
  return drafts[0] ?? null;
}

function hashesMatch(left, right) {
  return ["promptHash", "toolSchemaHash", "contextHash", "budgetHash"]
    .every((key) => left[key] === right[key]);
}

let registry = registryMod.loadRegistry(REGISTRY_PATH);
const slots = ["novelos_agentic", "style_optimizer", "writer_adapter", "retrieval_eval"];
const rows = [];

for (const slot of slots) {
  const active = registryMod.getActiveVersion(registry, slot);
  const actual = actualHashes(slot);
  const bundle = driftMod.computeCurrentBundle({
    workspaceRoot: EXT_ROOT,
    routingPath: ROUTING_PATH,
    slot,
  });
  const draft = latestDraft(registry, slot);
  const draftMatches = Boolean(
    draft
    && hashesMatch(draft.hashes, actual)
    && bundle
    && draft.bundleManifest?.bundleId === bundle.manifest.bundleId,
  );
  const activeMatches = Boolean(active && hashesMatch(active.hashes, actual));

  rows.push({ slot, active, actual, bundle, draft, draftMatches, activeMatches });

  console.log(`[r09] ${slot}`);
  console.log(`      active=${active?.versionId ?? "(none)"} status=${active?.status ?? "-"} hashMatch=${activeMatches}`);
  console.log(`      actual prompt=${actual.promptHash} tool=${actual.toolSchemaHash} context=${actual.contextHash} budget=${actual.budgetHash}`);
  console.log(`      actual bundle=${bundle?.manifest.bundleId?.slice(0, 12) ?? "(unknown route)"}… model=${bundle?.identity.modelVersion ?? "-"} route=${bundle?.identity.route ?? "-"}`);
  console.log(`      latestDraft=${draft?.versionId ?? "(none)"} matchesActual=${draftMatches}`);
}

if (!write) {
  console.log("\n[r09] 只读报告模式；使用 --write 追加 draft（不修改 active / 指针 / 晋级状态）。");
  process.exitCode = 0;
} else {
  let added = 0;
  for (const row of rows) {
    if (row.draftMatches) {
      console.log(`[r09] 跳过 ${row.slot}：最新 draft 已与当前真实基线一致（${row.draft.versionId}）。`);
      continue;
    }
    if (!row.bundle) {
      console.log(`[r09] 跳过 ${row.slot}：model-routing.json 无法解析该 slot 生产身份（未知路由）。`);
      continue;
    }
    const versionNumber = nextVersionNumber(registry, row.slot);
    const activeWriterProfile = row.active?.writerProfile;
    const draftEntry = registryMod.createProductionSnapshot(
      row.slot,
      versionNumber,
      `R09 真实基线快照（${new Date().toISOString().slice(0, 10)}；待评测/待授权，未晋级）`,
      driftMod.SLOT_PRODUCTION_ROUTES[row.slot],
      SLOT_PROMPTS[row.slot],
      activeWriterProfile,
      row.bundle.manifest,
    );
    registry = registryMod.addVersion(registry, draftEntry);
    added += 1;
    console.log(`[r09] 已追加 draft ${draftEntry.versionId}（bundle=${row.bundle.manifest.bundleId.slice(0, 12)}…）`);
  }
  if (added > 0) {
    registryMod.saveRegistry(registry, REGISTRY_PATH);
    console.log(`[r09] 写入 ${REGISTRY_PATH}；active 指针未变，drift 检查仍会 fail-closed 直到评测与授权完成。`);
  } else {
    console.log("[r09] 无需写入：所有 slot 的最新 draft 已与当前真实基线一致。");
  }
  process.exitCode = 0;
}
