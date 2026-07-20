/**
 * NB-3 Reference Analyzer 测试
 *
 * 验证（用 stub LLM，不调真实模型）：
 * 1. 正常提取（rounds=1）：stub 返回完整 12 类资产，span 全部正确 → status=extracted
 * 2. span 校验失败：excerpt 与 slice(start,end) 不一致 → status=invalid_span
 * 3. unknown（低 confidence）：confidence < 0.5 → status=unknown
 * 4. unknown（null 字段）：endingFunction=null → status=unknown
 * 5. 多轮冲突（rounds=2）：两轮同 matchId 不同 matchValue → status=conflict
 * 6. 架构边界：dataset-builder.js 不含 reference-analyzer import
 * 7. round-trip：registry.register → resolve → analyzeReference → JSON stringify/parse → 字段完整
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  analyzeReference,
  ReferenceRegistry,
  validateSpan,
} from "../dist-eval/novelbench/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const DATASET_BUILDER_JS = join(EXT_ROOT, "dist-eval", "novelbench", "dataset-builder.js");

// ─────────────────────────────────────────────────────────────────────────────
// 测试用 reference body（合成中文小说正文，span offset 可程序化计算）
// ─────────────────────────────────────────────────────────────────────────────

const REFERENCE_BODY =
  "夜色笼罩古城。主角独行于空巷，脚步声回荡。远处传来打更声，提示时辰已深。" +
  "他紧握手中残卷，目光警惕。暗处似有动静，他屏息凝神。多年追寻的答案，或许就在今夜揭晓。";

const BODY_HASH = createHash("sha256").update(REFERENCE_BODY, "utf-8").digest("hex");

/** 从 reference body 中截取 excerpt，构造合法 span */
function spanFor(excerpt) {
  const start = REFERENCE_BODY.indexOf(excerpt);
  if (start === -1) {
    throw new Error(`测试构造错误：excerpt 不在 reference body 中：${excerpt}`);
  }
  return { start, end: start + excerpt.length, excerpt };
}

/** 构造一个完整的合法 RawExtraction（无 status 字段，由 withStatus 填充） */
function makeValidRawExtraction() {
  return {
    eventGraph: {
      events: [
        {
          id: "e1",
          name: "夜行古城",
          type: "scene",
          characters: ["protagonist"],
          narrativeBeat: "setup",
          conflictLevel: 2,
          emotionalArc: { from: "calm", to: "tense" },
          hooks: ["暗处动静"],
          span: spanFor("夜色笼罩古城"),
          confidence: 0.9,
        },
      ],
      causalEdges: [{ from: "e1", to: "e1", type: "temporal" }],
    },
    characterStateDeltas: [
      {
        characterId: "protagonist",
        field: "location",
        before: "unknown",
        after: "古城空巷",
        span: spanFor("主角独行于空巷"),
        confidence: 0.85,
      },
    ],
    canonStateDeltas: [
      {
        id: "canon1",
        fact: "古城夜半有打更人",
        category: "setting",
        deltaType: "new",
        span: spanFor("远处传来打更声"),
        confidence: 0.8,
      },
    ],
    promiseMovements: [
      {
        promiseId: "p1",
        description: "追寻残卷答案",
        movement: "advance",
        heat: 0.6,
        span: spanFor("多年追寻的答案"),
        confidence: 0.75,
      },
    ],
    informationReleases: [
      {
        id: "ir1",
        what: "时辰已深",
        toWhom: "protagonist",
        releaseType: "hint",
        span: spanFor("提示时辰已深"),
        confidence: 0.7,
      },
    ],
    characterChoices: [
      {
        characterId: "protagonist",
        choice: "屏息凝神观察",
        motive: "警惕暗处动静",
        alternative: "unknown",
        span: spanFor("他屏息凝神"),
        confidence: 0.8,
      },
    ],
    costConsequences: [
      {
        characterId: "protagonist",
        cost: "精神紧绷",
        consequence: "持续警惕",
        isIrreversible: false,
        span: spanFor("目光警惕"),
        confidence: 0.65,
      },
    ],
    sceneTransitions: [
      {
        fromScene: "空巷",
        toScene: "暗处",
        transitionType: "continuous",
        span: spanFor("暗处似有动静"),
        confidence: 0.7,
      },
    ],
    endingFunction: {
      function: "cliffhanger",
      description: "今夜揭晓答案",
      span: spanFor("或许就在今夜揭晓"),
      confidence: 0.85,
    },
    voiceFingerprints: [
      {
        characterId: "protagonist",
        characterName: "主角",
        sentenceLengthAvg: 12,
        vocabularyLevel: "mixed",
        infoPattern: "direct",
        signaturePatterns: ["短句"],
        span: spanFor("他紧握手中残卷"),
        confidence: 0.6,
      },
    ],
    dialogueRoles: [
      {
        speakerId: "narrator",
        function: "info_give",
        subtext: "unknown",
        span: spanFor("远处传来打更声"),
        confidence: 0.55,
      },
    ],
  };
}

