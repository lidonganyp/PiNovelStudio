/**
 * Phase 5 受控生产接入 — facade runtime 变体 focused 测试
 *
 * 覆盖三个核心语义（受控接入，非全量切换）：
 * 1. registry facade 注册：enableFacade=false（默认）只注册 9 专用工具；
 *    enableFacade=true 额外注册 query_narrative_production（10 工具）。
 * 2. evidence-plan 受控注入：toolMode="facade" 时 allowedTools 收窄为统一入口；
 *    显式 allowedTools 优先于 toolMode；toolMode 缺省走 intent 推断/全量（默认行为不变）。
 * 3. resolve-tool-mode fail-closed/rollback：仅当 canary 授权明确声明 toolMode="facade"
 *    且未过期才返回 "facade"；授权缺失 / standard / 非法 / 损坏 / 过期一律返回 undefined
 *    （= 默认 9 专用工具，失败即可回退）。
 *
 * 依赖边界：本测试只依赖生产闭包（dist/），不依赖 eval-only 模块；验证
 * query_narrative（eval-only）与 query_narrative_production（runtime）隔离。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createNarrativeToolRegistry } from "../dist/novelos/agent/narrative-tool-registry.js";
import { PermissionPolicy } from "../dist/novelos/security/permission-policy.js";
import { createEvidencePlan } from "../dist/novelos/agent/evidence-plan.js";
import {
  NARRATIVE_TOOL_NAMES,
  NARRATIVE_TOOL_NAMES_WITH_FACADE,
  QUERY_NARRATIVE_PRODUCTION_NAME,
} from "../dist/novelos/tools/narrative-tools.js";
import { resolveToolModeFromCanaryAuthorization } from "../dist/v2/governance/resolve-tool-mode-from-canary-authorization.js";
import {
  CANARY_AUTHORIZATION_SCHEMA_ID,
  CANARY_AUTHORIZATION_SCHEMA_VERSION,
} from "../dist/v2/governance/canary-workspace-authorization.js";

// ============================================================================
// 常量（与源码一致，避免硬编码漂移）
// ============================================================================

const FACADE_NAME = QUERY_NARRATIVE_PRODUCTION_NAME;
const EVAL_FACADE_NAME = "query_narrative";

// ============================================================================
// 工具 fixture：registry / permissionPolicy
// ============================================================================

let workspaceRoot;
let permissionPolicy;

/** 最小 stub searchService（registry 构造不执行工具，仅测注册集合） */
const stubSearchService = {};

function makeRegistry(enableFacade) {
  return createNarrativeToolRegistry({
    searchService: stubSearchService,
    permissionPolicy,
    enableFacade,
  });
}

before(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "phase5-facade-"));
  permissionPolicy = new PermissionPolicy({
    workspaceRoot,
    sessionId: "phase5-session",
  });
});

