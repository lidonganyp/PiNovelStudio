/**
 * Phase 4A 测试：用户修改差分计算器
 *
 * 验证 user-modification-delta.ts 的核心行为：
 * - 全文 Levenshtein → editDistance（0-1 归一化）
 * - 句级 diff → 修改类型（deletion / insertion / rewording / structural）
 * - 重度修改阈值（heavy）
 * - 空文本边界
 * - 与 ingestor 的集成（modified → loss + weight 加成）
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeUserModificationDelta,
  HEAVY_EDIT_DISTANCE_THRESHOLD,
  MODIFICATION_THRESHOLD,
  REWORDING_SIMILARITY_THRESHOLD,
} from "../dist/v2/learning/user-modification-delta.js";
import { createStrategyPolicyStore } from "../dist/v2/learning/strategy-policy-store.js";
import { createUserFeedbackIngestor } from "../dist/v2/learning/user-feedback-ingestor.js";

describe("Phase 4A: user-modification-delta — 用户修改差分计算", () => {
  it("完全相同文本 → modified=false, editDistance=0", () => {
    const text = "叶尘推开石门，走入密室。他拿起古籍。";
    const delta = computeUserModificationDelta(text, text);
    assert.equal(delta.modified, false, "相同文本不应视为修改");
    assert.equal(delta.editDistance, 0, "editDistance 应为 0");
    assert.equal(delta.heavy, false, "不应为重度修改");
    assert.equal(delta.modificationSpans.length, 0, "不应有修改 span");
  });

  it("微小修改（标点变化）→ modified=false（低于 MODIFICATION_THRESHOLD）", () => {
    // 长文本中单个标点差异：editDistance = 1/length，足够低
    const delivered = "叶尘推开石门，走入密室。他拿起古籍，翻阅片刻。古籍中记载着上古秘法。他决定修炼此法。这是一段较长的文本用于测试微小修改不应触发修改判定。";
    const userFinal = "叶尘推开石门，走入密室。他拿起古籍，翻阅片刻。古籍中记载着上古秘法。他决定修炼此法。这是一段较长的文本用于测试微小修改不应触发修改判定"; // 缺末尾句号
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.equal(delta.modified, false, `单个标点差异不应视为修改，editDistance=${delta.editDistance}`);
    assert.ok(delta.editDistance < MODIFICATION_THRESHOLD, `editDistance=${delta.editDistance} 应 < ${MODIFICATION_THRESHOLD}`);
  });

  it("删句：用户删了一个句子 → modified=true, deletion=1", () => {
    const delivered = "叶尘推开石门。他拿起古籍。林默进入山洞。";
    const userFinal = "叶尘推开石门。他拿起古籍。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.equal(delta.modified, true, "删句应视为修改");
    assert.ok(delta.modificationTypes.deletion >= 1, `应至少有 1 个 deletion，实际: ${delta.modificationTypes.deletion}`);
    assert.equal(delta.modificationTypes.insertion, 0, "不应有 insertion");
  });

  it("增句：用户加了一个句子 → modified=true, insertion=1", () => {
    const delivered = "叶尘推开石门。他拿起古籍。";
    const userFinal = "叶尘推开石门。他拿起古籍。林默进入山洞。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.equal(delta.modified, true, "增句应视为修改");
    assert.ok(delta.modificationTypes.insertion >= 1, `应至少有 1 个 insertion，实际: ${delta.modificationTypes.insertion}`);
    assert.equal(delta.modificationTypes.deletion, 0, "不应有 deletion");
  });

  it("改措辞：句子相似但非完全相同 → rewording", () => {
    const delivered = "叶尘缓缓推开那扇沉重的石门，走入幽暗的密室。";
    const userFinal = "叶尘缓缓推开那扇沉重的石门，走进了幽暗的密室。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.equal(delta.modified, true, "改措辞应视为修改");
    // 应该有至少 1 个 rewording（相似度 >= REWORDING_SIMILARITY_THRESHOLD）
    const rewordingSpans = delta.modificationSpans.filter((s) => s.type === "rewording");
    assert.ok(
      rewordingSpans.length >= 1 || delta.modificationTypes.rewording >= 1,
      `应有 rewording（spans=${rewordingSpans.length}, typeCount=${delta.modificationTypes.rewording}）`,
    );
  });

  it("重度修改：editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD → heavy=true", () => {
    // 大段重写：长 delivered，完全不同的 userFinal
    const delivered = "叶尘推开石门，走入密室。他拿起古籍，翻阅片刻。古籍中记载着上古秘法。他决定修炼此法。";
    const userFinal = "苏婉站在竹阁前。微风吹过，竹叶沙沙作响。她望向远方，若有所思。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.equal(delta.modified, true, "全文重写应视为修改");
    assert.ok(delta.editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD, `editDistance=${delta.editDistance} 应 >= ${HEAVY_EDIT_DISTANCE_THRESHOLD}`);
    assert.equal(delta.heavy, true, "应为重度修改");
  });

  it("空文本边界：双方都为空 → modified=false", () => {
    const delta = computeUserModificationDelta("", "");
    assert.equal(delta.modified, false, "双方空文本不应视为修改");
    assert.equal(delta.editDistance, 0, "editDistance 应为 0");
  });

  it("空文本边界：delivered 为空但 userFinal 有内容 → insertion", () => {
    const delta = computeUserModificationDelta("", "叶尘推开石门。");
    assert.equal(delta.modified, true, "应视为修改");
    assert.equal(delta.editDistance, 1, "editDistance 应为 1（全文插入）");
    assert.equal(delta.heavy, true, "应为重度修改");
    assert.equal(delta.modificationTypes.insertion, 1, "应有 1 个 insertion");
  });

  it("空文本边界：delivered 有内容但 userFinal 为空 → deletion", () => {
    const delta = computeUserModificationDelta("叶尘推开石门。", "");
    assert.equal(delta.modified, true, "应视为修改");
    assert.equal(delta.editDistance, 1, "editDistance 应为 1（全文删除）");
    assert.equal(delta.heavy, true, "应为重度修改");
    assert.equal(delta.modificationTypes.deletion, 1, "应有 1 个 deletion");
  });

  it("修改 span 包含位置信息（deliveredStart/End + userStart/End）", () => {
    const delivered = "叶尘推开石门。他拿起古籍。";
    const userFinal = "叶尘推开石门。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    const deletionSpans = delta.modificationSpans.filter((s) => s.type === "deletion");
    assert.ok(deletionSpans.length >= 1, "应有 deletion span");
    const span = deletionSpans[0];
    assert.ok(span.deliveredStart >= 0, "deliveredStart 应 >= 0");
    assert.ok(span.deliveredEnd > span.deliveredStart, "deliveredEnd 应 > deliveredStart");
    assert.ok(span.deliveredExcerpt.length > 0, "deliveredExcerpt 应非空");
  });

  it("reason 字段包含可读摘要（用于 trace 审计）", () => {
    const delivered = "叶尘推开石门。他拿起古籍。";
    const userFinal = "叶尘推开石门。";
    const delta = computeUserModificationDelta(delivered, userFinal);
    assert.ok(delta.reason.length > 0, "reason 应非空");
    assert.match(delta.reason, /editDistance/, "reason 应包含 editDistance");
    assert.match(delta.reason, /删除/, "reason 应包含修改类型摘要");
  });

  it("与 ingestor 集成：computedDelta.modified=true → ingestEdit 记录 loss", () => {
    const delivered = "叶尘推开石门。他拿起古籍。";
    const userFinal = "叶尘推开石门。";
    const delta = computeUserModificationDelta(delivered, userFinal);

    const store = createStrategyPolicyStore("test-ws");
    const ingestor = createUserFeedbackIngestor();
    const result = ingestor.ingestEdit(store, {
      context: {
        sourceChapter: "ch1",
        modelVersion: "test-model-v1",
        strategyId: "guidance_reduction",
        opportunityType: "author_style",
      },
      deliveredSource: "editorial",
      modified: delta.modified,
      editDistance: delta.editDistance,
      note: delta.reason,
    });

    assert.equal(result.outcome, "loss", "用户修改 editorial 应记为 loss");
    assert.equal(result.recorded, true, "应记录 evidence");
    assert.ok(result.weight >= 3, `weight 应 >= 3（用户修改基础权重），实际: ${result.weight}`);
  });

  it("与 ingestor 集成：computedDelta.modified=false → ingestEdit 不记录（隐性接受）", () => {
    const text = "叶尘推开石门。他拿起古籍。";
    const delta = computeUserModificationDelta(text, text);

    const store = createStrategyPolicyStore("test-ws");
    const ingestor = createUserFeedbackIngestor();
    const result = ingestor.ingestEdit(store, {
      context: {
        sourceChapter: "ch1",
        modelVersion: "test-model-v1",
        strategyId: "guidance_reduction",
        opportunityType: "author_style",
      },
      deliveredSource: "editorial",
      modified: delta.modified,
      editDistance: delta.editDistance,
    });

    assert.equal(result.recorded, false, "未修改不应记录 evidence");
  });

  it("REWORDING_SIMILARITY_THRESHOLD 阈值合理（0.5）", () => {
    assert.ok(REWORDING_SIMILARITY_THRESHOLD > 0 && REWORDING_SIMILARITY_THRESHOLD < 1, "阈值应在 0-1 之间");
    assert.equal(REWORDING_SIMILARITY_THRESHOLD, 0.5, "默认阈值应为 0.5");
  });

  it("MODIFICATION_THRESHOLD 阈值合理（0.02）", () => {
    assert.ok(MODIFICATION_THRESHOLD > 0 && MODIFICATION_THRESHOLD < 0.1, "阈值应 > 0 且 < 0.1");
  });

  it("HEAVY_EDIT_DISTANCE_THRESHOLD 阈值合理（0.3）", () => {
    assert.ok(HEAVY_EDIT_DISTANCE_THRESHOLD > MODIFICATION_THRESHOLD, "heavy 阈值应 > modification 阈值");
    assert.ok(HEAVY_EDIT_DISTANCE_THRESHOLD < 1, "heavy 阈值应 < 1");
  });
});
