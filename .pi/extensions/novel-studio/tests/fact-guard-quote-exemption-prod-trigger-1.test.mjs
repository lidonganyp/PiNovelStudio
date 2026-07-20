/**
 * FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 — QuoteExemption 生产触发缺口
 *
 * 阶段：RED（核心生产缺口测试当前 FAIL，证明 ch3 合法引文回忆被误报 hard block；
 * 边界保护负例当前 PASS，确保新豁免不破坏既有阻断）。
 *
 * 真相源（冻结证据）：
 * - workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json
 *   RECOVERY-5 ch3 raw (11571 字, sha256=4a2e05bb...) 被 FactGuard duplicate_scan
 *   hard block，原因是同一句注释 "你看到了。这意味着你不是访客。--S" 在两个不同
 *   叙事场景各出现 1 次（共 2 次）：
 *     #1 位置 5535：林觉在副本底稿元数据中发现这条被折叠三层的完整注释（source/发现）
 *     #2 位置 6127：林觉在车库回忆起"副本通关后看到的那行注释"（recall/回忆）
 *   两处均在中文引号 "" 包裹内，无 markdown `>` 引文块。
 *
 * 根因（离线复现确认）：
 * QuoteExemption.decideExemption() 只识别 markdown `>` 引文块作为 source，
 * 不识别"引号包裹的普通段落注释"作为 source。ch3 无 `>` 块 → sourceStart===null
 * → exempted=false → hard block。这是合法的叙事回忆手法（同一句注释在发现场景与
 * 回忆场景各出现一次），非生成重复产物。
 *
 * 验收口径（用户授权 FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1）：
 * 1. RED 主测试：冻结 ch3 raw → duplicate_scan 不 hard block + QuoteExemption 命中 1 条
 *    （sourceSpan 落在 #1 发现位置附近，recallSpan 落在 #2 回忆位置附近）。
 * 2. RED 合成正例：引号包裹注释 + 引号包裹回忆（含回忆动词）→ 豁免，quoteBlockKind=quoted_note。
 * 3. RED 审计字段：豁免必须输出 sourceSpan/recallSpan/matchRatio/reason/quoteBlockKind/exemptedChunk。
 * 4. 回归：普通重复（引号外）→ 仍 hard block。
 * 5. 回归：三次复制（引号内 count==3）→ 仍 hard block。
 * 6. 回归：无来源复读（两处引号内但无回忆动词）→ 仍 hard block。
 * 7. 回归：跨段拼接（引文复制到不相关段落，无回忆语境）→ 仍 hard block。
 *
 * 边界（用户授权）：
 * - GREEN 只扩展证据证明的引文类型（引号包裹注释 + 引号包裹回忆）
 * - 普通重复、三次复制、无来源复读、跨段拼接仍须 hard block
 * - 不把 duplicate_scan 降为 warning
 * - RED fixture 必须使用冻结 ch3 raw
 *
 * 冻结证据永久丢失说明（2026-07-16，BLOCKED-CANDIDATE-EVIDENCE-FROZEN-PROTECTION-1）：
 * 2026-07-16 RECOVERY-5 之后的一次运行直接覆写了 3-blocked-candidate-evidence.json，
 * 原始冻结 raw（hash 4a2e05bb...，11571 字）被 hash 75cf... 的不同章节正文覆盖，
 * 永久丢失（workspaces/ 在 .gitignore:87，无 git 历史可恢复）。
 *
 * 用户授权处置（SKIP+文档+机制修复）：
 * - 已实现 HOLD-aware 不可变保护（v2/core/blocked-candidate-evidence.ts）：
 *   saveBlockedCandidateEvidence 在现存 evidence 被 HOLD 清单冻结且新 hash 不同时
 *   拒绝覆盖，改走 .recovery-N.json 路径。原始冻结文件保持不变。
 * - 下方 2 项冻结证据测试（#1 主测试、#2 审计字段）在检测到现存 evidence hash
 *   与 HOLD frozenSha256 不匹配时 skip，记录丢失原因。
 * - QuoteExemption 逻辑正确性由合成正例（#3）+ 4 项回归（#4-#7）+ 既有 markdown
 *   回归继续验证，覆盖完整。
 * - RECOVERY-6 重新授权单跑 ch3 以重建冻结证据，留待 ch4 三章验收后启动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 加载冻结 ch3 raw（HOLD_QUOTE_EXEMPTION_PROD_MISS）
// ============================================================================

const EVIDENCE_RELATIVE = "workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json";

const candidatePaths = [
  // 从测试文件：tests/ -> novel-studio/ -> extensions/ -> .pi/ -> repo root
  path.resolve(__dirname, "..", "..", "..", "..", EVIDENCE_RELATIVE),
  // 从 cwd（.pi/extensions/novel-studio/）
  path.resolve(process.cwd(), "..", "..", "..", EVIDENCE_RELATIVE),
  // 绝对路径兜底
  path.resolve("d:/CODE/PiNovelStudio", EVIDENCE_RELATIVE),
];

const evidencePath = candidatePaths.find((p) => fs.existsSync(p));

// HOLD_QUOTE_EXEMPTION_PROD_MISS 冻结的原始 ch3 raw sha256（见
// workspaces/fuben-clean-window-5-20260715/traces/3-hold-quote-exemption-prod-miss.json
// 的 frozenEvidence.storedSha256）。原始证据已被覆写丢失，此常量用于检测丢失状态。
const FROZEN_CH3_SHA256 = "4a2e05bb4d5bdb62ad66b709d8baacd33fa440655ac6d01f88d640a3324c39d7";

let CH3_RAW = "";
let CH3_SHA256 = "";
if (evidencePath) {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  CH3_RAW = evidence.storedText ?? "";
  CH3_SHA256 = evidence.storedSha256 ?? "";
}

/**
 * 冻结证据丢失检测：现存 evidence hash 与 HOLD frozenSha256 不匹配时返回 true。
 *
 * 触发条件：CH3_SHA256 非空且不等于 FROZEN_CH3_SHA256。
 * 含义：原始冻结 raw（4a2e...）已被覆写为不同 hash，永久丢失。
 * 处置：调用方应 assert.skip 并记录丢失原因（用户授权 SKIP+文档+机制修复）。
 */
