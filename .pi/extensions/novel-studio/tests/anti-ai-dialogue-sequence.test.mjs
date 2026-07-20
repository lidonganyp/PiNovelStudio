/**
 * AntiAI dialogue sequence regression tests.
 *
 * These cases protect forum/chat style suspense chapters: many short quoted
 * replies can be natural scene evidence, while exact repeated quoted content
 * is still a mechanical-repetition smell.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { AntiAIDetector, removeExactRepeatedSentences } from "../dist/craft/anti-ai-detector.js";

describe("AntiAIDetector repeat_dialogue_sequence", () => {
  it("does not flag distinct short forum replies as repeated dialogue", () => {
    const detector = new AntiAIDetector();
    const text = [
      "楼里有人说：“门把手在动。”",
      "又有人回：“我也听见了。”",
      "第三个人打字：“先别开门。”",
      "管理员发来一句：“记录时间。”",
    ].join("\n");

    const result = detector.analyze(text);
    const hasRepeatDialogue = result.detections.some((d) => d.patternId === "repeat_dialogue_sequence");

    assert.strictEqual(hasRepeatDialogue, false);
  });

  it("still flags the same quoted line repeated three times", () => {
    const detector = new AntiAIDetector();
    const text = "甲说：“别开门。”乙也说：“别开门。”丙跟着说：“别开门。”";

    const result = detector.analyze(text);
    const hasRepeatDialogue = result.detections.some((d) => d.patternId === "repeat_dialogue_sequence");

    assert.strictEqual(hasRepeatDialogue, true);
  });
});

describe("AntiAIDetector exact repeated sentences", () => {
  it("detects exact repeated sentence copies", () => {
    const detector = new AntiAIDetector();
    const text = "门缝里渗出一线冷风。门缝里渗出一线冷风。屏幕又暗了下去。";

    const result = detector.analyze(text);
    const hasExactRepeat = result.detections.some((d) => d.patternId === "repeat_sentence_exact");

    assert.strictEqual(hasExactRepeat, true);
  });

  it("removes later exact repeated sentence copies while keeping the first occurrence", () => {
    const text = "门缝里渗出一线冷风。门缝里渗出一线冷风。屏幕又暗了下去。";

    const cleanup = removeExactRepeatedSentences(text);

    assert.strictEqual(cleanup.removedCount, 1);
    assert.strictEqual(cleanup.text, "门缝里渗出一线冷风。屏幕又暗了下去。");
  });
});

describe("AntiAIDetector local structural replay regressions", () => {
  it("detects RPG/status-label narration outside dialogue", () => {
    const detector = new AntiAIDetector();
    const text = [
      "走廊尽头的灯闪了一下。",
      "状态：未知。",
      "危险等级：上升。",
      "任务目标：离开。",
      "剩余时间：三分钟。",
    ].join("\n");

    const result = detector.analyze(text);
    const hasStatusLabel = result.detections.some((d) => d.patternId === "rpg_status_label_block");

    assert.strictEqual(hasStatusLabel, true);
  });

  it("detects third-person to first-person narration drift outside dialogue", () => {
    const detector = new AntiAIDetector();
    const text = [
      "张三站在门口，他没有马上推门。",
      "门缝里传来的声音让他停住了。",
      "我知道里面不对劲。",
      "你不能再往前走了。",
    ].join("\n");

    const result = detector.analyze(text);
    const hasPronounDrift = result.detections.some((d) => d.patternId === "pronoun_person_drift");

    assert.strictEqual(hasPronounDrift, true);
  });

  it("detects telegraph short-sentence pileups outside dialogue", () => {
    const detector = new AntiAIDetector();
    const text = "灯灭了。门响了。风停了。人没动。屏幕黑了。脚步近了。手机亮了。电梯开了。";

    const result = detector.analyze(text);
    const hasTelegraphPileup = result.detections.some((d) => d.patternId === "telegraph_sentence_pileup");

    assert.strictEqual(hasTelegraphPileup, true);
  });

  it("detects explanatory narrator chains that substitute for reader inference", () => {
    const detector = new AntiAIDetector();
    const text = "这说明门后的东西不是普通人。换句话说，他已经没有退路。问题在于，真正的危险才刚靠近。";

    const result = detector.analyze(text);
    const hasExplanationChain = result.detections.some((d) => d.patternId === "explanatory_narrator_chain");

    assert.strictEqual(hasExplanationChain, true);
  });

  it("detects near-duplicate splice residue in adjacent narration", () => {
    const detector = new AntiAIDetector();
    const text = "门缝里渗出一线冷风，贴着地面爬过来。门缝里渗出一线冷风，像是从另一个房间爬过来。";

    const result = detector.analyze(text);
    const hasNearDuplicate = result.detections.some((d) => d.patternId === "near_duplicate_splice_residue");

    assert.strictEqual(hasNearDuplicate, true);
  });
});
