/**
 * PiNovelStudio — ChineseNarrativeNaturalnessScanner 单元测试
 *
 * 验证：
 * - 低/中/高风险文本的 riskLevel 判定
 * - 各 density 指标归一化（每 3000 字）
 * - findings 结构（type/text/index/suggestion）
 * - 空文本、纯对话、短文本不崩溃不误报
 * - scanner 不修改输入正文
 *
 * 规范来源：chinese-narrative-naturalness 历史文档第 4 节示例 + 第 6 节密度自检表（文档已删除）
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createChineseNarrativeNaturalnessScanner,
  buildChineseNaturalnessHints,
} from "../dist/craft/chinese-narrative-naturalness-scanner.js";

describe("ChineseNarrativeNaturalnessScanner", () => {
  const scanner = createChineseNarrativeNaturalnessScanner();

  it("空文本：返回 low 风险，不崩溃", () => {
    const result = scanner.scan("");
    assert.strictEqual(result.riskLevel, "low");
    assert.strictEqual(result.findings.length, 0);
    assert.strictEqual(result.temporalClauseDensity, 0);
    assert.ok(result.summary.includes("文本为空"));
  });

  it("低风险文本：自然中文写法，无 AI 腔堆叠", () => {
    // 模仿 docs 第 4 节"更自然写法"：动作顺承、身体反应、具体细节
    const text = [
      "他推开门。寒风扑面。",
      "屋里没人吭声。几个人都没动，连杯子也没人碰。",
      "他把屋里的灯都打开了，还是觉得空。",
      "她没回头，先把门反锁了。",
      "他往后看了一眼。门已经关上了。",
      "走廊像走不到头。灯坏了两盏，他每走一步都忍不住回头。",
      "他坐下没多久，指节就冻得发白。",
      "“再说一遍。”他把筷子搁下，声音很轻。",
      "她拿起包，走了。",
      "楼下的灯也灭了。",
      "他反而安静下来，把门关上，问：“谁让你来的？”",
    ].join("\n");
    // 重复到足够长度以触发 density 统计（>600 字）
    const longText = text.repeat(4);
    const result = scanner.scan(longText);
    assert.strictEqual(result.riskLevel, "low", `expected low, summary=${result.summary}`);
    assert.ok(result.temporalClauseDensity < 3, `temporal density should be low: ${result.temporalClauseDensity}`);
    assert.ok(result.psychologyExplanationDensity < 6, `psychology density should be low: ${result.psychologyExplanationDensity}`);
  });

  it("高风险文本：AI 腔密集堆叠（然而/感到/沉默笼罩/呢喃道/命运的齿轮/有些人）", () => {
    // 模仿 docs 第 4 节"AI 式写法"，密集堆叠各类出戏点
    const text = [
      "当推开门的时候，一阵寒风扑面而来。",
      "然而，他并没有立刻回答。",
      "他感到前所未有的孤独。",
      "她意识到自己被背叛了。",
      "恐惧攫住了他的心脏。",
      "沉默笼罩着整个房间。",
      "不安在空气中蔓延。",
      "“我知道了。”他低声呢喃道。",
      "“凭什么！”她高声反驳道。",
      "“原来如此。”他若有所思地叹息道。",
      "他不知道的是，真正的危险正在靠近。",
      "命运的齿轮，在这一刻悄然转动。",
      "有些人一旦错过，就再也回不去了。",
      "与此同时，楼下的灯也熄灭了。",
      "因此，她选择了离开。",
      "换句话说，他终于明白，所谓成长，就是学会与过去告别。",
      "显然，他内心充满愤怒。",
      "事实上，他震惊地看着眼前的一切。",
      "他明白，这意味着一切都结束了。",
      "毫无疑问，从此以后，他再也回不去了。",
    ].join("\n");
    // 重复到足够长度
    const longText = text.repeat(3);
    const result = scanner.scan(longText);
    assert.ok(result.riskLevel === "medium" || result.riskLevel === "high",
      `expected medium or high, got ${result.riskLevel}, summary=${result.summary}`);
    // 高密度出戏点应触发 high
    assert.strictEqual(result.riskLevel, "high", `dense AI residue should be high: ${result.summary}`);
    // 应命中多种类型
    const types = new Set(result.findings.map((f) => f.type));
    assert.ok(types.has("temporal_clause"), "should detect temporal_clause");
    assert.ok(types.has("logical_connector"), "should detect logical_connector");
    assert.ok(types.has("psychology_explanation"), "should detect psychology_explanation");
    assert.ok(types.has("abstract_subject"), "should detect abstract_subject");
    assert.ok(types.has("performative_dialogue_tag"), "should detect performative_dialogue_tag");
    assert.ok(types.has("pov_leak"), "should detect pov_leak");
    assert.ok(types.has("golden_sentence"), "should detect golden_sentence");
  });

  it("中风险文本：适度出现时间容器句与心理解释", () => {
    // 干净叙事段（无 AI 腔），重复到足够长度以启用 density 统计
    const cleanPara = "他推开门。寒风扑面。屋里没人吭声。几个人都没动，连杯子也没人碰。他把屋里的灯都打开了，还是觉得空。她没回头，先把门反锁了。走廊像走不到头。灯坏了两盏，他每走一步都忍不住回头。他往后看了一眼，门已经关上了。";
    // 适度 AI 腔：3 时间容器句 + 5 心理解释 + 2 逻辑连接词
    const hits = [
      "当他推开门的时候，寒风扑面。",
      "在她说出那句话的瞬间，屋里没人再出声。",
      "灯光熄灭的一刻，有人倒吸了一口气。",
      "他感到有些不对劲。",
      "她意识到情况复杂。",
      "他明白这不是巧合。",
      "她发现窗外的灯灭了。",
      "他再次感到不安。",
      "然而，他没说话。",
      "因此，她停下了脚步。",
    ];
    const parts = [];
    for (let i = 0; i < 18; i++) parts.push(cleanPara);
    parts.push(...hits);
    const text = parts.join("\n");
    assert.ok(text.length > 600, `text should exceed density threshold: ${text.length}`);
    const result = scanner.scan(text);
    assert.ok(result.riskLevel === "medium" || result.riskLevel === "high",
      `expected medium or high, got ${result.riskLevel}, summary=${result.summary}`);
  });

  it("纯对话文本：不崩溃，不在对话内的叙事词上误报", () => {
    // 对话内出现"感到/明白"是合法的，不应被叙事层 POV/金句扫描误报
    const text = [
      "“我感到有些害怕。”她说。",
      "“你明白我的意思吗？”他问。",
      "“有些人就是不可理喻。”她摇头。",
      "“原来如此，我明白了。”他点头。",
      "“命运的安排谁也说不准。”老人叹气。",
    ].join("\n");
    const result = scanner.scan(text);
    // 纯对话且短，应为 low（dialogue tag "她说/他问" 不在表演化黑名单内）
    assert.strictEqual(result.riskLevel, "low", `pure dialogue should be low: ${result.summary}`);
    // 对话内的金句词不应进入 goldenSentenceFindings（已剥离对话）
    // 注意："她说/他问/他点头" 不是表演化标签，不应命中
    const tagHits = result.findings.filter((f) => f.type === "performative_dialogue_tag");
    assert.strictEqual(tagHits.length, 0, `simple tags should not be flagged: ${JSON.stringify(tagHits)}`);
  });

  it("短文本：少量命中不因密度归一化被放大成误报", () => {
    // 200 字内出现 1 处"感到"和 1 处"然而"，不应触发 medium
    const text = "他推开门。寒风扑面。屋里没人吭声。然而，他没说话。她感到有些不对劲，先把门反锁了。走廊像走不到头。灯坏了两盏。他往后看了一眼，门已经关上了。";
    const result = scanner.scan(text);
    assert.strictEqual(result.riskLevel, "low", `short text should be low: ${result.summary}`);
    assert.strictEqual(result.temporalClauseDensity, 0, "short text density should be 0");
    assert.strictEqual(result.psychologyExplanationDensity, 0, "short text density should be 0");
  });

  it("findings 结构：每条带 type/text/index/suggestion", () => {
    const text = "当推开门的时候，然而，他感到恐惧攫住了他。他不知道的是，真正的危险正在靠近。命运的齿轮悄然转动。有些人一旦错过就再也回不去了。";
    // 拼长以启用 density
    const longText = (text + "\n").repeat(8);
    const result = scanner.scan(longText);
    assert.ok(result.findings.length > 0, "should have findings");
    for (const f of result.findings) {
      assert.ok(typeof f.type === "string", "type must be string");
      assert.ok(typeof f.text === "string" && f.text.length > 0, "text must be non-empty string");
      assert.ok(typeof f.index === "number" && f.index >= 0, "index must be non-negative number");
      assert.ok(typeof f.suggestion === "string" && f.suggestion.length > 0, "suggestion must be non-empty string");
    }
    // findings 按 index 升序
    for (let i = 1; i < result.findings.length; i++) {
      assert.ok(result.findings[i].index >= result.findings[i - 1].index, "findings should be sorted by index");
    }
  });

  it("scanner 不修改输入正文", () => {
    const text = "当推开门的时候，他感到恐惧攫住了他。然而，他没说话。".repeat(10);
    const snapshot = text;
    scanner.scan(text);
    assert.strictEqual(text, snapshot, "scanner must not mutate input text");
  });

  it("长定语/“的”字堆叠检测：单句“的”>3 触发 modifierStack", () => {
    const longModifierSentence = "那个穿着黑色大衣的、戴着一顶旧帽子的、脸色苍白的、眼神冷漠的男人站在门口的阴影里。";
    // 拼到 600+ 字
    const text = (longModifierSentence + "\n").repeat(12);
    const result = scanner.scan(text);
    assert.ok(result.modifierStackFindings.length > 0, "should detect modifier stack");
    assert.ok(result.modifierStackFindings[0].type === "modifier_stack");
    assert.ok(result.modifierStackFindings[0].suggestion.includes("的"), "suggestion should mention 的");
  });

  it("buildChineseNaturalnessHints：按优先级构造修订 hints", () => {
    const text = [
      "当推开门的时候，然而，他感到恐惧攫住了他。",
      "他不知道的是，真正的危险正在靠近。",
      "命运的齿轮悄然转动。所谓成长就是再也回不去了。",
      "“我知道了。”他低声呢喃道。",
    ].join("\n").repeat(6);
    const result = scanner.scan(text);
    const hints = buildChineseNaturalnessHints(result);
    assert.ok(Array.isArray(hints), "hints must be array");
    // 心理解释优先级最高，应出现在靠前位置
    if (hints.length > 0) {
      assert.ok(hints.length <= 6, "hints should be capped at 6");
      // 心理解释应优先于逻辑连接词
      const psychIdx = hints.findIndex((h) => h.includes("心理解释"));
      const logicalIdx = hints.findIndex((h) => h.includes("逻辑连接词"));
      if (psychIdx >= 0 && logicalIdx >= 0) {
        assert.ok(psychIdx < logicalIdx, "psychology should precede logical connector");
      }
      // 每条 hint 应包含"保持事件推进"约束
      for (const h of hints) {
        assert.ok(h.includes("保持事件推进"), `hint should preserve plot: ${h}`);
      }
    }
  });

  it("buildChineseNaturalnessHints：低风险无命中时返回空数组", () => {
    const result = scanner.scan("");
    const hints = buildChineseNaturalnessHints(result);
    assert.deepStrictEqual(hints, []);
  });
});
