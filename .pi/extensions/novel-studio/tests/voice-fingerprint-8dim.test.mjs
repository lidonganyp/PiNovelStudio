/**
 * PiNovelStudio — P7 VoiceFingerprint 8 维测试
 *
 * 覆盖：
 *   - P7-T1: VoiceFingerprintV2 8 维完整 + V1 适配 + 校验
 * 历史依据：PiNovelStudio-Agentic创作流水线升级方案 P7（文档已删除）；当前架构见 docs/top-tier-chinese-novel-system-development-plan.md
 * 注：原 P7-T2 DialogueCraftGate 测试已随 dialogue-craft-gate.ts（机械化对白比例 gate）一并退役，
 *     对白工艺证据现由 language-risk-library.ts 以 advisory Diagnostic 形式提供（不阻断）。
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  validateFingerprintV2,
  adaptV1ToV2,
  detectAddressHabitHit,
  FINGERPRINT_V2_DIMENSIONS,
} from "../dist/craft/voice-fingerprint.js";

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
