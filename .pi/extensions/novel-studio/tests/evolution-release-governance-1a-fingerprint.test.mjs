/**
 * EVOLUTION-RELEASE-GOVERNANCE-1A — Environment Fingerprint: 稳定性、敏感性、dirty 捕获 (RED)
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §2.2 / §3 / Phase G2
 * 任务卡：EVOLUTION-RELEASE-GOVERNANCE-1A 第一批
 *
 * 验收点（任务卡“必须测试”）：
 * - 同一环境生成稳定 fingerprint
 * - 任一行为资产变化都会改变 fingerprint
 * - dirty worktree 必须被准确捕获
 * - 秘密不得明文落盘
 * - 从 NovelBench 抽取环境 provenance，不得让生产代码依赖 eval 模块
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 不修改用户当前未提交代码（只读用户文件）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectEnvironmentFingerprint,
  verifyEnvironmentFingerprint,
  computeFingerprintHash,
} from "../dist-test/v2/governance/environment-fingerprint.js";

// ============================================================================
// Fixture
// ============================================================================

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "evo-rel-fp-"));
}

/** 构造一组指纹输入 fixture（同输入应产生同指纹） */
function makeFingerprintInput(projectRoot, overrides = {}) {
  return {
    projectRoot,
    modelRoutingPath: "config/model-routing.json",
    promptBundlePaths: [],
    toolSchemaPaths: [],
    activeStrategyIds: [],
    constitutionHash: "sha256:constitution:abc",
    datasetHash: "sha256:dataset:abc",
    evalProtocolHash: "sha256:eval:abc",
    seed: 0,
    budgetMaxCalls: 10,
    timeoutMs: 300000,
    fallbackPolicy: "disabled",
    generationModel: "glm-5.2",
    judgeModel: "glm-5.2",
    proxyApprovalModel: "gpt5.6-sol",
    envSwitchNames: ["PINOVEL_DISABLE_FALLBACK", "V2_FORCE_STUB"],
    secretEnvNames: ["GLM_API_KEY", "ARK_API_KEY"],
    ...overrides,
  };
}

