/**
 * B-safe 诊断脚本：捕获模型实际输出的非法工具名与非法 intent
 * 用于扩展 TOOL_NAME_TO_INTENT 映射与 inferIntentFromArgs 推断逻辑，使协议纠正能被真正 exercise
 *
 * 诊断两类情形（互补覆盖策略1/2/3 的纠正范围）：
 *   A. 工具名非法（!toolVisible）：策略1/2 的纠正范围
 *   B. 工具名合法但 intent 非法（toolVisible && !intentValid）：策略3 的纠正范围
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
);

const modelFn = await runner.createRealToolAbModelDecide({
  route: "narrator_testing_glm",
  maxTokens: 2048,
  timeoutMs: 120000,
  temperature: 0.72,
});

const scenarios = runner.getEnvelopeReplayScenarios();
const SEEDS = [0, 1, 2];

console.log("=== B-safe 非法工具名 + 非法 intent 诊断 ===\n");

const invalidToolNames = new Map(); // toolName -> count（工具名非法，策略1/2 范围）
const invalidIntents = new Map();   // intent -> count（工具名合法但 intent 非法，策略3 范围）
let correctedCount = 0;             // 协议纠正成功总数（策略1/2/3 命中）
let strategy3Corrected = 0;         // 策略3 纠正成功数（工具名合法但 intent 非法 → 推断成功）

for (const scenario of scenarios) {
  for (const seed of SEEDS) {
    const metrics = await runner.runRealToolAbScenario({
      scenario, arm: "B-safe", seed, modelFn,
    });

    for (const t of metrics.turns) {
      if (t.decision.kind !== "tool_call" || t.selectedTool === null) continue;

      if (t.toolSelectionCorrected) {
        correctedCount++;
        // 策略3 纠正：工具名合法（toolVisible）但 intent 被纠正
        if (t.toolVisible) {
          strategy3Corrected++;
        }
      }

      // A. 工具名非法且未纠正（策略1/2 未命中）
      if (!t.toolVisible && !t.toolSelectionCorrected) {
        const name = t.decision.toolName;
        invalidToolNames.set(name, (invalidToolNames.get(name) ?? 0) + 1);
        const intent = t.decision.intent ?? "(none)";
        const argsStr = JSON.stringify(t.decision.arguments).slice(0, 80);
        console.log("  [A " + scenario.id + ":s" + seed + "] r" + t.round + ' toolName="' + name + '" intent="' + intent + '" args=' + argsStr);
      }

      // B. 工具名合法但 intent 非法且未纠正（策略3 未命中）
      if (t.toolVisible && !t.intentValid && !t.toolSelectionCorrected) {
        const intent = t.intent ?? "(none)";
        invalidIntents.set(intent, (invalidIntents.get(intent) ?? 0) + 1);
        const argsStr = JSON.stringify(t.decision.arguments).slice(0, 80);
        console.log("  [B " + scenario.id + ":s" + seed + "] r" + t.round + ' intent="' + intent + '" args=' + argsStr);
      }
    }
  }
}

console.log("\n=== 非法工具名汇总（策略1/2 范围，未纠正）===");
for (const [name, count] of [...invalidToolNames.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${name}": ${count}次`);
}

console.log("\n=== 非法 intent 汇总（策略3 范围，工具名合法但 intent 非法且未纠正）===");
for (const [intent, count] of [...invalidIntents.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${intent}": ${count}次`);
}

console.log("\n=== 协议纠正统计 ===");
console.log(`  协议纠正总数（策略1/2/3 命中）: ${correctedCount}次`);
console.log(`  策略3 纠正数（工具名合法但 intent 非法 → 推断成功）: ${strategy3Corrected}次`);
console.log(`  策略1/2 纠正数（工具名非法 → 映射/路由）: ${correctedCount - strategy3Corrected}次`);

