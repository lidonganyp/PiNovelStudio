/**
 * PiNovelStudio — VoiceFingerprint 统一模块 (P7-T1)
 *
 * 历史依据：PiNovelStudio-Agentic创作流水线升级方案 P7-T1（文档已删除）；当前架构见 docs/top-tier-chinese-novel-system-development-plan.md
 * 目标：统一 8 维指纹模块（合并 voice-blind-test 7 维 + 补第 8 维称呼习惯）
 *
 * 共存策略：
 *   - 不修改 voice-blind-test.ts（旧 VoiceFingerprint 接口与 VoiceBlindTest 类保留）
 *   - 新建 VoiceFingerprintV2 作为统一接口，扩展第 8 维"称呼习惯"
 *   - 提供 V1 ↔ V2 适配器，确保旧调用路径不变
 *
 * 8 维指纹：
 *   1. 句式签名（长短、倒装、省略习惯） — sentenceSignature
 *   2. 词汇层级（口语/书面/专业）       — vocabularyLevel
 *   3. 信息处理模式（直述/暗示/反问）    — infoPattern
 *   4. 沉默频率（发言间隔）             — silenceFrequency
 *   5. 话题控制权（主动发起/被动回应）   — topicControl
 *   6. 言语动作耦合（说话时的小动作）    — speechActionCoupling
 *   7. 回避话题模式                     — avoidancePatterns
 *   8. 称呼习惯（对上级/同辈/下级/敌对不同称呼） — addressHabits (P7-T1 新增)
 */

// ============================================================================
// 8 维 VoiceFingerprintV2 接口
// ============================================================================

/** P7-T1: 统一 8 维声音指纹 */
export interface VoiceFingerprintV2 {
  readonly characterId: string;
  readonly characterName: string;

  // 维 1：句式签名
  readonly sentenceSignature: {
    readonly lengthAvg: number;
    readonly lengthVariance: number;
    readonly invertedSentenceRatio: number; // 倒装比例
    readonly omissionHabit: "frequent" | "occasional" | "rare"; // 省略习惯
  };

  // 维 2：词汇层级
  readonly vocabularyLevel: "colloquial" | "mixed" | "formal";

  // 维 3：信息处理模式
  readonly infoPattern: "direct" | "hint" | "question";

  // 维 4：沉默频率
  readonly silenceFrequency: number;

  // 维 5：话题控制权（0-1，主动发起比例）
  readonly topicControl: number;

  // 维 6：言语动作耦合
  readonly speechActionCoupling: readonly string[];

  // 维 7：回避话题模式
  readonly avoidancePatterns: readonly string[];

  // 维 8：称呼习惯（P7-T1 新增）
  readonly addressHabits: {
    /** 对上级的称呼（如"先生/师尊/大人"） */
    readonly toSuperior?: string;
    /** 对同辈的称呼（如"兄台/道友/老张"） */
    readonly toPeer?: string;
    /** 对下级的称呼（如"小友/晚辈/小子"） */
    readonly toSubordinate?: string;
    /** 对敌人的称呼（如"贼子/魔头/阁下"） */
    readonly toEnemy?: string;
    /** 自称（如"本座/在下/弟子"） */
    readonly selfAddress?: string;
  };
}

// ============================================================================
// 校验：8 维完整性
// ============================================================================

const REQUIRED_V2_TOP_KEYS: readonly (keyof VoiceFingerprintV2)[] = [
  "characterId",
  "characterName",
  "sentenceSignature",
  "vocabularyLevel",
  "infoPattern",
  "silenceFrequency",
  "topicControl",
  "speechActionCoupling",
  "avoidancePatterns",
  "addressHabits",
];

const REQUIRED_SENTENCE_SIG_KEYS: readonly (keyof VoiceFingerprintV2["sentenceSignature"])[] = [
  "lengthAvg",
  "lengthVariance",
  "invertedSentenceRatio",
  "omissionHabit",
];