function isFrozenEvidenceLost() {
  return CH3_SHA256.length > 0 && CH3_SHA256 !== FROZEN_CH3_SHA256;
}

const FROZEN_EVIDENCE_LOST_SKIP_REASON =
  "冻结 ch3 raw（sha256=4a2e05bb...）已被覆写为 " + (CH3_SHA256.slice(0, 12) + "...")
  + "，原始证据永久丢失（workspaces/ 在 .gitignore:87，无 git 历史）。"
  + "已实现 HOLD-aware 不可变保护（BLOCKED-CANDIDATE-EVIDENCE-FROZEN-PROTECTION-1）防止复发。"
  + "QuoteExemption 逻辑由合成正例 + 4 项回归 + 既有 markdown 回归继续验证。"
  + "RECOVERY-6 重建冻结证据留待 ch4 三章验收后启动。";

// ch3 出场角色（提供 knownCharacterNames 避免 entity_checker 误报干扰 duplicate_scan 验证）
const CH3_KNOWN_NAMES = [
  "林觉", "苏念", "齐墨", "老周", "周德茂", "沈游", "陈学礼", "N-7", "N-002",
];

// 冻结 ch3 raw 中引文出现位置（离线复现脚本确认）
const CH3_QUOTE = "你看到了。这意味着你不是访客。--S";
const CH3_SOURCE_POS = 5535; // #1 发现位置（底稿元数据注释）
const CH3_RECALL_POS = 6127; // #2 回忆位置（车库回忆）

// ============================================================================
// 测试工具
// ============================================================================

const BASE_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
  constitution: null,
  longTermState: null,
};

function runDuplicateScan(text, knownNames = []) {
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames: knownNames,
    identityContract: null,
    ontologyContract: null,
  });
  return {
    diags: report.allDiagnostics.filter((d) => d.source === "duplicate_scan"),
    hasHardBlock: report.hasHardBlock,
    quoteExemptions: report.quoteExemptions ?? [],
    hardBlocks: report.hardBlocks,
  };
}

