import { applyStage5LocalStyleRepair } from "../../.pi/extensions/novel-studio/dist/index.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "pns-debug-"));
const stageResults = {};
// Test: reduces exclamation density while pruning replaceable detail drift
const before = [
  "杨间推开病房门，拿起档案袋！！",
  "周围的一切都显得格外安静，仿佛有什么东西正在黑暗里窥视！",
  "他按住档案袋的封口，看见病危通知书上的时间和论坛帖子完全重合！",
  "这到底是不是陈大哥留下的线索？！",
  "他把两处时间记在便签上，又把论坛帖子编号抄在通知书背面！",
].join("");

const styleResult = {
  status: "needs_revision",
  passed: false,
  matchScore: 0.49,
  thresholdConfig: { matchScoreMin: 0.65, deviationTolerance: 0.4, maxDeviations: 5 },
  deviations: [
    {
      dimension: "sentence.exclamationDensity",
      deviation: 0.3,
      description: "exclamation density too high",
      fix: "reduce exclamation marks",
    },
    {
      dimension: "detailQuality.replaceable",
      deviation: 0.717,
      description: "replaceable details",
      fix: "remove generic details",
    },
  ],
};

const outcome = applyStage5LocalStyleRepair({
  text: before,
  styleResult,
  stage: "stage5.style.loop1",
  workspaceRootPath: root,
  workspaceId: "demo",
  chapterId: "chapter-1",
  stageResults,
});

console.log("attempted:", outcome.attempted);
console.log("repairable:", outcome.repairable);
console.log("changed:", outcome.changed);
console.log("reason:", outcome.reason);
console.log("---comparison---");
console.log(JSON.stringify(outcome.patchOutcome?.comparison, null, 2));
console.log("---repair.repairs---");
for (const r of outcome.repair?.repairs || []) {
  console.log(JSON.stringify(r, null, 2));
}
console.log("---repair.repairObservations---");
console.log(JSON.stringify(outcome.repair?.repairObservations, null, 2));