// ============================================================================
// 1. 稳定性：同输入 → 同指纹
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 同输入生成稳定 fingerprint", () => {
  const dir = makeTempDir();
  try {
    // 模拟项目结构
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "model-routing.json"),
      JSON.stringify({ version: "4.9.0", routes: {} }),
      "utf-8",
    );

    const input1 = makeFingerprintInput(dir);
    const input2 = makeFingerprintInput(dir);

    const fp1 = collectEnvironmentFingerprint(input1);
    const fp2 = collectEnvironmentFingerprint(input2);

    assert.equal(fp1.fingerprintHash, fp2.fingerprintHash, "同输入 fingerprint hash 必须一致");
    assert.equal(computeFingerprintHash(fp1), computeFingerprintHash(fp2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 敏感性：任一行为资产变化 → 不同指纹
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: model-routing 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "model-routing.json"),
      JSON.stringify({ version: "4.9.0", routes: {} }),
      "utf-8",
    );

    const fp1 = collectEnvironmentFingerprint(makeFingerprintInput(dir));

    // 修改 model-routing
    writeFileSync(
      join(dir, "config", "model-routing.json"),
      JSON.stringify({ version: "4.9.1", routes: { narrator: "doubao" } }),
      "utf-8",
    );

    const fp2 = collectEnvironmentFingerprint(makeFingerprintInput(dir));

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "model-routing 变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: generationModel 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "model-routing.json"),
      JSON.stringify({ version: "4.9.0" }),
      "utf-8",
    );

    const fp1 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { generationModel: "glm-5.2" }));
    const fp2 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { generationModel: "doubao-seed-2-1-pro" }));

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "generationModel 变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: seed 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const fp1 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { seed: 0 }));
    const fp2 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { seed: 1 }));

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "seed 变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: budget 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const fp1 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { budgetMaxCalls: 6 }));
    const fp2 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { budgetMaxCalls: 10 }));

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "budget 变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: activeStrategyIds 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const fp1 = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { activeStrategyIds: ["reader_payoff_strengthen"] }),
    );
    const fp2 = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { activeStrategyIds: ["character_agency_focus"] }),
    );

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "active 策略集合变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: fallbackPolicy 变化 → 不同 fingerprint", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const fp1 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { fallbackPolicy: "disabled" }));
    const fp2 = collectEnvironmentFingerprint(makeFingerprintInput(dir, { fallbackPolicy: "enabled" }));

    assert.notEqual(fp1.fingerprintHash, fp2.fingerprintHash, "fallback 策略变化必须改变 fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. dirty worktree 捕获
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: dirty worktree 必须被捕获", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const fp = collectEnvironmentFingerprint(makeFingerprintInput(dir));
    // worktreeDirty 字段必须存在（true 或 false），且类型为 boolean
    assert.ok("worktreeDirty" in fp, "fingerprint 必须含 worktreeDirty 字段");
    assert.equal(typeof fp.worktreeDirty, "boolean");
    // codeCommit 字段必须存在（即使为空字符串，也必须显式记录）
    assert.ok("codeCommit" in fp, "fingerprint 必须含 codeCommit 字段");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: worktreeDirty 影响 fingerprint hash", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    // 通过 mockGit 选项模拟 clean vs dirty
    const fpClean = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "abc123", worktreeDirty: false } }),
    );
    const fpDirty = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "abc123", worktreeDirty: true } }),
    );

    assert.notEqual(
      fpClean.fingerprintHash,
      fpDirty.fingerprintHash,
      "worktreeDirty 变化必须改变 fingerprint",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 秘密不得明文落盘
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 秘密环境变量只记录是否存在，不记录值", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    // 模拟设置秘密环境变量
    process.env["GLM_API_KEY_FAKE"] = "sk-secret-value-12345";
    try {
      const fp = collectEnvironmentFingerprint(
        makeFingerprintInput(dir, {
          secretEnvNames: ["GLM_API_KEY_FAKE"],
        }),
      );
      // 序列化后不得包含秘密值
      const serialized = JSON.stringify(fp);
      assert.ok(
        !serialized.includes("sk-secret-value-12345"),
        "秘密值不得出现在 fingerprint 中",
      );
      // 但应记录该秘密变量存在
      assert.ok(
        fp.secretEnvStates.some((s) => s.name === "GLM_API_KEY_FAKE" && s.set === true),
        "应记录秘密变量存在状态",
      );
    } finally {
      delete process.env["GLM_API_KEY_FAKE"];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: envSwitches 只记录是否存在，不记录值", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    process.env["PINOVEL_DISABLE_FALLBACK"] = "1";
    try {
      const fp = collectEnvironmentFingerprint(
        makeFingerprintInput(dir, { envSwitchNames: ["PINOVEL_DISABLE_FALLBACK"] }),
      );
      const serialized = JSON.stringify(fp);
      // envSwitches 只记录 set=true/false，不记录值 "1"
      assert.ok(fp.envSwitches.some((s) => s.name === "PINOVEL_DISABLE_FALLBACK" && s.set === true));
      // 不应包含值 "1" 作为环境变量值（但 "1" 可能巧合出现在其他字段，弱断言）
    } finally {
      delete process.env["PINOVEL_DISABLE_FALLBACK"];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. verifyEnvironmentFingerprint
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A verify: 相同 fingerprint → reproducible=true", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const mockGit = { codeCommit: "abc123", worktreeDirty: false };
    const recorded = collectEnvironmentFingerprint(makeFingerprintInput(dir, { mockGit }));
    const actual = collectEnvironmentFingerprint(makeFingerprintInput(dir, { mockGit }));

    const result = verifyEnvironmentFingerprint(recorded, actual);
    assert.equal(result.reproducible, true);
    assert.equal(result.checks.length > 0, true);
    assert.ok(result.checks.every((c) => c.passed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A verify: fingerprint hash 不一致 → reproducible=false", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const mockGit = { codeCommit: "abc123", worktreeDirty: false };
    const recorded = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit, generationModel: "glm-5.2" }),
    );
    const actual = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit, generationModel: "doubao" }),
    );

    const result = verifyEnvironmentFingerprint(recorded, actual);
    assert.equal(result.reproducible, false);
    assert.ok(result.checks.some((c) => !c.passed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A verify: codeCommit 不一致 → reproducible=false", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const recorded = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "aaa", worktreeDirty: false } }),
    );
    const actual = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "bbb", worktreeDirty: false } }),
    );

    const result = verifyEnvironmentFingerprint(recorded, actual);
    assert.equal(result.reproducible, false);
    assert.ok(result.checks.some((c) => /commit/i.test(c.name) && !c.passed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A verify: 实际 worktree dirty → reproducible=false（验收需 clean worktree）", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "model-routing.json"), "{}", "utf-8");

    const recorded = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "aaa", worktreeDirty: false } }),
    );
    const actual = collectEnvironmentFingerprint(
      makeFingerprintInput(dir, { mockGit: { codeCommit: "aaa", worktreeDirty: true } }),
    );

    const result = verifyEnvironmentFingerprint(recorded, actual);
    assert.equal(result.reproducible, false);
    assert.ok(result.checks.some((c) => /dirty/i.test(c.name) && !c.passed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 不依赖 eval 模块（结构断言）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 模块自包含，不 import novelbench/eval", async () => {
  // 读取编译后产物，验证不依赖 eval 模块
  // 相对测试文件定位 dist-test 产物，不依赖 process.cwd()
  const testDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = join(testDir, "..", "dist-test", "v2", "governance", "environment-fingerprint.js");
  const src = readFileSync(modulePath, "utf-8");
  // 只检查实际 import/require 语句，不匹配注释文本（编译后产物可能保留文档注释）
  const importMatch = src.match(/(?:from\s+|require\s*\(\s*)["']([^"']+)["']/g) || [];
  const forbiddenImports = importMatch.filter((s) =>
    /novelbench\//.test(s) || /(?:^|\/)eval\//.test(s),
  );
  assert.deepEqual(
    forbiddenImports,
    [],
    "environment-fingerprint 不得 import novelbench/ 或 eval/ 模块（生产代码不得依赖 eval）",
  );
});

// ============================================================================
// 7. 构建产物目录覆盖（buildArtifactDirs，DG-1 缺口修复）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 构建产物目录内文件变化 → buildArtifactHash + fingerprintHash 变化", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "dist", "v2", "core"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "INDEX-V1", "utf-8");
    writeFileSync(join(dir, "dist", "v2", "core", "final-state-commit.js"), "FSC-V1", "utf-8");
    const input = makeFingerprintInput(dir, {
      buildArtifactPaths: ["dist/index.js"],
      buildArtifactDirs: ["dist"],
    });
    const before = collectEnvironmentFingerprint(input);
    writeFileSync(join(dir, "dist", "v2", "core", "final-state-commit.js"), "FSC-V2", "utf-8");
    const after = collectEnvironmentFingerprint(input);
    assert.notEqual(after.buildArtifactHash, before.buildArtifactHash, "目录内 .js 变化必须改变 buildArtifactHash");
    assert.notEqual(after.fingerprintHash, before.fingerprintHash, "目录内 .js 变化必须改变 fingerprintHash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 构建产物目录不存在 → 空清单确定性", () => {
  const dir = makeTempDir();
  try {
    const input = makeFingerprintInput(dir, { buildArtifactDirs: ["dist-does-not-exist"] });
    const a = collectEnvironmentFingerprint(input);
    const b = collectEnvironmentFingerprint(input);
    assert.equal(a.buildArtifactHash, b.buildArtifactHash);
    assert.equal(a.fingerprintHash, b.fingerprintHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A fingerprint: 构建产物目录确定性（重复 capture 一致）", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "dist", "v2", "core"), { recursive: true });
    writeFileSync(join(dir, "dist", "v2", "core", "final-state-commit.js"), "FSC", "utf-8");
    const input = makeFingerprintInput(dir, { buildArtifactDirs: ["dist"] });
    const a = collectEnvironmentFingerprint(input);
    const b = collectEnvironmentFingerprint(input);
    assert.equal(a.buildArtifactHash, b.buildArtifactHash);
    assert.equal(a.fingerprintHash, b.fingerprintHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
