import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTaskTokenAuthMiddleware } from "../src/middleware/task-token-auth.js";
import { makeConfigForTest } from "../src/config.js";

async function startApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    createTaskTokenAuthMiddleware(makeConfigForTest()),
    (_req, res) => res.json({ ok: true }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

test("GET /v1/tools remains anonymously accessible after /v1 router mounting", async () => {
  const { baseUrl, close } = await startApp();
  try {
    const response = await fetch(`${baseUrl}/v1/tools`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close();
  }
});

test("non-public /v1 routes still require a task token", async () => {
  const { baseUrl, close } = await startApp();
  try {
    const response = await fetch(`${baseUrl}/v1/invoke`, { method: "POST" });
    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});
