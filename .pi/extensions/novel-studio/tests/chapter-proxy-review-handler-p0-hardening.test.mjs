/**
 * P0 阻断项修复 RED 测试（核验结论第二轮）：
 *   1. P0-1 凭据外泄/SSRF：公共 schema 不得暴露 callerOverride/apiKey/apiBaseUrl/modelId；
 *      runner 从 env 读取 NOVELOS_JUDGE_BASE_URL 时必须做 endpoint 白名单校验
 *      （拒绝非 HTTPS / 回环 / 私网地址），防止把 NOVELOS_JUDGE_API_KEY 作为 Bearer
 *      发往调用方指定地址。
 *   2. P0-2 artifact 身份错绑：顶层 workspaceId/chapterId/releaseId 必须与 packetInput
 *      对应字段完全一致；不一致 → fail-closed status=error，不调用 runner、不写 registry。
 *
 * 真相源：用户核验结论（2026-07-17 第二轮）
 *   - "公共入口删除 callerOverride/apiKey/apiBaseUrl/modelId；生产配置只能从可信环境/config 读取"
 *   - "进入 registry 前强制校验顶层三元组与 packetInput 完全一致"
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不联网（SSRF 测试用私有/回环地址 + 不提供 callerOverride，
 *   runner 必须在创建 caller 之前拒绝 endpoint，不发起任何 fetch）
 * - 不依赖真实 NOVELOS_JUDGE_* env（测试期间临时注入 + try/finally 还原）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// 工具：构造合法授权卡 JSON（覆盖指定 releaseId，预算 2 calls）
// ============================================================================

function makeValidCard(releaseId = "rel-001") {
  return {
    schemaId: "pinovel.evolution-authorization-card",
    schemaVersion: 1,
    cardId: "card-test-001",
    cardType: "real_gpt56sol",
    model: "gpt5.6-sol",
    allowedReleaseIds: [releaseId],
    budget: { maxCalls: 2, timeoutMs: 60000 },
    modelVersion: "gpt5.6-sol-2026-07",
    issuedAt: "2026-07-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    issuer: "test",
  };
}

// 工具：构造最小 packetInput（含 releaseId/workspaceId/chapterId）
function makePacketInput({ workspaceId = "ws-test", chapterId = "1", releaseId = "rel-001" } = {}) {
  return {
    releaseId,
    workspaceId,
    chapterId,
    candidates: [
      {
        candidateId: "cand-raw-001",
        candidateKind: "raw",
        text: "raw 候选正文",
        spans: [],
      },
      {
        candidateId: "cand-ed-001",
        candidateKind: "editorial",
        text: "editorial 候选正文",
        spans: [],
      },
    ],
    factGuardReport: { hardBlocked: false, warnings: [] },
    stateConsistency: { consistent: true },
    costProfile: { totalTokens: 0, latencyMs: 0 },
    systemJudgeConclusion: "",
    developerExpectation: "",
    budgetMaxCalls: 2,
    timeoutMs: 60000,
    fixedCase: "case-test",
    fixedModel: "gpt5.6-sol",
    fixedSeed: 0,
  };
}

// ============================================================================
// P0-1 SSRF: 公共 schema 不暴露 callerOverride/apiKey/apiBaseUrl/modelId
// ============================================================================

test("P0-1 schema: novel_workspace_manager inputSchema 不暴露 callerOverride/apiKey/apiBaseUrl/modelId", async () => {
  const { registerTools } = await import("../dist/tools/register-tools.js");
  const tools = registerTools({
    handleGenerateChapter: async () => ({}),
    handlePreflightWorkspace: async () => ({}),
    handleWorkspaceManager: async () => ({}),
    handlePlanStoryOutline: async () => ({}),
    handleStrategyPolicyView: async () => ({}),
    handleStrategyFeedback: async () => ({}),
  });
  const wsManager = tools.find((t) => t.name === "novel_workspace_manager");
  assert.ok(wsManager, "必须注册 novel_workspace_manager 工具");
  // registerTools 通过 wrapLegacyTool 把 inputSchema 转换为 TypeBox parameters
  // 公共 schema 字段实际暴露面在 parameters.properties（TypeBox schema）
  const props = wsManager.parameters?.properties ?? {};
  assert.ok(
    !("callerOverride" in props),
    "公共 schema 不得暴露 callerOverride（测试字段不得进入 MCP 公共接口，允许绕过真实审批 caller）",
  );
  assert.ok(
    !("apiKey" in props),
    "公共 schema 不得暴露 apiKey（凭据字段不得进入 MCP 公共接口）",
  );
  assert.ok(
    !("apiBaseUrl" in props),
    "公共 schema 不得暴露 apiBaseUrl（SSRF 攻击面：调用方可指定任意地址，runner 会把环境 NOVELOS_JUDGE_API_KEY 作为 Bearer 发往该地址）",
  );
  assert.ok(
    !("modelId" in props),
    "公共 schema 不得暴露 modelId（生产网络配置只能从可信环境/config 读取）",
  );
});

// ============================================================================
// P0-1 SSRF: runner 拒绝回环地址（防止把 NOVELOS_JUDGE_API_KEY 发往 127.0.0.1）
// ============================================================================

test("P0-1 SSRF: runRealChapterProxyReview 拒绝 NOVELOS_JUDGE_BASE_URL=http://127.0.0.1:9999（回环地址）", async () => {
  const { runRealChapterProxyReview } = await import("../dist/v2/core/review-surface-cli.js");
  const { createChapterProxyApprovalRegistry } = await import(
    "../dist/v2/governance/chapter-proxy-approval-registry.js"
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "p0-ssrf-loopback-"));
  // 备份 env 并注入恶意配置
  const prevKey = process.env.NOVELOS_JUDGE_API_KEY;
  const prevUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const prevModel = process.env.NOVELOS_JUDGE_MODEL;
  process.env.NOVELOS_JUDGE_API_KEY = "FAKE_ENV_SECRET_FOR_AUDIT";
  process.env.NOVELOS_JUDGE_BASE_URL = "http://127.0.0.1:9999";
  process.env.NOVELOS_JUDGE_MODEL = "gpt5.6-sol-test";

  try {
    const cardPath = join(tmpRoot, "card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCard("rel-001")));

    const chapterRegistry = createChapterProxyApprovalRegistry({
      approvalsDir: join(tmpRoot, "chapter-approvals"),
    });

    // 不提供 callerOverride，强制走 env 路径
    // 期望：runner 在创建 caller 之前对 endpoint 做白名单校验，拒绝回环地址
    // 不发起任何 fetch（不泄漏 NOVELOS_JUDGE_API_KEY）
    await assert.rejects(
      () =>
        runRealChapterProxyReview({
          chapterRegistry,
          packetInput: makePacketInput(),
          forwardVerdict: "PROXY_APPROVED",
          reverseVerdict: "PROXY_APPROVED",
          recommendedCandidateId: "cand-raw-001",
          recommendedSource: "raw",
          promptHash: "hash-001",
          budget: { maxCalls: 2, timeoutMs: 60000 },
          authorizationCardPath: cardPath,
          // 故意不提供 callerOverride
        }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          /endpoint|SSRF|回环|私有|不允许|HTTPS|loopback|private/i.test(msg),
          `错误消息必须包含 endpoint/SSRF/回环/私有/不允许/HTTPS 之一：${msg}`,
        );
        return true;
      },
    );
  } finally {
    // 还原 env
    if (prevKey === undefined) delete process.env.NOVELOS_JUDGE_API_KEY;
    else process.env.NOVELOS_JUDGE_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.NOVELOS_JUDGE_BASE_URL;
    else process.env.NOVELOS_JUDGE_BASE_URL = prevUrl;
    if (prevModel === undefined) delete process.env.NOVELOS_JUDGE_MODEL;
    else process.env.NOVELOS_JUDGE_MODEL = prevModel;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-1 SSRF: runner 拒绝非 HTTPS（防止明文外泄 Bearer token）
// ============================================================================

test("P0-1 SSRF: runRealChapterProxyReview 拒绝 NOVELOS_JUDGE_BASE_URL=http://attacker.example.com（非 HTTPS）", async () => {
  const { runRealChapterProxyReview } = await import("../dist/v2/core/review-surface-cli.js");
  const { createChapterProxyApprovalRegistry } = await import(
    "../dist/v2/governance/chapter-proxy-approval-registry.js"
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "p0-ssrf-http-"));
  const prevKey = process.env.NOVELOS_JUDGE_API_KEY;
  const prevUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const prevModel = process.env.NOVELOS_JUDGE_MODEL;
  process.env.NOVELOS_JUDGE_API_KEY = "FAKE_ENV_SECRET_FOR_AUDIT";
  process.env.NOVELOS_JUDGE_BASE_URL = "http://attacker.example.com";
  process.env.NOVELOS_JUDGE_MODEL = "gpt5.6-sol-test";

  try {
    const cardPath = join(tmpRoot, "card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCard("rel-001")));

    const chapterRegistry = createChapterProxyApprovalRegistry({
      approvalsDir: join(tmpRoot, "chapter-approvals"),
    });

    await assert.rejects(
      () =>
        runRealChapterProxyReview({
          chapterRegistry,
          packetInput: makePacketInput(),
          forwardVerdict: "PROXY_APPROVED",
          reverseVerdict: "PROXY_APPROVED",
          recommendedCandidateId: "cand-raw-001",
          recommendedSource: "raw",
          promptHash: "hash-001",
          budget: { maxCalls: 2, timeoutMs: 60000 },
          authorizationCardPath: cardPath,
        }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          /endpoint|SSRF|HTTPS|不允许|http/i.test(msg),
          `错误消息必须包含 endpoint/SSRF/HTTPS/不允许 之一：${msg}`,
        );
        return true;
      },
    );
  } finally {
    if (prevKey === undefined) delete process.env.NOVELOS_JUDGE_API_KEY;
    else process.env.NOVELOS_JUDGE_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.NOVELOS_JUDGE_BASE_URL;
    else process.env.NOVELOS_JUDGE_BASE_URL = prevUrl;
    if (prevModel === undefined) delete process.env.NOVELOS_JUDGE_MODEL;
    else process.env.NOVELOS_JUDGE_MODEL = prevModel;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2 artifact 身份错绑: 顶层三元组与 packetInput 不一致 -> fail-closed
// ============================================================================

test("P0-2 identity: 顶层 ws-target/ch-target/rel-target 与 packetInput ws-other/ch-other/rel-packet 不一致 -> status=error + 不写 registry", async () => {
  const { handleChapterProxyReview } = await import(
    "../dist/handlers/chapter-proxy-review-handler.js"
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "p0-identity-mismatch-"));
  try {
    const cardPath = join(tmpRoot, "card.json");
    // 授权卡覆盖 rel-target（顶层 releaseId），但 packetInput.releaseId=rel-packet
    // 即使授权卡通过，身份校验也应先 fail-closed
    writeFileSync(cardPath, JSON.stringify(makeValidCard("rel-target")));

    // _projectRoot=tmpRoot，使 workspacePath = {tmpRoot}/workspaces/ws-target
    // chapter-approvals 目录 = {tmpRoot}/workspaces/ws-target/chapter-approvals
    const result = await handleChapterProxyReview({
      workspaceId: "ws-target",
      chapterId: "ch-target",
      chapterNumber: 1,
      releaseId: "rel-target",
      authorizationCardPath: cardPath,
      // packetInput 故意使用其他身份
      packetInput: makePacketInput({
        workspaceId: "ws-other",
        chapterId: "ch-other",
        releaseId: "rel-packet",
      }),
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-raw-001",
      recommendedSource: "raw",
      promptHash: "hash-001",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      _projectRoot: tmpRoot,
    });

    assert.equal(
      result.status,
      "error",
      "顶层三元组与 packetInput 不一致时必须 status=error（fail-closed，不得写 artifact）",
    );
    assert.ok(
      /身份|identity|mismatch|不一致|packetInput/i.test(result.error || ""),
      `error 必须包含 身份/identity/mismatch/不一致/packetInput 之一：${result.error}`,
    );

    // 验证 registry 未被写入：ws-target 的 chapter-approvals 目录不应存在或为空
    const targetApprovalsDir = join(tmpRoot, "workspaces", "ws-target", "chapter-approvals");
    if (existsSync(targetApprovalsDir)) {
      const entries = readdirSync(targetApprovalsDir);
      assert.equal(
        entries.length,
        0,
        `身份不一致时不得写 artifact，chapter-approvals 必须为空，实际：${entries.join(",")}`,
      );
    }
    // 即使 packetInput 的 ws-other 身份，也不得在 ws-target 路径下创建任何 artifact
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2 artifact 身份错绑: 部分一致（仅 chapterId 不同）也应 fail-closed
// ============================================================================

test("P0-2 identity: 顶层与 packetInput 仅 chapterId 不同 -> 仍 fail-closed", async () => {
  const { handleChapterProxyReview } = await import(
    "../dist/handlers/chapter-proxy-review-handler.js"
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "p0-identity-partial-"));
  try {
    const cardPath = join(tmpRoot, "card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCard("rel-001")));

    const result = await handleChapterProxyReview({
      workspaceId: "ws-test",
      chapterId: "1",
      chapterNumber: 1,
      releaseId: "rel-001",
      authorizationCardPath: cardPath,
      packetInput: makePacketInput({
        workspaceId: "ws-test",
        chapterId: "2", // 仅 chapterId 不同
        releaseId: "rel-001",
      }),
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-raw-001",
      recommendedSource: "raw",
      promptHash: "hash-001",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      _projectRoot: tmpRoot,
    });

    assert.equal(
      result.status,
      "error",
      "仅 chapterId 不一致也必须 status=error（三元组必须完全一致）",
    );
    assert.ok(
      /身份|identity|mismatch|不一致|packetInput/i.test(result.error || ""),
      `error 必须包含身份不一致提示：${result.error}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
