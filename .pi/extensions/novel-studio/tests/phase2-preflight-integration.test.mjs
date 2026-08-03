/**
 * Phase 2A：Preflight 接入集成测试
 *
 * 验收口径（计划 §2A）：
 * - Preflight 阻断 → status=blocked + failureEnvelope.severity=preflight + userActionRequired
 * - Preflight 通过 → 正常生成（status=ok）
 * - Preflight 缺 series/outline.md 不阻断（仅高层背景参考）
 * - Preflight 缺 ChapterSeed 可生长性 → 阻断（提示补种子源，不提示补章纲）
 *
 * 使用 V2_FORCE_STUB=1 + 真实 runUnifiedPipeline 跑通生产入口。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(process.cwd(), "workspaces", "..");

function createValidWorkspace(workspaceId) {
  const wsRoot = join(process.cwd(), "workspaces", workspaceId);
  rmSync(wsRoot, { recursive: true, force: true });
  mkdirSync(join(wsRoot, "chapters"), { recursive: true });
  mkdirSync(join(wsRoot, "characters"), { recursive: true });
  mkdirSync(join(wsRoot, "series"), { recursive: true });
  mkdirSync(join(wsRoot, "styles"), { recursive: true });

  const config = {
    name: "Phase2 Preflight 测试",
    genre: "玄幻",
    subGenres: ["东方玄幻"],
    totalChapters: 50,
    chapterType: "standard",
    styleProfile: "phase2-author",
    serialFrequency: "daily",
    characters: [
      { id: "protagonist-1", name: "叶尘", role: "protagonist" },
    ],
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "接受传承", cost: "暴露身份" },
        ],
        expectedIrreversibleChange: ["叶尘接受传承后无法维持普通身份"],
        causalEndPressure: ["传承激活引来追踪者"],
      },
    },
    targetWordCount: {
      perChapter: { min: 2500, max: 3500 },
      total: 150000,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(wsRoot, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  writeFileSync(join(wsRoot, "series", "outline.md"), "# 大纲\n## 第1章\n故事开始。\n", "utf-8");
  writeFileSync(join(wsRoot, "characters", "叶尘.md"), "# 叶尘\n主角，废物少年，偶得传承。\n", "utf-8");
  writeFileSync(
    join(wsRoot, "styles", "profile.json"),
    JSON.stringify({
      id: "phase2-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力通过动作、停顿和环境变化呈现。"],
      characterVoiceGuidance: { 叶尘: ["少年感保留现实处境。"] },
    }, null, 2),
    "utf-8",
  );
  return wsRoot;
}

function createWorkspaceWithoutConfig(workspaceId) {
  const wsRoot = join(process.cwd(), "workspaces", workspaceId);
  rmSync(wsRoot, { recursive: true, force: true });
  mkdirSync(join(wsRoot, "chapters"), { recursive: true });
  return wsRoot;
}

test("Phase 2A · Preflight 阻断（缺 config.json）→ status=blocked + severity=preflight", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-block";

  // 不创建 config.json
  createWorkspaceWithoutConfig(workspaceId);

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
    });

    assert.equal(result.status, "blocked", `应阻断，实际: ${result.status}`);
    assert.equal(result.failureEnvelope?.severity, "preflight", "severity 应为 preflight");
    assert.equal(result.failureEnvelope?.stage, "preflight", "stage 应为 preflight");
    assert.equal(result.failureEnvelope?.recoverable, false, "preflight 阻断不可自动恢复");
    assert.ok(
      Array.isArray(result.failureEnvelope?.userActionRequired),
      "应提供 userActionRequired 修复指令",
    );
    assert.ok(result.failureEnvelope.userActionRequired.length > 0, "修复指令不应为空");
    assert.equal(result.stageResults?.preflight?.passed, false, "preflight.passed=false");
    assert.ok(
      result.stageResults?.preflight?.blockingItems?.length > 0,
      "应有 blockingItems",
    );
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.text, "", "blocked 不产出正文");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});

test("Phase 2A · Preflight 通过 → 正常生成（status=ok）", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-pass";
  createValidWorkspace(workspaceId);

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
    });

    assert.equal(result.status, "ok", `应正常生成，实际: ${result.status} ${JSON.stringify(result.failureEnvelope)}`);
    assert.equal(result.failureEnvelope ?? null, null, "通过 Preflight 后无 failureEnvelope");
    assert.ok(result.text.length > 0, "应有正文输出");
    assert.equal(result.stageResults?.preflight?.passed, true, "preflight.passed=true");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});

test("Phase 2A · 缺 series/outline.md 不阻断生成（仅高层背景参考）", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-no-outline";
  const wsRoot = createValidWorkspace(workspaceId);
  // 删除 outline.md（不应阻断）
  rmSync(join(wsRoot, "series", "outline.md"));

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
    });

    assert.equal(result.status, "ok", `缺 outline.md 不应阻断，实际: ${result.status} ${JSON.stringify(result.failureEnvelope)}`);
    assert.equal(result.failureEnvelope ?? null, null, "无 failureEnvelope");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});

test("Phase 2A · fullPipelinePreview 跳过 Preflight（不验证 workspace 完整性）", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-preview-skip";
  // 不创建任何 workspace 文件
  createWorkspaceWithoutConfig(workspaceId);

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
      fullPipelinePreview: true,
    });

    // fullPipelinePreview 跳过 Preflight，不应因缺 config.json 阻断
    assert.notEqual(result.status, "blocked", "fullPipelinePreview 不应被 Preflight 阻断");
    // fullPipelinePreview 标记 preflight 为 skipped（而非 undefined）
    assert.equal(result.stageResults?.preflight?.skipped, true, "fullPipelinePreview 应标记 preflight 为 skipped");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});

// ============================================================================
// P1-4 生产探针：缺风格档案 → preflight hard block（模型调用前阻断）
// 计划要求：有效作者风格档案是必需输入，缺风格档案必须在模型调用前 hard block。
// 原先双路径缺失仅 warning + passed=true，导致 Agentic 在无风格指导下调用模型。
// ============================================================================

test("P1-4 生产探针: 缺风格档案（styleProfile 已配置但文件缺失）→ preflight hard block", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-style-missing-configured";
  const wsRoot = createValidWorkspace(workspaceId);
  // 删除 styles/profile.json（模拟双路径缺失）
  rmSync(join(wsRoot, "styles", "profile.json"));

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
    });

    assert.equal(result.status, "blocked", `缺风格档案应阻断，实际: ${result.status}`);
    assert.equal(result.failureEnvelope?.severity, "preflight", "severity 应为 preflight");
    assert.equal(result.failureEnvelope?.stage, "preflight", "stage 应为 preflight");
    assert.equal(result.failureEnvelope?.recoverable, false, "preflight 阻断不可自动恢复");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.text, "", "blocked 不产出正文");
    // 应有 style_profile_missing 阻断项
    const styleBlock = result.stageResults?.preflight?.blockingItems?.find(
      (b) => b.check === "style_profile_missing",
    );
    assert.ok(styleBlock, "应有 style_profile_missing 阻断项");
    assert.ok(styleBlock.fixInstruction.includes("profile.json"), "修复指令应指向 profile.json");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});

test("P1-4 生产探针: 缺风格档案（未配置 styleProfile 字段且无 workspace-local 档案）→ preflight hard block", async () => {
  process.env.V2_FORCE_STUB = "1";
  const workspaceId = "phase2-preflight-style-missing-unconfigured";
  const wsRoot = createValidWorkspace(workspaceId);
  // 删除 styles/profile.json
  rmSync(join(wsRoot, "styles", "profile.json"));
  // 从 config.json 移除 styleProfile 字段
  const configPath = join(wsRoot, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  delete config.styleProfile;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId: "ch-1",
      chapterNumber: 1,
      projectRoot: process.cwd(),
    });

    assert.equal(result.status, "blocked", `未配置 styleProfile + 无档案应阻断，实际: ${result.status}`);
    assert.equal(result.failureEnvelope?.severity, "preflight", "severity 应为 preflight");
    assert.equal(result.failureEnvelope?.stage, "preflight", "stage 应为 preflight");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    const styleBlock = result.stageResults?.preflight?.blockingItems?.find(
      (b) => b.check === "style_profile_missing",
    );
    assert.ok(styleBlock, "应有 style_profile_missing 阻断项");
  } finally {
    rmSync(join(process.cwd(), "workspaces", workspaceId), { recursive: true, force: true });
  }
});