/** 校验 8 维完整性，返回缺失字段列表 */
export function validateFingerprintV2(fp: VoiceFingerprintV2): string[] {
  const errors: string[] = [];

  for (const key of REQUIRED_V2_TOP_KEYS) {
    if (fp[key] === undefined || fp[key] === null) {
      errors.push(`字段 ${key} 缺失`);
    }
  }

  if (fp.sentenceSignature) {
    for (const key of REQUIRED_SENTENCE_SIG_KEYS) {
      if (fp.sentenceSignature[key] === undefined || fp.sentenceSignature[key] === null) {
        errors.push(`sentenceSignature.${key} 缺失`);
      }
    }
  }

  if (fp.vocabularyLevel && !["colloquial", "mixed", "formal"].includes(fp.vocabularyLevel)) {
    errors.push(`vocabularyLevel 非法：${fp.vocabularyLevel}`);
  }

  if (fp.infoPattern && !["direct", "hint", "question"].includes(fp.infoPattern)) {
    errors.push(`infoPattern 非法：${fp.infoPattern}`);
  }

  if (typeof fp.silenceFrequency === "number" && (fp.silenceFrequency < 0 || fp.silenceFrequency > 1)) {
    errors.push(`silenceFrequency 应在 [0, 1] 范围内：${fp.silenceFrequency}`);
  }

  if (typeof fp.topicControl === "number" && (fp.topicControl < 0 || fp.topicControl > 1)) {
    errors.push(`topicControl 应在 [0, 1] 范围内：${fp.topicControl}`);
  }

  // 维 8：addressHabits 至少应有 1 个称呼
  if (fp.addressHabits) {
    const habitCount = Object.values(fp.addressHabits).filter(
      (v) => v !== undefined && v !== null && v !== ""
    ).length;
    if (habitCount === 0) {
      errors.push("addressHabits 至少应有 1 个称呼");
    }
  }

  return errors;
}

/** 8 维清单（用于报告） */
export const FINGERPRINT_V2_DIMENSIONS: readonly string[] = [
  "sentenceSignature",
  "vocabularyLevel",
  "infoPattern",
  "silenceFrequency",
  "topicControl",
  "speechActionCoupling",
  "avoidancePatterns",
  "addressHabits",
];

// ============================================================================
// V1 → V2 适配器
// ============================================================================

/** Phase 7: 从 voice-blind-test 内联，解除 legacy 耦合 */
interface VoiceFingerprintV1 {
  characterId: string;
  characterName: string;
  sentenceLengthAvg: number;
  sentenceLengthVariance: number;
  vocabularyLevel: "colloquial" | "mixed" | "formal";
  infoPattern: "direct" | "hint" | "question";
  silenceFrequency: number;
  topicControl: number;
  speechActionCoupling: string[];
  avoidancePatterns: string[];
  signaturePhrases: string[];
}

/** V1 → V2 适配：旧 VoiceFingerprint 升级为 V2，addressHabits 默认为空对象 */
export function adaptV1ToV2(
  v1: VoiceFingerprintV1,
  addressHabits?: VoiceFingerprintV2["addressHabits"]
): VoiceFingerprintV2 {
  return {
    characterId: v1.characterId,
    characterName: v1.characterName,
    sentenceSignature: {
      lengthAvg: v1.sentenceLengthAvg,
      lengthVariance: v1.sentenceLengthVariance,
      invertedSentenceRatio: 0, // V1 未采集，默认 0
      omissionHabit: "occasional",
    },
    vocabularyLevel: v1.vocabularyLevel,
    infoPattern: v1.infoPattern,
    silenceFrequency: v1.silenceFrequency,
    topicControl: v1.topicControl,
    speechActionCoupling: v1.speechActionCoupling,
    avoidancePatterns: v1.avoidancePatterns,
    addressHabits: addressHabits ?? {},
  };
}

// ============================================================================
// 称呼习惯匹配器（用于盲测，提升识别率）
// ============================================================================

/** 从对话文本中识别称呼习惯命中 */
export function detectAddressHabitHit(
  content: string,
  habits: VoiceFingerprintV2["addressHabits"]
): { hit: boolean; matchedHabit?: string } {
  const entries = Object.entries(habits) as [string, string | undefined][];
  for (const [key, value] of entries) {
    if (value && content.includes(value)) {
      return { hit: true, matchedHabit: key };
    }
  }
  return { hit: false };
}
