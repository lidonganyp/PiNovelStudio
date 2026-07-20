/**
 * DEMO-3-R2 RED 测试：Editorial Story Preservation Gate
 *
 * 验证 Case A R1 暴露的故事骨架替换漂移：
 * - raw 含 4 个有序关键事件：梦堂缺位 → 长乘失踪 → 黑雾/蚀神瘴 → 禁星渊
 * - drifted editorial 保留人物和洪逸前情，但删除上述主要事件，新增"洪摩逆推/灵脉水道"故事线
 * - preserved editorial 只加强章末压力，保留全部关键事件和因果顺序
 *
 * 期望行为（GREEN 后）：
 * - drifted editorial: preserved === false，missingEvents 含黑雾/蚀神瘴/禁星渊相关锚点
 * - preserved editorial: preserved === true，允许进入 judge
 * - 模拟 selection：gate 拒绝 drifted 后，该 candidate 不进入 editorialWins → fallbacked=true
 *
 * RED 阶段：模块 ../dist/v2/core/editorial-story-preservation-gate.js 不存在，import 失败 → 测试报错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkEditorialStoryPreservation,
} from "../dist/v2/core/editorial-story-preservation-gate.js";

// ============================================================================
// 已知实体（R2.2：实体来自运行输入，不靠频率提取）
// 角色专名 + 地点/物品专名；调用方标记 entityCoverage
// ============================================================================

const KNOWN_ENTITIES = [
  // 角色专名
  "祝明朗", "洪逸", "长隍", "长乘", "采悠", "玉衡星女神", "洪摩",
  // 地点/物品专名
  "梦堂", "玉衡星宫", "禁星渊", "蚀神瘴", "黑色雾气",
];

// ============================================================================
// 测试夹具：raw 含 4 个有序关键事件
// ============================================================================

/**
 * RAW_TEXT 模拟 Case A B4 内部 raw（"梦堂缺席者"主线）。
 * 4 个有序关键事件：
 *   E1 梦堂缺位（长乘神像位置空缺）
 *   E2 长乘失踪（三日未归）
 *   E3 黑雾 / 蚀神瘴（神像渗黑雾；采悠提蚀神瘴旧闻；北斗之下）
 *   E4 禁星渊（玉衡星女神揭示前任星神陨落处；"它在醒，别碰地脉"）
 */
const RAW_TEXT = `第1106章 梦堂缺席者

洪逸这块顽石被碾碎，阳寿尽数归还天道。祝明朗分明感觉到有一股温热的力量从冥冥中涌回了自己的神宫。

"阳寿归位，天道循环，算是圆满了。"长隍躬身说道。

祝明朗微微颔首，目光却从长隍身上移开，落在了梦堂两侧那些神像之上。

梦堂左侧，长隍的神像熠熠生辉，神光饱满。可长乘的位置，却是空空荡荡。不仅长乘，右侧第三位、第五位的神像同样蒙着一层晦暗的雾气，像是被人从内部抽走了什么核心的东西，只剩下空壳一般。

"长隍。"祝明朗的声音沉了下来。"长乘呢？最近几日，他为何屡屡缺席梦堂？"

长隍的那张刚毅的面庞上，闪过一丝不安："回上仙，长乘大人已经三日未归梦堂了。自梦堂建立以来，从未缺席过。"

祝明朗走到长乘的神像前。神像朦胧，几乎快要消散了。他伸出手，指尖触碰长乘的神像。一股寒意顺着指尖传来。指尖上竟然沾了一层薄薄的黑色雾气，那雾气像活的一样，试图往他的皮肤里钻。

采悠想了想，忽然脸色微变："吾神，您说的该不会是……蚀神瘴？能够侵蚀一切神灵的神魂。许多古神就是被这东西吞噬的。后来仙庭初建，用大神通将蚀神瘴镇压在了地脉深处。记载残缺不全，只提到'北斗之下'四个字。"

祝明朗回到玉衡星宫时，玉衡星女神正在殿中翻阅一卷古朴的星图。她将那卷星图缓缓推到他面前，指着其中一处标注。那是一个被朱红色墨迹圈起来的位置，旁边只写了三个字——禁星渊。

"前任玉衡星神，就是在探查禁星渊时陨落的。而她陨落之前，发回星宫的最后一条神谕只有一句话——'它在醒，别碰地脉。'"

殿中的烛火忽然晃了一下。门外空无一人。但台阶上，赫然残留着一道淡淡的黑色雾痕，正沿着石缝无声无息地蔓延上来，像一根伸入星宫的黑色指尖。`;

