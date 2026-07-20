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

  // skeleton.json
  writeFileSync(
    join(wsDir, "skeleton.json"),
    JSON.stringify({
      chapterId: "ch1",
      events: [
        {
          eventId: "evt-001",
          type: "discovery",
          summary: "主角发现复苏之眼能力",
          characters: ["林默", "苏雨"],
          location: "青鱼嘴",
        },
        {
          eventId: "evt-002",
          type: "conflict",
          summary: "林默与黑影对峙",
          characters: ["林默"],
          location: "水下洞穴",
        },
      ],
      locations: ["青鱼嘴", "水下洞穴"],
    }),
    "utf-8",
  );

  // unsettled-details.json
  writeFileSync(
    join(wsDir, "unsettled-details.json"),
    JSON.stringify([
      {
        id: "detail-001",
        type: "foreshadow",
        description: "复苏之眼的代价尚未揭示",
        chapterId: "ch1",
        status: "open",
      },
    ]),
    "utf-8",
  );

  // narrative-state.json
  writeFileSync(
    join(wsDir, "narrative-state.json"),
    JSON.stringify({
      pendingCosts: [
        { action: "使用复苏之眼", cost: "精神力透支", chapterIncurred: 1 },
      ],
      characterUpdates: [
        { name: "林默", field: "knowledgeBoundary", value: "知道黑影弱点但不知道来源" },
      ],
    }),
    "utf-8",
  );

  // arc-registry.json
  writeFileSync(
    join(wsDir, "arc-registry.json"),
    JSON.stringify({
      arcs: [
        {
          arcId: "arc-001",
          name: "复苏之眼觉醒",
          coreQuestion: "林默能否控制这份力量？",
          priority: "high",
          status: "advancing",
        },
      ],
      foreshadowings: [
        {
          id: "fore-001",
          description: "苏雨的真实身份",
          level: "high",
          status: "open",
        },
      ],
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
