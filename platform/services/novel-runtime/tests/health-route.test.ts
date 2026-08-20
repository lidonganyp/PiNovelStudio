/**
 * /healthz HTTP 路由测试（SUB2API-NOVEL-CREATION-UX-1 §7 验收要求）
 *
 * 验证任务书「Novel Runtime /healthz 仍显示 6 个公开工具」：
 *   - GET /healthz 返回 200
 *   - toolCount === 6
 *   - tools 数组恰好包含 6 个 novel_* 工具（与 ALLOWED_TOOL_NAMES 一致）
 *   - 响应不含密钥、URL、Provider、Route 等敏感字段
 *
 * 本测试用 makeLoadedToolsForTest 构造 6 工具桩，绕过真实 PiNovelStudio dist 依赖，
 * 专注验证 health 路由的响应契约。真实 dist 加载链路由 real-extension-loading.test.ts 覆盖。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createHealthRouter } from "../src/routes/health.js";
import { makeLoadedToolsForTest } from "../src/extension-loader.js";
import { ALLOWED_TOOL_NAMES } from "../src/tool-whitelist.js";
import type { PiTool } from "../src/pi-extension-api-stub.js";

/** 构造 6 个 invoke-only 工具桩（通过白名单）。 */
function makeSixToolStubs(): PiTool[] {
  return ALLOWED_TOOL_NAMES.map((name) => ({
    name,
    description: `stub for ${name}`,
    inputSchema: { type: "object" },
    async invoke() {
      return { stub: true };
    },
  }));
}

/** 启动一个临时 HTTP 服务并返回 { baseUrl, close }。 */
function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const loadedTools = makeLoadedToolsForTest(makeSixToolStubs());
  const app = express();
  app.use(createHealthRouter(loadedTools));

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

describe("SUB2API-NOVEL-CREATION-UX-1 §7 /healthz 6 tools assertion", () => {
  test("GET /healthz 返回 200 且 toolCount === 6", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const resp = await fetch(`${baseUrl}/healthz`);
      assert.equal(resp.status, 200, "healthz 应返回 200");
      const body = (await resp.json()) as { toolCount: number };
      assert.equal(body.toolCount, 6, "toolCount 必须为 6");
    } finally {
      await close();
    }
  });

  test("tools 数组恰好包含 6 个 novel_* 工具（与白名单一致）", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const resp = await fetch(`${baseUrl}/healthz`);
      const body = (await resp.json()) as { tools: string[]; toolCount: number };
      assert.equal(body.tools.length, 6, "tools 数组长度为 6");
      assert.deepEqual(
        [...body.tools].sort(),
        [...ALLOWED_TOOL_NAMES].sort(),
        "tools 必须与 ALLOWED_TOOL_NAMES 完全一致",
      );
      // 必须包含章节生成唯一入口
      assert.ok(
        body.tools.includes("novel_generate_chapter"),
        "必须包含 novel_generate_chapter（章节生成唯一入口）",
      );
    } finally {
      await close();
    }
  });

  test("响应不含密钥、URL、Provider、Route 等敏感字段", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const resp = await fetch(`${baseUrl}/healthz`);
      const body = (await resp.json()) as Record<string, unknown>;
      const keys = Object.keys(body);
      // 允许的字段
      const allowedKeys = new Set(["status", "service", "tools", "toolCount", "distPath"]);
      for (const k of keys) {
        assert.ok(allowedKeys.has(k), `不允许的字段泄露: ${k}`);
      }
      // 整个响应序列化后不得出现 key/url/provider/route/secret/token 字样
      const serialized = JSON.stringify(body).toLowerCase();
      const forbidden = ["api_key", "apikey", "provider", "route", "secret", "token", "base_url", "baseurl"];
      for (const word of forbidden) {
        assert.ok(
          !serialized.includes(word),
          `响应不得包含敏感字样: ${word}`,
        );
      }
    } finally {
      await close();
    }
  });

  test("status === ok 且 service === novel-runtime", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const resp = await fetch(`${baseUrl}/healthz`);
      const body = (await resp.json()) as { status: string; service: string };
      assert.equal(body.status, "ok");
      assert.equal(body.service, "novel-runtime");
    } finally {
      await close();
    }
  });
});
