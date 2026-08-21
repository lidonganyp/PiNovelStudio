/**
 * 章节交付契约回归测试：只有可交付的 unified pipeline 结果才能成功结算。
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { assertInvokeNotAborted, createInvokeRouter, readNarrativeStateSnapshot } from "../src/routes/v1/invoke.js";
import { makeConfigForTest } from "../src/config.js";
import type { BillingClient } from "../src/billing-client.js";
import type { LoadedTools } from "../src/extension-loader.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function invokeChapter(
  result: unknown,
  modelCallCount = 0,
  tempProjectRoot = "/tmp/job-1",
): Promise<{
  response: Response;
  finalizedOutcomes: string[];
}> {
  const finalizedOutcomes: string[] = [];
  const billingClient: BillingClient = {
    settle: async () => ({
      jobId: "job-1",
      callId: "call-1",
      alreadySettled: false,
      actualChargeFen: 0,
      settledAmountFen: 0,
      remainingBudgetFen: 100,
      budgetExhausted: false,
    }),
    finalize: async (_jobId, outcome) => {
      finalizedOutcomes.push(outcome);
      return {
        jobId: "job-1",
        userId: 1,
        amountFen: 100,
        settledAmountFen: 0,
        status: outcome === "success" ? "settled" : "released",
        alreadyFinalized: false,
      };
    },
  };

  const loadedTools = {
    byName: new Map([["novel_generate_chapter", {
      name: "novel_generate_chapter",
      invoke: async () => result,
    }]]),
    filterResult: { allowed: [], dropped: [], forbidden: [] },
    distPath: "/test/dist/index.js",
  } as unknown as LoadedTools;
  const workspaceManager = {
    deriveWorkspaceId: () => "p1",
    materializeWorkspace: () => ({
      tempProjectRoot,
      workspacePath: join(tempProjectRoot, "workspaces", "p1"),
    }),
    cleanupWorkspace: () => undefined,
  };

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.requestId = "request-1";
    res.locals.taskToken = { payload: { jobId: "job-1", userId: "1", projectId: "1" } };
    next();
  });
  app.use("/v1", createInvokeRouter(loadedTools, {
    billingClient,
    meteringBinder: {
      invokeWithMetering: async () => ({
        result,
        metering: {
          modelCallCount,
          settledCount: 0,
          alreadySettledCount: 0,
          budgetExhaustedCount: 0,
          totalSettledAmountFen: 0,
          remainingBudgetFen: 100,
          settleErrors: [],
          budgetExhausted: false,
        },
      }),
    },
    workspaceManager: workspaceManager as never,
    config: makeConfigForTest(),
  }));

  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool: "novel_generate_chapter",
      input: { chapterNumber: 1, workspaceId: "p1" },
    }),
  });
  return { response, finalizedOutcomes };
}

describe("invoke delivery contract", () => {
  test("malformed narrative state is a hard error instead of a silent omission", () => {
    const root = mkdtempSync(join(tmpdir(), "novel-runtime-state-"));
    try {
      const workspacePath = join(root, "workspaces", "p1");
      const statePath = join(workspacePath, "narrative-state-store.json");
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(statePath, "{malformed", "utf8");
      assert.throws(
        () => readNarrativeStateSnapshot(root, "p1"),
        /narrative state snapshot is invalid/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupt runtime snapshot rejects delivery and releases its billing hold", async () => {
    const root = mkdtempSync(join(tmpdir(), "novel-runtime-state-"));
    try {
      const workspacePath = join(root, "workspaces", "p1");
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "narrative-state-store.json"), "{malformed", "utf8");

      const { response, finalizedOutcomes } = await invokeChapter(
        { status: "ok", text: "deliverable chapter" },
        1,
        root,
      );

      assert.equal(response.status, 422);
      const body = await response.json() as { code?: unknown; status?: unknown };
      assert.equal(body.code, "NARRATIVE_STATE_INVALID");
      assert.equal(body.status, "error");
      assert.deepEqual(finalizedOutcomes, ["failure"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborted invoke requests cannot proceed to durable success", () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => assertInvokeNotAborted(controller.signal),
      /invoke request aborted/,
    );
  });

  test("blocked chapter is not a successful invocation or successful billing outcome", async () => {
    const { response, finalizedOutcomes } = await invokeChapter({
      status: "blocked",
      reason: "fact guard blocked",
      failureEnvelope: { stage: "preflight", reason: "风格指纹文件不存在" },
    });

    assert.equal(response.status, 422);
    const body = await response.json() as {
      code?: unknown;
      message?: unknown;
      failureEnvelope?: { reason?: unknown };
    };
    assert.equal(body.code, "CHAPTER_NOT_DELIVERABLE");
    assert.equal(body.message, "风格指纹文件不存在");
    assert.equal(body.failureEnvelope?.reason, "风格指纹文件不存在");
    assert.deepEqual(finalizedOutcomes, ["failure"]);
  });

  test("only an ok chapter with non-empty text is returned for API-owned finalization", async () => {
    const { response, finalizedOutcomes } = await invokeChapter({
      status: "ok",
      text: "可交付正文",
    }, 1);

    assert.equal(response.status, 200);
    assert.deepEqual(finalizedOutcomes, []);
  });

  test("an ok status without chapter text is still non-deliverable", async () => {
    const { response, finalizedOutcomes } = await invokeChapter({
      status: "ok",
      text: "   ",
    });

    assert.equal(response.status, 422);
    assert.deepEqual(finalizedOutcomes, ["failure"]);
  });

  test("an otherwise deliverable chapter without model calls is rejected and released", async () => {
    const { response, finalizedOutcomes } = await invokeChapter({
      status: "ok",
      text: "未计费正文",
    });

    assert.equal(response.status, 422);
    assert.deepEqual(finalizedOutcomes, ["failure"]);
  });
});
