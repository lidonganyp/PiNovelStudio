/**
 * Phase 3A 测试：结构化事件抽取器
 *
 * 验证 event-extractor.ts 的核心行为：
 * - action / state_change / state_description 三类事件正确分类
 * - 因果连接词识别（causalParentIds）
 * - 地点实体提取（location）
 * - 不可提取事件标记（extractable=false + skipReason）
 * - 代词绑定到前句主体
 * - 已知实体匹配（characters_only / full_entities）
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractEvents,
  getExtractableEvents,
} from "../dist/v2/core/event-extractor.js";

describe("Phase 3A: event-extractor — 结构化事件抽取", () => {
  it("action 类型：从含动作动词的句子中抽取事件", () => {
    const text = "叶尘推开石门，走入密室。";
    const result = extractEvents(text, ["叶尘", "密室"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);
    assert.ok(extractable.length >= 1, `应至少抽取 1 个事件，实际: ${extractable.length}`);

    const enterEvent = extractable.find((e) => e.action === "推开" || e.action === "走入");
    assert.ok(enterEvent, "应抽取推开/走入动作");
    assert.equal(enterEvent.eventType, "action");
    assert.equal(enterEvent.subject, "叶尘");
    assert.ok(enterEvent.evidenceSpan.excerpt.length > 0, "evidenceSpan.excerpt 应非空");
  });

  it("state_change 类型：状态变化动词被正确分类", () => {
    const text = "林默得到传承，力量出现质变。";
    const result = extractEvents(text, ["林默", "传承"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    const stateChange = extractable.find((e) => e.eventType === "state_change");
    assert.ok(stateChange, "应识别 state_change 事件");
    assert.ok(
      stateChange.action === "得到" || stateChange.action === "出现",
      `action 应为得到/出现，实际: ${stateChange.action}`,
    );
    assert.ok(stateChange.afterState.length > 0 || stateChange.result.length > 0, "state_change 应有 afterState 或 result");
  });

  it("state_description 类型：纯状态描述不作为动作反转证据", () => {
    // "是" "有" "在" 等判断动词不构成可提取动作事件
    const text = "天空是蓝色的。山上有座庙。";
    const result = extractEvents(text, [], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);
    // 无动作动词 → 无可提取事件（或仅 state_description）
    const actions = extractable.filter((e) => e.eventType === "action");
    assert.equal(actions.length, 0, "纯状态描述不应产生 action 事件");
  });

  it("不可提取事件标记 extractable=false + skipReason", () => {
    // 单独名字句（去标点后只剩实体名）→ extractable=false
    const text = "叶尘。";
    const result = extractEvents(text, ["叶尘"], { entityCoverage: "full_entities" });
    const nonExtractable = result.events.filter((e) => !e.extractable);
    assert.ok(nonExtractable.length >= 1, "应有单独名字句的不可提取事件");
    assert.ok(nonExtractable[0].skipReason, "不可提取事件应有 skipReason");
    assert.equal(nonExtractable[0].skipReason, "单独名字，无动作或状态变化");
  });

  it("纯判断句 extractable=false：含'不是'无动作动词", () => {
    // 判断标记检测：/不是/ 或 /(^|，)是/ 或 /^是/
    const text = "叶尘不是废物。";
    const result = extractEvents(text, ["叶尘"], { entityCoverage: "full_entities" });
    const nonExtractable = result.events.filter((e) => !e.extractable);
    assert.ok(nonExtractable.length >= 1, "含'不是'的纯判断句应不可提取");
    assert.equal(nonExtractable[0].skipReason, "纯判断/指认句，无动作或状态变化");
  });

  it("代词绑定：他/她/它 绑定到前句主体", () => {
    const text = "叶尘站在悬崖边。他纵身跳下。";
    const result = extractEvents(text, ["叶尘"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    const jumpEvent = extractable.find((e) => e.action === "跳");
    assert.ok(jumpEvent, "应抽取跳动作");
    // 代词"他"应绑定到前句主体"叶尘"
    assert.equal(jumpEvent.subject, "叶尘", `代词应绑定到叶尘，实际: ${jumpEvent.subject}`);
  });

  it("地点提取：进入/离开/到达 等介词识别 location", () => {
    const text = "苏婉进入竹阁，找到古卷。";
    const result = extractEvents(text, ["苏婉", "竹阁", "古卷"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    const enterEvent = extractable.find((e) => e.action === "进入");
    assert.ok(enterEvent, "应抽取进入动作");
    assert.equal(enterEvent.location, "竹阁", `location 应为竹阁，实际: ${enterEvent.location}`);
  });

  it("因果连接词识别 causalChains", () => {
    // 因果连接词 "之后" 需要在两个子句之间有实际内容才形成因果链。
    // P0-1b 修复后，"，然后" 等标点紧邻连接词的情况也能正确识别因果链。
    const text = "叶尘翻开古籍之后他找到线索。";
    const result = extractEvents(text, ["叶尘", "古籍", "线索"], { entityCoverage: "full_entities" });

    // 因果链应被检测到
    assert.ok(result.causalChains.length >= 1, `应检测到至少 1 条因果链，实际: ${result.causalChains.length}`);
    const chain = result.causalChains[0];
    assert.ok(chain.connector, "因果链应有连接词");
    assert.ok(chain.beforeClause.length > 0, `beforeClause 应非空，实际: "${chain.beforeClause}"`);
    assert.ok(chain.afterClause.length > 0, `afterClause 应非空，实际: "${chain.afterClause}"`);
    assert.ok(chain.beforeSpan.excerpt.length > 0, "beforeSpan.excerpt 应非空");
    assert.ok(chain.afterSpan.excerpt.length > 0, "afterSpan.excerpt 应非空");
  });

  // ── P0-1b 生产探针：因果图父子事件连接 ────────────────────────────
  // 用户反馈：心魔界 1-17 章共识别 10 条因果链、2003 个可提取事件，
  // 但 causalParentIds 命中数为 0。原因是标点紧邻连接词时 beforeClause 为空，
  // 且 span 匹配使用严格包含而非 overlap。
  it("P0-1b 生产探针：逗号+然后 的因果链应建立父子事件连接", () => {
    const text = "叶尘推开石门，然后走入密室。";
    const result = extractEvents(text, ["叶尘", "石门", "密室"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    // 应检测到因果链（"然后" 前有逗号也不应导致 beforeClause 为空）
    assert.ok(result.causalChains.length >= 1, `应检测到因果链，实际: ${result.causalChains.length}`);

    // 应有至少一个事件含 causalParentIds
    const eventsWithParents = extractable.filter((e) => e.causalParentIds.length > 0);
    assert.ok(
      eventsWithParents.length >= 1,
      `应有至少 1 个事件含 causalParentIds，实际: ${eventsWithParents.length}，events: ${JSON.stringify(extractable.map((e) => ({ action: e.action, subject: e.subject, causalParentIds: e.causalParentIds })))}`,
    );
  });

  it("P0-1b 生产探针：无标点连接词的因果链也应建立父子连接", () => {
    const text = "叶尘翻开古籍之后他找到线索。";
    const result = extractEvents(text, ["叶尘", "古籍", "线索"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    const eventsWithParents = extractable.filter((e) => e.causalParentIds.length > 0);
    assert.ok(
      eventsWithParents.length >= 1,
      `无标点连接词也应建立父子连接，实际: ${eventsWithParents.length}，events: ${JSON.stringify(extractable.map((e) => ({ action: e.action, subject: e.subject, causalParentIds: e.causalParentIds })))}`,
    );
  });

  it("P0-1b 生产探针：然后 子句主语应绑定到前句主体", () => {
    const text = "叶尘推开石门，然后走入密室。";
    const result = extractEvents(text, ["叶尘", "石门", "密室"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    // "走入" 事件的 subject 应为 "叶尘"（通过 lastSubject 绑定），而非 "密室"
    const walkEvent = extractable.find((e) => e.action === "走入");
    assert.ok(walkEvent, `应抽取 "走入" 事件，实际 actions: ${JSON.stringify(extractable.map((e) => e.action))}`);
    assert.equal(
      walkEvent.subject,
      "叶尘",
      `"然后走入密室" 的 subject 应为 "叶尘"（lastSubject 绑定），实际: "${walkEvent.subject}"`,
    );
  });

  it("characters_only 模式：只匹配角色名", () => {
    const text = "叶尘拿起古卷。古卷发出金光。";
    const result = extractEvents(text, ["叶尘", "古卷"], { entityCoverage: "characters_only" });
    const extractable = getExtractableEvents(result.events);

    // characters_only 模式下，"古卷发出金光"的主体可能是"古卷"（非角色）
    // 但"叶尘拿起古卷"的"叶尘"是角色，应被抽取
    const yeShenEvents = extractable.filter((e) => e.subject === "叶尘");
    assert.ok(yeShenEvents.length >= 1, "应至少抽取 1 个叶尘的事件");
  });

  it("full_entities 模式：匹配全部已知实体", () => {
    const text = "叶尘拿起古卷。古卷发出金光。";
    const result = extractEvents(text, ["叶尘", "古卷"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);

    // full_entities 模式下，"古卷"也可作为主体
    const allSubjects = extractable.map((e) => e.subject);
    assert.ok(allSubjects.includes("叶尘"), "应包含叶尘作为主体");
  });

  it("多句文本：每句最多抽取 1 个主事件", () => {
    const text = "叶尘推开门。林默拿起剑。苏婉回头。";
    const result = extractEvents(text, ["叶尘", "林默", "苏婉"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);
    // 三句应产生至少 3 个可提取事件（每句 1 个主事件）
    assert.ok(extractable.length >= 3, `三句应至少抽取 3 个事件，实际: ${extractable.length}`);
  });

  it("证据 span 完整性：excerpt 必须来自原文", () => {
    const text = "叶尘推开石门。";
    const result = extractEvents(text, ["叶尘"], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(result.events);
    for (const event of extractable) {
      // evidenceSpan.excerpt 必须是原文的子串
      assert.ok(
        text.includes(event.evidenceSpan.excerpt),
        `evidenceSpan.excerpt "${event.evidenceSpan.excerpt}" 应在原文中存在`,
      );
      // span 范围必须在文本长度内
      assert.ok(event.evidenceSpan.start >= 0, "span.start 应 >= 0");
      assert.ok(
        event.evidenceSpan.end <= text.length,
        `span.end ${event.evidenceSpan.end} 应 <= text.length ${text.length}`,
      );
      assert.ok(event.evidenceSpan.end > event.evidenceSpan.start, "span.end 应 > span.start");
    }
  });

  it("空文本/无实体文本：返回空事件列表", () => {
    const empty = extractEvents("", [], { entityCoverage: "full_entities" });
    assert.equal(empty.events.length, 0, "空文本应返回 0 事件");

    const noEntity = extractEvents("风很大。雨也很大。", [], { entityCoverage: "full_entities" });
    const extractable = getExtractableEvents(noEntity.events);
    // 无已知实体时，无法确定主体 → 不可提取
    assert.equal(extractable.length, 0, "无实体文本应无可提取事件");
  });
});