// ============================================================================
// RED 主测试：冻结 ch3 raw → 应豁免，不 hard block
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 RED: 冻结 ch3 raw 引号包裹注释+回忆 → QuoteExemption 命中，duplicate_scan 不 hard block", (t) => {
  if (!CH3_RAW) {
    assert.fail(
      `无法加载冻结 ch3 raw 文本，证据文件缺失。尝试路径：\n${candidatePaths.join("\n")}`,
    );
  }
  // 冻结证据丢失检测：原始冻结 raw（4a2e...）已被覆写为不同 hash，永久丢失。
  // 用户授权 SKIP+文档+机制修复：已实现 HOLD-aware 不可变保护防止复发，
  // QuoteExemption 逻辑由合成正例 + 回归继续验证，RECOVERY-6 重建留待 ch4 后。
  if (isFrozenEvidenceLost()) {
    t.skip(FROZEN_EVIDENCE_LOST_SKIP_REASON);
    return;
  }
  // 冻结完整性校验
  assert.equal(
    CH3_SHA256,
    FROZEN_CH3_SHA256,
    `冻结 ch3 raw sha256 必须匹配 HOLD_QUOTE_EXEMPTION_PROD_MISS 记录。实际：${CH3_SHA256}`,
  );
  assert.ok(
    CH3_RAW.length > 10000,
    `ch3 raw 长度应 > 10000（实际 ${CH3_RAW.length}）`,
  );

  // 引文出现位置校验（防止冻结 raw 被篡改）
  const firstIdx = CH3_RAW.indexOf(CH3_QUOTE);
  const secondIdx = CH3_RAW.indexOf(CH3_QUOTE, firstIdx + 1);
  const thirdIdx = CH3_RAW.indexOf(CH3_QUOTE, secondIdx + 1);
  assert.equal(firstIdx, CH3_SOURCE_POS, `引文 #1 位置应为 ${CH3_SOURCE_POS}（实际 ${firstIdx}）`);
  assert.equal(secondIdx, CH3_RECALL_POS, `引文 #2 位置应为 ${CH3_RECALL_POS}（实际 ${secondIdx}）`);
  assert.equal(thirdIdx, -1, `引文应只出现 2 次（count==2），不应有第三次（实际 ${thirdIdx}）`);

  const { diags, quoteExemptions } = runDuplicateScan(CH3_RAW, CH3_KNOWN_NAMES);

  // duplicate_scan 不应触发（合法引文回忆应被豁免）
  assert.equal(
    diags.length,
    0,
    `冻结 ch3 raw 的合法引文回忆应被 QuoteExemption 豁免，不输出 duplicate_scan diagnostic。实际诊断：${JSON.stringify(diags)}`,
  );

  // QuoteExemption 应命中 1 条
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption 审计记录。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];

  // sourceSpan 应落在 #1 发现位置附近（底稿元数据注释）
  assert.ok(
    ex.sourceSpan.start <= CH3_SOURCE_POS && ex.sourceSpan.end >= CH3_SOURCE_POS,
    `sourceSpan 必须覆盖 #1 发现位置 ${CH3_SOURCE_POS}。sourceSpan=${JSON.stringify(ex.sourceSpan)}`,
  );

  // recallSpan 应落在 #2 回忆位置附近（车库回忆）
  assert.ok(
    ex.recallSpan.start <= CH3_RECALL_POS && ex.recallSpan.end >= CH3_RECALL_POS,
    `recallSpan 必须覆盖 #2 回忆位置 ${CH3_RECALL_POS}。recallSpan=${JSON.stringify(ex.recallSpan)}`,
  );

  // sourceSpan 必须在 recallSpan 之前
  assert.ok(
    ex.sourceSpan.start < ex.recallSpan.start,
    `sourceSpan 必须在 recallSpan 之前。source=${ex.sourceSpan.start} recall=${ex.recallSpan.start}`,
  );
});

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 RED: 冻结 ch3 raw 豁免审计字段完整（sourceSpan/recallSpan/matchRatio/reason/quoteBlockKind/exemptedChunk）", (t) => {
  if (!CH3_RAW) {
    t.skip("冻结 ch3 raw 文本不可用，跳过审计字段测试");
    return;
  }
  // 冻结证据丢失检测：与主测试一致，丢失时 skip。
  if (isFrozenEvidenceLost()) {
    t.skip(FROZEN_EVIDENCE_LOST_SKIP_REASON);
    return;
  }

  const { quoteExemptions } = runDuplicateScan(CH3_RAW, CH3_KNOWN_NAMES);
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];

  // sourceSpan / recallSpan 必须含 start/end 数字
  assert.ok(ex.sourceSpan && typeof ex.sourceSpan.start === "number" && typeof ex.sourceSpan.end === "number",
    `sourceSpan 必须含 start/end 数字。实际：${JSON.stringify(ex.sourceSpan)}`);
  assert.ok(ex.recallSpan && typeof ex.recallSpan.start === "number" && typeof ex.recallSpan.end === "number",
    `recallSpan 必须含 start/end 数字。实际：${JSON.stringify(ex.recallSpan)}`);

  // matchRatio 必须是 (0,1] 数字
  assert.ok(typeof ex.matchRatio === "number" && ex.matchRatio > 0 && ex.matchRatio <= 1,
    `matchRatio 必须是 (0,1] 数字。实际：${ex.matchRatio}`);

  // reason 必须是非空字符串
  assert.ok(typeof ex.reason === "string" && ex.reason.length > 0,
    `reason 必须是非空字符串。实际：${ex.reason}`);

  // quoteBlockKind 必须包含新类型 quoted_note（引号包裹注释）
  assert.ok(
    ["announcement", "signboard", "nameplate", "rule_text", "quoted_note"].includes(ex.quoteBlockKind),
    `quoteBlockKind 必须是 announcement/signboard/nameplate/rule_text/quoted_note 之一。实际：${ex.quoteBlockKind}`,
  );
  assert.equal(
    ex.quoteBlockKind,
    "quoted_note",
    `ch3 引号包裹注释的 quoteBlockKind 必须是 quoted_note。实际：${ex.quoteBlockKind}`,
  );

  // exemptedChunk 必须是非空字符串
  assert.ok(typeof ex.exemptedChunk === "string" && ex.exemptedChunk.length > 0,
    `exemptedChunk 必须是非空字符串。实际：${ex.exemptedChunk}`);
});

