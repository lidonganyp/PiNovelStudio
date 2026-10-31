/**
 * 宿主审批路由测试（EXPERT-HOST-APPROVAL-1）
 *
 * 锁定 POST /internal/chapter-contract/approvals 的边界：
 *   - 缺内部签名 → 401 INTERNAL_AUTH_REQUIRED
 *   - 签名错误 → 401 INTERNAL_AUTH_INVALID（不签发凭证）
 *   - 合法签名 + 合法 body → 200，workspaceId 由 (userId, projectId) 派生
 *   - body 非法（proposalHash 非 sha256）→ 400 INVALID_BODY
 *   - issuer 拒绝（如 approvedBy 为空）→ 400 APPROVAL_REJECTED
 *
 * 本测试用假 issuer，不导入真实扩展 dist；真实签发函数加载由
 * host-approval.loadChapterContractApprovalIssuer 在生产启动时 fail-closed 校验。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createChapterContractApprovalRouter } from "../src/routes/internal/chapter-contract-approval.js";
import { signInternalRequest, stableStringify } from "../src/internal-hmac.js";
import { InternalNonceStore } from "../src/internal-nonce-store.js";
import type { ChapterContractApprovalIssuer } from "../src/host-approval.js";

const SECRET = "test-internal-secret";
const APPROVAL_PATH = "/internal/chapter-contract/approvals";
const VALID_HASH = "a".repeat(64);

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

function startServer(issuer: ChapterContractApprovalIssuer): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createChapterContractApprovalRouter({
      issuer,
      workspaceManager: {
        deriveWorkspaceId: (userId, projectId) => `u${userId}_p${projectId}`,
      },
      internalApiSecret: SECRET,
    }),
  );
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function signedHeaders(body: string, overrides?: Partial<{ signature: string; path: string }>): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "nnnnnnnnnnnnnnnn";
  const path = overrides?.path ?? APPROVAL_PATH;
  const signature =
    overrides?.signature ??
    signInternalRequest({ secret: SECRET, timestamp, nonce, method: "POST", path, body });
  return {
    "content-type": "application/json",
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature,
  };
}

const VALID_BODY = {
  userId: 7,
  projectId: 3,
  chapterNumber: 12,
  proposalHash: VALID_HASH,
  approvedBy: "作者@example.com",
};

function bodyText(payload: unknown): string {
  // 与路由侧验签使用的 stableStringify 对齐（键排序序列化）。
  return stableStringify(payload);
}

const okIssuer: ChapterContractApprovalIssuer = (params) => ({
  receiptId: "receipt-1",
  proposalHash: params.proposalHash,
  approvedBy: params.approvedBy,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe("EXPERT-HOST-APPROVAL-1 /internal/chapter-contract/approvals", () => {
  test("缺内部签名 → 401 INTERNAL_AUTH_REQUIRED", async () => {
    const { baseUrl, close } = await startServer(okIssuer);
    try {
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText(VALID_BODY),
      });
      assert.equal(resp.status, 401);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "INTERNAL_AUTH_REQUIRED");
    } finally {
      await close();
    }
  });

  test("签名错误 → 401 INTERNAL_AUTH_INVALID 且不签发凭证", async () => {
    let issued = 0;
    const countingIssuer: ChapterContractApprovalIssuer = (params) => {
      issued += 1;
      return okIssuer(params);
    };
    const { baseUrl, close } = await startServer(countingIssuer);
    try {
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: signedHeaders(bodyText(VALID_BODY), { signature: "b".repeat(64) }),
        body: bodyText(VALID_BODY),
      });
      assert.equal(resp.status, 401);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "INTERNAL_AUTH_INVALID");
      assert.equal(issued, 0, "验签失败不得调用签发器");
    } finally {
      await close();
    }
  });

  test("签名覆盖的路径不一致 → 401（防跨路由重放）", async () => {
    const { baseUrl, close } = await startServer(okIssuer);
    try {
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: signedHeaders(bodyText(VALID_BODY), { path: "/internal/other" }),
        body: bodyText(VALID_BODY),
      });
      assert.equal(resp.status, 401);
    } finally {
      await close();
    }
  });

  test("合法签名 + 合法 body → 200，workspaceId 由 userId/projectId 派生", async () => {
    const { baseUrl, close } = await startServer(okIssuer);
    try {
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: signedHeaders(bodyText(VALID_BODY)),
        body: bodyText(VALID_BODY),
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(body.workspaceId, "u7_p3");
      assert.equal(body.receiptId, "receipt-1");
      assert.equal(body.proposalHash, VALID_HASH);
      assert.equal(body.approvedBy, "作者@example.com");
    } finally {
      await close();
    }
  });

  test("body 非法 → 400 INVALID_BODY", async () => {
    const { baseUrl, close } = await startServer(okIssuer);
    try {
      const invalid = { ...VALID_BODY, proposalHash: "not-a-sha256" };
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: signedHeaders(bodyText(invalid)),
        body: bodyText(invalid),
      });
      assert.equal(resp.status, 400);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "INVALID_BODY");
    } finally {
      await close();
    }
  });

  test("同一份有效签名第二次请求 → 401 INTERNAL_AUTH_REPLAY 且不重复签发", async () => {
    let issued = 0;
    const countingIssuer: ChapterContractApprovalIssuer = (params) => {
      issued += 1;
      return okIssuer(params);
    };
    const { baseUrl, close } = await startServer(countingIssuer);
    try {
      const body = bodyText(VALID_BODY);
      const headers = signedHeaders(body);
      const first = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(first.status, 200);
      assert.equal(issued, 1);

      // 完全相同的 timestamp / nonce / signature 重放，不得再次签发凭证。
      const replay = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(replay.status, 401);
      const replayBody = (await replay.json()) as { code: string };
      assert.equal(replayBody.code, "INTERNAL_AUTH_REPLAY");
      assert.equal(issued, 1, "重放不得调用签发器");
    } finally {
      await close();
    }
  });

  test("nonce 表按 TTL 清理：窗口过后同一 nonce 可再次消费", () => {
    let clock = 1_000_000;
    const store = new InternalNonceStore(60_000, () => clock);
    assert.equal(store.consume("nonce-1"), true);
    assert.equal(store.consume("nonce-1"), false);
    clock += 60_001;
    assert.equal(store.consume("nonce-1"), true, "TTL 过期后应允许重新消费");
    assert.equal(store.size(), 1);
  });

  test("issuer 拒绝 → 400 APPROVAL_REJECTED", async () => {
    const rejectingIssuer: ChapterContractApprovalIssuer = (params) => {
      if (params.approvedBy.includes("reject")) throw new Error("approvedBy 不被接受");
      return okIssuer(params);
    };
    const { baseUrl, close } = await startServer(rejectingIssuer);
    try {
      const rejected = { ...VALID_BODY, approvedBy: "reject-me" };
      const resp = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: "POST",
        headers: signedHeaders(bodyText(rejected)),
        body: bodyText(rejected),
      });
      assert.equal(resp.status, 400);
      const body = (await resp.json()) as { code: string };
      assert.equal(body.code, "APPROVAL_REJECTED");
    } finally {
      await close();
    }
  });
});