// ============================================================================
// Drifted editorial：删除 raw 主线，新增洪摩逆推/灵脉水道（故事骨架替换）
// ============================================================================

/**
 * DRIFTED_EDITORIAL 模拟 Case A B4 内部 editorial（"暗潮涌动"）。
 * 保留人物（祝明朗/采悠/长隍/玉衡星女神）和洪逸前情，
 * 但删除梦堂缺位/长乘失踪/黑雾/蚀神瘴/禁星渊全部关键事件，
 * 新增洪摩逆推神识印记/灵脉水道异动/丈量玉衡星宫防线故事线。
 */
const DRIFTED_EDITORIAL = `第1106章 暗潮涌动

祝明朗从玉衡星宫出来时，天边已经泛起了鱼肚白。他脚步不快，脑子里却翻来覆去想着玉衡星女神那句话——"一层层剥夺她的神权"。

洪逸已经处决了。按道理，祝明朗该松一口气。可他偏偏松不了。因为洪逸死前喊的那句话，像根刺一样扎在肉里——"我大哥乃魔仙尊，为万神之尊！"

"采悠。"祝明朗站在仙城的石桥上，唤了一声。采悠立刻从桥柱的阴影里现身，像是早就候着了。

"洪逸被处决的事，传出去没有？"
"消息已经压不住了。"采悠低声道，"今早卯时之前，城中至少有十几处灵堂感知到了极狱的波动。"

祝明朗沉默了片刻。瞒不了太久，那就干脆不瞒。真正需要担心的，是洪摩的反应。

"洪摩这些日子有什么动静？"祝明朗问。
"很安静。"采悠说，"太安静了。"

这三个字比任何动静都让人不安。洪摩若是暴怒之下冲出来，反倒好办。可洪摩偏偏选择了沉默。一个拥有十成玉衡仙法力的魔仙尊，在弟弟被处决之后，选择沉默——这意味着他在等。

"采悠，你去查一件事。"祝明朗的目光落在桥下缓缓流淌的仙城灵脉水道上，"梦堂里的神像，最近有没有缺席的情况？你去查长乘。"

"是。"采悠领命，身形化作一缕银光消失在晨曦之中。

祝明朗正要迈步离开，忽然感到胸口一阵灼热。他低头看去，是自己星辰的那道神识印记——这枚印记本该已经随着洪逸的处决而消散，可此刻它却在微微震颤。

有人正在逆推这道神识印记的来源。洪摩。一定是洪摩。他在用自己残余的神力，顺着洪逸身上那道即将消散的神识印记，试图追溯到来处——追溯到他祝明朗身上！

祝明朗立刻运转神力，将那道残余的印记彻底碾碎。

然而还没走出石桥，脚下的灵脉水道忽然无端翻涌了一下。桥下那片一直平稳流淌的灵水，此刻正从中央向两侧分开，像是有什么东西从极深处往上升。那涟漪从桥下朝两侧扩散，沿着灵脉水道一路蔓延向仙城深处——朝着玉衡星宫的方向。

祝明朗蹲下身，手指探入水中。冰冷。不是灵脉该有的那种冰冷。像是一只手从极远的地方伸过来，隔着不知多少重的空间，轻轻触碰了一下这座城池的脉搏，随即缩回去了。

他望向玉衡星宫的方向。晨光中，星宫的轮廓一如往常般巍峨沉静，看不出任何异样。可祝明朗心里很清楚——方才那一触，不是冲着仙城来的，是冲着星宫去的。洪摩已经不只是在逆推他了。他在丈量玉衡星宫的防线。`;

// ============================================================================
// Preserved editorial：只加强章末压力，保留全部关键事件和因果顺序（通过样例）
// ============================================================================

/**
 * PRESERVED_EDITORIAL 模拟合法的增量编辑：
 * - 保留梦堂缺位（E1）
 * - 保留长乘失踪（E2）
 * - 保留黑雾/蚀神瘴（E3）
 * - 保留禁星渊（E4）
 * - 只加强章末压力（黑雾入侵玉衡星宫的描写更具体、更紧迫）
 */