// ============================================================================
// RED 合成正例：引号包裹注释 + 引号包裹回忆（含回忆动词）→ 豁免
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 RED: 合成正例 — 引号包裹注释(source) + 引号包裹回忆(recall，含回忆动词) → 豁免 quoteBlockKind=quoted_note", () => {
  // 模拟 ch3 模式：角色先在某场景读到一段引号包裹的注释，后在另一场景回忆起这段注释
  // ruleText 必须 ≥ 24 字符以触发 sliding window
  const noteText = "你已经被标记为样本第七号前六个样本均已死亡请谨慎选择下一步";
  const text = [
    "他在底稿元数据里翻到了一条被折叠的注释，展开后是完整内容：",
    "",
    "\"" + noteText + "\"",
    "",
    "这条注释是写给他的。写注释的人知道他会看到。",
    "",
    "──",
    "",
    "林觉站在车库里。他想到通关后看到的那行注释。",
    "",
    "\"" + noteText + "\"",
    "",
    "S。沈游。沈游是谁？",
  ].join("\n");

  const { diags, quoteExemptions } = runDuplicateScan(text, ["林觉", "沈游"]);

  assert.equal(
    diags.length,
    0,
    `引号包裹注释+回忆应被 QuoteExemption 豁免，不输出 duplicate_scan。实际诊断：${JSON.stringify(diags)}`,
  );

  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];
  assert.equal(
    ex.quoteBlockKind,
    "quoted_note",
    `合成正例 quoteBlockKind 必须是 quoted_note。实际：${ex.quoteBlockKind}`,
  );

  // sourceSpan 必须落在第一处引号包裹注释内
  const sourceSpanText = text.slice(ex.sourceSpan.start, ex.sourceSpan.end);
  assert.ok(
    sourceSpanText.includes("样本第七号") || sourceSpanText.includes("前六个样本"),
    `sourceSpan 必须落在第一处引号包裹注释内。sourceSpan 文本："${sourceSpanText}"`,
  );

  // recallSpan 必须落在第二处引号包裹回忆内
  const recallSpanText = text.slice(ex.recallSpan.start, ex.recallSpan.end);
  assert.ok(
    recallSpanText.includes("样本第七号") || recallSpanText.includes("前六个样本"),
    `recallSpan 必须落在第二处引号包裹回忆内。recallSpan 文本："${recallSpanText}"`,
  );

  // sourceSpan 必须在 recallSpan 之前
  assert.ok(
    ex.sourceSpan.start < ex.recallSpan.start,
    `sourceSpan 必须在 recallSpan 之前。source=${ex.sourceSpan.start} recall=${ex.recallSpan.start}`,
  );

  // reason 必须包含 "quoted_note" 字符串
  assert.ok(
    ex.reason.includes("quoted_note"),
    `reason 必须包含 quoteBlockKind 字符串 "quoted_note"。reason="${ex.reason}"`,
  );
});

