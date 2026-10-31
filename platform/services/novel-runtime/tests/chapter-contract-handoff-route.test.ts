/**
 * 章纲契约 handoff 路由测试（作者侧审批闭环）
 *
 * 锁定 POST /internal/chapter-contract/handoff 的边界：
 *   - 缺内部签名 → 401 INTERNAL_AUTH_REQUIRED
 *   - 同一份有效签名第二次请求 → 401 INTERNAL_AUTH_REPLAY（不重复执行 handoff）
 *   - preview → 200，返回 proposalHash / outlineMarkdown，不写盘
 *   - commit 被阻断（无审批凭证）→ 400 HANDOFF_BLOCKED
 *   - commit 成功 → 200，返回落盘章纲与 provenance
 *   - 落盘章纲 hash 与工具返回值不一致 → 500 HANDOFF_STATE_INCONSISTENT
 *
 * 本测试用假工具 + 真实 WorkspaceManager（临时目录），不加载扩展 dist。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createChapterContractHandoffRouter } from "../src/routes/internal/chapter-contract-handoff.js";
import { createWorkspaceManager } from "../src/workspace-manager.js";
import { signInternalRequest, stableStringify } from "../src/internal-hmac.js";
import type { LoadedTools } from "../src/extension-loader.js";

const SECRET = "test-internal-secret";
const HANDOFF_PATH = "/internal/chapter-contract/handoff";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  tempRoot: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fullWorkspaceInputs(body: Record<string, unknown>): Record<string, unknown> {
  return {
    userId: 7,
    projectId: 3,
    chapterNumber: 4,
    proposalText: "# 提案",
    projectConfig: { genre: "玄幻" },
    ...body,
  };
}

function startServer(
  invoke: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<Harness> {
  const tempRoot = mkdtempSync(join(tmpdir(), "handoff-route-"));
  const workspaceManager = createWorkspaceManager({ tempWorkspaceRoot: tempRoot });
  const loadedTools = {
    byName: new Map([
      [
        "novel_workspace_manager",
        {
          name: "novel_workspace_manager",
          invoke: async (input: unknown) => invoke(input as Record<string, unknown>),
        },
      ],
    ]),
  } as unknown as LoadedTools;

  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createChapterContractHandoffRouter({
      loadedTools,
      workspaceManager,
      internalApiSecret: SECRET,
    }),
  );
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        tempRoot,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              rmSync(tempRoot, { recursive: true, force: true });
              r();
            });
          }),
      });
    });
  });
}

function signedHeaders(
  body: string,
  overrides?: Partial<{ signature: string; nonce: string }>,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = overrides?.nonce ?? "nnnnnnnnnnnnnnnn";
  const signature =
    overrides?.signature ??
    signInternalRequest({
      secret: SECRET,
      timestamp,
      nonce,
      method: "POST",
      path: HANDOFF_PATH,
      body,
    });
  return {
    "content-type": "application/json",
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature,
  };
}

describe("作者侧审批闭环 /internal/chapter-contract/handoff", () => {
  test("缺内部签名 → 401 INTERNAL_AUTH_REQUIRED", async () => {
    const { baseUrl, close } = await startServer(async () => ({ status: "ok" }));
    try {
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stableStringify(fullWorkspaceInputs({ mode: "preview" })),
      });
      assert.equal(resp.status, 401);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "INTERNAL_AUTH_REQUIRED");
    } finally {
      await close();
    }
  });

  test("同一份有效签名第二次请求 → 401 INTERNAL_AUTH_REPLAY", async () => {
    let calls = 0;
    const { baseUrl, close } = await startServer(async () => {
      calls += 1;
      return { status: "ok", expertHandoff: { status: "ok", handoffMode: "preview" } };
    });
    try {
      const payload = stableStringify(fullWorkspaceInputs({ mode: "preview" }));
      const headers = signedHeaders(payload);
      const first = await fetch(`${baseUrl}${HANDOFF_PATH}`, { method: "POST", headers, body: payload });
      assert.equal(first.status, 200);
      assert.equal(calls, 1);

      const replay = await fetch(`${baseUrl}${HANDOFF_PATH}`, { method: "POST", headers, body: payload });
      assert.equal(replay.status, 401);
      const replayBody = (await replay.json()) as { code: string };
      assert.equal(replayBody.code, "INTERNAL_AUTH_REPLAY");
      assert.equal(calls, 1, "重放不得再次执行 handoff");
    } finally {
      await close();
    }
  });

  test("preview → 200，返回 proposalHash / outlineMarkdown", async () => {
    const outlineMarkdown = "# 第4章 显式章纲\n\n## 事件\n- 事件A";
    const proposalHash = sha256(outlineMarkdown);
    let seenRoot = "";
    const { baseUrl, close } = await startServer(async (input) => {
      seenRoot = String(input._projectRoot ?? "");
      return {
        status: "ok",
        expertHandoff: {
          status: "ok",
          handoffMode: "preview",
          chapterNumber: 4,
          outlineMarkdown,
          proposalHash,
          targetPath: "series/ch4-outline-explicit.md",
        },
      };
    });
    try {
      const payload = stableStringify(fullWorkspaceInputs({ mode: "preview" }));
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(body.proposalHash, proposalHash);
      assert.equal(body.outlineMarkdown, outlineMarkdown);
      assert.equal(body.workspaceId, "u7_p3");
      assert.ok(seenRoot.length > 0, "工具收到临时 project root");
      assert.equal(typeof body.provenance, "undefined", "preview 不返回 provenance");
    } finally {
      await close();
    }
  });

  test("commit 被阻断（缺审批凭证）→ 400 HANDOFF_BLOCKED", async () => {
    const { baseUrl, close } = await startServer(async () => ({
      status: "blocked",
      expertHandoff: {
        status: "blocked",
        error: "approval_receipt_required",
        handoffMode: "commit",
        chapterNumber: 4,
      },
    }));
    try {
      const payload = stableStringify(fullWorkspaceInputs({ mode: "commit", confirm: true }));
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 400);
      const body = (await resp.json()) as { code: string; message: string };
      assert.equal(body.code, "HANDOFF_BLOCKED");
      assert.match(body.message, /approval_receipt_required/);
    } finally {
      await close();
    }
  });

  test("commit 成功 → 200，返回落盘章纲与 provenance", async () => {
    const outlineMarkdown = "# 第4章 显式章纲\n\n## 事件\n- 事件A";
    const proposalHash = sha256(outlineMarkdown);
    const { baseUrl, close } = await startServer(async (input) => {
      const projectRoot = String(input._projectRoot);
      const workspacePath = join(projectRoot, "workspaces", String(input.workspaceId));
      mkdirSync(join(workspacePath, "series"), { recursive: true });
      writeFileSync(join(workspacePath, "series", "ch4-outline-explicit.md"), outlineMarkdown, "utf8");
      writeFileSync(
        join(workspacePath, "series", "ch4-outline-explicit.md.provenance.json"),
        JSON.stringify({ schemaVersion: 1, commitStatus: "committed", proposalHash, approval: { approvedBy: "作者-张三" } }),
        "utf8",
      );
      return {
        status: "ok",
        expertHandoff: {
          status: "ok",
          handoffMode: "commit",
          wrote: true,
          chapterNumber: 4,
          outlineMarkdown,
          proposalHash,
          targetPath: "series/ch4-outline-explicit.md",
        },
      };
    });
    try {
      const payload = stableStringify(
        fullWorkspaceInputs({
          mode: "commit",
          confirm: true,
          confirmedBy: "作者-张三",
          approvalReceipt: "receipt-1",
        }),
      );
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body.mode, "commit");
      assert.equal(body.outlineMarkdown, outlineMarkdown);
      assert.equal(body.proposalHash, proposalHash);
      assert.equal(
        (body.provenance as { approval?: { approvedBy?: string } }).approval?.approvedBy,
        "作者-张三",
      );
    } finally {
      await close();
    }
  });

  test("落盘章纲 hash 与工具返回值不一致 → 500 HANDOFF_STATE_INCONSISTENT", async () => {
    const { baseUrl, close } = await startServer(async (input) => {
      const projectRoot = String(input._projectRoot);
      const workspacePath = join(projectRoot, "workspaces", String(input.workspaceId));
      mkdirSync(join(workspacePath, "series"), { recursive: true });
      writeFileSync(join(workspacePath, "series", "ch4-outline-explicit.md"), "被篡改的章纲", "utf8");
      writeFileSync(
        join(workspacePath, "series", "ch4-outline-explicit.md.provenance.json"),
        JSON.stringify({ schemaVersion: 1, commitStatus: "committed" }),
        "utf8",
      );
      return {
        status: "ok",
        expertHandoff: {
          status: "ok",
          handoffMode: "commit",
          wrote: true,
          chapterNumber: 4,
          outlineMarkdown: "# 原始章纲",
          proposalHash: sha256("# 原始章纲"),
          targetPath: "series/ch4-outline-explicit.md",
        },
      };
    });
    try {
      const payload = stableStringify(
        fullWorkspaceInputs({ mode: "commit", confirm: true, confirmedBy: "作者", approvalReceipt: "r" }),
      );
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 500);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "HANDOFF_STATE_INCONSISTENT");
    } finally {
      await close();
    }
  });

  test("commit 返回越界 targetPath → 500 HANDOFF_INVALID_TARGET", async () => {
    const { baseUrl, close } = await startServer(async (input) => {
      const projectRoot = String(input._projectRoot);
      const workspacePath = join(projectRoot, "workspaces", String(input.workspaceId));
      mkdirSync(join(workspacePath, "series"), { recursive: true });
      // 攻击者把恶意内容写到 workspace 之外；路由必须拒绝按该路径读取。
      writeFileSync(join(projectRoot, "outside-workspace.md"), "# 越界内容", "utf8");
      return {
        status: "ok",
        expertHandoff: {
          status: "ok",
          handoffMode: "commit",
          wrote: true,
          chapterNumber: 4,
          outlineMarkdown: "# 越界内容",
          proposalHash: sha256("# 越界内容"),
          targetPath: "../../outside-workspace.md",
        },
      };
    });
    try {
      const payload = stableStringify(
        fullWorkspaceInputs({ mode: "commit", confirm: true, confirmedBy: "作者", approvalReceipt: "r" }),
      );
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 500);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "HANDOFF_INVALID_TARGET");
    } finally {
      await close();
    }
  });

  test("临时 workspace 读完后被清理", async () => {
    const outlineMarkdown = "# 第4章\n- 事件";
    const proposalHash = sha256(outlineMarkdown);
    const { baseUrl, close, tempRoot } = await startServer(async (input) => {
      const projectRoot = String(input._projectRoot);
      const workspacePath = join(projectRoot, "workspaces", String(input.workspaceId));
      mkdirSync(join(workspacePath, "series"), { recursive: true });
      writeFileSync(join(workspacePath, "series", "ch4-outline-explicit.md"), outlineMarkdown, "utf8");
      writeFileSync(
        join(workspacePath, "series", "ch4-outline-explicit.md.provenance.json"),
        JSON.stringify({ schemaVersion: 1, commitStatus: "committed", proposalHash }),
        "utf8",
      );
      return {
        status: "ok",
        expertHandoff: {
          status: "ok",
          handoffMode: "commit",
          wrote: true,
          chapterNumber: 4,
          outlineMarkdown,
          proposalHash,
          targetPath: "series/ch4-outline-explicit.md",
        },
      };
    });
    try {
      const payload = stableStringify(
        fullWorkspaceInputs({ mode: "commit", confirm: true, confirmedBy: "作者", approvalReceipt: "r" }),
      );
      const resp = await fetch(`${baseUrl}${HANDOFF_PATH}`, {
        method: "POST",
        headers: signedHeaders(payload),
        body: payload,
      });
      assert.equal(resp.status, 200);
      // 每个 job 目录都已清理，根目录下不应残留 handoff-* 目录
      assert.equal(readdirSync(tempRoot).length, 0);
    } finally {
      await close();
    }
  });
});