const PRESERVED_EDITORIAL = `第1106章 梦堂缺席者

洪逸这块顽石被碾碎，阳寿尽数归还天道，祝明朗感觉到一股温热的力量涌回神宫。

"阳寿归位，天道循环。"长隍躬身说道。

祝明朗颔首，目光落在梦堂两侧的神像之上。梦堂左侧，长隍的神像神光饱满。可长乘的位置，却是空空荡荡。右侧第三位、第五位的神像也蒙着晦暗的雾气，像是被抽走了核心。

"长隍，长乘呢？最近几日，他为何屡屡缺席梦堂？"

长隍面庞上闪过不安："回上仙，长乘大人已经三日未归梦堂了。自梦堂建立以来，从未缺席过。"

祝明朗走到长乘的神像前，伸手触碰。一股寒意传来，指尖沾了一层薄薄的黑色雾气，那雾气像活的一样，试图往他的皮肤里钻。

采悠脸色微变："吾神，您说的该不会是……蚀神瘴？能够侵蚀一切神灵的神魂。许多古神就是被这东西吞噬的。后来仙庭用大神通将蚀神瘴镇压在了地脉深处，只提到'北斗之下'四个字。"

祝明朗回到玉衡星宫。玉衡星女神将一卷古朴的星图推到他面前，指着标注处——禁星渊。

"前任玉衡星神，就是在探查禁星渊时陨落的。她发回星宫的最后一条神谕只有一句话——'它在醒，别碰地脉。'"

殿中的烛火忽然晃了一下。门外空无一人。但台阶上，赫然残留着一道淡淡的黑色雾痕，正沿着石缝无声无息地蔓延上来，像一根伸入星宫的黑色指尖。

那黑雾比祝明朗想象的更快、更密。它不再只是试探，而是沿着星宫的每一道石缝同时渗透，像是有什么东西在地底深处彻底翻身，要将整座玉衡星宫从地基处连根拔起。祝明朗猛地运转神力，星宫上空的玉衡星光骤然暴涨，与台阶上蔓延的黑雾无声对峙——他知道，这不是洪摩的手段，这是更古老的东西，正在禁星渊深处苏醒。`;

// ============================================================================
// RED 测试：drifted editorial 必须被拒绝
// ============================================================================

test("DEMO-3-R2 RED: drifted editorial（故事骨架替换）必须被 gate 拒绝", () => {
  const report = checkEditorialStoryPreservation({
    rawText: RAW_TEXT,
    editorialText: DRIFTED_EDITORIAL,
    knownEntities: KNOWN_ENTITIES,
    entityCoverage: "full_entities",
  });

  // 核心断言：故事骨架未保持
  assert.equal(
    report.preserved,
    false,
    `drifted editorial 删除了 raw 的黑雾/蚀神瘴/禁星渊主线并新增洪摩逆推/灵脉水道，必须判定 preserved=false。实际 report：${JSON.stringify(report).slice(0, 400)}`
  );

  // 必须识别出缺失的关键事件（黑雾/蚀神瘴/禁星渊至少缺 3 个）
  assert.ok(
    Array.isArray(report.missingEvents),
    "missingEvents 必须是数组"
  );
  assert.ok(
    report.missingEvents.length >= 3,
    `missingEvents 至少 3 个（黑雾/蚀神瘴/禁星渊），实际 ${report.missingEvents.length}：${JSON.stringify(report.missingEvents).slice(0, 400)}`
  );

  // 缺失事件必须包含故事独特锚点（非人物名）
  const missingAnchorsText = report.missingEvents
    .map((e) => e.anchor || "")
    .join(" ");
  const hasBlackMist = /黑雾|黑色雾气/.test(missingAnchorsText);
  const hasGodErosion = /蚀神瘴/.test(missingAnchorsText);
  const hasForbiddenAbyss = /禁星渊/.test(missingAnchorsText);
  assert.ok(
    hasBlackMist && hasGodErosion && hasForbiddenAbyss,
    `missingEvents 必须覆盖黑雾/蚀神瘴/禁星渊三个故事独特锚点。实际 missingAnchorsText：${missingAnchorsText.slice(0, 400)}`
  );

  // 必须有拒绝原因
  assert.ok(
    typeof report.reason === "string" && report.reason.length > 0,
    "reason 必须是非空字符串"
  );

  // 必须识别出替换事件（洪摩逆推/灵脉水道/丈量防线）
  assert.ok(
    Array.isArray(report.replacedEvents),
    "replacedEvents 必须是数组"
  );
  assert.ok(
    report.replacedEvents.length >= 1,
    `replacedEvents 至少 1 个（editorial 新增的洪摩逆推/灵脉水道/丈量防线），实际 ${report.replacedEvents.length}`
  );
});

