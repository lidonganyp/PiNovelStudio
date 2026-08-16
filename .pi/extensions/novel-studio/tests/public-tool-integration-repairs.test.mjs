/**
 * 六工具集成审计修复回归：workspace 生命周期、批量种子边界、反馈 trace 上下文。
 *
 * 不调用真实模型，不改真实 workspace。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleBatchGeneration } from "../dist/handlers/batch-generation-handler.js";
import { handleStrategyFeedback } from "../dist/handlers/public-handlers.js";
import { handleWorkspaceManager } from "../dist/tools/workspace-manager-handler.js";
import { registerTools } from "../dist/tools/register-tools.js";
import {
  clearConfigCache,
  getProjectRoot,
  setProjectRoot,
} from "../dist/utils/config.js";

function makeProjectRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".pi", "extensions", "novel-studio"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "docs", "top-tier-chinese-novel-system-development-plan.md"),
    "# test project marker\n",
    "utf8",
  );
  writeFileSync(join(root, "config", "model-routing.json"), "{}\n", "utf8");
  writeFileSync(join(root, "config", "quality-gates.json"), "{}\n", "utf8");
  return root;
}

function stubHandlers() {
  const empty = async () => ({ status: "ok" });
  return {
    handleGenerateChapter: empty,
    handlePreflightWorkspace: empty,
    handleWorkspaceManager: empty,
    handlePlanStoryOutline: empty,
    handleStrategyPolicyView: empty,
    handleStrategyFeedback: empty,
    handleBatchGeneration: empty,
  };
}

test("novel_workspace_manager 公开 init，并让 init/switch 真实接到 WorkspaceManager", async () => {
  const originalRoot = getProjectRoot();
  const projectRoot = makeProjectRoot("pinovel-workspace-tool-");
  try {
    setProjectRoot(projectRoot);
    clearConfigCache();

    const workspaceTool = registerTools(stubHandlers()).find(
      (tool) => tool.name === "novel_workspace_manager",
    );
    assert.ok(workspaceTool, "应注册 novel_workspace_manager");
    assert.ok(
      workspaceTool.parameters.properties.action.enum.includes("init"),
      "workspace_manager schema 应公开 init",
    );

    const initResult = await handleWorkspaceManager({
      action: "init",
      workspaceId: "tool-init-test",
      novelName: "工具初始化测试",
      genre: "悬疑",
      subGenres: ["都市"],
      styleProfile: "default",
    });
    assert.equal(initResult.status, "success");
    assert.equal(initResult.config?.workspaceId, "tool-init-test");
    assert.ok(
      existsSync(join(projectRoot, "workspaces", "tool-init-test", "config.json")),
      "init 应写入 workspace config",
    );

    const switchResult = await handleWorkspaceManager({
      action: "switch",
      workspaceId: "tool-init-test",
    });
    assert.equal(switchResult.status, "success");
    assert.equal(switchResult.config?.workspaceId, "tool-init-test");
  } finally {
    setProjectRoot(originalRoot);
    clearConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("批量 workspace_or_planner 缺种子时阻断，且绝不生成作者章纲文件", async () => {
  const projectRoot = makeProjectRoot("pinovel-batch-seed-boundary-");
  const workspaceId = "batch-seed-boundary";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  writeFileSync(
    join(workspacePath, "config.json"),
    JSON.stringify({ workspaceId, novelName: "测试", genre: "悬疑" }, null, 2),
    "utf8",
  );
  writeFileSync(join(workspacePath, "characters", "hero.md"), "# 林川\n", "utf8");
  let generateCalls = 0;

  try {
    const result = await handleBatchGeneration({
      mode: "batch",
      action: "start",
      workspaceId,
      startChapter: 1,
      endChapter: 2,
      seedSource: "workspace_or_planner",
      _projectRoot: projectRoot,
      _mockGenerateChapter: async () => {
        generateCalls += 1;
        return { status: "ok" };
      },
    });

    assert.equal(result.status, "error");
    assert.match(
      result.failureEnvelope?.reason ?? "",
      /ChapterSeed|种子源|作者/,
      "阻断原因应指导补充作者拥有的种子来源",
    );
    assert.equal(generateCalls, 0, "缺种子不得进入章节生成");
    assert.equal(
      existsSync(join(workspacePath, "series", "ch1-outline-explicit.md")),
      false,
      "系统不得伪造 ch1 显式章纲",
    );
    assert.equal(
      existsSync(join(workspacePath, "series", "ch2-outline-explicit.md")),
      false,
      "系统不得伪造 ch2 显式章纲",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("novel_strategy_feedback 可凭 chapterId 从成功 trace 推断模型与选中策略，并写 ledger", async () => {
  const projectRoot = makeProjectRoot("pinovel-feedback-trace-");
  const workspaceId = "feedback-trace";
  const tracesDir = join(projectRoot, "workspaces", workspaceId, "traces");
  mkdirSync(tracesDir, { recursive: true });
  writeFileSync(
    join(tracesDir, "17-quality-trace.json"),
    JSON.stringify({
      gates: [
        {
          stage: "v2_final_selected",
          evidence: {
            stage: "final_selected",
            strategyContext: {
              modelVersion: "gemini-3.1-pro-preview",
              selectedStrategyIds: ["voice_emphasis"],
              sourceChapter: "ch17",
              opportunityType: "author_style",
              // USER-FEEDBACK-EVIDENCE-PIPELINE-1：完整血缘
              orchestratorRunId: "run-feedback-trace-17",
              candidateId: "cand-ed-17",
              strategyBundleId: "bundle:voice_emphasis",
              exposureId: "exp-feedback-17",
              promptBundleId: "prompt:author_style:default",
              deliveredSource: "editorial",
            },
          },
        },
      ],
    }, null, 2),
    "utf8",
  );

  try {
    const result = await handleStrategyFeedback({
      workspaceId,
      chapterId: "17",
      naturalLanguageFeedback: "不错，很满意",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.modelVersion, "gemini-3.1-pro-preview");
    assert.equal(result.strategyId, "voice_emphasis");
    assert.equal(result.action, "choice");
    assert.equal(result.result?.recorded, true);
    assert.equal(result.lineageAudit?.complete, true);
    assert.ok((result.lineageAudit?.ledgerAppended ?? 0) >= 1);

    const store = JSON.parse(readFileSync(
      join(projectRoot, "workspaces", workspaceId, "strategy-policy.json"),
      "utf8",
    ));
    assert.ok(store.partitions?.["gemini-3.1-pro-preview"]?.voice_emphasis);

    const ledgerPath = join(
      projectRoot,
      "workspaces",
      workspaceId,
      "strategy-evidence",
      "feedback-evidence-ledger.json",
    );
    assert.ok(existsSync(ledgerPath), "公共反馈入口应写入 feedback-evidence-ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.ok(Array.isArray(ledger.events) && ledger.events.length >= 1);
    assert.equal(ledger.events[0].eventType, "observation");
    assert.equal(ledger.events[0].lineage.orchestratorRunId, "run-feedback-trace-17");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
