/**
 * UNCERTAINTY-ABLATION-RECALL-1：召回率指标纯函数 spec
 *
 * Step 1 RED 测试：验证 uncertainty-recall-metrics.ts 的纯函数行为。
 *
 * 覆盖：
 * 1. isValidSourceRef：过滤 voice:profile_only:degraded / ranked:no-match / *:empty 等无效值
 * 2. computeMustVerifyCoverage：逐项覆盖率（空集=1，部分覆盖=比例，全未覆盖=0）
 * 3. evaluateRecallCriterion：三态（pass/fail/unmeasured）
 * 4. extractConfirmedEvidenceFromTrajectory：从 JSONL 提取 confirmed 证据，过滤 inferred/profile_only
 *
 * 授权边界：纯函数测试，不调用模型，不依赖真实 workspace。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const MODULE_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "uncertainty-recall-metrics.js");

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造 trajectory JSONL fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造临时 trajectory JSONL 文件，返回文件路径。
 *
 * @param entries trajectory 条目数组，每条 {type, data}
 */
function makeTrajectoryFixture(entries) {
  const tmpDir = mkdtempSync(join(tmpdir(), "ablation-recall-test-"));
  const trajPath = join(tmpDir, "trajectory.jsonl");
  const lines = entries.map((e) => JSON.stringify({ type: e.type, timestamp: Date.now(), data: e.data }));
  writeFileSync(trajPath, lines.join("\n"), "utf-8");
  return { trajPath, cleanup: () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：isValidSourceRef
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-RECALL-1：isValidSourceRef", () => {
  it("voice:profile_only:degraded 返回 false（Step 1 修复的核心 bug）", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("voice:profile_only:degraded"), false);
  });

  it("ranked:no-match 返回 false", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("ranked:no-match"), false);
  });

  it("character:empty 返回 false", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("character:empty"), false);
  });

  it("search:chapter_span:no-match 返回 false（后缀匹配）", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("search:chapter_span:no-match"), false);
  });

  it("canon:empty 返回 false（后缀匹配）", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("canon:empty"), false);
  });

  it("confirmed 的 sourceRef 返回 true（如 chapter:span:ch6:L10-L25）", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef("chapter:span:ch6:L10-L25"), true);
  });

  it("undefined / 空字符串 返回 false", async () => {
    const mod = await importModule();
    assert.equal(mod.isValidSourceRef(undefined), false);
    assert.equal(mod.isValidSourceRef(""), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：computeMustVerifyCoverage
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-RECALL-1：computeMustVerifyCoverage", () => {
  it("mustVerifyItems 为空 → coverageRatio=1（无要求即全覆盖）", async () => {
    const mod = await importModule();
    const result = mod.computeMustVerifyCoverage([], []);
    assert.equal(result.coverageRatio, 1);
    assert.equal(result.perItem.length, 0);
    assert.equal(result.uncoveredItems.length, 0);
  });

  it("3 项 mustVerify，2 项有 confirmed 证据 → coverageRatio=2/3", async () => {
    const mod = await importModule();
    const items = [
      "确认林默左臂噬魂印伤势当前状态",
      "查证云岚当前所在位置",
      "验证血玉的具体位置和用途",
    ];
    const evidences = [
      {
        sourceRef: "chapter:span:ch6:L10-L25",
        excerpt: "林默用天枢心法压制住左臂的噬魂印侵蚀，左臂目前只能发挥平时三成的力量",
        evidenceLevel: "confirmed",
      },
      {
        sourceRef: "character:state:云岚",
        excerpt: "云岚去天枢宗求援，应在秘境入口青石处",
        evidenceLevel: "confirmed_state",
      },
      // 第3项"血玉"无证据
    ];
    const result = mod.computeMustVerifyCoverage(items, evidences);
    assert.equal(result.coverageRatio, 2 / 3);
    assert.equal(result.perItem.length, 3);
    assert.equal(result.uncoveredItems.length, 1);
    assert.ok(result.uncoveredItems[0].includes("血玉"));
  });

  it("全部无覆盖 → coverageRatio=0，uncoveredItems 包含全部", async () => {
    const mod = await importModule();
    const items = ["确认A", "查证B"];
    const result = mod.computeMustVerifyCoverage(items, []);
    assert.equal(result.coverageRatio, 0);
    assert.equal(result.uncoveredItems.length, 2);
  });

  it("perItem 含 matchedEvidence（confirmed 时记录 sourceRef）", async () => {
    const mod = await importModule();
    const items = ["林默伤势"];
    const evidences = [
      {
        sourceRef: "chapter:span:ch6:L10-L25",
        excerpt: "林默伤势未愈",
        evidenceLevel: "confirmed",
      },
    ];
    const result = mod.computeMustVerifyCoverage(items, evidences);
    assert.equal(result.perItem[0].covered, true);
    assert.equal(result.perItem[0].matchedEvidence, "chapter:span:ch6:L10-L25");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：evaluateRecallCriterion（三态）
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-RECALL-1：evaluateRecallCriterion 三态", () => {
  it("两组 mustVerifyCount 全 0 → unmeasured", async () => {
    const mod = await importModule();
    const armA = [{ mustVerifyCount: 0, confirmedEvidenceCount: 0, mustVerifyCoverage: 1 }];
    const armB = [{ mustVerifyCount: 0, confirmedEvidenceCount: 0, mustVerifyCoverage: 1 }];
    const result = mod.evaluateRecallCriterion(armA, armB);
    assert.equal(result.value, "unmeasured");
    assert.ok(result.reason, "应提供 unmeasured 原因");
  });

  it("两组 confirmedEvidenceCount 全 0（有 mustVerify 但无 confirmed 证据）→ unmeasured", async () => {
    const mod = await importModule();
    const armA = [{ mustVerifyCount: 3, confirmedEvidenceCount: 0, mustVerifyCoverage: 0 }];
    const armB = [{ mustVerifyCount: 3, confirmedEvidenceCount: 0, mustVerifyCoverage: 0 }];
    const result = mod.evaluateRecallCriterion(armA, armB);
    assert.equal(result.value, "unmeasured");
    assert.ok(result.reason.includes("confirmed") || result.reason.includes("证据"), "原因应提及无 confirmed 证据");
  });

  it("avgCoverageB >= avgCoverageA → pass", async () => {
    const mod = await importModule();
    const armA = [
      { mustVerifyCount: 3, confirmedEvidenceCount: 1, mustVerifyCoverage: 0.33 },
    ];
    const armB = [
      { mustVerifyCount: 3, confirmedEvidenceCount: 2, mustVerifyCoverage: 0.67 },
    ];
    const result = mod.evaluateRecallCriterion(armA, armB);
    assert.equal(result.value, "pass");
  });

  it("avgCoverageB < avgCoverageA → fail", async () => {
    const mod = await importModule();
    const armA = [
      { mustVerifyCount: 3, confirmedEvidenceCount: 2, mustVerifyCoverage: 0.67 },
    ];
    const armB = [
      { mustVerifyCount: 3, confirmedEvidenceCount: 1, mustVerifyCoverage: 0.33 },
    ];
    const result = mod.evaluateRecallCriterion(armA, armB);
    assert.equal(result.value, "fail");
  });

  it("A 组有 confirmed 证据但 B 组无 → fail（B 组召回退化）", async () => {
    const mod = await importModule();
    const armA = [{ mustVerifyCount: 3, confirmedEvidenceCount: 2, mustVerifyCoverage: 0.67 }];
    const armB = [{ mustVerifyCount: 3, confirmedEvidenceCount: 0, mustVerifyCoverage: 0 }];
    const result = mod.evaluateRecallCriterion(armA, armB);
    assert.equal(result.value, "fail");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：extractConfirmedEvidenceFromTrajectory
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-RECALL-1：extractConfirmedEvidenceFromTrajectory", () => {
  it("从 ranked_evidence 条目提取 confirmed 证据，过滤 inferred/profile_only", async () => {
    const mod = await importModule();
    const { trajPath, cleanup } = makeTrajectoryFixture([
      {
        type: "ranked_evidence",
        data: {
          evidences: [
            { sourceRef: "chapter:span:ch6:L10-L25", excerpt: "林默左臂噬魂印侵蚀", evidenceLevel: "confirmed" },
            { sourceRef: "ranked:no-match", excerpt: "", evidenceLevel: "inferred" },
            { sourceRef: "voice:profile_only:degraded", excerpt: "声音降级", evidenceLevel: "profile_only" },
          ],
        },
      },
    ]);
    try {
      const result = mod.extractConfirmedEvidenceFromTrajectory(trajPath);
      assert.equal(result.length, 1, "只应提取 1 条 confirmed 证据");
      assert.equal(result[0].sourceRef, "chapter:span:ch6:L10-L25");
      assert.equal(result[0].evidenceLevel, "confirmed");
    } finally {
      cleanup();
    }
  });

  it("从 tool_event 条目提取 confirmed_state 证据", async () => {
    const mod = await importModule();
    const { trajPath, cleanup } = makeTrajectoryFixture([
      {
        type: "tool_event",
        data: {
          type: "tool_execution_end",
          result: {
            details: { sourceRef: "character:state:林默", evidenceLevel: "confirmed_state" },
            content: [{ type: "text", text: "林默 leftArmStatus: 噬魂印侵蚀，三成力量" }],
          },
        },
      },
    ]);
    try {
      const result = mod.extractConfirmedEvidenceFromTrajectory(trajPath);
      assert.equal(result.length, 1);
      assert.equal(result[0].evidenceLevel, "confirmed_state");
      assert.ok(result[0].excerpt.includes("噬魂印"));
    } finally {
      cleanup();
    }
  });

  it("过滤 evidenceLevel=inferred 的 tool_result（如 character:empty）", async () => {
    const mod = await importModule();
    const { trajPath, cleanup } = makeTrajectoryFixture([
      {
        type: "tool_event",
        data: {
          type: "tool_execution_end",
          result: {
            details: { sourceRef: "character:empty", evidenceLevel: "inferred" },
            content: [{ type: "text", text: "未找到角色" }],
          },
        },
      },
    ]);
    try {
      const result = mod.extractConfirmedEvidenceFromTrajectory(trajPath);
      assert.equal(result.length, 0, "inferred 证据不应被提取");
    } finally {
      cleanup();
    }
  });

  it("文件不存在 → 返回空数组", async () => {
    const mod = await importModule();
    const result = mod.extractConfirmedEvidenceFromTrajectory("/nonexistent/path/trajectory.jsonl");
    assert.equal(result.length, 0);
  });

  it("混合 ranked_evidence + tool_event，按 VALID_EVIDENCE_LEVELS 过滤", async () => {
    const mod = await importModule();
    const { trajPath, cleanup } = makeTrajectoryFixture([
      {
        type: "ranked_evidence",
        data: {
          evidences: [
            { sourceRef: "chapter:span:ch6:L10-L25", excerpt: "血玉在林默怀中", evidenceLevel: "exact_chapter_span" },
            { sourceRef: "voice:profile_only:degraded", excerpt: "降级", evidenceLevel: "profile_only" },
          ],
        },
      },
      {
        type: "tool_event",
        data: {
          type: "tool_execution_end",
          result: {
            details: { sourceRef: "canon:evt-blood-jade", evidenceLevel: "confirmed" },
            content: [{ type: "text", text: "血玉是葬神渊封印钥匙" }],
          },
        },
      },
      {
        type: "tool_event",
        data: {
          type: "tool_execution_end",
          result: {
            details: { sourceRef: "ranked:no-match", evidenceLevel: "inferred" },
            content: [{ type: "text", text: "无匹配" }],
          },
        },
      },
    ]);
    try {
      const result = mod.extractConfirmedEvidenceFromTrajectory(trajPath);
      assert.equal(result.length, 2, "应提取 2 条（exact_chapter_span + confirmed），过滤 profile_only 和 inferred");
      const levels = result.map((e) => e.evidenceLevel).sort();
      assert.deepEqual(levels, ["confirmed", "exact_chapter_span"]);
    } finally {
      cleanup();
    }
  });
});
