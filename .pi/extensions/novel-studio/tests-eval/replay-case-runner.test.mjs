/**
 * Replay case extraction and runner tests.
 *
 * These tests verify the external replay training-ground path without writing
 * chapter prose directly. Candidate generation must stay behind the existing
 * novel_generate_chapter invoke script.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeNovelSourceBuffer,
  extractReplayCasesFromText,
  hashReplayBody,
  resolveReplayReferenceBody,
  sanitizeReplayProtagonistName,
  writeReplayCases,
} from "../dist-eval/eval/replay-case-extractor.js";
import {
  createReplayWorkspaceInput,
  defaultInvokeGenerateChapter,
  runReplayCases,
} from "../dist-eval/eval/replay-runner.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(extensionRoot, "../../..");

const GB18030_SAMPLE_BYTES = [
  181, 218, 210, 187, 213, 194, 32, 211, 234, 210, 185, 213, 239, 203, 249, 10,
  211, 234, 203, 174, 199, 195, 212, 218, 213, 239, 203, 249, 181, 196, 178,
  163, 193, 167, 201, 207, 161, 163, 10, 181, 218, 182, 254, 213, 194, 32, 190,
  201, 194, 165, 192, 180, 208, 197, 10, 209, 238, 188, 228, 202, 213, 181,
  189, 210, 187, 183, 226, 195, 187, 211, 208, 211, 202, 198, 177, 181, 196,
  208, 197, 161, 163,
];

function makeTempRoot(prefix) {
  const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function makeSourceText() {
  return [
    "第一章 雨夜诊所",
    "雨水敲在诊所的玻璃上，杨间看见柜台后面的旧账本没有合上。",
    "老板压低声音说不要再问，抽屉里的收据却露出半截红印。",
    "杨间停住手，选择把账本锁回去，只把那张收据带走。",
    "门外的脚步声忽然停在雨棚下。",
    "",
    "第二章 旧楼来信",
    "清晨的旧楼里，王珊珊把一封没有邮票的信递给杨间。",
    "信纸边缘有潮湿的黑印，楼道灯在他们头顶闪了三次。",
    "杨间没有立刻拆信，而是先确认昨夜的收据编号。",
    "走廊尽头传来同样的敲门声。",
  ].join("\n");
}

function makeVolumePrefixedSourceText() {
  return [
    "第一集 盘龙之戒 第一章 小镇的早晨",
    "乌山镇的早晨还带着雾气。林雷跟着霍格走进祠堂，听见龙血战士四个字被低声提起。",
    "他没有追问，只把手按在石阶上的裂纹处，记住父亲忽然沉下来的脸色。",
    "",
    "第一集 盘龙之戒 第二章 龙血战士家族（上）",
    "霍格把家族的旧徽章放在桌上，告诉林雷荣耀和债务从来没有分开过。",
    "林雷看见母亲留下的空椅子，第一次意识到追问真相也要付出代价。",
    "",
    "第二集 成长 第一章 魔兽‘影鼠’",
    "后山的石缝里传来细响，林雷停下脚步，把刚学会的精神力压到最轻。",
    "影鼠没有立刻逃走，而是在他掌心前停住，像是在衡量这个少年是否可信。",
  ].join("\n");
}

function makeFragmentPollutedSourceText() {
  return [
    "第1章 临时讲课",
    "我怎么也没有立刻回答，只把讲义压在桌上。",
    "分的人都没有停住脚步，走廊里的灯闪了两下。",
    "老人已经没有回头，把那张收据递给柜台。",
    "门外的敲门声忽然停住。",
  ].join("\n");
}

function makePollutedReplayCase() {
  return {
    bookId: "polluted-book",
    chapterNumber: 2,
    chapterTitle: "临时讲课",
    abstractOutline: "核心是我怎么在核心场景遭遇异常线索、做出选择，并把压力推向下一章。",
    characterState: "主角：我怎么；当前压力：谨慎调查；状态变化：从观察转向决断。",
    worldState: "场景簇：核心场景；类型信号：异常、线索、延迟揭示。",
    keyEvents: [
      "以临时讲课的异常处境开场，让我怎么立刻卷入问题。",
      "在外部压力逼近时，迫使我怎么做出关键选择。",
      "以新的压力信号收束，让下一章成为必要。",
    ],
    emotionalBeats: ["安静观察", "不安上升", "悬念钩子"],
    conflictTarget: "Protect or interpret clue while pressure narrows the protagonist's options.",
    endingHook: "End 临时讲课 with pressure returning before the clue is fully explained.",
    originalChapterPath: "D:/Download/delete/polluted.txt",
    originalHash: "0".repeat(64),
    sourceSpan: {
      startOffset: 0,
      endOffset: 120,
    },
  };
}

function makeLegacyTemplateReplayCase() {
  return {
    bookId: "legacy-template-book",
    chapterNumber: 1,
    chapterTitle: "论坛里的鬼故事",
    abstractOutline: "第1章《论坛里的鬼故事》应完成84个叙事推进点。核心是主角遭遇异常线索、做出选择，并把压力推向下一章。生成时只使用抽象节拍和事件目标，不复用 reference 正文句子。",
    characterState: "Primary character: 主角; active pressure: cautious investigation; state should shift from observation to decision.",
    worldState: "Scene cluster: 核心场景; genre signals: anomaly, clue, delayed disclosure; continuity needs explicit transitions between locations.",
    keyEvents: [
      "Open 论坛里的鬼故事 with 主角 encountering an unstable situation rather than exposition.",
      "Expose 信 as actionable evidence that changes the scene objective.",
      "Force 主角 into 选择 under 脚步声, with visible cost or hesitation.",
      "Close on a new pressure signal that makes the next chapter necessary.",
    ],
    emotionalBeats: ["quiet observation", "rising unease", "controlled decision", "suspense hook"],
    conflictTarget: "Protect or interpret 信 while 脚步声 narrows the protagonist's options.",
    endingHook: "End 论坛里的鬼故事 with 脚步声 returning before the clue is fully explained.",
    originalChapterPath: "D:/Download/delete/legacy-template.txt",
    originalHash: "1".repeat(64),
    sourceSpan: {
      startOffset: 0,
      endOffset: 180,
    },
  };
}

function makeReplayCaseWithProtagonist(protagonistName) {
  return {
    bookId: "real-fragment-book",
    chapterNumber: 1,
    chapterTitle: "\u8bba\u575b\u91cc\u7684\u9b3c\u6545\u4e8b",
    abstractOutline: `\u6838\u5fc3\u662f${protagonistName}\u906d\u9047\u5f02\u5e38\u7ebf\u7d22\u3001\u505a\u51fa\u9009\u62e9\u3002`,
    characterState: `\u4e3b\u89d2\uff1a${protagonistName}\uff1b\u5f53\u524d\u538b\u529b\uff1a\u8c28\u614e\u8c03\u67e5\uff1b\u72b6\u6001\u53d8\u5316\uff1a\u4ece\u89c2\u5bdf\u8f6c\u5411\u51b3\u65ad\u3002`,
    worldState: "\u573a\u666f\u7c07\uff1a\u6838\u5fc3\u573a\u666f\uff1b\u7c7b\u578b\u4fe1\u53f7\uff1a\u5f02\u5e38\u3001\u7ebf\u7d22\u3001\u5ef6\u8fdf\u63ed\u793a\u3002",
    keyEvents: [
      `\u4ee5\u5f02\u5e38\u5904\u5883\u5f00\u573a\uff0c\u8ba9${protagonistName}\u7acb\u523b\u5377\u5165\u95ee\u9898\u3002`,
      `\u8feb\u4f7f${protagonistName}\u505a\u51fa\u9009\u62e9\uff0c\u5e76\u5448\u73b0\u4ee3\u4ef7\u6216\u72b9\u8c6b\u3002`,
      "\u4ee5\u65b0\u7684\u538b\u529b\u4fe1\u53f7\u6536\u675f\uff0c\u8ba9\u4e0b\u4e00\u7ae0\u6210\u4e3a\u5fc5\u8981\u3002",
    ],
    emotionalBeats: ["\u5b89\u9759\u89c2\u5bdf", "\u4e0d\u5b89\u4e0a\u5347", "\u53d7\u63a7\u51b3\u65ad"],
    conflictTarget: "Protect or interpret clue while pressure narrows the protagonist's options.",
    endingHook: "End with pressure returning before the clue is fully explained.",
    originalChapterPath: "D:/Download/delete/real-fragment.txt",
    originalHash: "2".repeat(64),
    sourceSpan: {
      startOffset: 0,
      endOffset: 160,
    },
  };
}

describe("replay case extraction", () => {
  it("extracts compact replay cases without storing original chapter bodies", () => {
    const sourcePath = "D:/Download/delete/sample.txt";
    const cases = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 2,
    });

    assert.equal(cases.length, 2);
    assert.equal(cases[0].bookId, "sample-book");
    assert.equal(cases[0].chapterNumber, 1);
    assert.equal(cases[0].chapterTitle, "雨夜诊所");
    assert.equal(cases[0].originalChapterPath, sourcePath);
    assert.match(cases[0].originalHash, /^[a-f0-9]{64}$/);
    assert.equal(typeof cases[0].abstractOutline, "string");
    assert.ok(cases[0].abstractOutline.length > 20);
    assert.ok(cases[0].keyEvents.length >= 3);
    assert.ok(cases[0].emotionalBeats.length >= 1);
    assert.ok(cases[0].sourceSpan.startOffset >= 0);
    assert.ok(cases[0].sourceSpan.endOffset > cases[0].sourceSpan.startOffset);

    const serialized = JSON.stringify(cases[0]);
    assert.equal(serialized.includes("雨水敲在诊所的玻璃上"), false);
    assert.equal(serialized.includes("老板压低声音说不要再问"), false);
    assert.equal(serialized.includes("门外的脚步声忽然停在雨棚下"), false);
    assert.equal(Object.hasOwn(cases[0], "originalText"), false);
  });

  it("extracts concrete replay anchors instead of abstract hard-gate phrases", () => {
    const [replayCase] = extractReplayCasesFromText(
      [
        "第一章 论坛里的鬼故事",
        "杨间收到一封没有邮票的信，信封边缘带着潮湿的黑印。",
        "他没有立刻拆信，而是先把收据编号和信纸编号对在一起。",
        "楼道里的脚步声忽然停住，他选择把信收起，转身去关门。",
        "门外同样的脚步声又退了回来。",
      ].join("\n"),
      {
        bookId: "anchor-book",
        sourcePath: "D:/Download/delete/anchor.txt",
        maxCases: 1,
      }
    );

    const promptSurface = JSON.stringify({
      keyEvents: replayCase.keyEvents,
      conflictTarget: replayCase.conflictTarget,
      endingHook: replayCase.endingHook,
    });

    assert.doesNotMatch(
      promptSurface,
      /改变现场目标|让下一章成为必要|新的压力信号|Protect or interpret|protagonist's options|before the clue is fully explained/
    );
    assert.match(promptSurface, /线索推进/);
    assert.match(promptSurface, /选择加压/);
    assert.match(promptSurface, /结尾钩子/);
    assert.match(promptSurface, /信|收据/);
    assert.match(promptSurface, /脚步声/);
  });

  it("uses concrete pressure fallbacks when source pressure signals are sparse", () => {
    const [replayCase] = extractReplayCasesFromText(
      [
        "第一章 临时讲课",
        "主角拿到一封没有落款的信，先把信纸压在课本下面。",
        "他打开抽屉确认编号，又把信收起，决定课后再查。",
      ].join("\n"),
      {
        bookId: "sparse-pressure-book",
        sourcePath: "D:/Download/delete/sparse-pressure.txt",
        maxCases: 1,
      }
    );

    const promptSurface = JSON.stringify({
      keyEvents: replayCase.keyEvents,
      conflictTarget: replayCase.conflictTarget,
      endingHook: replayCase.endingHook,
    });

    assert.doesNotMatch(promptSurface, /外部压力|未解压力/);
    assert.match(promptSurface, /现场动静/);
  });

  it("decodes GB18030 source buffers before splitting chapters", () => {
    const decoded = decodeNovelSourceBuffer(Uint8Array.from(GB18030_SAMPLE_BYTES));

    assert.equal(decoded.encoding, "gb18030");
    assert.ok(decoded.text.includes("第一章 雨夜诊所"));
    assert.ok(decoded.text.includes("第二章 旧楼来信"));

    const cases = extractReplayCasesFromText(decoded.text, {
      bookId: "gb18030-book",
      sourcePath: "D:/Download/delete/gb18030.txt",
      maxCases: 2,
    });

    assert.equal(cases.length, 2);
    assert.equal(cases[0].chapterTitle, "雨夜诊所");
    assert.equal(cases[1].chapterTitle, "旧楼来信");
  });

  it("reconstructs reference body from sourceSpan with a matching originalHash (no generation)", () => {
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "roundtrip-book",
      sourcePath: "D:/Download/delete/roundtrip.txt",
      maxCases: 1,
    });

    const body = resolveReplayReferenceBody(makeSourceText(), replayCase);
    assert.equal(typeof body, "string");
    assert.equal(hashReplayBody(body), replayCase.originalHash);
    // Reference body is the chapter prose, not the heading line.
    assert.doesNotMatch(body, /^第一章/);
    assert.match(body, /雨水敲在诊所的玻璃上/);
  });

  it("reconstructs reference body across CRLF and GB18030 decoding", () => {
    const decoded = decodeNovelSourceBuffer(Uint8Array.from(GB18030_SAMPLE_BYTES));
    const crlfSource = decoded.text.replace(/\n/g, "\r\n");
    const cases = extractReplayCasesFromText(decoded.text, {
      bookId: "gb18030-roundtrip",
      sourcePath: "D:/Download/delete/gb18030-roundtrip.txt",
      maxCases: 2,
    });

    for (const replayCase of cases) {
      // Offsets recorded on normalized text must still resolve when the runner
      // re-decodes a CRLF source through decodeNovelSourceBuffer/normalization.
      const body = resolveReplayReferenceBody(crlfSource, replayCase);
      assert.equal(typeof body, "string", `chapter ${replayCase.chapterNumber} body should resolve`);
      assert.equal(hashReplayBody(body), replayCase.originalHash);
    }
  });

  it("returns null when the source no longer maps to the recorded sourceSpan", () => {
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "drift-book",
      sourcePath: "D:/Download/delete/drift.txt",
      maxCases: 1,
    });

    const tampered = "第零章 插入的前言\n这一段把所有后续偏移都推移了。\n\n" + makeSourceText();
    const body = resolveReplayReferenceBody(tampered, replayCase);
    assert.equal(body, null);
  });

  it("splits volume-prefixed chapter headings into global sequential replay cases", () => {
    const cases = extractReplayCasesFromText(makeVolumePrefixedSourceText(), {
      bookId: "panlong",
      sourcePath: "D:/Download/delete/panlong.txt",
      maxCases: 3,
    });

    assert.equal(cases.length, 3);
    assert.deepEqual(
      cases.map((replayCase) => replayCase.chapterNumber),
      [1, 2, 3]
    );
    assert.deepEqual(
      cases.map((replayCase) => replayCase.chapterTitle),
      ["小镇的早晨", "龙血战士家族（上）", "魔兽‘影鼠’"]
    );
  });

  it("does not promote sentence fragments to replay protagonist names", () => {
    const [replayCase] = extractReplayCasesFromText(makeFragmentPollutedSourceText(), {
      bookId: "fragment-book",
      sourcePath: "D:/Download/delete/fragment.txt",
      maxCases: 1,
    });

    const serialized = JSON.stringify(replayCase);
    assert.doesNotMatch(serialized, /我怎么|我怎么也|分的人都|老人已经/);
    assert.match(replayCase.characterState, /主角[:：]主角/);
    assert.ok(replayCase.abstractOutline.includes("核心是主角"));
  });

  it("rejects real replay action fragments as protagonist names", () => {
    const fallbackName = "\u4e3b\u89d2";
    const fragments = [
      "\u978b\u5b50\u6389\u4e86",
      "\u62ff\u51fa\u624b\u673a",
      "\u7684\u5b66\u4f1a\u90fd",
      "\u5f53\u65f6\u6211",
      "\u9690\u7ea6\u53ef\u4ee5",
      "\u8fc7\u73bb\u7483\u7a97",
    ];

    for (const fragment of fragments) {
      assert.equal(sanitizeReplayProtagonistName(fragment), null);

      const input = createReplayWorkspaceInput(makeReplayCaseWithProtagonist(fragment), {
        workspaceId: `replay-real-fragment-${fragment.length}`,
        novelName: "Real Fragment Replay",
        genre: "\u60ac\u7591",
        styleProfile: "default",
      });

      assert.equal(input.config.characters[0].name, fallbackName);
      assert.equal(JSON.stringify(input).includes(fragment), false);
    }
  });

  it("writes one JSON case file per chapter", () => {
    const root = makeTempRoot("pns-replay-cases");
    const cases = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath: join(root, "sample.txt"),
      maxCases: 2,
    });

    const result = writeReplayCases(cases, join(root, "cases"));

    assert.equal(result.files.length, 2);
    assert.equal(existsSync(join(root, "cases", "sample-book-ch001.json")), true);
    const first = readJson(join(root, "cases", "sample-book-ch001.json"));
    assert.equal(first.bookId, "sample-book");
    assert.equal(first.chapterNumber, 1);
  });
});

describe("replay generation runner", () => {
  it("creates workspace input files from a replay case without original body leakage", () => {
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath: "D:/Download/delete/sample.txt",
      maxCases: 1,
    });

    const input = createReplayWorkspaceInput(replayCase, {
      workspaceId: "replay-sample-book-run-a-ch001",
      novelName: "Sample Book Replay",
      genre: "悬疑",
      styleProfile: "default",
    });

    assert.equal(input.workspaceId, "replay-sample-book-run-a-ch001");
    assert.equal(input.config.generatedFromReplay, true);
    assert.equal(input.outline.includes("雨水敲在诊所的玻璃上"), false);
    assert.equal(input.outline.includes("老板压低声音说不要再问"), false);
    assert.ok(input.outline.includes("第1章"));
    assert.equal(input.outline.includes("Expose "), false);
    assert.equal(input.outline.includes("actionable evidence"), false);
    assert.equal(input.outline.includes("The scene must show concrete action"), false);
    assert.equal(input.outline.includes("Reference prose is excluded"), false);
    assert.equal(input.outline.includes("abstract case fields"), false);
    assert.equal(input.outline.includes("reference"), false);
    assert.ok(input.characterProfile.includes("回放角色状态"));
    assert.equal(input.characterProfile.includes("Primary character"), false);
    assert.equal(input.characterProfile.includes("Writing constraint"), false);
    assert.equal(input.characterProfile.includes("reference"), false);
    assert.ok(input.skeleton.version);
  });

  it("sanitizes old replay protagonist fragments before writing generation inputs", () => {
    const input = createReplayWorkspaceInput(makePollutedReplayCase(), {
      workspaceId: "replay-polluted-book-run-a-ch002",
      novelName: "Polluted Book Replay",
      genre: "悬疑",
      styleProfile: "default",
    });

    assert.equal(input.config.characters[0].name, "主角");
    assert.ok(Array.isArray(input.config.characters[0].aliases));
    assert.ok(input.config.characters[0].aliases.includes("我"));

    const generationPromptSurface = `${input.outline}\n${input.characterProfile}`;
    assert.doesNotMatch(generationPromptSurface, /我怎么/);
    assert.match(generationPromptSurface, /核心是主角/);
    assert.match(generationPromptSurface, /让主角立刻卷入问题/);
  });

  it("normalizes legacy English replay craft templates before writing generation inputs", () => {
    const input = createReplayWorkspaceInput(makeLegacyTemplateReplayCase(), {
      workspaceId: "replay-legacy-template-book-run-a-ch001",
      novelName: "Legacy Template Book Replay",
      genre: "悬疑",
      styleProfile: "default",
    });

    const generationPromptSurface = `${input.outline}\n${input.characterProfile}`;
    for (const forbidden of [
      "Open ",
      "Expose ",
      "Force ",
      "Close on",
      "End ",
      "actionable evidence",
      "encountering an unstable situation",
      "rather than exposition",
      "scene objective",
      "visible cost or hesitation",
      "protagonist's options",
      "before the clue is fully explained",
      "Primary character",
      "active pressure",
      "Scene cluster",
      "genre signals",
      "quiet observation",
      "reference",
    ]) {
      assert.equal(generationPromptSurface.includes(forbidden), false, `prompt surface leaked ${forbidden}`);
    }

    assert.ok(generationPromptSurface.includes("论坛里的鬼故事"));
    assert.ok(generationPromptSurface.includes("信"));
    assert.ok(generationPromptSurface.includes("脚步声"));
    assert.ok(generationPromptSurface.includes("选择"));
    assert.ok(generationPromptSurface.includes("谨慎调查"));
    assert.ok(generationPromptSurface.includes("空间切换必须有明确过门"));
    assert.ok(generationPromptSurface.includes("安静观察"));
  });

  it("records orchestrator proof but marks missing candidate text as failed", async () => {
    const root = makeTempRoot("pns-replay-runner");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const invoked = [];
    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-a",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        invoked.push(command);
        mkdirSync(dirname(command.resultPath), { recursive: true });
        writeFileSync(command.resultPath, JSON.stringify({ status: "success", stageResults: {} }, null, 2), "utf-8");
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].toolName, "novel_generate_chapter");
    assert.deepEqual(invoked[0].args.slice(0, 3), ["scripts/invoke-generate-chapter.mjs", "replay-sample-book-run-a-ch001", "1"]);
    assert.equal(invoked[0].mockAgent, true);
    assert.equal(summary.totalCases, 1);
    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-a", "reports", "ch001-generation-report.json"));
    assert.equal(report.metadata.generatedBy, "novel_generate_chapter");
    assert.equal(report.metadata.candidate.generationTool, "novel_generate_chapter");
    assert.equal(report.result.status, "success");

    const skippedQualityReport = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-a", "reports", "ch001-quality-report.skipped.json"));
    assert.equal(skippedQualityReport.status, "skipped");
    assert.match(skippedQualityReport.reason, /candidate text/i);
    assert.equal(skippedQualityReport.metadata.generatedBy, "novel_generate_chapter");

    const workspaceConfig = readJson(join(projectRoot, "workspaces", "replay-sample-book-run-a-ch001", "config.json"));
    assert.equal(workspaceConfig.generatedFromReplay, true);

    const replayWorldItemsPath = join(projectRoot, "workspaces", "replay-sample-book-run-a-ch001", "series", "world-items.json");
    assert.equal(existsSync(replayWorldItemsPath), true);
    const replayWorldItems = readJson(replayWorldItemsPath);
    assert.ok(Array.isArray(replayWorldItems.items));
    assert.ok(replayWorldItems.items.length >= 1);
    assert.equal(typeof replayWorldItems.items[0].summary, "string");
    assert.match(replayWorldItems.items[0].summary, /场景簇|类型信号|异常|线索/);
  });

  it("marks novel_generate_chapter error results as failed even when the invoke process exits cleanly", async () => {
    const root = makeTempRoot("pns-replay-runner-error-result");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-error-result",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        writeFileSync(
          command.resultPath,
          JSON.stringify({ status: "error", stage: "5-style", message: "style gate blocked", stageResults: {} }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(summary.totalCases, 1);
    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-error-result", "reports", "ch001-generation-report.json"));
    assert.equal(report.result.status, "error");
    assert.equal(report.result.stage, "5-style");
  });

  it("classifies Stage 8 structural integrity upstream rewrites from the raw generation report", async () => {
    const root = makeTempRoot("pns-replay-runner-structural-review");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-structural-review",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        const tracePath = join(
          projectRoot,
          "workspaces",
          command.workspaceId,
          "traces",
          `${command.chapterId}-quality-trace.json`
        );
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(
          tracePath,
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            chapterId: command.chapterId,
            events: [
              {
                eventId: "E4",
                progression: {
                  passed: true,
                  stateDelta: 0.7,
                  adjustment_signals: ["stage8_anti_ai_repairable_review"],
                },
              },
            ],
            patches: [
              {
                stage: "stage8",
                accepted: true,
                issueType: "explanation_residue",
              },
            ],
            gates: [
              {
                gateId: "stage8-anti-ai",
                stage: "stage8",
                result: "HUMAN_REVIEW",
                routeDecision: "completed_with_review",
                evidence: ["Nested anti-AI revised text remained reviewable after local patches."],
              },
            ],
          }, null, 2),
          "utf-8"
        );
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "error",
            stage: "8-structural-integrity",
            message: "[structural-integrity] structural issue requires upstream rewrite",
            stageResults: {
              stage8: {
                structuralIntegrity: {
                  route: "stage2_rewrite",
                  shouldRequestUpstreamRewrite: true,
                  issueTypes: ["protagonist_agency_missing"],
                  blockingIssueTypes: ["narrative_splice", "protagonist_agency_missing"],
                },
              },
            },
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failureBreakdown.upstream_rewrite_requested, 1);
    assert.equal(summary.failureBreakdown.human_review_required, 0);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].kind, "upstream_rewrite_requested");
    assert.equal(summary.failures[0].route, "stage2_rewrite");
    assert.equal(summary.failures[0].stage, "8-structural-integrity");
    assert.equal(summary.failures[0].shouldRequestUpstreamRewrite, true);
    assert.match(summary.failures[0].message, /structural issue requires upstream rewrite/);

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-structural-review", "reports", "ch001-generation-report.json"));
    assert.equal(report.failure.kind, "upstream_rewrite_requested");
    assert.equal(report.failure.gate, "structural_integrity");
    assert.equal(report.failure.route, "stage2_rewrite");
    assert.equal(report.failure.shouldRequestUpstreamRewrite, true);
    assert.deepEqual(report.failure.issueTypes, ["protagonist_agency_missing"]);
    assert.deepEqual(report.failure.blockingIssueTypes, ["narrative_splice", "protagonist_agency_missing"]);
  });

  it("treats exhausted Stage 8 repairable anti-AI error results as failed canonical output", async () => {
    const root = makeTempRoot("pns-replay-runner-anti-ai-repairable");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-anti-ai-repairable",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        const tracePath = join(
          projectRoot,
          "workspaces",
          command.workspaceId,
          "traces",
          `${command.chapterId}-quality-trace.json`
        );
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(
          tracePath,
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            chapterId: command.chapterId,
            events: [
              {
                eventId: "E4",
                progression: {
                  passed: true,
                  stateDelta: 0.7,
                  adjustment_signals: ["stage8_anti_ai_repairable_review"],
                },
              },
            ],
            patches: [
              {
                stage: "stage8",
                accepted: true,
                issueType: "过度解释",
              },
            ],
            gates: [
              {
                gateId: "stage8-anti-ai",
                stage: "stage8",
                result: "HUMAN_REVIEW",
                routeDecision: "completed_with_review",
                evidence: ["Repairable anti-AI residue remained after accepted local patches."],
              },
              {
                stage: "stage8.anti_ai.final",
                status: "blocked",
                passed: false,
                blocked: true,
                score: 0.018,
                reason: "[anti-ai-local-repair] repairable explanation residue; retries exhausted",
                issueTypes: ["过度解释"],
                revisionHints: [],
                evidence: {
                  routeGate: "anti_ai_repairable",
                  density: 0.018,
                  densityThreshold: 0.02,
                  loops: 2,
                  maxLoops: 2,
                  stage: "8-anti-ai",
                },
              },
            ],
          }, null, 2),
          "utf-8"
        );
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "error",
            stage: "8-anti-ai",
            message: "[anti-ai-local-repair] repairable explanation residue",
            text: "The envelope changed Lin's objective before the last knock returned. He kept the clue, marked the risk, and chose the stairwell instead of the door.",
            stageResults: {
              stage8: {
                antiAI: {
                  routeGate: "anti_ai_repairable",
                  routeStage: "8-anti-ai",
                  routeMessage: "[anti-ai-local-repair] repairable explanation residue",
                  repairableIssueTypes: ["过度解释"],
                  shouldRequestUpstreamRewrite: false,
                },
                antiAIRoutes: [
                  {
                    targetKey: "antiAI",
                    gate: "anti_ai_repairable",
                    stage: "8-anti-ai",
                    blockingIssueTypes: ["过度解释"],
                    repairableIssueTypes: ["过度解释"],
                    shouldRequestUpstreamRewrite: false,
                  },
                ],
              },
            },
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failureBreakdown.generation_error, 1);
    assert.equal(summary.failureBreakdown.stage8_repairable_warning, 0);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].kind, "generation_error");
    assert.equal(summary.failures[0].status, "error");

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-anti-ai-repairable", "reports", "ch001-generation-report.json"));
    assert.equal(report.failure.kind, "generation_error");
    assert.equal(report.result.status, "error");
    assert.equal(report.result.stageResults.stage8.antiAI.routeGate, "anti_ai_repairable");

    const qualityReportPath = join(root, ".pi", "replay-runs", "sample-book", "run-anti-ai-repairable", "reports", "ch001-quality-report.json");
    assert.equal(existsSync(qualityReportPath), false);

    // Verify mirror trace contains the final blocked gate
    const mirrorTracePath = join(root, ".pi", "replay-runs", "sample-book", "run-anti-ai-repairable", "traces", "ch001-quality-trace.json");
    assert.equal(existsSync(mirrorTracePath), true, "Mirror trace file must exist");
    const mirrorTrace = readJson(mirrorTracePath);
    const finalBlockedGates = mirrorTrace.gates.filter(g => g.blocked === true);
    assert.ok(finalBlockedGates.length >= 1, `Mirror trace must contain at least one blocked:true gate, got ${finalBlockedGates.length}`);
    assert.ok(finalBlockedGates.some(g => g.stage === "stage8.anti_ai.final"), "Mirror trace must contain stage8.anti_ai.final blocked gate");
  });

  it("does not extract nested Stage 8 revised text when generate-result status is error", async () => {
    const root = makeTempRoot("pns-replay-runner-anti-ai-nested-text");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const nestedRevisedText =
      "The envelope changed Lin's objective before the last knock returned. He kept the clue, marked the risk, and chose the stairwell instead of the door.";

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-anti-ai-nested-text",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        const tracePath = join(
          projectRoot,
          "workspaces",
          command.workspaceId,
          "traces",
          `${command.chapterId}-quality-trace.json`
        );
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(
          tracePath,
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            chapterId: command.chapterId,
            events: [
              {
                eventId: "E4",
                progression: {
                  passed: true,
                  stateDelta: 0.7,
                  adjustment_signals: ["stage8_anti_ai_repairable_review"],
                },
              },
            ],
            patches: [
              {
                stage: "stage8",
                accepted: true,
                issueType: "explanation_residue",
              },
            ],
            gates: [
              {
                gateId: "stage8-anti-ai",
                stage: "stage8",
                result: "HUMAN_REVIEW",
                routeDecision: "completed_with_review",
                evidence: ["Nested anti-AI revised text remained reviewable after local patches."],
              },
            ],
          }, null, 2),
          "utf-8"
        );
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "error",
            stage: "8-anti-ai",
            message: "[anti-ai-local-repair] repairable residue remained after local patches",
            stageResults: {
              stage8: {
                antiAI: {
                  routeGate: "anti_ai_repairable",
                  routeStage: "8-anti-ai",
                  routeMessage: "[anti-ai-local-repair] repairable residue remained after local patches",
                  repairableIssueTypes: ["explanation_residue"],
                  shouldRequestUpstreamRewrite: false,
                  revisedText: nestedRevisedText,
                },
                antiAIRoutes: [
                  {
                    targetKey: "antiAI",
                    gate: "anti_ai_repairable",
                    stage: "8-anti-ai",
                    repairableIssueTypes: ["explanation_residue"],
                    shouldRequestUpstreamRewrite: false,
                  },
                ],
              },
            },
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failureBreakdown.generation_error, 1);

    const candidatePath = join(root, ".pi", "replay-runs", "sample-book", "run-anti-ai-nested-text", "generated", "ch001-candidate.txt");
    assert.equal(existsSync(candidatePath), false);

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-anti-ai-nested-text", "reports", "ch001-generation-report.json"));
    assert.equal(report.failure.kind, "generation_error");
    assert.equal(report.result.status, "error");
  });

  it("skips quality evaluation when the reference body no longer matches originalHash", async () => {
    const root = makeTempRoot("pns-replay-runner-ref-mismatch");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    // Source drifts after extraction: a prepended chapter shifts every offset,
    // so the recorded sourceSpan can no longer reproduce the hashed body.
    writeFileSync(sourcePath, "第零章 新增前言\n额外的一段正文推移了所有偏移。\n\n" + makeSourceText(), "utf-8");

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-ref-mismatch",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        writeFileSync(
          command.resultPath,
          JSON.stringify({ status: "success", text: "候选正文：主角在诊所做出选择。", stageResults: {} }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);

    const reportsDir = join(root, ".pi", "replay-runs", "sample-book", "run-ref-mismatch", "reports");
    const skipped = readJson(join(reportsDir, "ch001-quality-report.skipped.json"));
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.reason, /reference hash mismatch/i);
    // The runner must not silently emit a mis-sliced reference file.
    assert.equal(existsSync(join(reportsDir, "ch001-reference.txt")), false);
  });

  it("passes invoke timeout budgets into novel_generate_chapter reports", async () => {
    const root = makeTempRoot("pns-replay-runner-timeout-budget");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    let seenCommand = null;
    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-timeout-budget",
      mockAgent: true,
      invokeTimeoutMs: 1234,
      invokeGenerateChapter: async (command) => {
        seenCommand = command;
        return {
          exitCode: 124,
          stdout: "",
          stderr: "mock timeout",
          timedOut: true,
          durationMs: 1234,
        };
      },
    });

    assert.equal(seenCommand.timeoutMs, 1234);
    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);

    const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-timeout-budget", "reports", "ch001-generation-report.json"));
    assert.equal(report.command.timeoutMs, 1234);
    assert.equal(report.invocation.exitCode, 124);
    assert.equal(report.invocation.timedOut, true);
    assert.equal(report.result.status, "missing_result");
  });

  it("applies a replay invoke timeout default above the per-request model budget", async () => {
    const previousEnv = process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS;
    delete process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS;
    try {
      const root = makeTempRoot("pns-replay-runner-default-timeout-budget");
      const sourcePath = join(root, "sample.txt");
      writeFileSync(sourcePath, makeSourceText(), "utf-8");
      const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
        bookId: "sample-book",
        sourcePath,
        maxCases: 1,
      });
      const casePath = join(root, "cases", "sample-book-ch001.json");
      writeReplayCases([replayCase], join(root, "cases"));

      let seenCommand = null;
      await runReplayCases({
        projectRoot,
        cases: [casePath],
        runRoot: join(root, ".pi", "replay-runs"),
        runId: "run-default-timeout-budget",
        mockAgent: true,
        invokeGenerateChapter: async (command) => {
          seenCommand = command;
          return {
            exitCode: 124,
            stdout: "",
            stderr: "mock timeout",
            timedOut: true,
            durationMs: command.timeoutMs,
          };
        },
      });

      assert.equal(seenCommand.timeoutMs, 600_000);
      assert.ok(seenCommand.timeoutMs > 300_000);

      const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-default-timeout-budget", "reports", "ch001-generation-report.json"));
      assert.equal(report.command.timeoutMs, 600_000);
      assert.equal(report.invocation.timedOut, true);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS;
      } else {
        process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS = previousEnv;
      }
    }
  });

  it("allows the replay invoke timeout default to be configured by environment", async () => {
    const previousEnv = process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS;
    process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS = "420000";
    try {
      const root = makeTempRoot("pns-replay-runner-env-timeout-budget");
      const sourcePath = join(root, "sample.txt");
      writeFileSync(sourcePath, makeSourceText(), "utf-8");
      const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
        bookId: "sample-book",
        sourcePath,
        maxCases: 1,
      });
      const casePath = join(root, "cases", "sample-book-ch001.json");
      writeReplayCases([replayCase], join(root, "cases"));

      let seenCommand = null;
      await runReplayCases({
        projectRoot,
        cases: [casePath],
        runRoot: join(root, ".pi", "replay-runs"),
        runId: "run-env-timeout-budget",
        mockAgent: true,
        invokeGenerateChapter: async (command) => {
          seenCommand = command;
          return {
            exitCode: 124,
            stdout: "",
            stderr: "mock timeout",
            timedOut: true,
            durationMs: command.timeoutMs,
          };
        },
      });

      assert.equal(seenCommand.timeoutMs, 420_000);

      const report = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-env-timeout-budget", "reports", "ch001-generation-report.json"));
      assert.equal(report.command.timeoutMs, 420_000);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS;
      } else {
        process.env.PINOVEL_REPLAY_INVOKE_TIMEOUT_MS = previousEnv;
      }
    }
  });

  it("terminates a hung default novel_generate_chapter child after the invoke timeout", async () => {
    const root = makeTempRoot("pns-replay-default-invoke-timeout");
    const result = await defaultInvokeGenerateChapter({
      toolName: "novel_generate_chapter",
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: projectRoot,
      workspaceId: "timeout-workspace",
      chapterId: "1",
      chapterNumber: 1,
      mockAgent: false,
      resultPath: join(root, "generate-result.json"),
      timeoutMs: 100,
    });

    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /timed out after 100ms/);
    assert.ok(result.durationMs >= 50);
    assert.ok(result.durationMs < 5_000);
  });

  it("writes a replay quality report when novel_generate_chapter returns candidate text", async () => {
    const root = makeTempRoot("pns-replay-quality-report");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-quality",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        const tracePath = join(
          projectRoot,
          "workspaces",
          command.workspaceId,
          "traces",
          `${command.chapterId}-quality-trace.json`
        );
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(
          tracePath,
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            chapterId: command.chapterId,
            events: [
              {
                eventId: "event_1",
                eventName: "dialogue revelation beat",
                sceneType: "revelation",
                craftGate: {
                  issueTypes: ["dialogue_propulsion"],
                  metrics: {
                    dialoguePropulsion: 62,
                    contractCoverage: 0.86,
                    dialogueRatio: 0.48,
                  },
                },
                progression: {
                  passed: true,
                  stateDelta: 0.8,
                  evidence: {
                    metrics: {
                      state_delta: { passed: false },
                      causal_chain: { passed: true },
                      protagonist_active: { passed: false },
                    },
                    riskDelta: { score: 0 },
                    informationDelta: { score: 1 },
                  },
                },
                getdraftDialogueTrace: {
                  event_type: "dialogue",
                  narrative_beat: "revelation",
                  dialogue_propulsion_score: 62,
                  state_delta: false,
                  risk_delta: 0,
                  causal_chain: true,
                  protagonist_active: false,
                  contract_coverage: 0.86,
                },
              },
            ],
            patches: [],
            gates: [
              {
                stage: "stage8-final",
                passed: true,
              },
            ],
          }, null, 2),
          "utf-8"
        );
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "success",
            text: [
              "The old clinic receipt matched the cabinet tag, so Lin marked the evidence in red.",
              "He chose the back stairs when the knocking moved closer, leaving the lobby empty.",
              "The final tag carried his own phone number.",
            ].join("\n"),
            stageResults: {},
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    const qualityReportPath = join(root, ".pi", "replay-runs", "sample-book", "run-quality", "reports", "ch001-quality-report.json");
    assert.equal(existsSync(qualityReportPath), true);
    assert.ok(summary.reports.includes(qualityReportPath));
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 0);

    const qualityReport = readJson(qualityReportPath);
    assert.equal(qualityReport.metadata.generatedBy, "novel_generate_chapter");
    assert.equal(qualityReport.metadata.candidate.generationTool, "novel_generate_chapter");
    assert.equal(typeof qualityReport.metadata.candidate.tracePath, "string");
    assert.equal(typeof qualityReport.candidateMetrics.progression, "number");
    assert.equal(typeof qualityReport.candidateMetrics.evidenceDelta, "number");
    assert.equal(typeof qualityReport.candidateMetrics.readerNeedToContinue, "number");
    assert.deepEqual(
      qualityReport.candidateRules.map((rule) => rule.id).sort(),
      ["DP-001", "DP-002"]
    );
    assert.ok(qualityReport.candidateRules.every((rule) => rule.validationStatus === "candidate"));
    assert.ok(qualityReport.candidateRules.every((rule) => rule.runtimeDefaultEnabled === false));
    assert.ok(qualityReport.candidateRules.every((rule) => rule.requiresReplayPromotion === true));
  });

  it("treats completed_with_review with candidate text and trace as completed replay output", async () => {
    const root = makeTempRoot("pns-replay-completed-with-review");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-completed-with-review",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        const tracePath = join(
          projectRoot,
          "workspaces",
          command.workspaceId,
          "traces",
          `${command.chapterId}-quality-trace.json`
        );
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(
          tracePath,
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            chapterId: command.chapterId,
            events: [
              {
                eventId: "E3",
                progression: {
                  passed: true,
                  stateDelta: 0.6,
                  adjustment_signals: ["progression_human_review"],
                },
              },
            ],
            patches: [],
            gates: [
              {
                gateId: "stage2-event-progression",
                stage: "stage2",
                result: "HUMAN_REVIEW",
                routeDecision: "completed_with_review",
                evidence: ["Gate requested review but preserved candidate text."],
              },
            ],
          }, null, 2),
          "utf-8"
        );
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "completed_with_review",
            text: "The clue changed Lin's next step, and he kept the drive for review before the knocking returned.",
            humanReviewRequired: true,
            humanReviewFlags: ["stage2_human_review"],
            stageResults: {
              needsHumanReview: true,
              stage2: { humanReviewRequired: true },
            },
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    const qualityReportPath = join(root, ".pi", "replay-runs", "sample-book", "run-completed-with-review", "reports", "ch001-quality-report.json");
    // P0: completed_with_review 需要人工复核，不再视为成功
    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(existsSync(qualityReportPath), false);

    const generationReport = readJson(join(root, ".pi", "replay-runs", "sample-book", "run-completed-with-review", "reports", "ch001-generation-report.json"));
    assert.equal(generationReport.result.status, "completed_with_review");
    assert.equal(generationReport.result.humanReviewRequired, true);
    // P0: completed_with_review 现在被视为失败，应有 failure 记录
    assert.ok(generationReport.failure, "completed_with_review 应有 failure 记录");
    assert.ok(
      generationReport.failure.kind === "generation_error" || generationReport.failure.kind === "quality_report_unavailable",
      `failure.kind 应为 generation_error 或 quality_report_unavailable，实际: ${generationReport.failure.kind}`
    );
  });

  it("rejects candidate text when replay quality trace proof is missing", async () => {
    const root = makeTempRoot("pns-replay-missing-trace");
    const sourcePath = join(root, "sample.txt");
    writeFileSync(sourcePath, makeSourceText(), "utf-8");
    const [replayCase] = extractReplayCasesFromText(makeSourceText(), {
      bookId: "sample-book",
      sourcePath,
      maxCases: 1,
    });
    const casePath = join(root, "cases", "sample-book-ch001.json");
    writeReplayCases([replayCase], join(root, "cases"));

    const summary = await runReplayCases({
      projectRoot,
      cases: [casePath],
      runRoot: join(root, ".pi", "replay-runs"),
      runId: "run-missing-trace",
      mockAgent: true,
      invokeGenerateChapter: async (command) => {
        mkdirSync(dirname(command.resultPath), { recursive: true });
        writeFileSync(
          command.resultPath,
          JSON.stringify({
            status: "success",
            text: "The receipt changed the investigation objective before the door knocked again.",
            stageResults: {},
          }, null, 2),
          "utf-8"
        );
        return { exitCode: 0, stdout: "mock invoke", stderr: "" };
      },
    });

    const qualityReportPath = join(root, ".pi", "replay-runs", "sample-book", "run-missing-trace", "reports", "ch001-quality-report.json");
    const skippedQualityReportPath = join(root, ".pi", "replay-runs", "sample-book", "run-missing-trace", "reports", "ch001-quality-report.skipped.json");
    assert.equal(existsSync(qualityReportPath), false);
    assert.equal(existsSync(skippedQualityReportPath), true);
    assert.equal(summary.completed, 0);
    assert.equal(summary.failed, 1);

    const skippedQualityReport = readJson(skippedQualityReportPath);
    assert.equal(skippedQualityReport.status, "failed");
    assert.match(skippedQualityReport.reason, /quality evaluator failed/i);
    assert.match(skippedQualityReport.evaluator.stderr, /quality trace|trace/i);
    assert.equal(typeof skippedQualityReport.metadata.candidate.tracePath, "string");
  });
});
