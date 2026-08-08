/**
 * 诊断脚本：运行 4 个反例通过事件抽取器 + 账本比对器，打印详细结果。
 * 用于定位 P0-1 漏检根因。
 */

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";

const cases = [
  {
    name: "交给玉玺并放行 → 看玉玺并留下 (exact user text)",
    raw: "交给玉玺并放行",
    editorial: "看玉玺并留下",
    entities: ["玉玺"],
  },
  {
    name: "攻击 → 看一眼 (exact user text)",
    raw: "攻击",
    editorial: "看一眼",
    entities: [],
  },
  {
    name: "拿起 → 放下 (exact user text)",
    raw: "拿起",
    editorial: "放下",
    entities: [],
  },
  {
    name: "防御攻击 → 主动攻击 (exact user text)",
    raw: "防御攻击",
    editorial: "主动攻击",
    entities: [],
  },
];

for (const c of cases) {
  console.log("\n========================================");
  console.log(`CASE: ${c.name}`);
  console.log(`  raw: ${c.raw}`);
  console.log(`  ed : ${c.editorial}`);
  console.log(`  entities: ${c.entities.join(", ")}`);

  const rawRes = extractEvents(c.raw, c.entities);
  const edRes = extractEvents(c.editorial, c.entities);

  console.log(`\n  raw events (${rawRes.events.length}):`);
  for (const e of rawRes.events) {
    console.log(
      `    [${e.eventType}] subj='${e.subject}' action='${e.action}' obj='${e.object}' sent='${e.sentence}' extractable=${e.extractable}`,
    );
  }
  console.log(`  ed events (${edRes.events.length}):`);
  for (const e of edRes.events) {
    console.log(
      `    [${e.eventType}] subj='${e.subject}' action='${e.action}' obj='${e.object}' sent='${e.sentence}' extractable=${e.extractable}`,
    );
  }

  const cmp = compareEventLedgers({
    rawEvents: rawRes.events,
    editorialEvents: edRes.events,
    rawCausalChains: rawRes.causalChains,
    editorialCausalChains: edRes.causalChains,
    knownEntities: c.entities,
    entityCoverage: "full_entities",
    rawText: c.raw,
    editorialText: c.editorial,
  });

  console.log(`\n  preserved=${cmp.preserved} rejectionType=${cmp.rejectionType}`);
  console.log(`  missingEvents=${cmp.missingEvents.length} replacedEvents=${cmp.replacedEvents.length}`);
  console.log(`  rawEventCount=${cmp.rawEventCount} editorialEventCount=${cmp.editorialEventCount}`);
  for (const r of cmp.replacedEvents) {
    console.log(
      `    REPLACED: critical=${r.critical} reversal=${r.reversal} sim=${r.similarity?.toFixed(3)} rawAction='${r.rawAction}' edAction='${r.editorialAction}' rawCritical='${r.rawCriticalAction}'`,
    );
    console.log(`      reason: ${r.reason}`);
  }
  for (const a of cmp.advisorySimilarities) {
    console.log(
      `    ADVISORY: sim=${a.similarity?.toFixed(3)} sharesBigram=${a.sharesBigram} note=${a.note}`,
    );
  }
  if (cmp.unverifiable) console.log(`  unverifiable: ${cmp.reason}`);
}