/** 单轮 stub：总是返回同一个 raw extraction */
function makeStubAdapter(rawExtraction) {
  return {
    async extractJSON() {
      return structuredClone(rawExtraction);
    },
  };
}

/** 双轮 stub：第一次返回 raw1，第二次返回 raw2 */
function makeTwoRoundStub(raw1, raw2) {
  let callCount = 0;
  return {
    async extractJSON() {
      callCount++;
      return structuredClone(callCount === 1 ? raw1 : raw2);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-3 Reference Analyzer", () => {
  describe("场景 1：正常提取（rounds=1）", () => {
    test("所有资产 status=extracted，span 校验通过", async () => {
      const raw = makeValidRawExtraction();
      const adapter = makeStubAdapter(raw);

      const asset = await analyzeReference({
        referenceId: "test-1",
        referenceBody: REFERENCE_BODY,
        bodyHash: BODY_HASH,
        rounds: 1,
        llmAdapter: adapter,
      });

      // 11 条资产全部 extracted
      assert.equal(asset.consistency.agreedFields, 11, "11 条资产应全部 extracted");
      assert.equal(asset.consistency.unknownFields, 0);
      assert.equal(asset.consistency.conflictedFields, 0);
      assert.equal(asset.consistency.invalidSpanFields, 0);

      // 抽查几条 status
      assert.equal(asset.eventGraph.events[0].status, "extracted");
      assert.equal(asset.characterStateDeltas[0].status, "extracted");
      assert.equal(asset.endingFunction.status, "extracted");
      assert.equal(asset.dialogueRoles[0].status, "extracted");

      // provenance
      assert.equal(asset.provenance.rounds, 1);
      assert.equal(asset.provenance.route, "reference_analyzer");
      assert.equal(asset.referenceId, "test-1");
      assert.equal(asset.bodyHash, BODY_HASH);
    });
  });

  describe("场景 2：span 校验失败", () => {
    test("excerpt 与 slice(start,end) 不一致 → status=invalid_span", async () => {
      const raw = makeValidRawExtraction();
      // 篡改一条资产的 excerpt，使其与 body 切片不一致
      raw.characterStateDeltas[0].span.excerpt = "篡改的错误片段";
      const adapter = makeStubAdapter(raw);

      const asset = await analyzeReference({
        referenceId: "test-2",
        referenceBody: REFERENCE_BODY,
        bodyHash: BODY_HASH,
        rounds: 1,
        llmAdapter: adapter,
      });

      assert.equal(
        asset.characterStateDeltas[0].status,
        "invalid_span",
        "篡改 excerpt 的资产应标 invalid_span",
      );
      assert.equal(asset.consistency.invalidSpanFields, 1);
      assert.equal(asset.consistency.agreedFields, 10);
    });
  });

  describe("场景 3：unknown（低 confidence）", () => {
    test("confidence < 0.5 → status=unknown", async () => {
      const raw = makeValidRawExtraction();
      raw.canonStateDeltas[0].confidence = 0.3;
      const adapter = makeStubAdapter(raw);

      const asset = await analyzeReference({
        referenceId: "test-3",
        referenceBody: REFERENCE_BODY,
        bodyHash: BODY_HASH,
        rounds: 1,
        llmAdapter: adapter,
      });

      assert.equal(
        asset.canonStateDeltas[0].status,
        "unknown",
        "confidence < 0.5 的资产应标 unknown",
      );
      assert.equal(asset.consistency.unknownFields, 1);
      assert.equal(asset.consistency.agreedFields, 10);
      // unknown 资产不跑 span 校验，故 invalidSpanFields 仍为 0
      assert.equal(asset.consistency.invalidSpanFields, 0);
    });
  });

  describe("场景 4：unknown（null 字段）", () => {
    test("endingFunction=null → status=unknown", async () => {
      const raw = makeValidRawExtraction();
      raw.endingFunction = null;
      const adapter = makeStubAdapter(raw);

      const asset = await analyzeReference({
        referenceId: "test-4",
        referenceBody: REFERENCE_BODY,
        bodyHash: BODY_HASH,
        rounds: 1,
        llmAdapter: adapter,
      });

      assert.equal(
        asset.endingFunction.status,
        "unknown",
        "null endingFunction 应标 unknown",
      );
      assert.equal(asset.consistency.unknownFields, 1);
      assert.equal(asset.consistency.agreedFields, 10);
    });
  });

  describe("场景 5：多轮冲突（rounds=2）", () => {
    test("两轮同 matchId 不同 matchValue → status=conflict", async () => {
      const raw1 = makeValidRawExtraction();
      const raw2 = makeValidRawExtraction();
      // 同 characterId + field（matchId 匹配），不同 after（matchValue 冲突）
      raw2.characterStateDeltas[0].after = "废墟石塔";

      const adapter = makeTwoRoundStub(raw1, raw2);

      const asset = await analyzeReference({
        referenceId: "test-5",
        referenceBody: REFERENCE_BODY,
        bodyHash: BODY_HASH,
        rounds: 2,
        llmAdapter: adapter,
      });

      assert.equal(
        asset.characterStateDeltas[0].status,
        "conflict",
        "两轮 after 值冲突应标 conflict",
      );
      assert.equal(asset.consistency.conflictedFields, 1);
      assert.equal(asset.consistency.agreedFields, 10);
      assert.equal(asset.provenance.rounds, 2);
    });
  });

  describe("场景 6：架构边界", () => {
    test("dataset-builder.js 不含 reference-analyzer import", () => {
      assert.ok(existsSync(DATASET_BUILDER_JS), "dataset-builder.js 应存在");
      const src = readFileSync(DATASET_BUILDER_JS, "utf-8");
      assert.ok(
        !src.includes("reference-analyzer"),
        "dataset-builder.js 不得 import reference-analyzer（generator 路径零 evaluator 依赖）",
      );
    });

    test("reference-analyzer.js 编译产物存在", () => {
      const p = join(EXT_ROOT, "dist-eval", "novelbench", "reference-analyzer.js");
      assert.ok(existsSync(p), "dist-eval/novelbench/reference-analyzer.js 应存在");
      const src = readFileSync(p, "utf-8");
      assert.ok(src.length > 0, "reference-analyzer.js 应非空");
    });

    test("span-validator.js 编译产物存在", () => {
      const p = join(EXT_ROOT, "dist-eval", "novelbench", "span-validator.js");
      assert.ok(existsSync(p), "dist-eval/novelbench/span-validator.js 应存在");
      const src = readFileSync(p, "utf-8");
      assert.ok(src.length > 0, "span-validator.js 应非空");
    });
  });

  describe("场景 7：round-trip（registry → resolve → analyzeReference → 持久化）", () => {
    let tmpDir;
    let registryPath;
    let sourcePath;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `novelbench-nb3-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });
      registryPath = join(tmpDir, "reference-registry.json");
      sourcePath = join(tmpDir, "source.txt");
      // 写源文件（reference body 作为源文件内容）
      writeFileSync(sourcePath, REFERENCE_BODY, "utf-8");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("register → resolve → analyzeReference → JSON round-trip", async () => {
      const registry = new ReferenceRegistry(registryPath);
      // 注意：reference-registry.resolve 会做 .trim()，所以 bodyHash 应基于 trim 后的 body
      const trimmedBody = REFERENCE_BODY.trim();
      const trimmedHash = createHash("sha256").update(trimmedBody, "utf-8").digest("hex");

      registry.register({
        referenceId: "rt-1",
        sourcePath,
        bodyHash: trimmedHash,
        startOffset: 0,
        endOffset: REFERENCE_BODY.length,
        encoding: "utf-8",
      });

      const resolvedBody = registry.resolve("rt-1");
      assert.equal(resolvedBody, trimmedBody, "resolve 应返回 trim 后的 body");

      const adapter = makeStubAdapter(makeValidRawExtraction());
      const asset = await analyzeReference({
        referenceId: "rt-1",
        referenceBody: resolvedBody,
        bodyHash: trimmedHash,
        rounds: 1,
        llmAdapter: adapter,
      });

      // JSON round-trip
      const json = JSON.stringify(asset);
      const reloaded = JSON.parse(json);

      assert.equal(reloaded.referenceId, "rt-1");
      assert.equal(reloaded.bodyHash, trimmedHash);
      assert.equal(reloaded.consistency.agreedFields, 11);
      assert.equal(reloaded.eventGraph.events[0].status, "extracted");
      assert.equal(reloaded.endingFunction.function, "cliffhanger");
      assert.equal(reloaded.voiceFingerprints[0].characterId, "protagonist");

      // span 在 round-trip 后仍可校验
      const span = reloaded.eventGraph.events[0].span;
      assert.ok(
        validateSpan(resolvedBody, span),
        "round-trip 后 span 应仍可通过校验",
      );
    });
  });
});
