/**
 * PiNovelStudio — P7 VoiceFingerprint 8 维 + DialogueCraftGate 3 规则 测试
 *
 * 覆盖：
 *   - P7-T1: VoiceFingerprintV2 8 维完整 + V1 适配 + 校验
 *   - P7-T2: DialogueCraftGate 3 规则可阻断
 *   - P7-T7: 测试覆盖
 * 历史依据：PiNovelStudio-Agentic创作流水线升级方案 P7（文档已删除）；当前架构见 docs/top-tier-chinese-novel-system-development-plan.md
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  validateFingerprintV2,
  adaptV1ToV2,
  detectAddressHabitHit,
  FINGERPRINT_V2_DIMENSIONS,
} from "../dist/craft/voice-fingerprint.js";
import {
  runDialogueCraftGate,
  checkRule1Increment,
  checkRule2Attribution,
  checkRule3ActionTagInfo,
} from "../dist/craft/dialogue-craft-gate.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeValidV2(overrides) {
  return {
    characterId: "c1",
    characterName: "墨老",
    sentenceSignature: {
      lengthAvg: 12,
      lengthVariance: 4,
      invertedSentenceRatio: 0.2,
      omissionHabit: "occasional",
    },
    vocabularyLevel: "formal",
    infoPattern: "hint",
    silenceFrequency: 0.3,
    topicControl: 0.6,
    speechActionCoupling: ["摸胡须", "端茶杯"],
    avoidancePatterns: ["避谈师门旧事"],
    addressHabits: {
      toSuperior: "师尊",
      toPeer: "道友",
      toSubordinate: "小友",
      selfAddress: "老夫",
    },
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// P7-T1: VoiceFingerprintV2 8 维
// ----------------------------------------------------------------------------

describe("P7-T1 VoiceFingerprintV2 8 维完整性", () => {
  it("8 维清单包含 addressHabits", () => {
    assert.equal(FINGERPRINT_V2_DIMENSIONS.length, 8);
    assert.ok(FINGERPRINT_V2_DIMENSIONS.includes("addressHabits"));
  });

  it("8 维完整指纹通过校验", () => {
    const errors = validateFingerprintV2(makeValidV2());
    assert.equal(errors.length, 0);
  });

  it("缺少 addressHabits 被拒", () => {
    const fp = makeValidV2();
    fp.addressHabits = undefined;
    const errors = validateFingerprintV2(fp);
    assert.ok(errors.some((e) => e.includes("addressHabits")));
  });

  it("addressHabits 为空对象被拒（至少 1 个称呼）", () => {
    const errors = validateFingerprintV2(
      makeValidV2({ addressHabits: {} })
    );
    assert.ok(errors.some((e) => e.includes("至少应有 1 个称呼")));
  });

  it("vocabularyLevel 非法被拒", () => {
    const errors = validateFingerprintV2(
      makeValidV2({ vocabularyLevel: "invalid" })
    );
    assert.ok(errors.some((e) => e.includes("vocabularyLevel 非法")));
  });

  it("silenceFrequency 越界被拒", () => {
    const errors = validateFingerprintV2(
      makeValidV2({ silenceFrequency: 1.5 })
    );
    assert.ok(errors.some((e) => e.includes("silenceFrequency")));
  });

  it("topicControl 越界被拒", () => {
    const errors = validateFingerprintV2(
      makeValidV2({ topicControl: -0.1 })
    );
    assert.ok(errors.some((e) => e.includes("topicControl")));
  });

  it("sentenceSignature.invertedSentenceRatio 缺失被拒", () => {
    const fp = makeValidV2();
    fp.sentenceSignature = { ...fp.sentenceSignature };
    delete fp.sentenceSignature.invertedSentenceRatio;
    const errors = validateFingerprintV2(fp);
    assert.ok(errors.some((e) => e.includes("invertedSentenceRatio")));
  });
});

// ----------------------------------------------------------------------------
// P7-T1: V1 → V2 适配
// ----------------------------------------------------------------------------

describe("P7-T1 V1 → V2 适配器", () => {
  it("V1 字段映射到 V2 对应字段", () => {
    const v1 = {
      characterId: "c1",
      characterName: "墨老",
      sentenceLengthAvg: 12,
      sentenceLengthVariance: 4,
      vocabularyLevel: "formal",
      infoPattern: "hint",
      silenceFrequency: 0.3,
      topicControl: 0.6,
      speechActionCoupling: ["摸胡须"],
      avoidancePatterns: ["避谈师门"],
      signaturePhrases: ["老夫..."],
    };
    const v2 = adaptV1ToV2(v1, { selfAddress: "老夫" });
    assert.equal(v2.characterId, "c1");
    assert.equal(v2.sentenceSignature.lengthAvg, 12);
    assert.equal(v2.sentenceSignature.lengthVariance, 4);
    assert.equal(v2.vocabularyLevel, "formal");
    assert.equal(v2.addressHabits.selfAddress, "老夫");
  });

  it("V1 适配后 V2 通过校验（含 addressHabits）", () => {
    const v1 = {
      characterId: "c1",
      characterName: "墨老",
      sentenceLengthAvg: 12,
      sentenceLengthVariance: 4,
      vocabularyLevel: "formal",
      infoPattern: "hint",
      silenceFrequency: 0.3,
      topicControl: 0.6,
      speechActionCoupling: ["摸胡须"],
      avoidancePatterns: ["避谈师门"],
      signaturePhrases: [],
    };
    const v2 = adaptV1ToV2(v1, { selfAddress: "老夫" });
    const errors = validateFingerprintV2(v2);
    assert.equal(errors.length, 0);
  });
});

// ----------------------------------------------------------------------------
// P7-T1: 称呼习惯匹配
// ----------------------------------------------------------------------------

describe("P7-T1 detectAddressHabitHit", () => {
  it("命中 selfAddress", () => {
    const r = detectAddressHabitHit("老夫以为此事不可", { selfAddress: "老夫" });
    assert.equal(r.hit, true);
    assert.equal(r.matchedHabit, "selfAddress");
  });

  it("命中 toPeer", () => {
    const r = detectAddressHabitHit("道友请看", { toPeer: "道友" });
    assert.equal(r.hit, true);
  });

  it("未命中返回 hit=false", () => {
    const r = detectAddressHabitHit("此事不可", { selfAddress: "老夫" });
    assert.equal(r.hit, false);
  });
});

// ----------------------------------------------------------------------------
// P7-T2 规则 1：3 轮纯对白必证增量
// ----------------------------------------------------------------------------

describe("P7-T2 规则 1：3 轮纯对白必证增量", () => {
  it("3 轮含变化动词 + 名词 → 通过", () => {
    const lines = [
      { speaker: "a", content: "三师弟决定离开师门", rawLine: 'a说："三师弟决定离开师门"' },
      { speaker: "b", content: "他答应去西北", rawLine: 'b道："他答应去西北"' },
      { speaker: "a", content: "好", rawLine: 'a说："好"' },
    ];
    const v = checkRule1Increment(lines);
    assert.equal(v.length, 0);
  });

  it("3 轮含转折词 → 通过", () => {
    const lines = [
      { speaker: "a", content: "原来是如此", rawLine: 'a说："原来是如此"' },
      { speaker: "b", content: "其实另有隐情", rawLine: 'b说："其实另有隐情"' },
      { speaker: "a", content: "如何", rawLine: 'a说："如何"' },
    ];
    const v = checkRule1Increment(lines);
    assert.equal(v.length, 0);
  });

  it("3 轮无任何增量 → 违规", () => {
    const lines = [
      { speaker: "a", content: "好", rawLine: 'a说："好"' },
      { speaker: "b", content: "嗯", rawLine: 'b说："嗯"' },
      { speaker: "a", content: "啊", rawLine: 'a说："啊"' },
    ];
    const v = checkRule1Increment(lines);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 1);
    assert.equal(v[0].severity, "critical");
  });

  it("含动作标签的对话不算纯对白，跳过规则 1", () => {
    const lines = [
      { speaker: "a", content: "好", rawLine: 'a端起茶杯："好"', actionTag: "端起茶杯" },
      { speaker: "b", content: "嗯", rawLine: 'b说："嗯"' },
      { speaker: "a", content: "啊", rawLine: 'a说："啊"' },
    ];
    const v = checkRule1Increment(lines);
    assert.equal(v.length, 0);
  });

  it("5 轮中段 3 轮无增量 → 滑窗检出", () => {
    const lines = [
      { speaker: "a", content: "三师弟决定离开", rawLine: 'a说："三师弟决定离开"' },
      { speaker: "b", content: "好", rawLine: 'b说："好"' },
      { speaker: "a", content: "嗯", rawLine: 'a说："嗯"' },
      { speaker: "b", content: "啊", rawLine: 'b说："啊"' },
      { speaker: "a", content: "原来如此", rawLine: 'a说："原来如此"' },
    ];
    const v = checkRule1Increment(lines);
    // 窗口 [1,2,3] 无增量 → 1 个违规；窗口 [2,3,4] 含"原来" → 通过
    assert.equal(v.length, 1);
    assert.equal(v[0].lineIndex, 1);
  });
});

// ----------------------------------------------------------------------------
// P7-T2 规则 2：标签删除归属清楚
// ----------------------------------------------------------------------------

describe("P7-T2 规则 2：标签删除归属清楚", () => {
  it("含自称通过", () => {
    const lines = [
      { speaker: "a", content: "本座不屑", rawLine: 'a说："本座不屑"' },
    ];
    const v = checkRule2Attribution(lines);
    assert.equal(v.length, 0);
  });

  it("含称呼通过", () => {
    const lines = [
      { speaker: "a", content: "道友请留步", rawLine: 'a说："道友请留步"' },
    ];
    const v = checkRule2Attribution(lines);
    assert.equal(v.length, 0);
  });

  it("含口癖语气词通过", () => {
    const lines = [
      { speaker: "a", content: "此事甚是奇怪也", rawLine: 'a说："此事甚是奇怪也"' },
    ];
    const v = checkRule2Attribution(lines);
    assert.equal(v.length, 0);
  });

  it("无任何线索被拒", () => {
    const lines = [
      { speaker: "a", content: "好", rawLine: 'a说："好"' },
    ];
    const v = checkRule2Attribution(lines);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 2);
    assert.equal(v[0].severity, "critical");
  });
});

// ----------------------------------------------------------------------------
// P7-T2 规则 3：动作标签有信息量
// ----------------------------------------------------------------------------

describe("P7-T2 规则 3：动作标签有信息量", () => {
  it('"他笑了" 空标签被拒', () => {
    const lines = [
      { speaker: "a", content: "...", rawLine: '他笑了："..."', actionTag: "他笑了" },
    ];
    const v = checkRule3ActionTagInfo(lines);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 3);
    assert.equal(v[0].severity, "warning"); // 规则 3 是 warning
  });

  it('"她点头" 空标签被拒', () => {
    const v = checkRule3ActionTagInfo([
      { speaker: "a", content: "...", rawLine: '她点头："..."', actionTag: "她点头" },
    ]);
    assert.equal(v.length, 1);
  });

  it('"他攥紧了拳头" 通过', () => {
    const v = checkRule3ActionTagInfo([
      { speaker: "a", content: "...", rawLine: '他攥紧了拳头："..."', actionTag: "他攥紧了拳头" },
    ]);
    assert.equal(v.length, 0);
  });

  it('"她指尖发白" 通过', () => {
    const v = checkRule3ActionTagInfo([
      { speaker: "a", content: "...", rawLine: '她指尖发白："..."', actionTag: "她指尖发白" },
    ]);
    assert.equal(v.length, 0);
  });

  it("无 actionTag 的行不参与规则 3", () => {
    const v = checkRule3ActionTagInfo([
      { speaker: "a", content: "...", rawLine: 'a说："..."' },
    ]);
    assert.equal(v.length, 0);
  });
});

// ----------------------------------------------------------------------------
// P7-T2 集成：runDialogueCraftGate
// ----------------------------------------------------------------------------

describe("P7-T2 runDialogueCraftGate 集成", () => {
  it("3 规则全绿 → passed=true", () => {
    const input = {
      lines: [
        {
          speaker: "a",
          content: "本座决定让三师弟离开",
          rawLine: 'a说："本座决定让三师弟离开"',
        },
        {
          speaker: "b",
          content: "道友不可",
          rawLine: 'b说："道友不可"',
        },
        {
          speaker: "a",
          content: "本座意已决",
          rawLine: 'a说："本座意已决"',
        },
      ],
    };
    const result = runDialogueCraftGate(input);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("规则 1 critical 违规 → passed=false", () => {
    const input = {
      lines: [
        { speaker: "a", content: "好", rawLine: 'a说："好"' },
        { speaker: "b", content: "嗯", rawLine: 'b说："嗯"' },
        { speaker: "a", content: "啊", rawLine: 'a说："啊"' },
      ],
    };
    const result = runDialogueCraftGate(input);
    // 规则 1 + 规则 2 同时违规（3 行也都缺归属线索）
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.rule === 1));
    assert.ok(result.violations.some((v) => v.rule === 2));
  });

  it("仅规则 3 warning → passed=true（warning 不阻断）", () => {
    const input = {
      lines: [
        {
          speaker: "a",
          content: "本座决定让三师弟离开",
          rawLine: '他笑了："本座决定让三师弟离开"',
          actionTag: "他笑了",
        },
        {
          speaker: "b",
          content: "道友请慎重",
          rawLine: 'b说："道友请慎重"',
        },
        {
          speaker: "a",
          content: "本座意已决",
          rawLine: 'a说："本座意已决"',
        },
      ],
    };
    const result = runDialogueCraftGate(input);
    // 规则 1 通过（含决定+三师弟）、规则 2 通过（道友/本座）、规则 3 warning
    assert.equal(result.passed, true); // warning 不阻断
    assert.ok(result.violations.some((v) => v.rule === 3 && v.severity === "warning"));
  });

  it("report 文本包含统计信息", () => {
    const result = runDialogueCraftGate({
      lines: [
        { speaker: "a", content: "好", rawLine: 'a说："好"' },
      ],
    });
    assert.ok(result.report.includes("DialogueCraftGate"));
  });
});
