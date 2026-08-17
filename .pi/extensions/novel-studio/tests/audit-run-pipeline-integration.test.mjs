/**
 * AUDIT-1 Phase 3：产品级断言 — runUnifiedPipeline 真实写入 events.jsonl
 *
 * 要求：
 * - stageResults.auditRun 存在
 * - workspaces/{ws}/traces/{runId}/events.jsonl 落盘
 * - 含 run_started 与终止事件
 * - blocked 路径含 failure_recorded
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
const WS_ID = "audit-run-pipeline-integration";
const WS_PATH = join(PROJECT_ROOT, "workspaces", WS_ID);

const originalStub = process.env.V2_FORCE_STUB;
const originalDev = process.env.PINOVEL_DEV_MODE;

function writeMinimalWorkspace() {
  rmSync(WS_PATH, { recursive: true, force: true });
  mkdirSync(join(WS_PATH, "chapters"), { recursive: true });
  mkdirSync(join(WS_PATH, "characters"), { recursive: true });
  mkdirSync(join(WS_PATH, "series"), { recursive: true });
  mkdirSync(join(WS_PATH, "styles"), { recursive: true });

  writeFileSync(
    join(WS_PATH, "config.json"),
    JSON.stringify(
      {
        name: "Audit Run Integration",
        genre: "玄幻",
        subGenres: ["东方玄幻"],
        totalChapters: 10,
        chapterType: "standard",
        styleProfile: "audit-author",
        serialFrequency: "daily",
        characters: [{ id: "p1", name: "叶尘", role: "protagonist" }],
        chapterSeeds: {
          default: {
            choicesAndCosts: [{ choice: "接受传承", cost: "暴露身份" }],
            expectedIrreversibleChange: ["无法回到普通人身份"],
            causalEndPressure: ["追踪者逼近"],
          },
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(join(WS_PATH, "series", "outline.md"), "# 大纲\n## 第1章\n开始。\n", "utf-8");
  writeFileSync(join(WS_PATH, "characters", "叶尘.md"), "# 叶尘\n主角。\n", "utf-8");
  writeFileSync(
    join(WS_PATH, "styles", "profile.json"),
    JSON.stringify({
      id: "audit-author",
      kind: "fingerprint",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["动作优先。"],
    }),
    "utf-8",
  );
}

describe("AUDIT Phase 3: runUnifiedPipeline writes events.jsonl", () => {
  before(() => {
    process.env.V2_FORCE_STUB = "1";
    process.env.PINOVEL_DEV_MODE = "1"; // bypass release gate for local stub
    writeMinimalWorkspace();
  });

  after(() => {
    rmSync(WS_PATH, { recursive: true, force: true });
    if (originalStub === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = originalStub;
    if (originalDev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = originalDev;
  });

  it("production path attaches auditRun with start+terminal events on disk", async () => {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const output = await runUnifiedPipeline({
      workspaceId: WS_ID,
      chapterId: "ch1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
    });

    assert.ok(output.stageResults, "stageResults present");
    const auditRun = output.stageResults.auditRun;
    assert.ok(auditRun, "stageResults.auditRun must exist (production integration)");
    assert.equal(auditRun.enabled, true);
    assert.ok(auditRun.runId, "runId present");
    assert.ok(auditRun.traceId, "traceId present");
    assert.equal(auditRun.runTerminal, true, "run must be terminal");
    assert.ok(auditRun.eventCount >= 2, `eventCount>=2, got ${auditRun.eventCount}`);
    assert.ok(auditRun.eventsPath, "eventsPath present");
    assert.equal(existsSync(auditRun.eventsPath), true, `events.jsonl exists: ${auditRun.eventsPath}`);

    const lines = readFileSync(auditRun.eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].eventType, "run_started");
    assert.equal(lines[0].parentEventId, null);
    const terminal = lines[lines.length - 1];
    assert.ok(
      ["run_finished", "run_failed", "run_interrupted"].includes(terminal.eventType),
      `terminal event, got ${terminal.eventType}`,
    );

    if (output.status === "blocked") {
      const hasFailure = lines.some((e) => e.eventType === "failure_recorded");
      assert.equal(hasFailure, true, "blocked path must record failure_recorded");
    }

    // 完整性：开始+终止
    assert.ok(lines.some((e) => e.eventType === "run_started"));
    assert.ok(
      lines.some((e) =>
        ["run_finished", "run_failed", "run_interrupted"].includes(e.eventType),
      ),
    );

    // P7 Stage A 双写：trace 落盘后应追加 trace_persisted（单事件，防漏记）
    const tracePersistedEvents = lines.filter(
      (e) => e.eventType === "custom" && e.payload?.eventTypeHint === "trace_persisted",
    );
    assert.ok(tracePersistedEvents.length <= 1, "trace_persisted 至多一条");
    if (output.stageResults?.tracePersistence) {
      assert.equal(tracePersistedEvents.length, 1, "trace 落盘后必须 emit trace_persisted");
      const tp = tracePersistedEvents[0];
      assert.ok(String(tp.eventId).startsWith("tracePersisted:"), `eventId=${tp.eventId}`);
      assert.equal(tp.payload.status, output.stageResults.tracePersistence.status);
    }

    // Phase 3 续：若进入模型调用，应有 model_turn_*；stub 生产路径通常会有
    const modelTurns = lines.filter((e) => String(e.eventType).startsWith("model_turn_"));
    // 不强制：preflight/release 早阻断时可以没有模型回合；有则必须成对或 failed
    if (modelTurns.length > 0) {
      assert.ok(
        modelTurns.some((e) => e.eventType === "model_turn_started"),
        "model turns must include started",
      );
    }

    // persisted 语义：无 writeError 时才为 true
    if (auditRun.writeError) {
      assert.equal(auditRun.persisted, false);
    } else {
      assert.equal(auditRun.persisted, true);
    }
  });

  it("fullPipelinePreview keeps audit in-memory (no events.jsonl side effect path required)", async () => {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    const output = await runUnifiedPipeline({
      workspaceId: WS_ID,
      chapterId: "ch-preview",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
      fullPipelinePreview: true,
    });
    const auditRun = output.stageResults?.auditRun;
    assert.ok(auditRun, "preview still exposes auditRun summary");
    assert.equal(auditRun.persisted, false);
    assert.equal(auditRun.runTerminal, true);
  });
});
