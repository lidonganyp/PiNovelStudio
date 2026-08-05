/**
 * MUST-VERIFY-COVERAGE-GATE-1：生产风险门接口设计测试（Step 4，interface only）
 *
 * 验证内容：
 * 1. 模块导出预期的类型与函数
 * 2. assessMustVerifyRisk stub：全部返回 P0（最保守分类）
 * 3. checkMustVerifyCoverage stub：passed=true + skippedReason="stub_not_implemented"
 * 4. CoverageGateResult 含 failureEnvelope 结构（未实现时 undefined）
 * 5. FactRiskLevel 类型 = "P0" | "P1" | "P2"
 *
 * ⚠️ 本测试验证的是 STUB 行为（保持生产行为不变），不是实际风险分类逻辑。
 * 实际逻辑在 Step 1-3 事实安全重新通过后实现，届时更新本测试文件。
 *
 * RED 阶段：模块不存在，所有测试失败（ERR_MODULE_NOT_FOUND）
 * GREEN 阶段：实现 must-verify-coverage-gate.ts stub 后全部通过
 *
 * 授权边界：纯函数测试，不调用模型 API，不依赖 workspace fixture。
 * 模块位置：novelos/agent/must-verify-coverage-gate.ts（eval-only，不入 tsconfig.prod.json）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "agent",
  "must-verify-coverage-gate.js",
);

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：模块导出
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST-VERIFY-COVERAGE-GATE-1：模块导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importModule();
    assert.ok(mod, "must-verify-coverage-gate 模块应可导入");
  });

  it("导出 assessMustVerifyRisk / checkMustVerifyCoverage / createStubCoverageGate", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.assessMustVerifyRisk, "function");
    assert.equal(typeof mod.checkMustVerifyCoverage, "function");
    assert.equal(typeof mod.createStubCoverageGate, "function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：assessMustVerifyRisk — stub 风险分类
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST-VERIFY-COVERAGE-GATE-1：assessMustVerifyRisk（stub）", () => {
  it("空 mustVerify → 空数组", async () => {
    const mod = await importModule();
    const result = mod.assessMustVerifyRisk([], []);
    assert.equal(result.length, 0);
  });

  it("所有 mustVerify 项分类为 P0（最保守）", async () => {
    const mod = await importModule();
    const mustVerify = ["确认林默伤势", "查证云岚位置", "验证血玉用途"];
    const result = mod.assessMustVerifyRisk(mustVerify, []);
    assert.equal(result.length, 3);
    for (const item of result) {
      assert.equal(item.riskLevel, "P0", `项 "${item.item}" 应为 P0`);
      assert.ok(typeof item.reason === "string" && item.reason.length > 0, "reason 非空");
    }
  });

  it("每项含 item / riskLevel / reason 字段", async () => {
    const mod = await importModule();
    const result = mod.assessMustVerifyRisk(["测试项"], []);
    assert.equal(result.length, 1);
    assert.ok("item" in result[0], "含 item 字段");
    assert.ok("riskLevel" in result[0], "含 riskLevel 字段");
    assert.ok("reason" in result[0], "含 reason 字段");
  });

  it("inviolableFacts 非空时仍全部返回 P0（stub 不做实际分类）", async () => {
    const mod = await importModule();
    const mustVerify = ["确认林默伤势"];
    const inviolableFacts = ["林默左臂有噬魂印"];
    const result = mod.assessMustVerifyRisk(mustVerify, inviolableFacts);
    assert.equal(result.length, 1);
    assert.equal(result[0].riskLevel, "P0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：checkMustVerifyCoverage — stub 覆盖门
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST-VERIFY-COVERAGE-GATE-1：checkMustVerifyCoverage（stub）", () => {
  it("stub 返回 passed=true（不阻断，保持生产行为）", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["确认林默伤势"],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    assert.equal(result.passed, true, "stub 应 passed=true（不阻断）");
  });

  it("stub 返回 skippedReason='stub_not_implemented'", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["确认林默伤势"],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    assert.equal(result.skippedReason, "stub_not_implemented");
  });

  it("stub 返回空 unverifiedHighRisk / confirmedItems", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["确认林默伤势"],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    assert.equal(result.unverifiedHighRisk.length, 0);
    assert.equal(result.confirmedItems.length, 0);
  });

  it("stub 不设置 failureEnvelope（undefined）", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["确认林默伤势"],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    assert.equal(result.failureEnvelope, undefined);
  });

  it("mustVerify 为空时 stub 仍返回 passed=true", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: [],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    assert.equal(result.passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：createStubCoverageGate — 工厂函数
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST-VERIFY-COVERAGE-GATE-1：createStubCoverageGate", () => {
  it("返回含 checkAndBlock 方法的对象", async () => {
    const mod = await importModule();
    const gate = mod.createStubCoverageGate();
    assert.ok(gate, "工厂应返回对象");
    assert.equal(typeof gate.checkAndBlock, "function");
  });

  it("checkAndBlock 行为与 checkMustVerifyCoverage 一致", async () => {
    const mod = await importModule();
    const gate = mod.createStubCoverageGate();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["确认林默伤势"],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = gate.checkAndBlock(input);
    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "stub_not_implemented");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：类型结构验证（运行时形状）
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST-VERIFY-COVERAGE-GATE-1：类型结构", () => {
  it("CoverageGateResult 含 passed / unverifiedHighRisk / confirmedItems / skippedReason / failureEnvelope 字段", async () => {
    const mod = await importModule();
    const input = {
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: [],
        allowedTools: [],
        stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
      },
      trajectoryPath: "",
      inviolableFacts: [],
      contextCoveredFacts: [],
    };
    const result = mod.checkMustVerifyCoverage(input);
    // 验证所有必需字段存在
    assert.ok("passed" in result, "含 passed 字段");
    assert.ok("unverifiedHighRisk" in result, "含 unverifiedHighRisk 字段");
    assert.ok("confirmedItems" in result, "含 confirmedItems 字段");
    assert.ok("skippedReason" in result, "含 skippedReason 字段");
    assert.ok("failureEnvelope" in result, "含 failureEnvelope 字段");
  });

  it("ClassifiedMustVerify 含 item / riskLevel / reason 字段", async () => {
    const mod = await importModule();
    const result = mod.assessMustVerifyRisk(["测试"], []);
    assert.equal(result.length, 1);
    const item = result[0];
    assert.ok("item" in item, "含 item 字段");
    assert.ok("riskLevel" in item, "含 riskLevel 字段");
    assert.ok("reason" in item, "含 reason 字段");
    // riskLevel 只能是 P0/P1/P2
    assert.ok(["P0", "P1", "P2"].includes(item.riskLevel), `riskLevel 应为 P0/P1/P2，实际 ${item.riskLevel}`);
  });
});
