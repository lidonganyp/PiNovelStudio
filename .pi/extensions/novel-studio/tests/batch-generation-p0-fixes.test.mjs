/**
 * BATCH P0/P1 FIX 测试 — 用户核验发现的 6 个 P0 阻断 + 2 个 P1 问题修复验证
 *
 * 覆盖：
 *   P0-FIX-1  路径穿越防护 — workspaceId/jobId 安全校验
 *   P0-FIX-2  崩溃恢复 — running 孤儿任务可 resume
 *   P0-FIX-4  取消状态覆盖 — 保存前合并最新控制字段
 *   P0-FIX-5  锁续租 + releaseBatchLock 校验 jobId
 *   P1-FIX-6  resume 清理瞬态失败状态 + 重算 summary
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  createMockGenerateChapter,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

// 直接 import lock 模块测试底层函数
import {
  acquireBatchLock,
  releaseBatchLock,
  renewBatchLock,
  readBatchLock,
  isLockAlive,
  isPidAlive,
  batchLockPath,
} from "../dist/v2/core/batch-generation-lock.js";
import {
  validateWorkspaceId,
  validateJobId,
  loadBatchJobStore,
  saveBatchJobStore,
  batchJobPath,
} from "../dist/v2/core/batch-generation-job-store.js";

const FIX_WORKSPACE = "batch-p0fix-test";

describe("BATCH P0/P1 FIX：路径穿越 / 崩溃恢复 / 取消覆盖 / 锁续租 / resume 清理", () => {
  let tool;

  before(async () => {
    createBatchWorkspace(FIX_WORKSPACE);
    tool = await loadGenerateChapterTool();
  });

  after(() => {
    cleanupWorkspace(FIX_WORKSPACE);
  });

  // ──────────────────────────────────────────────────────────────────────
  // P0-FIX-1：路径穿越防护
  // ──────────────────────────────────────────────────────────────────────
  describe("P0-FIX-1：路径穿越防护", () => {
    it("workspaceId 含 '..' 时被校验拒绝", () => {
      assert.throws(() => validateWorkspaceId(".."), /Invalid workspaceId/);
      assert.throws(() => validateWorkspaceId("../escape"), /Invalid workspaceId/);
      assert.throws(() => validateWorkspaceId("foo/../bar"), /Invalid workspaceId/);
    });

    it("jobId 含路径分隔符时被校验拒绝", () => {
      assert.throws(() => validateJobId("../../escape"), /Invalid jobId/);
      assert.throws(() => validateJobId("foo/bar"), /Invalid jobId/);
      assert.throws(() => validateJobId("foo\\bar"), /Invalid jobId/);
    });

    it("合法 workspaceId / jobId 通过校验", () => {
      assert.doesNotThrow(() => validateWorkspaceId("my-workspace_1"));
      assert.doesNotThrow(() => validateJobId("batch-12345-abcde"));
    });

    it("start action 拒绝路径穿越 workspaceId", async () => {
      const result = await tool.execute(
        "test-p0fix-traversal-start",
        {
          mode: "batch",
          action: "start",
          workspaceId: "..",
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 1,
          _projectRoot: PROJECT_ROOT,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "error", "应拒绝路径穿越 workspaceId");
      assert.ok(
        details.failureEnvelope?.reason?.includes("Invalid workspaceId"),
        `阻断原因应含 Invalid workspaceId，实际: ${details.failureEnvelope?.reason}`,
      );
    });

    it("resume action 拒绝路径穿越 jobId", async () => {
      const result = await tool.execute(
        "test-p0fix-traversal-resume",
        {
          mode: "batch",
          action: "resume",
          workspaceId: FIX_WORKSPACE,
          jobId: "../../escape",
          _projectRoot: PROJECT_ROOT,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "error", "应拒绝路径穿越 jobId");
      assert.ok(
        details.failureEnvelope?.reason?.includes("Invalid jobId"),
        `阻断原因应含 Invalid jobId，实际: ${details.failureEnvelope?.reason}`,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P0-FIX-2：崩溃恢复 — running 孤儿任务可 resume
  // ──────────────────────────────────────────────────────────────────────
  describe("P0-FIX-2：崩溃恢复", () => {
    it("running 状态 + 锁死亡（PID 不存活）时可 resume", async () => {
      const wsId = "batch-p0fix-crash-recovery";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 1. 手动创建一个 status=running 的 BatchJobState（模拟崩溃后的磁盘状态）
      const jobId = "batch-crash-test-001";
      const state = {
        jobId,
        workspaceId: wsId,
        status: "running", // 崩溃后磁盘上留下的状态
        startChapter: 1,
        endChapter: 3,
        seedSource: "workspace_or_planner",
        stopOnFailure: true,
        confirmLargeBatch: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        frontier: 2, // 已完成第 1 章，frontier 指向第 2 章
        completedChapters: [1],
        failedChapter: null,
        chapters: [
          { chapterNumber: 1, chapterId: "1", status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
          { chapterNumber: 2, chapterId: "2", status: "pending" },
          { chapterNumber: 3, chapterId: "3", status: "pending" },
        ],
        cancelRequested: false,
      };
      saveBatchJobStore(state, wsId, jobId, PROJECT_ROOT);

      // 2. 写一个死锁（PID=999999 不存在），模拟崩溃后残留的锁
      const lockPath = batchLockPath(wsId, PROJECT_ROOT);
      const deadLock = {
        workspaceId: wsId,
        jobId,
        pid: 999999, // 不存在的 PID
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      writeFileSync(lockPath, JSON.stringify(deadLock, null, 2), "utf-8");

      // 3. 验证锁已死亡（PID 不存活）
      assert.ok(!isPidAlive(999999), "PID 999999 应不存活");
      const lockInfo = readBatchLock(wsId, PROJECT_ROOT);
      assert.ok(lockInfo, "锁文件应存在");
      assert.ok(!isLockAlive(lockInfo), "锁应判定为死亡（PID 不存活）");

      // 4. mock 只生成第 2-3 章
      const mock = createMockGenerateChapter({ workspacePath });

      // 5. resume 应该成功（孤儿 running 任务恢复）
      const result = await tool.execute(
        "test-p0fix-crash-resume",
        {
          mode: "batch",
          action: "resume",
          workspaceId: wsId,
          jobId,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "completed", "孤儿 running 任务应成功 resume 并完成");
      // 只应调用第 2-3 章（第 1 章已完成，不应重复调用）
      assert.equal(mock.calls.length, 2, "应只调用第 2-3 章模型（第 1 章已完成）");
      assert.equal(mock.calls[0].chapterNumber, 2, "第一次调用应是第 2 章");
      assert.equal(mock.calls[1].chapterNumber, 3, "第二次调用应是第 3 章");

      cleanupWorkspace(wsId);
    });

    it("running 状态 + 锁存活（PID 存活）时拒绝 resume", async () => {
      const wsId = "batch-p0fix-crash-alive";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      const jobId = "batch-crash-alive-001";
      const state = {
        jobId,
        workspaceId: wsId,
        status: "running",
        startChapter: 1,
        endChapter: 3,
        seedSource: "workspace_or_planner",
        stopOnFailure: true,
        confirmLargeBatch: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        frontier: 2,
        completedChapters: [1],
        failedChapter: null,
        chapters: [
          { chapterNumber: 1, chapterId: "1", status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
          { chapterNumber: 2, chapterId: "2", status: "pending" },
          { chapterNumber: 3, chapterId: "3", status: "pending" },
        ],
        cancelRequested: false,
      };
      saveBatchJobStore(state, wsId, jobId, PROJECT_ROOT);

      // 写一个存活锁（使用当前进程 PID）
      const lockPath = batchLockPath(wsId, PROJECT_ROOT);
      const aliveLock = {
        workspaceId: wsId,
        jobId,
        pid: process.pid, // 当前进程存活
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      writeFileSync(lockPath, JSON.stringify(aliveLock, null, 2), "utf-8");

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p0fix-crash-alive-resume",
        {
          mode: "batch",
          action: "resume",
          workspaceId: wsId,
          jobId,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "error", "锁存活时应拒绝 resume");
      assert.equal(mock.calls.length, 0, "锁存活时不应调用模型");
      assert.ok(
        details.failureEnvelope?.reason?.includes("运行中"),
        `阻断原因应含"运行中"，实际: ${details.failureEnvelope?.reason}`,
      );

      // 清理锁（用正确 jobId）
      releaseBatchLock(wsId, jobId, PROJECT_ROOT);
      cleanupWorkspace(wsId);
    });

    it("cancelled/error 状态拒绝 resume", async () => {
      const wsId = "batch-p0fix-cancelled-resume";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      const jobId = "batch-cancelled-001";
      const state = {
        jobId,
        workspaceId: wsId,
        status: "cancelled",
        startChapter: 1,
        endChapter: 3,
        seedSource: "workspace_or_planner",
        stopOnFailure: true,
        confirmLargeBatch: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        frontier: 2,
        completedChapters: [1],
        failedChapter: null,
        chapters: [
          { chapterNumber: 1, chapterId: "1", status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
          { chapterNumber: 2, chapterId: "2", status: "pending" },
          { chapterNumber: 3, chapterId: "3", status: "pending" },
        ],
        cancelRequested: true,
      };
      saveBatchJobStore(state, wsId, jobId, PROJECT_ROOT);

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p0fix-cancelled-resume",
        {
          mode: "batch",
          action: "resume",
          workspaceId: wsId,
          jobId,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "error", "cancelled 状态应拒绝 resume");
      assert.equal(mock.calls.length, 0, "cancelled 状态不应调用模型");

      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P0-FIX-4：取消状态不被旧内存覆盖
  //
  // 运行中调用 cancel → 章节完成后不应覆盖 cancelRequested=true
  // ──────────────────────────────────────────────────────────────────────
  describe("P0-FIX-4：取消状态不被覆盖", () => {
    it("章节执行期间 cancel → 任务停止，不继续后续章节", async () => {
      const wsId = "batch-p0fix-cancel-overwrite";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // mock 在第 2 章执行期间触发 cancel（写 cancelRequested=true 到磁盘）
      const mock = async function (input) {
        const { chapterNumber, workspaceId, _projectRoot } = input;
        mock.calls.push({ ...input, timestamp: Date.now() });

        // 成功：写章节文件 + state store
        const chapterText = `# 第${chapterNumber}章\n\n这是第${chapterNumber}章的正文内容。`;
        const chapterFile = join(workspacePath, "chapters", `${chapterNumber}.md`);
        writeFileSync(chapterFile, chapterText, "utf-8");

        // 写 state store
        const stateStorePath = join(workspacePath, "narrative-state-store.json");
        let store = { canon: [], character: [], promise: [], pattern: [], expectation: [] };
        if (existsSync(stateStorePath)) {
          try { store = JSON.parse(readFileSync(stateStorePath, "utf-8")); } catch { /* */ }
        }
        store.canon.push({
          sourceChapter: `ch${chapterNumber}`,
          sourceRef: `ch${chapterNumber}#finalText:abc123`,
          content: `第${chapterNumber}章状态`,
          timestamp: new Date().toISOString(),
        });
        writeFileSync(stateStorePath, JSON.stringify(store, null, 2), "utf-8");

        // 第 1 章完成后、第 2 章开始前，模拟用户调用 cancel
        if (chapterNumber === 1) {
          // 加载当前 state，设置 cancelRequested，保存
          const freshStore = loadBatchJobStore(workspaceId, mock._jobId, _projectRoot);
          if (freshStore) {
            freshStore.state.cancelRequested = true;
            freshStore.state.status = "cancelled";
            freshStore.state.updatedAt = new Date().toISOString();
            saveBatchJobStore(freshStore.state, workspaceId, mock._jobId, _projectRoot);
          }
        }

        return {
          status: "ok",
          workspaceId,
          chapterId: String(chapterNumber),
          chapterNumber,
          text: chapterText,
          stageResults: {
            stateCommit: { ok: true },
            modelCallCount: 1,
          },
        };
      };
      mock.calls = [];

      const jobId = "batch-cancel-overwrite-001";
      mock._jobId = jobId;

      const result = await tool.execute(
        "test-p0fix-cancel-overwrite",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 5,
          jobId, // 固定 jobId 方便 mock 操作
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      // P0-FIX-4：cancel 应在章节执行期间被检测到，任务应停止
      assert.equal(details.status, "cancelled", "任务应在 cancel 后停止");
      // 只应调用第 1 章（第 1 章执行期间 cancel 被设置，第 2 章不应执行）
      assert.equal(mock.calls.length, 1, "应只调用 1 章模型（cancel 后不继续）");

      // 验证磁盘上的 state 也是 cancelled
      const finalStore = loadBatchJobStore(wsId, jobId, PROJECT_ROOT);
      assert.ok(finalStore, "最终 state 应存在");
      assert.equal(finalStore.state.status, "cancelled", "磁盘 state 应为 cancelled");
      assert.equal(finalStore.state.cancelRequested, true, "cancelRequested 应为 true");

      // P1-C：cancel 前已提交的章节必须被正确记录（checkpoint 一致性）
      // 第 1 章正文和状态已提交 → 应标记为 completed，frontier 应推进到 2
      assert.equal(finalStore.state.frontier, 2, "frontier 应推进到 2（第 1 章已完成）");
      assert.ok(
        finalStore.state.completedChapters.includes(1),
        "completedChapters 应包含第 1 章",
      );
      const ch1Slot = finalStore.state.chapters[0];
      assert.ok(ch1Slot, "第 1 章 slot 应存在");
      assert.equal(ch1Slot.status, "completed", "第 1 章应标记为 completed（cancel 不漏记已提交章节）");

      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P0-A：作者已有章纲不被覆盖
  //
  // startChapter 缺少章纲时，规划器只应为缺失章节生成；
  // 已有作者章纲文件必须跳过，不覆盖。
  // ──────────────────────────────────────────────────────────────────────
  describe("P0-A：作者已有章纲不被覆盖", () => {
    it("规划器跳过已有作者章纲文件，只为缺失章节生成", async () => {
      const wsId = "batch-p0fix-author-outline";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 作者已为第 2 章手写章纲
      const seriesDir = join(workspacePath, "series");
      mkdirSync(seriesDir, { recursive: true });
      const authorOutlinePath = join(seriesDir, "ch2-outline-explicit.md");
      const authorContent = "# 第2章 作者手写章纲\n\n## 事件 1：作者专属内容\n\n- **内容摘要**：这是作者精心设计的内容，不应被覆盖\n";
      writeFileSync(authorOutlinePath, authorContent, "utf-8");

      // 删除第 1 章章纲（如果 createBatchWorkspace 创建了），确保规划器被触发
      const ch1OutlinePath = join(seriesDir, "ch1-outline-explicit.md");
      if (existsSync(ch1OutlinePath)) rmSync(ch1OutlinePath);

      // start：第 1 章无章纲 → 触发规划；第 2 章有作者章纲 → 应跳过
      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p0fix-author-outline",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 2,
          seedSource: "workspace_or_planner",
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      // 作者章纲不应被覆盖
      const afterAuthorContent = readFileSync(authorOutlinePath, "utf-8");
      assert.equal(
        afterAuthorContent,
        authorContent,
        "作者已有章纲文件不应被规划器覆盖",
      );
      assert.ok(
        afterAuthorContent.includes("作者手写章纲"),
        "作者内容应完好保留",
      );

      // 第 1 章章纲应被规划器生成
      assert.ok(existsSync(ch1OutlinePath), "第 1 章章纲应被规划器生成");

      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P0-FIX-5：锁续租 + releaseBatchLock 校验 jobId
  // ──────────────────────────────────────────────────────────────────────
  describe("P0-FIX-5：锁续租 + releaseBatchLock 校验 jobId", () => {
    it("releaseBatchLock 只删除自己的锁（jobId 不匹配时不删除）", () => {
      const wsId = "batch-p0fix-lock-jobid";
      createBatchWorkspace(wsId);

      const jobId1 = "batch-lock-job1-001";
      const jobId2 = "batch-lock-job2-002";

      // job1 获取锁
      const acq1 = acquireBatchLock(wsId, jobId1, PROJECT_ROOT);
      assert.ok(acq1.ok, "job1 应获取锁");

      // job2 尝试 release（错误 jobId）
      releaseBatchLock(wsId, jobId2, PROJECT_ROOT);

      // 锁仍应存在且属于 job1
      const lockInfo = readBatchLock(wsId, PROJECT_ROOT);
      assert.ok(lockInfo, "锁不应被 job2 删除");
      assert.equal(lockInfo.jobId, jobId1, "锁应仍属于 job1");

      // job1 release（正确 jobId）
      releaseBatchLock(wsId, jobId1, PROJECT_ROOT);
      assert.ok(!existsSync(batchLockPath(wsId, PROJECT_ROOT)), "锁应被 job1 删除");

      cleanupWorkspace(wsId);
    });

    it("renewBatchLock 延长 expiresAt（只续租自己的锁）", () => {
      const wsId = "batch-p0fix-lock-renew";
      createBatchWorkspace(wsId);

      const jobId1 = "batch-lock-renew-001";
      const jobId2 = "batch-lock-renew-002";

      // job1 获取锁
      acquireBatchLock(wsId, jobId1, PROJECT_ROOT);

      // P1-D：写入受控旧 expiresAt（10 分钟前），避免同毫秒续租导致 expiresAt 不严格增加
      const lockPath = batchLockPath(wsId, PROJECT_ROOT);
      const acquiredLock = readBatchLock(wsId, PROJECT_ROOT);
      const controlledOld = {
        ...acquiredLock,
        expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 分钟前
      };
      writeFileSync(lockPath, JSON.stringify(controlledOld, null, 2), "utf-8");
      const expiresBefore = controlledOld.expiresAt;

      // job1 续租
      renewBatchLock(wsId, jobId1, PROJECT_ROOT);
      const lockAfter = readBatchLock(wsId, PROJECT_ROOT);
      assert.ok(lockAfter, "续租后锁应存在");
      assert.equal(lockAfter.jobId, jobId1, "锁应属于 job1");
      // expiresAt 应被延长（新的 now+30min > 旧的 now-10min，严格增加）
      assert.ok(
        new Date(lockAfter.expiresAt).getTime() > new Date(expiresBefore).getTime(),
        "续租后 expiresAt 应延长",
      );

      // job2 尝试续租（错误 jobId）→ 不应改变锁
      renewBatchLock(wsId, jobId2, PROJECT_ROOT);
      const lockAfterWrong = readBatchLock(wsId, PROJECT_ROOT);
      assert.equal(lockAfterWrong.jobId, jobId1, "job2 续租不应改变锁归属");
      assert.equal(
        lockAfterWrong.expiresAt,
        lockAfter.expiresAt,
        "job2 续租不应改变 expiresAt",
      );

      releaseBatchLock(wsId, jobId1, PROJECT_ROOT);
      cleanupWorkspace(wsId);
    });

    it("acquireBatchLock 对僵死锁（PID 死亡）强制释放并重新获取", () => {
      const wsId = "batch-p0fix-lock-stale";
      createBatchWorkspace(wsId);

      // 写一个僵死锁（PID 不存在）
      const lockPath = batchLockPath(wsId, PROJECT_ROOT);
      const staleLock = {
        workspaceId: wsId,
        jobId: "batch-stale-001",
        pid: 999999,
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      writeFileSync(lockPath, JSON.stringify(staleLock, null, 2), "utf-8");

      // 新任务应能获取锁（僵死锁被强制释放）
      const acq = acquireBatchLock(wsId, "batch-new-001", PROJECT_ROOT);
      assert.ok(acq.ok, "新任务应能获取僵死锁的 workspace");

      const lockInfo = readBatchLock(wsId, PROJECT_ROOT);
      assert.equal(lockInfo.jobId, "batch-new-001", "锁应属于新任务");

      releaseBatchLock(wsId, "batch-new-001", PROJECT_ROOT);
      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P1-FIX-6：resume 清理瞬态失败状态 + 重算 summary
  //
  // 失败暂停 → resume 成功 → summary 应反映最新状态（不含旧 failed）
  // ──────────────────────────────────────────────────────────────────────
  describe("P1-FIX-6：resume 清理瞬态失败状态 + 重算 summary", () => {
    it("失败暂停后 resume 成功 → summary 重算（不含旧 failed 数据）", async () => {
      const wsId = "batch-p0fix-resume-summary";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      const jobId = "batch-resume-summary-001";

      // 1. 第 2 章失败 → 暂停
      const mockFail = createMockGenerateChapter({
        workspacePath,
        failOnChapters: [2],
      });
      const result1 = await tool.execute(
        "test-p0fix-resume-summary-fail",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 3,
          jobId,
          stopOnFailure: true,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mockFail,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details1 = result1.details || result1;
      assert.equal(details1.status, "paused", "第 2 章失败应暂停");
      assert.equal(details1.failedChapter, 2, "failedChapter 应为 2");
      // summary 应反映 1 成功 1 失败
      assert.ok(details1.summary, "paused 时应有 summary");
      assert.equal(details1.summary.completedChapters, 1, "summary completedChapters = 1");
      assert.equal(details1.summary.failedChapters, 1, "summary failedChapters = 1");

      // 2. resume 用成功 mock（第 2-3 章都成功）
      const mockSuccess = createMockGenerateChapter({ workspacePath });
      const result2 = await tool.execute(
        "test-p0fix-resume-summary-success",
        {
          mode: "batch",
          action: "resume",
          workspaceId: wsId,
          jobId,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mockSuccess,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details2 = result2.details || result2;
      assert.equal(details2.status, "completed", "resume 后应完成所有章节");

      // P1-FIX-6：summary 应重算，反映 3 成功 0 失败（不含旧 failed 数据）
      assert.ok(details2.summary, "completed 时应有 summary");
      assert.equal(details2.summary.completedChapters, 3, "summary completedChapters 应重算为 3");
      assert.equal(details2.summary.failedChapters, 0, "summary failedChapters 应重算为 0");

      // failedChapter 应被清理
      assert.equal(details2.failedChapter, null, "failedChapter 应被清理为 null");

      // 只应调用第 2-3 章（第 1 章已完成）
      assert.equal(mockSuccess.calls.length, 2, "应只调用第 2-3 章");

      cleanupWorkspace(wsId);
    });
  });
});
