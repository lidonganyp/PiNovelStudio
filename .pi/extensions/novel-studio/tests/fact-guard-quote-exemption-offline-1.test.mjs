/**
 * FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 — QuoteExemption 离线验证（真实 RECOVERY-3 raw + 合成正负样本）
 *
 * 阶段：RED（编写离线验证测试，预期在 GREEN ee94b073 + 8097af94 之后全部 PASS）。
 *
 * 与 tests/fact-guard-quote-exemption-1.test.mjs 的区别：
 * - 既有测试使用合成的简短样本（4 行文本），覆盖豁免边界条件。
 * - 本文件加载真实 RECOVERY-3 raw（12870 字，来自 2-blocked-candidate-evidence.json
 *   storedText），验证 GREEN fix 在真实生产 raw 上不引入 false positive，
 *   并在真实 raw 上注入合成公告+重读模式，验证 QuoteExemption 端到端命中。
 *
 * 验收口径（用户授权）：
 * 1. 真实 RECOVERY-3 raw baseline：duplicate_scan 零触发 + quoteExemptions 零触发
 *    （证明 GREEN fix 在真实 raw 上不产生 false positive）。
 * 2. 真实 raw + 注入公告屏引文+主角重读：QuoteExemption 命中，输出 sourceSpan /
 *    recallSpan / matchRatio / reason / quoteBlockKind / exemptedChunk 审计字段；
 *    sourceSpan 落在注入的引文块内，recallSpan 落在注入的重读 prose 内。
 * 3. 真实 raw + 注入普通重复（无引文块）：仍 hard block，不豁免。
 * 4. 合成正例 span 内容验证：sourceSpan.excerpt 与 recallSpan.excerpt 必须包含
 *    重复 chunk 文本（不仅是 start/end 数字类型，而是内容匹配）。
 * 5. 合成正例 reason 内容验证：reason 必须包含 quoteBlockKind 类型字符串
 *    （不只是非空字符串）。
 * 6. 合成负例（3+ 次复制）：仍 hard block，不豁免。
 *
 * 真相源：
 * - workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json
 *   RECOVERY-3 ch2 raw (12870 字, sha256=c9ee46df...) 被 FactGuard entity_checker
 *   hard block（4 条误报），duplicate_scan 零触发。本文件验证：
 *   (a) 真实 raw 不触发 duplicate_scan（无 false positive）；
 *   (b) 在真实 raw 上注入公告+重读模式后 QuoteExemption 命中；
 *   (c) 在真实 raw 上注入普通重复后仍 hard block。
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
// 加载真实 RECOVERY-3 raw 文本（多路径回退，保证测试可移植）
// ============================================================================

const EVIDENCE_RELATIVE = "workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json";

const candidatePaths = [
  // 从测试文件：tests/ -> novel-studio/ -> extensions/ -> .pi/ -> repo root
  path.resolve(__dirname, "..", "..", "..", "..", EVIDENCE_RELATIVE),
  // 从 cwd（.pi/extensions/novel-studio/）
  path.resolve(process.cwd(), "..", "..", "..", EVIDENCE_RELATIVE),
  // 绝对路径兜底
  path.resolve("d:/CODE/PiNovelStudio", EVIDENCE_RELATIVE),
];

const evidencePath = candidatePaths.find((p) => fs.existsSync(p));

let RECOVERY_3_RAW = "";
let RECOVERY_3_SHA256 = "";
if (evidencePath) {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  RECOVERY_3_RAW = evidence.storedText ?? "";
  RECOVERY_3_SHA256 = evidence.storedSha256 ?? "";
}

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

function runDuplicateScan(text) {
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames: [],
    identityContract: null,
    ontologyContract: null,
  });
  return {
    diags: report.allDiagnostics.filter((d) => d.source === "duplicate_scan"),
    hasHardBlock: report.hasHardBlock,
    quoteExemptions: report.quoteExemptions ?? [],
  };
}

// ============================================================================
// Test 1: 真实 RECOVERY-3 raw baseline — 不触发 duplicate_scan，不触发 QuoteExemption
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 baseline: 真实 RECOVERY-3 raw (12870 字) 不触发 duplicate_scan 也无需豁免", (t) => {
  if (!RECOVERY_3_RAW) {
    t.skip(`RECOVERY-3 raw 证据文件缺失；尝试路径：${candidatePaths.join(" | ")}`);
    return;
  }
  assert.ok(
    RECOVERY_3_RAW.length > 10000,
    `RECOVERY-3 raw 长度应 > 10000（实际 ${RECOVERY_3_RAW.length}）。sha256=${RECOVERY_3_SHA256}`,
  );

  const { diags, quoteExemptions } = runDuplicateScan(RECOVERY_3_RAW);
  assert.equal(
    diags.length,
    0,
    `RECOVERY-3 raw 不含公告+重读重复模式，duplicate_scan 应零触发。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(
    quoteExemptions.length,
    0,
    `RECOVERY-3 raw 无 duplicate_scan 触发，QuoteExemption 不应被激活。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

// ============================================================================
// Test 2: 真实 raw + 注入公告屏引文+主角重读 → QuoteExemption 命中并输出审计字段
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 positive: 真实 raw 尾部注入公告屏引文+主角重读 → QuoteExemption 命中并输出完整审计字段", (t) => {
  if (!RECOVERY_3_RAW) {
    t.skip("RECOVERY-3 raw 文本不可用，跳过注入测试");
    return;
  }

  // 注入的公告+重读模式（使用独特的规则文本避免与真实 raw 内容碰撞）
  const ruleText = "测试规则Omega七：当红光闪三次所有样本须在三十秒内完成核验";
  const announcementBlock = [
    "",
    "> **N-999 测试公告（注入）**",
    ">",
    "> " + ruleText,
    "",
  ].join("\n");
  const recallProse =
    "林觉想起入口走廊的门禁屏：测试规则Omega七说\"" + ruleText + "\"他皱起眉头。\n";

  const text = RECOVERY_3_RAW + announcementBlock + recallProse;

  const { diags, quoteExemptions } = runDuplicateScan(text);
  assert.equal(
    diags.length,
    0,
    `注入的公告+重读模式应被 QuoteExemption 豁免，不输出 duplicate_scan diagnostic。实际：${JSON.stringify(diags)}`,
  );
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption 审计记录。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];

  // sourceSpan 必须落在注入的 announcement block 内（含 ruleText）
  const sourceSpanText = text.slice(ex.sourceSpan.start, ex.sourceSpan.end);
  assert.ok(
    sourceSpanText.includes("红光闪三次") || sourceSpanText.includes("样本须在三十秒"),
    `sourceSpan 必须落在注入的公告屏引文块内。sourceSpan 文本："${sourceSpanText}"`,
  );

  // recallSpan 必须落在注入的 recall prose 内（含 ruleText）
  const recallSpanText = text.slice(ex.recallSpan.start, ex.recallSpan.end);
  assert.ok(
    recallSpanText.includes("红光闪三次") || recallSpanText.includes("样本须在三十秒"),
    `recallSpan 必须落在注入的主角重读 prose 内。recallSpan 文本："${recallSpanText}"`,
  );

  // sourceSpan 必须在 recallSpan 之前
  assert.ok(
    ex.sourceSpan.start < ex.recallSpan.start,
    `sourceSpan 必须在 recallSpan 之前。source=${ex.sourceSpan.start} recall=${ex.recallSpan.start}`,
  );

  // 完整审计字段验证
  assert.ok(typeof ex.matchRatio === "number" && ex.matchRatio > 0 && ex.matchRatio <= 1,
    `matchRatio 必须是 (0,1] 数字。实际：${ex.matchRatio}`);
  assert.ok(typeof ex.reason === "string" && ex.reason.length > 0,
    `reason 必须是非空字符串。实际：${ex.reason}`);
  assert.ok(
    ["announcement", "signboard", "nameplate", "rule_text"].includes(ex.quoteBlockKind),
    `quoteBlockKind 必须是 announcement/signboard/nameplate/rule_text 之一。实际：${ex.quoteBlockKind}`,
  );
  assert.equal(
    ex.quoteBlockKind,
    "announcement",
    `注入的 N-999 公告 quoteBlockKind 必须是 announcement。实际：${ex.quoteBlockKind}`,
  );
  assert.ok(typeof ex.exemptedChunk === "string" && ex.exemptedChunk.length > 0,
    `exemptedChunk 必须是非空字符串。实际：${ex.exemptedChunk}`);
});

// ============================================================================
// Test 3: 真实 raw + 注入普通重复（无引文块）→ 仍 hard block，不豁免
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 negative: 真实 raw 尾部注入普通重复（无引文块）→ 仍 hard block 不豁免", (t) => {
  if (!RECOVERY_3_RAW) {
    t.skip("RECOVERY-3 raw 文本不可用，跳过注入测试");
    return;
  }

  // 注入的普通重复（无引文块、无重读语境，长度 ≥ 24 字符 ×2 触发 sliding window）
  const plainDuplicate = "他独自走到河边看着那缓缓流淌的河水心中涌起无限感慨久久不愿离去";
  const text = RECOVERY_3_RAW + "\n" + plainDuplicate + plainDuplicate;

  const { diags, quoteExemptions, hasHardBlock } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `普通重复（无引文块）应触发 duplicate_scan hard block。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(
    diags[0].severity,
    "hard",
    `普通重复 diagnostic severity 必须是 hard。实际：${diags[0].severity}`,
  );
  assert.equal(hasHardBlock, true, "普通重复应触发 hasHardBlock=true");
  assert.equal(
    quoteExemptions.length,
    0,
    `普通重复不应被 QuoteExemption 豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

// ============================================================================
// Test 4: 合成正例 span 内容验证 — excerpt 内容必须包含重复 chunk 文本
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 span content: sourceSpan.excerpt 与 recallSpan.excerpt 必须包含重复 chunk 文本（内容匹配，非仅类型）", () => {
  // 使用 26 字符规则文本，确保 ≥ minLen=24 触发 sliding window
  const ruleText = "本馆最多容纳四人超员时最后进入者请自行离开不得喧哗违者清退";
  const text = [
    "门口贴着一块金属标牌，上面刻着：",
    "",
    "> 标牌：" + ruleText,
    "",
    "老周看了一眼标牌，对林觉说：\"" + ruleText + "\"他皱起眉头。",
  ].join("\n");

  const { quoteExemptions } = runDuplicateScan(text);
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];

  // sourceSpan.excerpt 必须非空且是 ruleText 的子串
  assert.ok(
    ex.sourceSpan.excerpt && ex.sourceSpan.excerpt.length > 0,
    `sourceSpan.excerpt 必须非空。实际：${JSON.stringify(ex.sourceSpan)}`,
  );
  assert.ok(
    ruleText.includes(ex.sourceSpan.excerpt),
    `sourceSpan.excerpt 必须是规则文本的子串。excerpt="${ex.sourceSpan.excerpt}" ruleText="${ruleText}"`,
  );

  // recallSpan.excerpt 必须非空且是 ruleText 的子串
  assert.ok(
    ex.recallSpan.excerpt && ex.recallSpan.excerpt.length > 0,
    `recallSpan.excerpt 必须非空。实际：${JSON.stringify(ex.recallSpan)}`,
  );
  assert.ok(
    ruleText.includes(ex.recallSpan.excerpt),
    `recallSpan.excerpt 必须是规则文本的子串。excerpt="${ex.recallSpan.excerpt}" ruleText="${ruleText}"`,
  );

  // 两个 span 的 excerpt 应相同（sliding window 逐字匹配，相同 chunk）
  assert.equal(
    ex.sourceSpan.excerpt,
    ex.recallSpan.excerpt,
    `sourceSpan.excerpt 与 recallSpan.excerpt 应相同（逐字匹配同 chunk）。source="${ex.sourceSpan.excerpt}" recall="${ex.recallSpan.excerpt}"`,
  );

  // exemptedChunk 也应包含相同内容
  assert.ok(
    ruleText.includes(ex.exemptedChunk),
    `exemptedChunk 必须是规则文本的子串。exemptedChunk="${ex.exemptedChunk}" ruleText="${ruleText}"`,
  );
});

// ============================================================================
// Test 5: 合成正例 reason 内容验证 — reason 必须包含 quoteBlockKind 类型字符串
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 reason content: reason 必须包含 quoteBlockKind 类型字符串（不只是非空）", () => {
  // 铭牌（nameplate）+ 角色对话引用；ruleText 必须 ≥ 24 字符以触发 sliding window
  const ruleText = "铭牌写着此地长眠者不得惊扰违者必遭反噬不得擅入违者必死";
  const text = [
    "石碑上嵌着一块金属铭牌，上面刻着：",
    "",
    "> 铭牌：" + ruleText,
    "",
    "林觉低头看了一眼铭牌，对老周说：\"" + ruleText + "\"他皱起眉头。",
  ].join("\n");

  const { quoteExemptions } = runDuplicateScan(text);
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条 QuoteExemption。实际：${JSON.stringify(quoteExemptions)}`,
  );

  const ex = quoteExemptions[0];

  // quoteBlockKind 必须是 nameplate（铭牌）
  assert.equal(
    ex.quoteBlockKind,
    "nameplate",
    `铭牌引文 quoteBlockKind 必须是 nameplate。实际：${ex.quoteBlockKind}`,
  );

  // reason 必须包含 "nameplate" 字符串（不只非空）
  assert.ok(
    ex.reason.includes("nameplate"),
    `reason 必须包含 quoteBlockKind 字符串 "nameplate"。reason="${ex.reason}"`,
  );

  // reason 还应描述重读语境（引号包裹 或 重读动词）
  const describesQuoteOrVerb = ex.reason.includes("引号") || ex.reason.includes("重读");
  assert.ok(
    describesQuoteOrVerb,
    `reason 应描述重读语境（"引号"或"重读"）。reason="${ex.reason}"`,
  );
});

// ============================================================================
// Test 6: 合成负例 — 3+ 次复制（即便源于公告）仍 hard block 不豁免
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-OFFLINE-1 negative: 三次以上复制（公告+主角重读+第三人再念）→ 仍 hard block 不豁免", () => {
  const text = [
    "> 规则二：如遇停电请保持原地不动但第十七条不受断电影响",
    "",
    "林觉想起：\"如遇停电请保持原地不动但第十七条不受断电影响\"",
    "",
    "老周也念了一遍：\"如遇停电请保持原地不动但第十七条不受断电影响\"",
  ].join("\n");

  const { diags, quoteExemptions, hasHardBlock } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `三次以上复制即便源于公告仍应触发 duplicate_scan。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(hasHardBlock, true, "三次以上复制应 hard block");
  assert.equal(
    quoteExemptions.length,
    0,
    `三次以上复制不应被豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});
