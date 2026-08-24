/**
 * FactGuard 高影响术语授权必须读取大纲全文副本（series/outline-full.md）。
 *
 * 背景：平台侧把 story_outline 按 token 预算裁剪后再物化，裁剪是保头弃尾的，
 * 因此大纲尾部已有术语（例："魂玉可以封印伤势"）会从 series/outline.md 消失，
 * 导致 FactGuard 把它误判为未授权高影响新设定并硬阻断整章。
 * 平台额外物化 series/outline-full.md 专供授权判定，本测试锁定该读取路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCandidateFactGuard } from "../dist/v2/core/orchestrator-factguard.js";

const CLIPPED_OUTLINE = "# 故事大纲\n沈砚回到旧城，追查父亲失踪的旧案。";
const OUTLINE_TAIL = "魂玉（压制毒素、封印伤势的临时手段）由旧城药师提供。";
const CANDIDATE_TEXT = [
  "沈砚把魂玉贴在伤口上，血线立刻停住。",
  "他知道这只是封印伤势的权宜之计，撑不过三天。",
  "旧城的雨没有停，他把外衣裹紧，往药师的巷子走去。",
].join("");

function makeWorkspace(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), "factguard-outline-full-"));
  const workspaceId = "p252";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(workspacePath, relativePath), content, "utf8");
  }
  return { projectRoot, workspaceId };
}

function makeInput(projectRoot, workspaceId) {
  return {
    workspaceId,
    chapterId: "17",
    chapterNumber: 17,
    projectRoot,
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      longTermState: null,
    },
    characterNames: ["沈砚"],
    stagedStateUpdate: null,
  };
}

function unauthorizedDiagnostics(result) {
  return (result.report?.allDiagnostics ?? []).filter(
    (diagnostic) => diagnostic.id?.includes("unauthorized_high_impact_setting"),
  );
}

test("大纲全文副本授权尾部高影响术语，不再硬阻断", () => {
  const { projectRoot, workspaceId } = makeWorkspace({
    "series/outline.md": CLIPPED_OUTLINE,
    "series/outline-full.md": `${CLIPPED_OUTLINE}\n${OUTLINE_TAIL}`,
  });

  const result = checkCandidateFactGuard(
    CANDIDATE_TEXT,
    makeInput(projectRoot, workspaceId),
  );

  const diagnostics = unauthorizedDiagnostics(result);
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.evidence?.includes("封印")).length,
    0,
    `封印 应被 outline-full.md 授权，实际诊断：${JSON.stringify(diagnostics)}`,
  );
});

test("术语在两份大纲副本中都不存在时仍然硬阻断", () => {
  const { projectRoot, workspaceId } = makeWorkspace({
    "series/outline.md": CLIPPED_OUTLINE,
    "series/outline-full.md": CLIPPED_OUTLINE,
  });

  const result = checkCandidateFactGuard(
    CANDIDATE_TEXT,
    makeInput(projectRoot, workspaceId),
  );

  const diagnostics = unauthorizedDiagnostics(result);
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.evidence?.includes("封印")),
    "未授权术语必须仍被检出，避免授权副本把检测整体放空",
  );
});