// ============================================================================
// RED 测试：preserved editorial 必须通过 gate
// ============================================================================

test("DEMO-3-R2 RED: preserved editorial（保留全部关键事件）必须通过 gate", () => {
  const report = checkEditorialStoryPreservation({
    rawText: RAW_TEXT,
    editorialText: PRESERVED_EDITORIAL,
    knownEntities: KNOWN_ENTITIES,
    entityCoverage: "full_entities",
  });

  // 核心断言：故事骨架保持
  assert.equal(
    report.preserved,
    true,
    `preserved editorial 保留了 raw 全部关键事件（梦堂缺位/长乘失踪/黑雾/蚀神瘴/禁星渊），只加强章末压力，必须判定 preserved=true。实际 report：${JSON.stringify(report).slice(0, 400)}`
  );

  // 不应有大量缺失事件
  assert.ok(
    Array.isArray(report.missingEvents),
    "missingEvents 必须是数组"
  );
  assert.ok(
    report.missingEvents.length <= 1,
    `preserved editorial 的 missingEvents 至多 1 个（允许措辞微调导致的小偏差），实际 ${report.missingEvents.length}：${JSON.stringify(report.missingEvents).slice(0, 400)}`
  );
});

// ============================================================================
// Story preservation is diagnostic evidence, not a mechanical candidate veto.
// ============================================================================

test("story preservation diagnostic does not mechanically remove a fact-valid candidate", () => {

  const driftReport = checkEditorialStoryPreservation({
    rawText: RAW_TEXT,
    editorialText: DRIFTED_EDITORIAL,
    knownEntities: KNOWN_ENTITIES,
    entityCoverage: "full_entities",
  });

  const factValidCandidates = [{ id: "drifted", text: DRIFTED_EDITORIAL }];
  assert.equal(factValidCandidates.length, 1, "启发式事件抽取结果只进入 trace，不淘汰候选");
  assert.equal(
    driftReport.preserved,
    false,
    "前置条件：drifted editorial preserved=false"
  );
});

// ============================================================================
// RED 测试：使用完整正文核验（非前 500 字）
// ============================================================================

test("DEMO-3-R2 RED: gate 必须使用完整候选正文核验（非前 500 字）", () => {
  // 构造一个"前 500 字保留 raw 主线，但 500 字之后删除全部关键事件并替换"的 candidate
  // 如果 gate 只检查前 500 字，会误判 preserved=true；
  // gate 必须检查完整正文才能发现后段的漂移。

  const rawHead = RAW_TEXT.slice(0, 400); // raw 前 400 字（含梦堂缺位/长乘失踪）
  const driftTail = DRIFTED_EDITORIAL.slice(400); // editorial 后段（洪摩逆推/灵脉水道）

  // 拼接：前段保留 raw 主线，后段替换为 editorial 漂移内容
  const mixedCandidate = rawHead + "\n\n" + driftTail;

  const report = checkEditorialStoryPreservation({
    rawText: RAW_TEXT,
    editorialText: mixedCandidate,
    knownEntities: KNOWN_ENTITIES,
    entityCoverage: "full_entities",
  });

  // gate 必须检查完整正文：后段替换了黑雾/蚀神瘴/禁星渊为洪摩逆推/灵脉水道
  // 即使前 400 字保留 raw，后段漂移也必须被识别
  assert.equal(
    report.preserved,
    false,
    `gate 必须检查完整正文。前段保留 raw 但后段替换为洪摩逆推/灵脉水道，必须判定 preserved=false。实际 report：${JSON.stringify(report).slice(0, 400)}`
  );
});
