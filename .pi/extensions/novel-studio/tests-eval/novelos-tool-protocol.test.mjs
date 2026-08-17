/**
 * NovelOS 工具协议与权限边界测试（OPT-8.8/8.9/9.2/9.3/9.12）
 *
 * 验证：
 * - 9 个工具均返回 sourceRef + evidenceLevel（P0-1 新增 search_narrative_evidence）
 * - agent 角色不持有 final_commit 权限
 * - candidate_write 路径白名单（隔离目录外被拒绝）
 * - 工具注册校验（final_commit 工具不可注册）
 * - query_voice_evidence 降级为 profile_only
 * - getToolsForRole 返回正确工具集
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNarrativeToolRegistry } from "../dist/novelos/agent/narrative-tool-registry.js";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { PermissionPolicy, PermissionDeniedError } from "../dist/novelos/security/permission-policy.js";
import { createNarrativeTools } from "../dist/novelos/tools/narrative-tools.js";

// ============================================================================
// 测试夹具：临时 workspace + 状态文件
// ============================================================================

let tmpRoot;
let workspaceId = "test-ws";
let searchService;
let permissionPolicy;
let registry;

function setupWorkspace() {
  tmpRoot = mkdtempSync(join(tmpdir(), "novelos-tools-"));
  const wsDir = join(tmpRoot, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });

  const now = new Date().toISOString();

  // narrative-state-store.json（统一状态存储，替代 legacy skeleton/narrative-state/arc-registry）
  writeFileSync(
    join(wsDir, "narrative-state-store.json"),
    JSON.stringify({
      schemaVersion: "narrative-state-store-v1",
      workspaceId,
      canon: [
        {
          kind: "canon",
          id: "canon:evt-001",
          fact: "主角发现复苏之眼能力",
          category: "timeline",
          sourceChapter: "ch1",
          sourceRef: "skeleton:evt-001",
          confidence: 1.0,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:evt-002",
          fact: "林默与黑影对峙",
          category: "timeline",
          sourceChapter: "ch1",
          sourceRef: "skeleton:evt-002",
          confidence: 1.0,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:loc-001",
          fact: "青鱼嘴",
          category: "location",
          sourceChapter: "ch1",
          sourceRef: "skeleton:locations",
          confidence: 1.0,
          lastUpdated: now,
        },
        {
          kind: "canon",
          id: "canon:loc-002",
          fact: "水下洞穴",
          category: "location",
          sourceChapter: "ch1",
          sourceRef: "skeleton:locations",
          confidence: 1.0,
          lastUpdated: now,
        },
      ],
      character: [
        {
          kind: "character",
          id: "character:林默:knowledgeBoundary",
          characterId: "林默",
          field: "knowledgeBoundary",
          value: "知道黑影弱点但不知道来源",
          sourceChapter: "ch1",
          sourceRef: "narrative-state:ch1",
          confidence: 1.0,
          lastUpdated: now,
        },
      ],
      promise: [
        {
          kind: "promise",
          id: "promise:arc-001",
          promiseId: "arc-001",
          description: "复苏之眼觉醒",
          status: "advancing",
          currentHeat: 0.7,
          sourceChapter: "ch1",
          sourceRef: "arc-registry:arc-001",
          confidence: 1.0,
          lastUpdated: now,
        },
        {
          kind: "promise",
          id: "promise:fore-001",
          promiseId: "fore-001",
          description: "苏雨的真实身份",
          status: "open",
          currentHeat: 0.5,
          sourceChapter: "ch1",
          sourceRef: "arc-registry:fore-001",
          confidence: 1.0,
          lastUpdated: now,
        },
      ],
      pattern: [],
      expectation: [],
      eventLog: [],
      quarantine: [],
      planned: [],
      updatedAt: now,
    }),
    "utf-8",
  );

  // 章节正文
  const chapterDir = join(wsDir, "chapters", "chapter-01");
  mkdirSync(chapterDir, { recursive: true });
  writeFileSync(
    join(chapterDir, "final.md"),
    "林默站在青鱼嘴的岸边，浑浊的水面下隐约可见一道黑影。\n他闭上眼，复苏之眼在眉心微热，那是能力觉醒的征兆。\n苏雨在身后喊道：\"别下去！\"\n但林默已经跃入了水中。",
    "utf-8",
  );
}

before(() => {
  setupWorkspace();
  searchService = createNarrativeSearchService({
    projectRoot: tmpRoot,
    workspaceId,
    sourceChapter: "ch1",
  });
  permissionPolicy = new PermissionPolicy({
    workspaceRoot: join(tmpRoot, "workspaces", workspaceId),
    sessionId: "test-session-1",
  });
  registry = createNarrativeToolRegistry({
    searchService,
    permissionPolicy,
  });
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================

describe("NovelOS 工具协议与权限边界", () => {
  it("9 个工具全部注册（含 P0-1 新增 search_narrative_evidence）", () => {
    const names = registry.getToolNames();
    assert.equal(names.length, 9, `应注册 9 个工具，实际 ${names.length}`);
    const expected = [
      "search_chapter_span",
      "search_narrative_evidence",
      "query_canon",
      "query_character_state",
      "query_timeline",
      "query_character_knowledge_boundary",
      "query_promise_ledger",
      "query_pattern_memory",
      "query_voice_evidence",
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `应包含工具 ${name}`);
    }
  });

  it("getToolsForRole(agent) 返回 9 个工具（全部 workspace_read）", () => {
    const tools = registry.getToolsForRole("agent");
    assert.equal(tools.length, 9, `agent 应可用 9 个工具，实际 ${tools.length}`);
    for (const tool of tools) {
      assert.equal(typeof tool.execute, "function", `${tool.name} 应有 execute`);
      assert.equal(typeof tool.parameters, "object", `${tool.name} 应有 parameters schema`);
    }
  });

  it("search_chapter_span 返回 sourceRef + evidenceLevel=confirmed", async () => {
    const tool = registry.getToolProtocol("search_chapter_span");
    const result = await tool.execute("tc-1", { query: "复苏之眼" });
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "confirmed");
    assert.ok(result.content[0].text.includes("复苏之眼"), "content 应包含匹配文本");
  });

  it("query_canon 返回 canon 事实 + sourceRef", async () => {
    const tool = registry.getToolProtocol("query_canon");
    const result = await tool.execute("tc-2", {});
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "confirmed");
    assert.ok(result.content[0].text.includes("主角发现复苏之眼"), "应包含 skeleton 事件");
  });

  it("query_character_state 返回角色状态 + sourceRef", async () => {
    const tool = registry.getToolProtocol("query_character_state");
    const result = await tool.execute("tc-3", { characterId: "林默" });
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "confirmed");
  });

  it("query_timeline 返回时间线事件", async () => {
    const tool = registry.getToolProtocol("query_timeline");
    const result = await tool.execute("tc-4", {});
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "confirmed");
  });

  it("query_character_knowledge_boundary 返回知识边界", async () => {
    const tool = registry.getToolProtocol("query_character_knowledge_boundary");
    const result = await tool.execute("tc-5", { characterId: "林默" });
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    // 知识边界来自 narrative-state.json，是 confirmed（legacy 数据默认置信度）
    assert.equal(result.details.evidenceLevel, "confirmed");
  });

  it("query_promise_ledger 返回伏笔/承诺", async () => {
    const tool = registry.getToolProtocol("query_promise_ledger");
    const result = await tool.execute("tc-6", {});
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "confirmed");
    assert.ok(result.content[0].text.includes("复苏之眼觉醒"), "应包含 arc 名称");
  });

  it("query_pattern_memory 返回空但结构正确（legacy 无 pattern）", async () => {
    const tool = registry.getToolProtocol("query_pattern_memory");
    const result = await tool.execute("tc-7", {});
    assert.ok(result.details.sourceRef, "应包含 sourceRef（即使空结果）");
    assert.equal(result.details.evidenceLevel, "inferred", "空结果应为 inferred");
  });

  it("query_voice_evidence 降级为 profile_only", async () => {
    const tool = registry.getToolProtocol("query_voice_evidence");
    const result = await tool.execute("tc-8", { characterId: "林默" });
    assert.ok(result.details.sourceRef, "应包含 sourceRef");
    assert.equal(result.details.evidenceLevel, "profile_only", "voice evidence 应降级为 profile_only");
    assert.ok(result.details.degradedReason, "应包含降级原因");
  });
});

// ============================================================================

describe("NovelOS 权限边界", () => {
  it("agent 不持有 final_commit 权限", () => {
    assert.equal(permissionPolicy.can("agent", "final_commit"), false, "agent 不可 final_commit");
    assert.equal(permissionPolicy.can("agent", "workspace_read"), true);
    assert.equal(permissionPolicy.can("agent", "candidate_write"), true);
    assert.equal(permissionPolicy.can("agent", "project_propose"), true);
  });

  it("orchestrator 持有 final_commit 权限", () => {
    assert.equal(permissionPolicy.can("orchestrator", "final_commit"), true);
  });

  it("assertCan 对 agent + final_commit 抛 PermissionDeniedError", () => {
    assert.throws(
      () => permissionPolicy.assertCan("agent", "final_commit"),
      (err) => err instanceof PermissionDeniedError,
    );
  });

  it("grant(agent, final_commit) 抛错——不可提权", () => {
    assert.throws(
      () => permissionPolicy.grant("agent", "final_commit"),
      (err) => err instanceof PermissionDeniedError,
    );
  });

  it("candidate_write 路径白名单：隔离目录内允许", () => {
    const allowedDir = permissionPolicy.getCandidateWorkspaceDir();
    const okPath = join(allowedDir, "draft.md");
    assert.equal(permissionPolicy.isCandidateWriteAllowed(okPath), true);
  });

  it("candidate_write 路径白名单：隔离目录外拒绝", () => {
    const outsidePath = join(tmpRoot, "workspaces", workspaceId, "chapters", "chapter-01", "final.md");
    assert.equal(
      permissionPolicy.isCandidateWriteAllowed(outsidePath),
      false,
      "隔离目录外写入应被拒绝",
    );
    assert.throws(
      () => permissionPolicy.assertCandidateWriteAllowed(outsidePath),
      (err) => err instanceof PermissionDeniedError,
    );
  });

  it("注册 final_commit 工具被拒绝", () => {
    const maliciousTool = {
      name: "malicious_commit",
      description: "尝试直接提交最终状态",
      label: "Malicious",
      parameters: { type: "object", properties: {} },
      requiredPermission: "final_commit",
      sideEffect: "read_only",
      async execute() {
        return { content: [{ type: "text", text: "hacked" }], details: {} };
      },
    };
    assert.throws(
      () => registry.register(maliciousTool),
      /final_commit/,
      "注册 final_commit 工具应被拒绝",
    );
  });

  it("所有工具的 requiredPermission 不是 final_commit", () => {
    for (const name of registry.getToolNames()) {
      const tool = registry.getToolProtocol(name);
      assert.notEqual(
        tool.requiredPermission,
        "final_commit",
        `${name} 不应要求 final_commit`,
      );
    }
  });
});

// ============================================================================

describe("NovelOS 工具独立创建（不经 registry）", () => {
  it("createNarrativeTools 返回 9 个 ToolProtocol（含 search_narrative_evidence）", () => {
    const tools = createNarrativeTools({ searchService });
    assert.equal(tools.length, 9);
    for (const tool of tools) {
      assert.ok(tool.name, "工具应有 name");
      assert.ok(tool.description, "工具应有 description");
      assert.ok(tool.label, "工具应有 label");
      assert.equal(tool.sideEffect, "read_only", `${tool.name} 应为 read_only`);
      assert.equal(tool.requiredPermission, "workspace_read", `${tool.name} 应要求 workspace_read`);
      assert.ok(tool.timeoutMs > 0, `${tool.name} 应有 timeoutMs`);
    }
  });
});

// ============================================================================

describe("Phase 3 统一工具结果格式（resultKind/returnedCount/truncated/nextQueryHint）", () => {
  // 每个工具在此 fixture 下的调用参数与预期 resultKind。
  // 注意：query_pattern_memory 在 legacy 无 pattern → 空结果统一为 no_match。
  const TOOL_CALLS = {
    search_narrative_evidence: { args: { query: "复苏之眼" }, kind: "ranked_evidence" },
    search_chapter_span: { args: { query: "复苏之眼" }, kind: "chapter_spans" },
    query_canon: { args: {}, kind: "canon_entries" },
    query_character_state: { args: {}, kind: "character_state" },
    query_timeline: { args: {}, kind: "timeline_events" },
    query_character_knowledge_boundary: { args: {}, kind: "character_knowledge_boundary" },
    query_promise_ledger: { args: {}, kind: "promise_entries" },
    query_pattern_memory: { args: {}, kind: "no_match" },
    query_voice_evidence: { args: {}, kind: "voice_evidence" },
  };

  async function callTool(name, args) {
    const tool = registry.getToolProtocol(name);
    return tool.execute(`tc-phase3-${name}`, args);
  }

  it("9 个工具均返回 4 个 Phase 3 结构化字段（类型正确 + resultKind 符合预期）", async () => {
    for (const [name, { args, kind }] of Object.entries(TOOL_CALLS)) {
      const result = await callTool(name, args);
      const d = result.details;
      // resultKind 必须存在且与预期一致（空结果统一 no_match）
      assert.equal(typeof d.resultKind, "string", `${name} 应返回 resultKind`);
      assert.equal(d.resultKind, kind, `${name} resultKind 应为 ${kind}，实际 ${d.resultKind}`);
      // returnedCount 必须是非负整数（基线 fixture 有小结果或空结果）
      assert.equal(typeof d.returnedCount, "number", `${name} 应返回 returnedCount`);
      assert.ok(Number.isInteger(d.returnedCount) && d.returnedCount >= 0, `${name} returnedCount 应为非负整数`);
      // truncated 必须是布尔
      assert.equal(typeof d.truncated, "boolean", `${name} 应返回 truncated`);
      // nextQueryHint 必须是 string 或 null
      assert.ok(d.nextQueryHint === null || typeof d.nextQueryHint === "string", `${name} nextQueryHint 应为 string|null`);
      // 保留原有字段
      assert.equal(typeof d.sourceRef, "string", `${name} 应保留 sourceRef`);
      assert.equal(typeof d.evidenceLevel, "string", `${name} 应保留 evidenceLevel`);
    }
  });

  it("空结果统一为 resultKind=no_match + returnedCount=0 + truncated=false", async () => {
    // query_pattern_memory 在 legacy 无 pattern -> 空结果
    const result = await callTool("query_pattern_memory", {});
    assert.equal(result.details.resultKind, "no_match", "空结果 resultKind 应统一为 no_match");
    assert.equal(result.details.returnedCount, 0, "空结果 returnedCount 应为 0");
    assert.equal(result.details.truncated, false, "空结果不应截断");
    assert.equal(result.details.nextQueryHint, null, "空结果不应有 nextQueryHint");
  });

  it("returnedCount 与 text 中实际条目数一致（列表型工具）", async () => {
    const result = await callTool("query_canon", {});
    const d = result.details;
    assert.ok(d.returnedCount > 0, "query_canon 应命中 skeleton 事件");
    // content 以 "找到 N 条..." 开头，N 即 returnedCount
    const match = result.content[0].text.match(/^找到 (\d+) 条/);
    assert.ok(match, "content 应包含 '找到 N 条' 汇总");
    assert.equal(Number(match[1]), d.returnedCount, "text 汇总条数应等于 returnedCount");
  });

  it("宽查询 maxResults 被有界收束（不返回超过 DEFAULT_LIST_LIMIT）", async () => {
    // 传超大 maxResults，返回数仍应被 limit 约束
    const result = await callTool("search_chapter_span", {
      query: "林默",
      maxResults: 5000,
    });
    assert.ok(
      result.details.returnedCount <= 50,
      `returnedCount 应受有界 limit 约束，实际 ${result.details.returnedCount}`,
    );
  });

  it("maxChapters 被有界收束（不抛错、不无界遍历历史章节）", async () => {
    // 传超大/非法 maxChapters，系统应安全收束，返回结构完整
    for (const maxChapters of [999_999, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const result = await callTool("search_chapter_span", {
        query: "林默",
        maxChapters,
        maxResults: 5,
      });
      assert.equal(typeof result.details.returnedCount, "number", `maxChapters=${maxChapters} 应安全返回数字`);
      assert.ok(Number.isInteger(result.details.returnedCount) && result.details.returnedCount >= 0, `returnedCount 应非负整数`);
      assert.equal(typeof result.details.truncated, "boolean", "应返回 truncated");
    }
  });

  it("截断时 truncated=true 且 nextQueryHint 非空（limit+1 探测）", async () => {
    // 构造 >50 条 canon 的独立 workspace
    const bigRoot = mkdtempSync(join(tmpdir(), "novelos-big-canon-"));
    const wsDir = join(bigRoot, "workspaces", "big-ws");
    mkdirSync(wsDir, { recursive: true });
    const now = new Date().toISOString();
    const canonEntries = [];
    for (let i = 1; i <= 55; i++) {
      canonEntries.push({
        kind: "canon",
        id: `canon:evt-${String(i).padStart(3, "0")}`,
        fact: `事件条目 ${i}`,
        category: "timeline",
        sourceChapter: "ch1",
        sourceRef: `skeleton:evt-${String(i).padStart(3, "0")}`,
        confidence: 1.0,
        lastUpdated: now,
      });
    }
    writeFileSync(
      join(wsDir, "narrative-state-store.json"),
      JSON.stringify({
        schemaVersion: "narrative-state-store-v1",
        workspaceId: "big-ws",
        canon: canonEntries,
        character: [],
        promise: [],
        pattern: [],
        expectation: [],
        eventLog: [],
        quarantine: [],
        planned: [],
        updatedAt: now,
      }),
      "utf-8",
    );
    const bigService = createNarrativeSearchService({
      projectRoot: bigRoot,
      workspaceId: "big-ws",
      sourceChapter: "ch1",
    });
    const bigTools = createNarrativeTools({ searchService: bigService });
    const tool = bigTools.find((t) => t.name === "query_canon");
    const result = await tool.execute("tc-big", {});
    assert.equal(result.details.returnedCount, 50, "应返回有界 limit 50 条");
    assert.equal(result.details.truncated, true, "55 条 canon 应被判定截断");
    assert.ok(
      typeof result.details.nextQueryHint === "string" && result.details.nextQueryHint.length > 0,
      "截断时应给出 nextQueryHint",
    );
    rmSync(bigRoot, { recursive: true, force: true });
  });

  it("voice_evidence 降级结果返回 resultKind=voice_evidence + returnedCount=0", async () => {
    const result = await callTool("query_voice_evidence", { characterId: "林默" });
    assert.equal(result.details.resultKind, "voice_evidence");
    assert.equal(result.details.returnedCount, 0);
    assert.equal(result.details.truncated, false);
  });
});
