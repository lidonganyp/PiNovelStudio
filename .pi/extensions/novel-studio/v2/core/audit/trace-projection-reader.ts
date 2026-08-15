/**
 * TRACE-PROJECTION-READER — 定位章节审计事件并重建 legacy 读视图（P7 Stage B-Read）
 *
 * 职责：给定 workspace 目录与 chapterId，扫描 traces 下各 run 目录的 events.jsonl，找到该章节
 * 的审计事件流（按 run_started.payload.chapterId 匹配），再用纯投影函数重建
 * legacy 读视图。返回 null 表示「无投影数据」，调用方回退读旧 quality-trace.json。
 *
 * 设计约束：
 * - 只读、不写、不删；本模块是读侧投影入口，不触碰旧文件写路径（Stage B-Read 边界）。
 * - 依赖最小化：只 import trace-projections（纯投影）与 audit-event-types（纯类型），
 *   不拉入 audit-event-store 的运行时依赖，便于治理/成本读点跨编译目标复用。
 * - JSONL 解析内联（readFileSync + 逐行 JSON.parse），跳过损坏行，不抛。
 *
 * 事件定位：审计事件按 runId 落盘（workspaces/{ws}/traces/{runId}/events.jsonl），
 * 与 chapterId 无确定性文件名映射，故此处扫描 traces 目录下所有 events.jsonl，
 * 以 run_started.payload.chapterId 匹配章节。每个 run 是同一章节的一次生成；
 * 同一章节多次重跑会产生多个 run 目录，此处取 events.jsonl mtime 最新者
 * （与旧 quality-trace.json「最新 run 覆盖」语义一致）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AuditEvent } from "./audit-event-types.js";
import {
  rebuildQualityTraceFromEvents,
  type RebuiltQualityTrace,
} from "./trace-projections.js";

/** 章节 id 归一化：剥 "ch" 前缀（与 strategy-feedback-trace-context 的归一化一致） */
function normalizeChapterKey(id: string): string {
  return id.replace(/^ch/i, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 内联 JSONL 读取：逐行 JSON.parse，跳过空行/损坏行，不抛。 */
function readEventsFromJsonl(path: string): AuditEvent[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.eventId === "string") {
        events.push(parsed);
      }
    } catch {
      // 跳过损坏行，不阻断读侧
    }
  }
  return events;
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 投影优先读取：返回章节的 legacy 读视图重建结果。
 *
 * @returns RebuiltQualityTrace（含 gates[]/failureEnvelopes[]），或 null——
 *          无匹配 run / 无可重建数据（最新 run 无 gate 且无失败归因）时返回 null，
 *          调用方应回退读旧 quality-trace.json。
 */
export function loadQualityTraceProjection(
  workspacePath: string,
  chapterId: string,
): RebuiltQualityTrace | null {
  const tracesDir = join(workspacePath, "traces");
  if (!existsSync(tracesDir)) return null;

  let runDirs: string[];
  try {
    runDirs = readdirSync(tracesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  // 最新 run 优先（events.jsonl mtime 降序），与旧文件「最新 run 覆盖」语义一致。
  const ordered = runDirs
    .map((name) => ({ name, mtimeMs: safeMtimeMs(join(tracesDir, name, "events.jsonl")) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const targetKey = normalizeChapterKey(chapterId);

  for (const { name } of ordered) {
    const events = readEventsFromJsonl(join(tracesDir, name, "events.jsonl"));
    if (events.length === 0) continue;
    const runStart = events.find((event) => event.eventType === "run_started");
    if (!runStart) continue;
    const payload = asRecord(runStart.payload);
    if (typeof payload.chapterId !== "string") continue;
    if (normalizeChapterKey(payload.chapterId) !== targetKey) continue;

    const rebuilt = rebuildQualityTraceFromEvents(events, {
      workspaceId: basename(workspacePath),
      chapterId,
    });
    // 有可重建数据（gates 或 failureEnvelopes）才返回，否则回退旧文件——
    // 避免用空投影顶掉旧文件里可能存在的有效数据（如 Stage B-Read 前的旧章节）。
    if (rebuilt.gates.length > 0 || rebuilt.failureEnvelopes.length > 0) {
      return rebuilt;
    }
    // 最新 run 无可重建数据，不再翻更旧 run（与旧文件覆盖语义对齐）。
    return null;
  }

  return null;
}
