/**
 * Phase 3B 测试：事件账本比对器
 *
 * 验证 event-ledger-comparator.ts 的核心行为：
 * - 事件删除检测（missingEvents）
 * - 事件替换检测（replacedEvents）
 * - 状态变化丢失检测（stateChangeLosses）
 * - 不可验证边界（unverifiable）
 * - 保守通过（preserved=true 当事件骨架保持）
 * - advisory 相似度不阻断
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";

const KNOWN_ENTITIES = ["叶尘", "林默", "苏婉", "密室", "古籍", "线索", "传承"];

function buildLedgerInput(rawText, editorialText, entities = KNOWN_ENTITIES) {
  const rawResult = extractEvents(rawText, entities, { entityCoverage: "full_entities" });
  const editorialResult = extractEvents(editorialText, entities, { entityCoverage: "full_entities" });
  return {
    rawEvents: rawResult.events,
    editorialEvents: editorialResult.events,
    rawCausalChains: rawResult.causalChains,
    editorialCausalChains: editorialResult.causalChains,
    knownEntities: entities,
    entityCoverage: "full_entities",
    rawText,
    editorialText,
  };
}

describe("Phase 3B: event-ledger-comparator — 事件账本比对", () => {
  it("保守通过：editorial 保留 raw 的核心事件骨架 → preserved=true", () => {
    const raw = "叶尘推开石门，走入密室。他拿起古籍。";
    const editorial = "叶尘推开石门，走入密室。他拿起古籍，翻阅片刻。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.equal(result.unverifiable, false, "不应不可验证");
    assert.equal(result.preserved, true, `应通过故事保持，实际: ${result.reason}`);
    assert.equal(result.rejectionType, null, "无拒绝类型");
  });

  it("事件删除：editorial 删除 raw 的关键事件 → preserved=false (missing_event)", () => {
    const raw = "叶尘推开石门，走入密室。他拿起古籍。林默进入山洞。";
    const editorial = "叶尘推开石门，走入密室。他拿起古籍。";
    // 单个关键事件删除用 missingEventThreshold=1 触发；默认阈值 2 用于多事件系统性删除
    const result = compareEventLedgers({ ...buildLedgerInput(raw, editorial), missingEventThreshold: 1 });
    // 删除了"林默进入山洞"事件
    assert.equal(result.preserved, false, "删除关键事件应不通过");
    // 拒绝类型可能是 missing_event 或其他（取决于阈值）
    assert.ok(
      result.rejectionType === "missing_event" || result.missingEvents.length > 0,
      `应检测到缺失事件，rejectionType=${result.rejectionType}, missingEvents=${result.missingEvents.length}`,
    );
  });

  it("不可验证：raw 无可提取事件 → unverifiable=true", () => {
    const raw = "风很大。"; // 无实体无动作 → 无事件
    const editorial = "叶尘推开石门。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.equal(result.unverifiable, true, "raw 无事件应不可验证");
    assert.equal(result.preserved, false, "不可验证应 preserved=false");
    assert.equal(result.rejectionType, "unverifiable");
  });

  it("不可验证：editorial 无可提取事件 → unverifiable=true", () => {
    const raw = "叶尘推开石门。";
    const editorial = "风很大。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.equal(result.unverifiable, true, "editorial 无事件应不可验证");
    assert.equal(result.rejectionType, "unverifiable");
  });

  it("事件替换：同 subject 但 action 反转（封印→释放）→ preserved=false (replaced_event)", () => {
    const raw = "叶尘封印魔物。";
    const editorial = "叶尘释放魔物。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["叶尘", "魔物"]));
    assert.equal(result.preserved, false, "动作反转应不通过");
    assert.ok(
      result.rejectionType === "replaced_event" || result.replacedEvents.length > 0,
      `应检测到事件替换，rejectionType=${result.rejectionType}, replacedEvents=${result.replacedEvents.length}`,
    );
  });

  it("保留人物但整章换事件：preserved=false", () => {
    // raw 讲叶尘推开石门拿古籍；editorial 保留叶尘但换成品茶
    const raw = "叶尘推开石门，走入密室。他拿起古籍。";
    const editorial = "叶尘坐下喝茶。他看向窗外。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.equal(result.preserved, false, "保留人物但换事件应不通过");
    assert.ok(
      result.rejectionType !== null,
      `应有拒绝类型，实际: ${result.rejectionType}`,
    );
  });

  it("状态变化丢失：raw 有 state_change 但 editorial 缺失 → state_change_loss", () => {
    const raw = "叶尘得到传承。";
    const editorial = "叶尘思考人生。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["叶尘", "传承"]));
    // "得到" 是 state_change，editorial 中没有对应状态变化
    if (result.stateChangeLosses.length > 0) {
      assert.ok(
        result.stateChangeLosses.some((e) => e.afterState === "得到"),
        "应检测到'得到'状态变化丢失",
      );
    }
    // 整体应不通过（事件被替换或状态丢失）
    assert.equal(result.preserved, false, "状态变化丢失应不通过");
  });

  it("advisory 相似度：文本相似但不阻断（相似度证据记录但不触发 preserved=false）", () => {
    const raw = "叶尘推开石门，走入密室。他拿起古籍。";
    const editorial = "叶尘推开石门，走入密室。他拿起古籍，翻阅片刻。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    // 相似度证据可能存在但不阻断
    assert.equal(result.preserved, true, "相似度证据不应阻断");
    // advisorySimilarities 是诊断信息，不参与阻断判定
    assert.ok(Array.isArray(result.advisorySimilarities), "advisorySimilarities 应为数组");
  });

  it("阈值参数：missingEventThreshold 可配置", () => {
    const raw = "叶尘推开石门。林默拿起古籍。";
    const editorial = "叶尘推开石门。";
    // 删除了 1 个事件（林默拿起古籍）
    // 默认阈值 missingEventThreshold=2，1 < 2 → 不阻断（但可能有其他检测项阻断）
    const resultDefault = compareEventLedgers({
      ...buildLedgerInput(raw, editorial),
      missingEventThreshold: 2,
    });
    // 阈值设为 1 时，1 >= 1 → 阻断
    const resultStrict = compareEventLedgers({
      ...buildLedgerInput(raw, editorial),
      missingEventThreshold: 1,
    });
    // 严格阈值下应检测到更多缺失
    assert.ok(
      resultStrict.missingEvents.length >= resultDefault.missingEvents.length,
      "严格阈值应检测到不少于默认阈值的缺失事件",
    );
  });

  it("raw/editorial 事件计数正确", () => {
    const raw = "叶尘推开石门。林默拿起古籍。";
    const editorial = "叶尘推开石门。林默拿起古籍。苏婉进入密室。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.ok(result.rawEventCount >= 2, `raw 事件数应 >= 2，实际: ${result.rawEventCount}`);
    assert.ok(result.editorialEventCount >= 3, `editorial 事件数应 >= 3，实际: ${result.editorialEventCount}`);
  });

  it("判定原因写入 trace（reason 非空）", () => {
    const raw = "叶尘推开石门。";
    const editorial = "叶尘推开石门。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial));
    assert.ok(typeof result.reason === "string" && result.reason.length > 0, "reason 应为非空字符串");
  });

  // ── P0-1 生产探针回归测试 ──────────────────────────────────────────
  // 生产探针：raw "交出玉玺并放行" → editorial "只看玉玺并扣留"
  // 预期：检测到动作反转（放行→扣留），preserved=false
  it("P0-1 生产探针：交出玉玺并放行 → 只看玉玺并扣留 = preserved=false", () => {
    const raw = "李天行交出玉玺并放行。";
    const editorial = "李天行只看玉玺并扣留。";
    const entities = ["李天行", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `生产探针应被阻断（交出并放行 → 只看并扣留），实际 preserved=true, reason: ${result.reason}`,
    );
    assert.ok(
      result.replacedEvents.length > 0,
      `应检测到替换事件，实际 replacedEvents=${result.replacedEvents.length}，reason: ${result.reason}`,
    );
    // 至少有一个替换事件涉及动作反转或扣留
    const hasReversalOrDetain = result.replacedEvents.some(
      (e) => e.reversal === true || e.editorialAction.includes("扣留") || e.rawAction.includes("放行"),
    );
    assert.ok(
      hasReversalOrDetain,
      `替换事件应涉及放行/扣留反转，实际: ${JSON.stringify(result.replacedEvents.map((e) => ({ raw: e.rawAction, ed: e.editorialAction, reversal: e.reversal })))}`,
    );
  });

  // P0-1：多事件抽取 —— "并" 连接的两个动作应被分别抽取
  it("P0-1 多事件抽取：'交出玉玺并放行' 应抽取 2 个事件", () => {
    const text = "李天行交出玉玺并放行。";
    const entities = ["李天行", "玉玺"];
    const result = extractEvents(text, entities, { entityCoverage: "full_entities" });
    const extractable = result.events.filter((e) => e.extractable);
    assert.ok(
      extractable.length >= 2,
      `'交出玉玺并放行' 应至少抽取 2 个可提取事件，实际: ${extractable.length}，events: ${JSON.stringify(extractable.map((e) => ({ action: e.action, object: e.object })))}`,
    );
    // 应同时识别 "交出" 和 "放行"
    const actions = extractable.map((e) => e.action);
    assert.ok(actions.includes("交出"), `应识别 '交出' 动作，实际 actions: ${JSON.stringify(actions)}`);
    assert.ok(actions.includes("放行"), `应识别 '放行' 动作，实际 actions: ${JSON.stringify(actions)}`);
  });

  // P0-1：动作反转对 —— 交出/扣留、放行/扣留
  it("P0-1 动作反转：交出→扣留 应被识别为反义词对", () => {
    const raw = "李天行交出玉玺。";
    const editorial = "李天行扣留玉玺。";
    const entities = ["李天行", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(result.preserved, false, "交出→扣留 应被阻断");
    assert.ok(
      result.replacedEvents.some((e) => e.reversal === true),
      `应检测到动作反转，实际: ${JSON.stringify(result.replacedEvents.map((e) => e.reversal))}`,
    );
  });

  // P0-1：位置加分 —— 第二个事件应匹配第二个事件（而非第一个）
  it("P0-1 位置匹配：放行→扣留 应匹配到第二个 editorial 事件", () => {
    const raw = "李天行交出玉玺并放行。";
    const editorial = "李天行查看玉玺并扣留。";
    const entities = ["李天行", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(result.preserved, false, "放行→扣留 反转应被阻断");
    // 应检测到 放行/扣留 反转
    const reversalEvents = result.replacedEvents.filter((e) => e.reversal);
    assert.ok(
      reversalEvents.length > 0,
      `应检测到动作反转事件，实际: ${JSON.stringify(result.replacedEvents.map((e) => ({ raw: e.rawAction, ed: e.editorialAction, reversal: e.reversal })))}`,
    );
  });

  // ── P0-1 第二轮生产探针：单个关键事件替换（非反义词对）也必须阻断 ──
  // 用户反馈：交出玉玺并放行 → 看玉玺并留下 仍为 preserved=true
  // 原因：交出→看、放行→留下 都不是反义词对；单个非反义替换未达 3 次阈值
  // 修复：引入"关键动作"概念，关键动作被任意不同动作替换单个即阻断
  it("P0-1 第二轮生产探针：交出玉玺并放行 → 看玉玺并留下 = preserved=false（关键动作替换）", () => {
    const raw = "李天行交出玉玺并放行。";
    const editorial = "李天行看玉玺并留下。";
    const entities = ["李天行", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `关键动作替换应被阻断（交出→看、放行→留下），实际 preserved=true, reason: ${result.reason}`,
    );
    // 应检测到关键动作替换事件
    const criticalEvents = result.replacedEvents.filter((e) => e.critical);
    assert.ok(
      criticalEvents.length > 0,
      `应检测到关键动作替换事件，实际: ${JSON.stringify(result.replacedEvents.map((e) => ({ raw: e.rawAction, ed: e.editorialAction, critical: e.critical })))}`,
    );
    // 关键动作应为"交出"或"放行"
    const criticalActions = criticalEvents.map((e) => e.rawCriticalAction);
    assert.ok(
      criticalActions.some((a) => a === "交出" || a === "放行"),
      `关键动作应为交出或放行，实际: ${JSON.stringify(criticalActions)}`,
    );
  });

  it("P0-1 第二轮：单个关键动作替换即阻断（不需要累积到 3 次）", () => {
    // 单个关键事件：交出 → 看（非反义词对）
    const raw = "李天行交出玉玺。";
    const editorial = "李天行看玉玺。";
    const entities = ["李天行", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `单个关键动作替换（交出→看）应阻断，实际 preserved=true, reason: ${result.reason}`,
    );
    assert.ok(
      result.replacedEvents.some((e) => e.critical && e.rawCriticalAction === "交出"),
      `应标记为关键替换（交出），实际: ${JSON.stringify(result.replacedEvents.map((e) => ({ raw: e.rawAction, ed: e.editorialAction, critical: e.critical, rawCritical: e.rawCriticalAction })))}`,
    );
  });

  it("P0-1 第二轮：非关键动作替换不触发单个阻断（仍需累积）", () => {
    // 非关键动作：坐下 → 站起（不改变故事状态）
    const raw = "李天行坐在椅子上。";
    const editorial = "李天行站在椅子旁。";
    const entities = ["李天行", "椅子"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    // 单个非关键替换不应阻断（需累积到 3 次）
    assert.equal(
      result.preserved,
      true,
      `单个非关键动作替换（坐→站）不应阻断，实际 preserved=false, reason: ${result.reason}`,
    );
  });

  it("P0-1 第二轮：封印→看 关键动作替换阻断", () => {
    const raw = "李天行封印了魔物。";
    const editorial = "李天行看了魔物。";
    const entities = ["李天行", "魔物"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `封印→看 是关键动作替换应阻断，实际 preserved=${result.preserved}, reason: ${result.reason}`,
    );
    assert.ok(
      result.replacedEvents.some((e) => e.critical && e.rawCriticalAction === "封印"),
      `应标记为关键替换（封印）`,
    );
  });
});
