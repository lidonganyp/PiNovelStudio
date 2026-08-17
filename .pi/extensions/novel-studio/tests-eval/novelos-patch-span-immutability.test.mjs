/**
 * NovelOS Patch Span Immutability 测试（P1 配套）
 *
 * 验证 CandidatePatchService.evaluatePatch 的 span 外不变性检查：
 * - span 外正文保持不变 → accepted=true, spanImmutabilityPassed=true
 * - span 外正文被修改 → accepted=false, spanImmutabilityPassed=false, spanViolationDetail 非空
 * - span 内修改（长度变化）→ accepted=true（容忍 span 内增删）
 * - 多 proposal 场景：只改各自 span 内 → 通过
 *
 * 测试从 dist/ 导入构建产物（与现有 novelos-*.test.mjs 一致）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_ROOT = join(__dirname, "..", "dist");

const patchServiceUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "agent", "candidate-patch-service.js"),
).href;

const { createCandidatePatchService } = await import(patchServiceUrl);

// ============================================================================
// 辅助：构造 PatchProposal
// ============================================================================

function makeProposal(start, end) {
  return {
    findingId: "test-finding-1",
    type: "sentence_patch",
    targetSpan: { start, end, excerpt: "" },
    suggestion: "修复测试",
    repairDirection: `在 span [${start}, ${end}] 范围内修复`,
    applied: false,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("CandidatePatchService — span 外不变性检查", () => {
  test("span 外正文保持不变 → accepted=true, spanImmutabilityPassed=true", () => {
    const service = createCandidatePatchService();
    const original = "前面这段正文保持不变。需要修复的目标内容。后面这段也保持不变。";
    // span [10, 16] = "需要修复的目标内容"（6 字符，"需要修复的目标内容" 实际 9 字符）
    // 重新定位：原文字符索引
    // "前面这段正文保持不变。" = 11 字符（含句号）
    // "需要修复的目标内容。" = 10 字符
    // "后面这段也保持不变。" = 11 字符
    const spanStart = 11;
    const spanEnd = 20; // "需要修复的目标内容"（不含句号）
    const proposal = makeProposal(spanStart, spanEnd);

    // patch 只改 span 内内容
    const patched = "前面这段正文保持不变。已经修复好的新内容。后面这段也保持不变。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "span 外不变应接受");
    assert.equal(result.metrics.spanImmutabilityPassed, true, "spanImmutabilityPassed 应为 true");
    assert.equal(result.metrics.spanViolationDetail, undefined, "无违规详情");
  });

  test("span 外正文被修改 → accepted=false, spanImmutabilityPassed=false", () => {
    const service = createCandidatePatchService();
    const original = "前面这段正文保持不变。需要修复的目标内容。后面这段也保持不变。";
    const spanStart = 11;
    const spanEnd = 20;
    const proposal = makeProposal(spanStart, spanEnd);

    // patch 暗改了 span 外内容（"前面这段正文保持不变" → "前面这段正文被暗改了"）
    const patched = "前面这段正文被暗改了。已经修复好的新内容。后面这段也保持不变。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "span 外被改应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(result.metrics.spanViolationDetail, "spanViolationDetail 应非空");
    assert.ok(
      result.metrics.spanViolationDetail.includes("span 外"),
      `违规详情应说明 span 外被修改，实际：${result.metrics.spanViolationDetail}`,
    );
    assert.equal(proposal.rejected, true, "proposal 应标记 rejected");
    assert.ok(
      proposal.rejectionReason?.includes("span 外"),
      "rejectionReason 应说明 span 外违规",
    );
  });

  test("span 内长度变化（增删）→ accepted=true（容忍 span 内修改）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段正文保持不变。需要修复的目标内容。后面这段也保持不变。";
    const spanStart = 11;
    const spanEnd = 20;
    const proposal = makeProposal(spanStart, spanEnd);

    // patch 在 span 内大幅增加内容（长度从 9 → 50），span 外不变
    const patched = "前面这段正文保持不变。这里是修复后大幅扩展的新内容增加了许多文字保持语义完整。后面这段也保持不变。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "span 内长度变化应接受");
    assert.equal(result.metrics.spanImmutabilityPassed, true, "span 外不变 → true");
    assert.ok(result.metrics.lengthRatio > 0.7, "长度比应 > 0.7（span 内增加不影响）");
  });

  test("span 外尾部正文被删除 → accepted=false", () => {
    const service = createCandidatePatchService();
    const original = "开头正文。需要修复的目标。结尾正文保持不变。";
    // "开头正文。" = 5 字符
    // "需要修复的目标。" = 8 字符
    // "结尾正文保持不变。" = 9 字符
    const spanStart = 5;
    const spanEnd = 12; // "需要修复的目标"（不含句号）
    const proposal = makeProposal(spanStart, spanEnd);

    // patch 删除了尾部 span 外内容
    const patched = "开头正文。已修复好的新内容。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "span 外尾部被删应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(result.metrics.spanViolationDetail, "应有违规详情");
  });

  test("空 repairRanges（无 span 约束）→ spanImmutabilityPassed=true（无不可变段）", () => {
    const service = createCandidatePatchService();
    const original = "任意正文内容。";
    const proposal = makeProposal(0, 0); // 空 range

    const patched = "完全不同的正文。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    // 空 range → 整个原文都是不可变段，但 patched 完全不同 → 应拒绝
    // 实际上空 range 会被 filter(r => r.end > r.start) 过滤掉
    // 所以整个原文成为一个不可变段
    assert.equal(result.metrics.spanImmutabilityPassed, false, "空 range → 全文不可变 → patched 不同应拒绝");
  });
});

// ============================================================================
// M1.1 加固测试：段落顺序倒置防护
// ============================================================================

describe("CandidatePatchService — span 不变性加固（段落顺序防护）", () => {
  test("段落顺序倒置：span 外段 A 和 C 顺序颠倒 → rejected（核心加固）", () => {
    const service = createCandidatePatchService();
    // 原文：A + B + C，span 覆盖 B
    // A = "前面不可变段A。"（7 字符）
    // B = "需要修复的B内容。"（9 字符，span 内）
    // C = "后面不可变段C。"（7 字符）
    const aContent = "前面不可变段A。";
    const bContent = "需要修复的B内容。";
    const cContent = "后面不可变段C。";
    const original = aContent + bContent + cContent;
    const spanStart = aContent.length;
    const spanEnd = aContent.length + bContent.length;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched：把 C 移到 A 前面，B 保留在 span 内 → patched = C + B + A
    // 旧算法（子串检查）：A 和 C 都作为子串存在 → 通过（漏洞！段落顺序被打乱）
    // 新算法（按序非重叠）：不可变段顺序 [A, C]，patched 中 A 在 C 之后
    //   找 A：从 searchFrom=0，A 在 C+B 之后
    //   找 C：从 searchFrom=A 结尾，C 必须在 A 之后 → C 在 A 之前 → 找不到 → rejected
    const patched = cContent + bContent + aContent;

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "段落顺序倒置应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(result.metrics.spanViolationDetail, "应有违规详情");
    assert.equal(proposal.rejected, true, "proposal 应标记 rejected");
  });

  test("正常 patch（span 内修改，span 外顺序保留）→ accepted=true（回归保护）", () => {
    const service = createCandidatePatchService();
    const aContent = "前面不可变段A。";
    const bContent = "需要修复的B内容。";
    const cContent = "后面不可变段C。";
    const original = aContent + bContent + cContent;
    const spanStart = aContent.length;
    const spanEnd = aContent.length + bContent.length;
    const proposal = makeProposal(spanStart, spanEnd);

    // 正常 patch：只改 span 内 B 内容，A 和 C 保留且顺序不变
    const patched = aContent + "这是修复后的新B内容。" + cContent;

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "正常 patch 应接受");
    assert.equal(result.metrics.spanImmutabilityPassed, true, "span 外不变 → true");
  });

  test("span 外段被删除 → rejected（searchFrom 机制下后续段找不到）", () => {
    const service = createCandidatePatchService();
    const aContent = "前面不可变段A。";
    const bContent = "需要修复的B内容。";
    const cContent = "后面不可变段C。";
    const original = aContent + bContent + cContent;
    const spanStart = aContent.length;
    const spanEnd = aContent.length + bContent.length;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched：删除 A，保留 B（修复后）和 C
    // 不可变段 [A, C]，A 在 patched 中找不到 → rejected
    const patched = "这是修复后的新B内容。" + cContent;

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.metrics.spanImmutabilityPassed, false, "A 被删除应触发 span 违规");
    assert.equal(result.accepted, false, "应拒绝");
  });
});

// ============================================================================
// M1.2 P0-3 严格局部替换验证（prefix/suffix/gap 逐字校验）
// ============================================================================

describe("CandidatePatchService — P0-3 严格 span 不变性", () => {
  test("span 外新增前缀 → rejected（startsWith(prefix) 失败）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段保持不变。需要修复的目标。后面这段也保持不变。";
    // "前面这段保持不变。" = 9 字符（位置 0-8）
    // "需要修复的目标" = 7 字符（位置 9-15）
    const spanStart = 9;
    const spanEnd = 16; // "需要修复的目标"（不含句号）
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 在 span 外前缀前新增了 "新增的前缀文字。"
    const patched = "新增的前缀文字。前面这段保持不变。已经修复好的新内容。后面这段也保持不变。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "span 外新增前缀应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(
      result.metrics.spanViolationDetail?.includes("前缀"),
      `违规详情应说明前缀被修改，实际：${result.metrics.spanViolationDetail}`,
    );
  });

  test("span 外新增后缀 → rejected（endsWith(suffix) 失败）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段保持不变。需要修复的目标。后面这段也保持不变。";
    const spanStart = 9;
    const spanEnd = 16;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 在 span 外后缀后新增了 "这是新增的后缀文字。"
    const patched = "前面这段保持不变。已经修复好的新内容。后面这段也保持不变。这是新增的后缀文字。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "span 外新增后缀应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(
      result.metrics.spanViolationDetail?.includes("后缀"),
      `违规详情应说明后缀被修改，实际：${result.metrics.spanViolationDetail}`,
    );
  });

  test("单 span 场景：span 内插入内容 → accepted（middle 全是 span 内修改）", () => {
    const service = createCandidatePatchService();
    // 原文：A + B + C，span 覆盖 B
    const a = "前面段A。";
    const b = "修复B内容。";
    const c = "后面段C。";
    const original = a + b + c;
    const spanStart = a.length;
    const spanEnd = a.length + b.length;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 在 span 内（B 位置）插入额外内容，span 外 A 和 C 不变
    // 单 span：prefix=A, suffix=C, middle="新B内容。插入的额外内容。"
    // 无 gap 检查，middle 全是 span 内修改 → 通过
    const patched = a + "新B内容。插入的额外内容。" + c;

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "单 span 场景 span 内修改应通过");
    assert.equal(result.metrics.spanImmutabilityPassed, true, "span 外不变 → true");
  });

  test("span 外文本被修改 → rejected（indexOf 找不到或 prefix/suffix 不匹配）", () => {
    const service = createCandidatePatchService();
    // 原文：A + B + C，span 覆盖 B
    const a = "前面段A。";
    const b = "修复B内容。";
    const c = "后面段C。";
    const original = a + b + c;
    const spanStart = a.length;
    const spanEnd = a.length + b.length;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 修改了 span 外的 C（"后面段C。" → "后面段C被改了。"）
    // suffix = "后面段C。" 但 patched 不以它结尾 → 拒绝
    const patched = a + "新B内容。" + "后面段C被改了。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "span 外文本 C 被修改应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
  });

  test("删除 span 外文本 → rejected（endsWith(suffix) 或 indexOf 失败）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段保持不变。需要修复的目标。后面这段也保持不变。";
    const spanStart = 9;
    const spanEnd = 16;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 删除了后缀 "后面这段也保持不变。"
    const patched = "前面这段保持不变。已经修复好的新内容。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "删除 span 外后缀应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
  });

  test("移动 span 外文本 → rejected（prefix/suffix 不匹配）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段保持不变。需要修复的目标。后面这段也保持不变。";
    const spanStart = 9;
    const spanEnd = 16;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 把后缀 "后面这段也保持不变。" 移到前面
    const patched = "后面这段也保持不变。前面这段保持不变。已经修复好的新内容。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "移动 span 外文本应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
  });

  test("越界 span → rejected（范围校验）", () => {
    const service = createCandidatePatchService();
    const original = "短文本。";
    // span 超出原文长度（原文 4 字符，span [2, 100] 越界）
    const proposal = makeProposal(2, 100);

    const patched = "短文本。";
    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "越界 span 应拒绝");
    assert.equal(result.metrics.spanImmutabilityPassed, false, "spanImmutabilityPassed 应为 false");
    assert.ok(
      result.metrics.spanViolationDetail?.includes("非法 span"),
      `违规详情应说明 span 越界，实际：${result.metrics.spanViolationDetail}`,
    );
  });

  test("倒置 span（start >= end）→ rejected（RRB-6.1 范围校验 fail-closed）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段正文。需要修复的目标。后面这段正文。";
    // span start >= end → 被 checkSpanImmutability 范围校验拒绝（不再是静默过滤）
    const proposal = makeProposal(15, 10);

    const patched = "前面这段正文。需要修复的目标。后面这段正文。";
    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    // RRB-6.1：倒置 span 必须 fail-closed 拒绝，不得被 .filter 静默丢弃
    assert.equal(result.metrics.spanImmutabilityPassed, false, "倒置 span 应被拒绝");
    assert.equal(result.accepted, false, "倒置 span 应拒绝");
    assert.ok(
      result.metrics.spanViolationDetail?.includes("非法 span"),
      `违规详情应说明 span 非法（倒置/越界），实际：${result.metrics.spanViolationDetail}`,
    );
  });

  test("仅 span 内增删 → accepted=true（回归保护）", () => {
    const service = createCandidatePatchService();
    const original = "前面这段保持不变。需要修复的目标。后面这段也保持不变。";
    const spanStart = 9;
    const spanEnd = 16;
    const proposal = makeProposal(spanStart, spanEnd);

    // patched 只在 span 内大幅增加内容，span 外不变
    const patched = "前面这段保持不变。这里是修复后大幅扩展的新内容增加了许多文字保持语义完整。后面这段也保持不变。";

    const result = service.evaluatePatch(original, patched, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "span 内长度变化应接受");
    assert.equal(result.metrics.spanImmutabilityPassed, true, "span 外不变 → true");
    assert.ok(result.metrics.lengthRatio > 0.7, "长度比应 > 0.7（span 内增加不影响）");
  });
});
