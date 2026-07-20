/**
 * Invoke novel_generate_chapter directly from the compiled extension code.
 * This bypasses PI tool registration and calls handleGenerateChapter directly.
 */
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

// Set project root before import
process.env.PROJECT_ROOT = projectRoot;

// Load the compiled extension — need file:// protocol on Windows
import { pathToFileURL } from "url";
const extPath = resolve(projectRoot, ".pi/extensions/novel-studio/dist/index.js");
const extModule = await import(pathToFileURL(extPath).href);

// The default export is the extension setup function (registerTools + registerCommand).
// We need to access the tools array from inside registerTools.
// Since handleGenerateChapter is a closure, we can't get it directly.
// Let's create a mock PI API to capture the tools.
const tools = [];
const mockPi = {
  registerTool: (tool) => tools.push(tool),
  registerCommand: () => {},
  on: () => {},
};

// Call the extension setup
extModule.default(mockPi);

// Find the novel_generate_chapter tool
const generateChapterTool = tools.find(t => t.name === "novel_generate_chapter");
if (!generateChapterTool) {
  console.error("novel_generate_chapter tool not found!");
  process.exit(1);
}

// Parse arguments
//   node invoke-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber> [mock] [--model-test-route=claude|claude48|fable5|grok45|doubao|glm|gpt|gpt56|deepseek] [--require-claude-stage2]
const argv = process.argv.slice(2);
const workspaceId = argv[0];
const chapterId = argv[1];
const chapterNumber = parseInt(argv[2], 10);
const mockAgent = argv[3] === "true" || argv[3] === "mock";

// P30/P34-T09: 解析 --model-test-route / --style-shaper-route / --chinese-naturalizer-route 标志
// 用于显式章节生成测试通道（不改 .env、不改生产主路由）
const VALID_MODELS = ["claude", "claude48", "fable5", "grok45", "doubao", "glm", "gpt", "gpt56", "deepseek"];
const VALID_NATURALIZER_MODELS = ["doubao", "glm", "gpt", "deepseek"];
const DEFAULT_MODEL_TEST_ROUTE = process.env.PINOVEL_MODEL_TEST_ROUTE || "glm";
function parseFlag(name) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit === `--${name}`) return "true";
  return hit.split("=")[1];
}
const modelTestRoute = parseFlag("model-test-route") || DEFAULT_MODEL_TEST_ROUTE;
const styleShaperRoute = parseFlag("style-shaper-route");
const requireClaudeStage2 = parseFlag("require-claude-stage2");
const chineseNaturalizerRoute = parseFlag("chinese-naturalizer-route");
const stage2Only = parseFlag("stage2-only");
const generationMode = parseFlag("generation-mode");
const stopAfterV2Stage = parseFlag("stop-after-v2-stage");
const recoverBlockedRaw = parseFlag("recover-blocked-raw");
const previewOnly = parseFlag("preview-only");
const chineseNaturalizerRouteValue = VALID_NATURALIZER_MODELS.includes(chineseNaturalizerRoute) ? chineseNaturalizerRoute : undefined;
const requireClaudeStage2Value = requireClaudeStage2 === "true";
const stage2OnlyValue = stage2Only === "true";
// V2: --generation-mode=quality_amplifier_v2 + 可选 --stop-after-v2-stage=rawStage2
const generationModeValue = generationMode === "quality_amplifier_v2" ? "quality_amplifier_v2" : undefined;
const stopAfterV2StageValue = stopAfterV2Stage === "rawStage2" ? "rawStage2" : undefined;
const recoverBlockedRawValue = recoverBlockedRaw === "true";
const previewOnlyValue = previewOnly === "true";
// Development/test invocations default to GLM; production routing is unchanged.
// MODEL-ROUTING-CLAUDE46-1D: development route lock — GLM is the development route
//   lock for this script. The default modelTestRoute=glm is a development convenience
//   to keep dev/test calls off the production provider (Claude 4.6) budget; it must
//   never be read as a production default. Public novel_generate_chapter calls
//   without an explicit modelTestRoute do NOT trigger any GLM route.
const modelTestRouteValue = VALID_MODELS.includes(modelTestRoute) ? modelTestRoute : undefined;
const styleShaperRouteValue = VALID_MODELS.includes(styleShaperRoute) ? styleShaperRoute : undefined;

