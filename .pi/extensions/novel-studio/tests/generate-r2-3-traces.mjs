/**
 * R2.3 典型 trace 生成脚本
 *
 * 运行 StoryPreservationGate 生成"通过"和"拒绝"两种典型 trace，
 * 保存到 data/novelbench/demo-3/r2-3/traces/ 供验证产物归档。
 *
 * 不调用模型（纯本地门禁）。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEditorialStoryPreservation } from "../dist/v2/core/editorial-story-preservation-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
const TRACE_DIR = resolve(PROJECT_ROOT, "data/novelbench/demo-3/r2-3/traces");
mkdirSync(TRACE_DIR, { recursive: true });

// ============================================================================
// 场景 1：通过 trace（同义改写，事件骨架保持）
// ============================================================================

const PASS_RAW = [
  "祝明朗推开门，走进丹房。",
  "他从储物戒中取出青莲地心火，火苗灼热逼人。",
  "药老在旁提醒他控制火候。",
  "异火被成功封入药鼎，丹房归于平静。",
].join("\n");

const PASS_EDITORIAL = [
  "丹房石门沉重，祝明朗用力推开方才入内。",
  "青莲地心火自储物戒飞出，悬于掌心上方，灼热难当。",
  "药老出声嘱咐，务必拿捏好火候分寸。",
  "斗气催动之下，异火被压入药鼎，丹房复归安宁。",
].join("\n");

const passReport = checkEditorialStoryPreservation({
  rawText: PASS_RAW,
  editorialText: PASS_EDITORIAL,
  knownEntities: ["祝明朗", "药老", "青莲地心火", "异火", "药鼎"],
});

const passTrace = {
  scenario: "pass_同义改写事件保持",
  description: "raw 与 editorial 事件骨架一致，仅句式/措辞大幅改写，门禁应通过",
  input: {
    rawText: PASS_RAW,
    editorialText: PASS_EDITORIAL,
    knownEntities: ["祝明朗", "药老", "青莲地心火", "异火", "药鼎"],
  },
  report: passReport,
  verification: {
    preserved: passReport.preserved,
    expectedPreserved: true,
    matched: passReport.preserved === true,
    rawEventAnchorFindingsCount: passReport.rawEventAnchorFindings?.length ?? 0,
    extractableFindingsCount: passReport.rawEventAnchorFindings?.filter((f) => f.extractable).length ?? 0,
    extractableFindingsHaveAction: passReport.rawEventAnchorFindings
      ?.filter((f) => f.extractable)
      .every((f) => f.action.length > 0) ?? false,
  },
};

writeFileSync(resolve(TRACE_DIR, "pass-trace.json"), JSON.stringify(passTrace, null, 2), "utf-8");
console.log("[pass-trace] preserved=" + passReport.preserved + ", findings=" + passReport.rawEventAnchorFindings?.length);

// ============================================================================
// 场景 2：拒绝 trace（主线替换，漂移）
// ============================================================================

const REJECT_RAW = [
  "林川推开舱门，冲进浑浊的水里。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "老周在岸上接应，把他们拉上船。",
].join("\n");

const REJECT_EDITORIAL = [
  "陈锋站在山顶，望着远处的云海。",
  "一只白鹤从云层中飞出，落在他的肩上。",
  "白鹤振翅飞起，带他来到一座古刹前。",
].join("\n");

const rejectReport = checkEditorialStoryPreservation({
  rawText: REJECT_RAW,
  editorialText: REJECT_EDITORIAL,
  knownEntities: ["林川", "苏婉", "老周", "陈锋", "白鹤", "古刹"],
});

const rejectTrace = {
  scenario: "reject_主线替换漂移",
  description: "raw 水下救援主线被替换为山顶奇遇主线，门禁应拒绝",
  input: {
    rawText: REJECT_RAW,
    editorialText: REJECT_EDITORIAL,
    knownEntities: ["林川", "苏婉", "老周", "陈锋", "白鹤", "古刹"],
  },
  report: rejectReport,
  verification: {
    preserved: rejectReport.preserved,
    expectedPreserved: false,
    matched: rejectReport.preserved === false,
    rejectionType: rejectReport.rejectionType,
    missingEventCount: rejectReport.missingEvents.length,
    replacedEventCount: rejectReport.replacedEvents.length,
    orderViolationCount: rejectReport.orderViolations.length,
    rawEventAnchorFindingsCount: rejectReport.rawEventAnchorFindings?.length ?? 0,
    extractableFindingsCount: rejectReport.rawEventAnchorFindings?.filter((f) => f.extractable).length ?? 0,
    extractableFindingsHaveAction: rejectReport.rawEventAnchorFindings
      ?.filter((f) => f.extractable)
      .every((f) => f.action.length > 0) ?? false,
  },
};

writeFileSync(resolve(TRACE_DIR, "reject-trace.json"), JSON.stringify(rejectTrace, null, 2), "utf-8");
console.log("[reject-trace] preserved=" + rejectReport.preserved + ", rejectionType=" + rejectReport.rejectionType + ", findings=" + rejectReport.rawEventAnchorFindings?.length);

// ============================================================================
// 场景 3：纯判断句 trace（验证判断句 extractable=false）
// ============================================================================

const JUDGMENT_RAW = [
  "林川推开舱门，冲进浑浊的水里。",
  "林川不是疯子。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "是苏婉。",
  "老周。",
  "三人爬上甲板，水面恢复了平静。",
].join("\n");

const judgmentReport = checkEditorialStoryPreservation({
  rawText: JUDGMENT_RAW,
  editorialText: JUDGMENT_RAW, // 完全一致
  knownEntities: ["林川", "苏婉", "老周"],
});

const judgmentTrace = {
  scenario: "judgment_纯判断句不成为事件",
  description: "raw 含纯判断句/指认句/单独名字，应 extractable=false，不制造替换事件",
  input: {
    rawText: JUDGMENT_RAW,
    editorialText: JUDGMENT_RAW,
    knownEntities: ["林川", "苏婉", "老周"],
  },
  report: judgmentReport,
  verification: {
    preserved: judgmentReport.preserved,
    expectedPreserved: true,
    matched: judgmentReport.preserved === true,
    rawEventAnchorFindingsCount: judgmentReport.rawEventAnchorFindings?.length ?? 0,
    judgmentSentencesExtractableFalse: {
      "林川不是疯子": judgmentReport.rawEventAnchorFindings?.find(
        (f) => f.sentence?.includes("不是疯子"),
      )?.extractable ?? "not_found",
      "是苏婉": judgmentReport.rawEventAnchorFindings?.find(
        (f) => f.sentence?.trim() === "是苏婉。",
      )?.extractable ?? "not_found",
      "老周。": judgmentReport.rawEventAnchorFindings?.find(
        (f) => f.sentence?.trim() === "老周。",
      )?.extractable ?? "not_found",
    },
    replacedEventsEmpty: judgmentReport.replacedEvents.length === 0,
  },
};

writeFileSync(resolve(TRACE_DIR, "judgment-trace.json"), JSON.stringify(judgmentTrace, null, 2), "utf-8");
console.log("[judgment-trace] preserved=" + judgmentReport.preserved + ", findings=" + judgmentReport.rawEventAnchorFindings?.length);

console.log("\n所有 trace 已生成到: " + TRACE_DIR);