after(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

// ============================================================================
// 1. registry facade 注册
// ============================================================================

describe("Phase 5 registry facade 注册", () => {
  it("默认（enableFacade 缺省）只注册 9 专用工具，不含 facade", () => {
    const registry = makeRegistry();
    const names = registry.getToolNames();
    assert.equal(names.length, 9, `默认应注册 9 工具，实际 ${names.length}`);
    assert.equal(registry.getToolProtocol(FACADE_NAME), undefined, "默认不应注册 facade");
    for (const name of NARRATIVE_TOOL_NAMES) {
      assert.ok(names.includes(name), `应包含专用工具 ${name}`);
    }
  });

  it("enableFacade=false 同样只注册 9 工具", () => {
    const registry = makeRegistry(false);
    assert.equal(registry.getToolNames().length, 9);
    assert.equal(registry.getToolProtocol(FACADE_NAME), undefined);
  });

  it("enableFacade=true 额外注册 query_narrative_production（10 工具）", () => {
    const registry = makeRegistry(true);
    const names = registry.getToolNames();
    assert.equal(names.length, 10, `facade 模式应注册 10 工具，实际 ${names.length}`);
    assert.ok(names.includes(FACADE_NAME), "应包含 facade 工具");
    for (const name of NARRATIVE_TOOL_NAMES) {
      assert.ok(names.includes(name), `应保留专用工具 ${name}`);
    }
  });

  it("facade 工具是 read_only + workspace_read（agent 可安全使用）", () => {
    const registry = makeRegistry(true);
    const tool = registry.getToolProtocol(FACADE_NAME);
    assert.ok(tool, "facade 工具应存在");
    assert.equal(tool.sideEffect, "read_only", "facade 应为只读");
    assert.equal(tool.requiredPermission, "workspace_read", "facade 应要求 workspace_read");
    assert.ok(tool.timeoutMs > 0, "facade 应有 timeoutMs");
  });

  it("facade 工具可被 agent 角色获取（不要求 final_commit）", () => {
    const registry = makeRegistry(true);
    const tools = registry.getToolsForRole("agent");
    assert.ok(
      tools.some((t) => t.name === FACADE_NAME),
      "agent 应可见 facade 工具",
    );
  });
});

// ============================================================================
// 2. evidence-plan 受控注入
// ============================================================================

describe("Phase 5 evidence-plan allowedTools 受控注入", () => {
  it("toolMode=facade 且未显式 allowedTools → 收窄为 [query_narrative_production]", () => {
    const plan = createEvidencePlan({
      chapterIntent: "",
      seedContext: "",
      toolMode: "facade",
    });
    assert.deepEqual(plan.allowedTools, [FACADE_NAME], "facade 模式 allowedTools 应收窄为统一入口");
  });

  it("toolMode=facade 但与 intent 结合时仍收窄为统一入口", () => {
    const plan = createEvidencePlan({
      chapterIntent: "本章",
      seedContext: "林默",
      toolMode: "facade",
      intent: {
        authorMustInclude: ["林默确认复苏之眼代价"],
        inviolableFacts: ["复苏之眼使用会透支精神力"],
      },
    });
    assert.deepEqual(plan.allowedTools, [FACADE_NAME], "facade 优先于 intent 推断");
  });

  it("显式 allowedTools 优先于 toolMode（调用方精确控制）", () => {
    const plan = createEvidencePlan({
      chapterIntent: "",
      seedContext: "",
      toolMode: "facade",
      allowedTools: ["query_canon"],
    });
    assert.deepEqual(plan.allowedTools, ["query_canon"], "显式 allowedTools 应覆盖 toolMode");
  });

  it("toolMode 缺省（undefined）→ 无 intent 时回退全量 9 工具", () => {
    const plan = createEvidencePlan({
      chapterIntent: "",
      seedContext: "",
    });
    assert.deepEqual(plan.allowedTools, [...NARRATIVE_TOOL_NAMES], "缺省 mode 且无 intent 应回退全量");
  });

  it("toolMode 缺省 + 有 intent → intent 推断收窄（默认生产行为）", () => {
    const plan = createEvidencePlan({
      chapterIntent: "",
      seedContext: "",
      intent: {
        inviolableFacts: ["复苏之眼代价"],
        focusCharacterGoals: ["林默控制复苏之眼"],
      },
    });
    const tools = plan.allowedTools;
    assert.ok(tools.includes("query_canon"), "intent 推断应含 query_canon");
    assert.ok(tools.includes("query_character_state"), "intent 推断应含 query_character_state");
    assert.ok(!tools.includes(FACADE_NAME), "默认生产不应含 facade 工具");
  });

  it("toolMode=standard 明确声明 → 与缺省一致（不走 facade）", () => {
    const plan = createEvidencePlan({
      chapterIntent: "",
      seedContext: "",
      toolMode: "standard",
    });
    assert.deepEqual(plan.allowedTools, [...NARRATIVE_TOOL_NAMES], "standard 应走默认全量");
  });
});

// ============================================================================
// 3. resolve-tool-mode fail-closed / rollback
// ============================================================================

describe("Phase 5 resolveToolModeFromCanaryAuthorization fail-closed", () => {
  const NOW = new Date("2026-08-08T12:00:00.000Z");
  const FUTURE = new Date("2026-08-09T12:00:00.000Z");
  const PAST = new Date("2026-08-07T12:00:00.000Z");

  function writeAuth(projectRoot, workspaceId, overrides = {}) {
    const wsDir = join(projectRoot, "workspaces", workspaceId);
    mkdirSync(wsDir, { recursive: true });
    const auth = {
      schemaId: CANARY_AUTHORIZATION_SCHEMA_ID,
      schemaVersion: CANARY_AUTHORIZATION_SCHEMA_VERSION,
      authorizationId: "phase5-auth",
      workspaceId,
      allowedReleaseIds: ["*"],
      budget: { maxChapters: 1, maxCalls: 1 },
      issuedAt: "2026-08-08T00:00:00.000Z",
      expiresAt: FUTURE.toISOString(),
      issuer: "user",
      ...overrides,
    };
    writeFileSync(join(wsDir, "canary-authorization.json"), JSON.stringify(auth), "utf-8");
  }

  it("授权声明 toolMode=facade 且未过期 → 返回 facade", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-facade", { toolMode: "facade" });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-facade", NOW), "facade");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权文件缺失 → fail-closed 返回 undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-missing", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权未声明 toolMode → 返回 undefined（默认 standard）", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-no-mode");
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-no-mode", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权声明 toolMode=standard → 返回 undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-standard", { toolMode: "standard" });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-standard", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权 toolMode=facade 但已过期 → 返回 undefined（不回退到已失效 opt-in）", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-expired", { toolMode: "facade", expiresAt: PAST.toISOString() });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-expired", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权 toolMode=facade 但 expiresAt 无法解析 → 返回 undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-bad-expiry", { toolMode: "facade", expiresAt: "not-a-date" });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-bad-expiry", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权文件损坏 JSON → fail-closed 返回 undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      const wsDir = join(root, "workspaces", "ws-corrupt");
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, "canary-authorization.json"), "{bad json", "utf-8");
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-corrupt", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("授权 toolMode 为非法枚举值 → schema 校验失败，返回 undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-bad-mode", { toolMode: "full_switch" });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-bad-mode", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollback 语义：facade 授权删除后立即回到 undefined（9 专用工具）", () => {
    const root = mkdtempSync(join(tmpdir(), "phase5-auth-"));
    try {
      writeAuth(root, "ws-rollback", { toolMode: "facade" });
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-rollback", NOW), "facade");
      // 模拟失败后删除授权 → fail-closed 回到 standard
      rmSync(join(root, "workspaces", "ws-rollback", "canary-authorization.json"));
      assert.equal(resolveToolModeFromCanaryAuthorization(root, "ws-rollback", NOW), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 依赖边界：eval-only query_narrative 与 runtime query_narrative_production 隔离
// ============================================================================

describe("Phase 5 eval/production 隔离", () => {
  it("NARRATIVE_TOOL_NAMES_WITH_FACADE = 9 专用工具 + query_narrative_production", () => {
    assert.equal(
      NARRATIVE_TOOL_NAMES_WITH_FACADE.size,
      NARRATIVE_TOOL_NAMES.size + 1,
      "facade 白名单应为 9 工具 + 1 facade",
    );
    assert.ok(NARRATIVE_TOOL_NAMES_WITH_FACADE.has(FACADE_NAME), "白名单应含 runtime facade");
  });

  it("runtime facade 名与 eval-only query_narrative 不同（不混用）", () => {
    assert.notEqual(FACADE_NAME, EVAL_FACADE_NAME, "runtime 与 eval facade 必须区分");
    assert.ok(!NARRATIVE_TOOL_NAMES_WITH_FACADE.has(EVAL_FACADE_NAME), "白名单不应含 eval-only facade");
  });
});