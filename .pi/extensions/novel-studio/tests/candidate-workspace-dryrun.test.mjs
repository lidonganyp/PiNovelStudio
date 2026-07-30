/**
 * P0-1 GREEN — CandidateWorkspace dryRun 单元测试
 *
 * 验证 dryRun=true 时：
 * 1. 构造函数不创建目录
 * 2. 所有 write 方法无副作用（不写盘）
 * 3. writeDraft 的内容仍可通过 readDraft 读取（内存镜像）
 * 4. dryRun=false（默认）时正常写盘
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const TEST_WORKSPACE_ID = "candidate-workspace-dryrun-test";
const TEST_WORKSPACE = join(PROJECT_ROOT, "workspaces", TEST_WORKSPACE_ID);

describe("CandidateWorkspace dryRun", () => {
  before(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TEST_WORKSPACE, { recursive: true });
  });

  after(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it("dryRun=true 时构造函数不创建 novelos-sessions 目录", async () => {
    const { createCandidateWorkspace } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "candidate-workspace.js")).href
    );

    const sessionId = "dryrun-no-dir-test";
    const novelosDir = join(TEST_WORKSPACE, "novelos-sessions");

    // 运行前确认 novelos-sessions 不存在
    assert.ok(!existsSync(join(novelosDir, sessionId)));

    const ws = createCandidateWorkspace({
      workspaceRoot: TEST_WORKSPACE,
      sessionId,
      dryRun: true,
    });

    // dryRun=true 时 session 目录不得被创建
    assert.ok(
      !existsSync(join(novelosDir, sessionId)),
      "dryRun=true 时不得创建 session 目录",
    );

    // 甚至 novelos-sessions 父目录也不应被创建（如果之前不存在）
    // 但这里 TEST_WORKSPACE 已存在，所以只检查 session 子目录
  });

  it("dryRun=true 时所有 write 方法无副作用", async () => {
    const { createCandidateWorkspace } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "candidate-workspace.js")).href
    );

    const sessionId = "dryrun-no-write-test";
    const sessionDir = join(TEST_WORKSPACE, "novelos-sessions", sessionId);

    const ws = createCandidateWorkspace({
      workspaceRoot: TEST_WORKSPACE,
      sessionId,
      dryRun: true,
    });

    // 调用所有 write 方法
    ws.writeEvidencePlan({ id: "test", mustVerify: [] });
    ws.recordToolEvent({ type: "test", data: "event" });
    ws.writeDraft("这是测试草稿内容。");
    ws.saveVerifierReport({ passed: true });
    ws.savePatchProposals([{ id: "patch1" }]);
    ws.appendPatchProposal({ id: "patch2" });
    ws.saveLineage({ sourceRefs: [], stopReason: "test" });

    // 确认目录未被创建（dryRun 短路了 mkdirSync）
    assert.ok(!existsSync(sessionDir), "dryRun=true 时 session 目录不得被创建");

    // 确认没有任何文件被写入
    if (existsSync(sessionDir)) {
      const files = readdirSync(sessionDir);
      assert.equal(files.length, 0, "dryRun=true 时不得写入任何文件");
    }
  });

  it("dryRun=true 时 writeDraft 内容仍可通过 readDraft 读取", async () => {
    const { createCandidateWorkspace } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "candidate-workspace.js")).href
    );

    const sessionId = "dryrun-read-draft-test";
    const ws = createCandidateWorkspace({
      workspaceRoot: TEST_WORKSPACE,
      sessionId,
      dryRun: true,
    });

    const draftText = "这是 dryRun 模式下的草稿内容，应保留在内存中。";
    ws.writeDraft(draftText);

    // readDraft 应从内存镜像读取
    const readBack = ws.readDraft();
    assert.equal(
      readBack,
      draftText,
      "dryRun=true 时 readDraft 应返回 writeDraft 写入的内容（内存镜像）",
    );
  });

  it("dryRun=false（默认）时正常创建目录和写盘", async () => {
    const { createCandidateWorkspace } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "candidate-workspace.js")).href
    );

    const sessionId = "dryrun-false-test";
    const sessionDir = join(TEST_WORKSPACE, "novelos-sessions", sessionId);

    const ws = createCandidateWorkspace({
      workspaceRoot: TEST_WORKSPACE,
      sessionId,
      // dryRun 不传，默认 false
    });

    // 目录应被创建
    assert.ok(existsSync(sessionDir), "dryRun=false 时应创建 session 目录");

    // writeDraft 应写盘
    ws.writeDraft("正常模式下的草稿。");
    const draftPath = join(sessionDir, "draft.md");
    assert.ok(existsSync(draftPath), "dryRun=false 时 draft.md 应被写入");

    // readDraft 应从磁盘读取
    const readBack = ws.readDraft();
    assert.equal(readBack, "正常模式下的草稿。", "dryRun=false 时 readDraft 应从磁盘读取");
  });
});
