#!/usr/bin/env node
/**
 * CEG-6.1 / 6.2 / 6.4 — 同一 snapshot 下平铺 vs 分层真实模型对照。
 *
 * 不调用文学 judge。真人匿名包另存，晋级决策不得由本脚本自动作出。
 *
 *   node scripts/ceg-wave5-layering-ab.mjs --workspace xinmo --chapter 23 [--skip-model]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", "..");

function parseArgs(argv) {
  const args = { workspace: "xinmo", chapter: 23, skipModel: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workspace") args.workspace = argv[++i];
    else if (argv[i] === "--chapter") args.chapter = Number(argv[++i]);
    else if (argv[i] === "--skip-model") args.skipModel = true;
  }
  return args;
}

function loadDotEnv() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

function emptyIntent() {
  return {
    chapterFunction: "推进已冻结事实下的本章压力",
    readerExperience: ["保持人物在场"],
    currentPressure: ["不得改写已死/已断的事实"],
    inviolableFacts: [],
    relevantCharacters: [],
    focusCharacterGoals: [],
  };
}

const args = parseArgs(process.argv.slice(2));
loadDotEnv();
process.env.PINOVEL_DISABLE_FALLBACK = process.env.PINOVEL_DISABLE_FALLBACK ?? "1";

const compilerMod = await import(pathToFileURL(join(EXT_ROOT, "dist/v2/core/context-compiler.js")).href);
const snapshotMod = await import(pathToFileURL(join(EXT_ROOT, "dist/v2/core/narrative-evidence-snapshot.js")).href);
const promptMod = await import(pathToFileURL(join(EXT_ROOT, "dist/v2/core/model-prompt-adapter.js")).href);
const metricsMod = await import(pathToFileURL(join(EXT_ROOT, "dist-test/v2/core/ceg-wave5-metrics.js")).href);

const projectRoot = REPO_ROOT;
const snapshot = snapshotMod.buildNarrativeEvidenceSnapshot({
  workspaceId: args.workspace,
  projectRoot,
  chapterNumber: args.chapter,
  prepareBackfill: false,
});
let compiled;
try {
  compiled = compilerMod.createContextCompiler().compile({
    workspaceId: args.workspace,
    chapterId: String(args.chapter),
    chapterNumber: args.chapter,
    projectRoot,
    evidenceSnapshot: snapshot,
  });
} catch (error) {
  compiled = {
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: snapshot.creativeConstitution,
      longTermState: {
        canon: snapshot.narrativeState.canon,
        character: snapshot.narrativeState.character,
        promise: snapshot.narrativeState.promise,
        pattern: snapshot.narrativeState.pattern,
      },
    },
    contextHash: snapshot.knowledgeSnapshotHash,
    compileError: error instanceof Error ? error.message : String(error),
  };
}
const intent = {
  ...emptyIntent(),
  inviolableFacts: (compiled.context.longTermState?.canon ?? []).slice(0, 8).map((e) => e.fact),
  relevantCharacters: (compiled.context.characterStates ?? []).map((c) => c.name).filter(Boolean).slice(0, 6),
};
const orchInput = {
  intent,
  context: compiled.context,
  constitution: compiled.context.constitution ?? null,
};
const contract = promptMod.buildChapterContract(orchInput);
const flatPrompt = promptMod.renderContract(contract);
const layeredPrompt = promptMod.renderLayeredContract(contract);

const outDir = join(EXT_ROOT, "eval/fixtures/ceg-wave5-6");
mkdirSync(join(outDir, "blind"), { recursive: true });

const arms = { flat: { text: "", error: null, ms: 0, tokens: null }, layered: { text: "", error: null, ms: 0, tokens: null } };

if (!args.skipModel) {
  const modelMod = await import(pathToFileURL(join(EXT_ROOT, "dist/v2/adapters/legacy-model-route-adapter.js")).href);
  const generate = modelMod.createLegacyModelGenerateFn();
  for (const [arm, prompt] of [["flat", flatPrompt], ["layered", layeredPrompt]]) {
    const started = Date.now();
    try {
      const output = await generate({
        route: "v2_rawstage2_gemini31",
        systemPrompt: promptMod.WRITER_ADAPTER_SYSTEM_PROMPT,
        userPrompt: [
          prompt,
          `只写第${args.chapter}章开场，不超过400字。遵守硬约束，不得改写已发生事实。只输出正文。`,
        ].join("\n\n"),
        kind: "raw_chapter",
        maxTokens: 700,
        temperature: 0.4,
        seed: 42,
        timeoutMs: 180000,
      });
      arms[arm].text = output.text ?? "";
      arms[arm].tokens = output.tokenUsage ?? null;
      arms[arm].model = output.model;
      arms[arm].provider = output.provider;
    } catch (error) {
      arms[arm].error = error instanceof Error ? error.message : String(error);
    }
    arms[arm].ms = Date.now() - started;
  }
}

const score = metricsMod.scoreLayeringDeterministic({
  inviolableFacts: contract.inviolableFacts ?? [],
  futureChapterMarkers: [`ch${args.chapter + 5}`, `第${args.chapter + 5}章`],
  flatPrompt,
  layeredPrompt,
  generatedFlat: arms.flat.text,
  generatedLayered: arms.layered.text,
});

const mapping = Math.random() < 0.5
  ? { A: "flat", B: "layered" }
  : { A: "layered", B: "flat" };
writeFileSync(join(outDir, "blind", "A.txt"), mapping.A === "flat" ? arms.flat.text : arms.layered.text, "utf8");
writeFileSync(join(outDir, "blind", "B.txt"), mapping.B === "flat" ? arms.flat.text : arms.layered.text, "utf8");
writeFileSync(
  join(outDir, "blind", "mapping.json"),
  `${JSON.stringify({ mapping, note: "真人评审前勿打开" }, null, 2)}\n`,
  "utf8",
);

const report = {
  schemaId: "pinovel.ceg-wave5-layering-ab",
  workspaceId: args.workspace,
  chapterNumber: args.chapter,
  snapshotId: snapshot.snapshotId,
  knowledgeSnapshotHash: snapshot.knowledgeSnapshotHash,
  contextHash: compiled.contextHash,
  modelRoute: "v2_rawstage2_gemini31",
  seed: 42,
  skipModel: args.skipModel,
  deterministic: score,
  arms,
  decision: {
    productionRenderer: "gemini_writer_v2",
    layeredAdmitted: false,
    reason: "缺少真人匿名 A/B 结论；确定性门槛通过也不得自动替换生产 renderer",
  },
};
writeFileSync(join(outDir, "wave5-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(
  join(outDir, "wave5-report.md"),
  [
    "# CEG Wave 5 分层对照",
    "",
    `- workspace: ${args.workspace} ch${args.chapter}`,
    `- snapshotId: ${snapshot.snapshotId}`,
    `- inviolableFactsPresentInBoth: ${score.inviolableFactsPresentInBoth}`,
    `- futureLeakInPrompts: ${score.futureLeakInPrompts}`,
    `- futureLeakInOutput: ${score.futureLeakInOutput}`,
    `- tokenEstimate flat/layered: ${score.tokenEstimateFlat}/${score.tokenEstimateLayered} (Δ${score.tokenDelta})`,
    `- flat error: ${arms.flat.error ?? "none"} (${arms.flat.ms}ms)`,
    `- layered error: ${arms.layered.error ?? "none"} (${arms.layered.ms}ms)`,
    `- 生产决策: 保留 gemini_writer_v2，分层未晋级`,
    "",
  ].join("\n"),
  "utf8",
);
console.log(JSON.stringify({ ok: !arms.flat.error && !arms.layered.error || args.skipModel, snapshotId: snapshot.snapshotId, score }, null, 2));
process.exit(score.inviolableFactsPresentInBoth && score.futureLeakInPrompts === 0 ? 0 : 1);