if (!workspaceId || !chapterId || !chapterNumber) {
  console.error("Usage: node invoke-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber> [mock] [--model-test-route=doubao|glm|gpt|deepseek|claude] [--require-claude-stage2]");
  process.exit(1);
}

// MODEL-ROUTING-CLAUDE46-1D: development route lock — log explicitly so that
// trace/audit can distinguish dev invocations from production calls.
if (modelTestRouteValue === "glm") {
  console.log("[development route lock] modelTestRoute=glm — GLM is locked as the development route for this script; production novel_generate_chapter calls without modelTestRoute do NOT trigger any GLM route.");
}

console.log(`[Invoke] novel_generate_chapter for workspace=${workspaceId}, chapter=${chapterId}, number=${chapterNumber}, mock=${mockAgent}` + (modelTestRouteValue ? `, modelTestRoute=${modelTestRouteValue}` : "") + (styleShaperRouteValue ? `, styleShaperRoute=${styleShaperRouteValue}` : "") + (requireClaudeStage2Value ? ", requireClaudeStage2=true" : "") + (stage2OnlyValue ? ", stopAfterStage=stage2" : "") + (generationModeValue ? `, generationMode=${generationModeValue}` : "") + (stopAfterV2StageValue ? `, stopAfterV2Stage=${stopAfterV2StageValue}` : "") + (recoverBlockedRawValue ? ", recoverBlockedRaw=true" : ""));

// Call the tool's execute function (wrapped format)
// execute(toolCallId, params, _signal, _onUpdate, ctx)
const mockCtx = { cwd: projectRoot };
const result = await generateChapterTool.execute(
  "local-invoke",
  {
    workspaceId,
    chapterId: String(chapterId),
    chapterNumber,
    mockAgent: mockAgent,
    ...(modelTestRouteValue ? { modelTestRoute: modelTestRouteValue } : {}),
    ...(styleShaperRouteValue ? { styleShaperRoute: styleShaperRouteValue } : {}),
    ...(chineseNaturalizerRouteValue ? { chineseNaturalizerRoute: chineseNaturalizerRouteValue } : {}),
    ...(requireClaudeStage2Value ? { requireClaudeStage2: true } : {}),
    ...(stage2OnlyValue ? { stopAfterStage: "stage2" } : {}),
    ...(generationModeValue ? { generationMode: generationModeValue } : {}),
    ...(stopAfterV2StageValue ? { stopAfterV2Stage: stopAfterV2StageValue } : {}),
    ...(recoverBlockedRawValue ? { recoverBlockedRaw: true } : {}),
    ...(previewOnlyValue ? { previewOnly: true } : {}),
  },
  undefined,
  undefined,
  mockCtx
);

// Output result
console.log("\n=== RESULT ===");
if (result.details) {
  console.log(JSON.stringify(result.details, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}

// Save result to file
const resultPath = join(projectRoot, "workspaces", workspaceId, "chapters", `chapter-${chapterId}`, "generate-result.json");
const dir = dirname(resultPath);
if (!existsSync(dir)) {
  // mkdir -p equivalent
  const fs = await import("fs");
  fs.mkdirSync(dir, { recursive: true });
}
const { writeFileSync, mkdirSync } = await import("fs");
const saveData = result.details || result;
if (!existsSync(dirname(resultPath))) {
  const { dirname: dn } = await import("path");
  mkdirSync(dn(resultPath), { recursive: true });
}
writeFileSync(resultPath, JSON.stringify(saveData, null, 2), "utf-8");
console.log(`\nResult saved to: ${resultPath}`);