// ============================================================================
// 回归保护测试：4 类负例仍按原规则 hard block
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 回归: 普通重复（两处都在引号外）→ 仍 hard block", () => {
  // 24+ 字片段重复 2 次，无引号包裹、无引文块、无重读语境
  const repeated = "他独自走到河边看着那缓缓流淌的河水心中涌起无限感慨久久不愿离去";
  const text = repeated + repeated;

  const { diags, quoteExemptions } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `普通重复（引号外）应触发 duplicate_scan hard block。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
  assert.equal(
    quoteExemptions.length,
    0,
    `普通重复不应被豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 回归: 三次复制（引号内 count==3）→ 仍 hard block", () => {
  // 引号包裹注释出现 3 次（超出"引文+回忆"叙事必要边界）
  const noteText = "你已被标记为样本第七号前六个样本均已死亡请谨慎选择下一步";
  const text = [
    "他翻开注释：\"" + noteText + "\"",
    "",
    "他想起那行注释：\"" + noteText + "\"",
    "",
    "老周也念了一遍：\"" + noteText + "\"",
  ].join("\n");

  const { diags, quoteExemptions } = runDuplicateScan(text, ["老周"]);
  assert.ok(
    diags.length >= 1,
    `三次复制（引号内 count==3）应触发 duplicate_scan hard block。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
  assert.equal(
    quoteExemptions.length,
    0,
    `三次复制不应被豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 回归: 无来源复读（两处引号内但无回忆动词）→ 仍 hard block", () => {
  // 两处引号包裹，但第二处无回忆动词（不是"回忆/想到/翻开/说"，是另一处纸条"写着"）
  // 这区分"引文+回忆"与"无来源复读污染"
  // 注意：RECALL_VERBS 包含"说"，所以不能用"另一个人说"；用"纸条写着"确保无回忆动词
  const noteText = "你已被标记为样本第七号前六个样本均已死亡请谨慎选择下一步";
  const text = [
    "他翻开注释：\"" + noteText + "\"",
    "",
    "墙上的另一张纸条写着：\"" + noteText + "\"",
    "",
    "两处文本相同。仅此而已。",
  ].join("\n");

  const { diags, quoteExemptions } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `无来源复读（两处引号内但无回忆动词）应触发 duplicate_scan hard block。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
  assert.equal(
    quoteExemptions.length,
    0,
    `无来源复读不应被豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 回归: 跨段拼接（引文复制到不相关段落，无回忆语境）→ 仍 hard block", () => {
  // 第一处引号包裹注释，第二处引号包裹但出现在完全不相关的叙事段落（无回忆动词）
  // 这区分"引文+回忆"与"跨段拼接污染"
  // 注意：RECALL_VERBS 包含"说"，所以不能用"对服务员说"；用"留下一张纸条，上面写着"确保无回忆动词
  const noteText = "你已被标记为样本第七号前六个样本均已死亡请谨慎选择下一步";
  const text = [
    "他翻开注释：\"" + noteText + "\"",
    "",
    "──",
    "",
    "城市的另一端。咖啡馆。一个陌生人走进来，留下一张纸条，上面写着：\"" + noteText + "\"服务员愣住了。",
  ].join("\n");

  const { diags, quoteExemptions } = runDuplicateScan(text, ["服务员"]);
  assert.ok(
    diags.length >= 1,
    `跨段拼接（引文复制到不相关段落，无回忆语境）应触发 duplicate_scan hard block。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
  assert.equal(
    quoteExemptions.length,
    0,
    `跨段拼接不应被豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

// ============================================================================
// 现有 markdown `>` 引文块豁免不回归（确保新 quoted_note 不破坏既有 announcement/signboard/nameplate/rule_text）
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 回归: 现有 markdown `>` 公告屏引文+重读仍豁免（不破坏既有 QuoteExemption）", () => {
  const text = [
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
    "",
    "林觉想起门禁屏：规则二说\"如遇停电，请保持原地不动。但第17条不受断电影响。\"",
  ].join("\n");

  const { diags, quoteExemptions } = runDuplicateScan(text, ["林觉"]);
  assert.equal(
    diags.length,
    0,
    `既有 markdown > 公告屏引文+重读应继续被豁免。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption。实际：${JSON.stringify(quoteExemptions)}`,
  );
  // 既有 `>` 块豁免的 quoteBlockKind 不应是 quoted_note（应是 announcement/rule_text 等）
  assert.notEqual(
    quoteExemptions[0].quoteBlockKind,
    "quoted_note",
    `markdown > 块豁免的 quoteBlockKind 不应是 quoted_note。实际：${quoteExemptions[0].quoteBlockKind}`,
  );
});
