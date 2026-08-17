/**
 * SIGKILL 注入子进程驱动 — 内容库原子写（临时文件 → rename）
 *
 * 由 tests/run-lifecycle-sigkill-injection.test.mjs 派生。写入 N 条轨迹明细到
 * TrajectoryContentStore（原子 temp→rename）。当 PINOVEL_SIGKILL_FAULT_POINT=
 * during_content_store_write 时，进程在「临时文件已写、rename 前」同步阻塞，等待 SIGKILL。
 *
 * 正常完成时打印 { mode:"done", ok, outputPath, entryCount } 到 stdout。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTrajectoryContentStore } from "../../dist/v2/core/audit/trajectory-content-store.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const projectRoot = arg("root");
const workspaceId = arg("ws");
const sessionId = arg("session");
const n = Number(arg("n", "4"));

if (!projectRoot || !workspaceId || !sessionId) {
  process.stderr.write("missing required args\n");
  process.exit(2);
}

const entries = Array.from({ length: n }, (_, i) => ({
  type: "message",
  timestamp: 1700000000000 + i,
  data: { role: "assistant", content: `message-${i}` },
}));

const store = createTrajectoryContentStore({ projectRoot, workspaceId, sessionId });
const ok = store.writeAll(entries);

const outputPath = store.getOutputPath();
process.stdout.write(
  JSON.stringify({
    mode: "done",
    ok,
    outputPath,
    entryCount: store.size(),
    fileExists: existsSync(outputPath),
    fileLines: existsSync(outputPath) ? readFileSync(outputPath, "utf-8").trim().split("\n").length : 0,
  }) + "\n",
);
process.exit(0);
