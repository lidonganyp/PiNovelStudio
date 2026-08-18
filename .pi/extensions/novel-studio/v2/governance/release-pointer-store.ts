/**
 * ReleasePointerStore — active-development / active-production 单指针存储（EVOLUTION-RELEASE-GOVERNANCE-1A）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 *
 * fs 持久化层，管理两个单指针文件与一个 append-only 历史。提供：
 * - readActive(kind)：读取当前 active pointer
 * - switchActive(kind, releaseId, opts)：原子切换 + 备份旧 pointer + 追加历史
 * - rollback(kind, opts)：回滚到上一个 pointer（基于历史）
 * - loadRollbackHistory(kind)：读取 append-only 历史
 *
 * 文件布局：
 *   {configDir}/active-development.json   — 当前开发 active pointer
 *   {configDir}/active-production.json    — 当前生产 active pointer
 *   {configDir}/rollback-history-{kind}.jsonl — append-only 切换/回滚历史
 *
 * 安全规则（计划 §G6 / 任务卡"必须测试" + P0-2 修复）：
 * - production pointer 只允许 user 切换（system/gpt5.6-sol-proxy/evaluation/test 均无权）
 * - production pointer 切换前必须校验目标 manifest：存在 + status ∈ {candidate_prod, active_prod} + approvalRef 非空
 *   （通过 options.resolveManifestForValidation 提供；未提供时退化为仅 actor 校验，兼容开发期/1A 测试）
 * - development pointer 允许所有 actor 写
 * - 原子写入（temp → rename），不残留 .tmp
 * - 损坏 JSON / 未知 schema 明确抛错
 * - rollback 必须有历史可回滚；否则抛错
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 只写 configDir，不触碰外部文件
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import {
  EVOLUTION_POINTER_SCHEMA_ID,
  EVOLUTION_POINTER_SCHEMA_VERSION,
} from "./evolution-release-types.js";
import type {
  PointerKind,
  ReleasePointer,
  PointerHistoryEntry,
  ReleaseStatus,
} from "./evolution-release-types.js";

// ============================================================================
// 类型
// ============================================================================

export type PointerActor = "system" | "user" | "gpt5.6-sol-proxy" | "evaluation" | "test";

export interface SwitchActiveOptions {
  reason: string;
  actor: PointerActor;
}

export interface RollbackOptions {
  reason: string;
  actor: PointerActor;
  /**
   * 当 history 因 revoke 后再 switch(from=null) 丢失前序时，
   * 使用当前 release 的 rollbackReleaseId 作为可执行回滚目标。
   */
  designatedTargetReleaseId?: string;
}

/**
 * Manifest 解析回调（用于 production pointer 切换前的存在性 + 状态校验）。
 *
 * P0-2 修复：production pointer 切换不能仅靠 actor 限制，还必须校验目标 release
 * 的 manifest 存在且处于可上线状态（candidate_prod 或 active_prod）。
 *
 * 回调返回 null 表示 manifest 不存在；返回对象会校验 status 是否在允许集合内。
 * 回调可选；未提供时退化为仅 actor 校验（开发期/1A 测试兼容）。
 */
export type ManifestResolver = (
  releaseId: string,
) => {
  releaseId: string;
  status: ReleaseStatus;
  approvalRef: string | null;
} | null;

export interface ReleasePointerStoreOptions {
  /** config 根目录（config/evolution-release/ 或测试临时目录） */
  configDir: string;
  /**
   * 可选：production pointer 切换前的 manifest 校验回调。
   *
   * 提供时，switchActive("production", ...) 会校验：
   * 1. manifest 存在（回调返回非 null）
   * 2. status ∈ { candidate_prod, active_prod }（active_prod 允许用于 reaffirm/rollback）
   * 3. approvalRef 非空（必须经过代理审批；R3 仍需用户审批由更上层把关）
   *
   * 未提供时，只做 actor 校验（开发期/1A 测试兼容；生产 G6 接入时必须提供）。
   */
  resolveManifestForValidation?: ManifestResolver;
}

export interface ReleasePointerStore {
  /** 读取当前 active pointer；不存在返回 null；损坏抛错 */
  readActive(kind: PointerKind): ReleasePointer | null;
  /**
   * 原子切换 active pointer。返回上一个 pointer（首次为 null）。
   * evaluation/test 角色禁止切换 production pointer。
   */
  switchActive(kind: PointerKind, releaseId: string, opts: SwitchActiveOptions): ReleasePointer | null;
  /**
   * 回滚到上一个 pointer（基于 rollback-history 的最近 switch 记录）。
   * 无历史可回滚时抛错。
   * P1-1 修复：追踪已被后续 rollback 消费的 switch，避免连续 rollback 选同一目标。
   */
  rollback(kind: PointerKind, opts: RollbackOptions): ReleasePointer | null;
  /**
   * 撤销当前 active pointer（删除指针文件，不切到任何后继）。
   * held + P6 失败的 production 不得继续自称 active。
   * 无合法 rollback 目标时必须走本入口，不得把已 held 的旧基线重新激活。
   */
  revokeActive(kind: PointerKind, opts: SwitchActiveOptions): ReleasePointer;
  /**
   * 只读 peek：返回当前可回滚到的目标 releaseId，不切换。
   * 无可回滚目标时返回 null。
   * history 不一致时抛错（与 rollback 一致）。
   * P1-3 修复：供 CLI 预校验回滚目标（存在/状态/审批）。
   */
  peekRollbackTarget(kind: PointerKind): string | null;
  /** 读取 append-only 历史。 */
  loadRollbackHistory(kind: PointerKind): PointerHistoryEntry[];
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * releaseId 安全字符集（P1-2 路径穿越守护）。
 * 虽然 pointer JSON 中的 releaseId 不直接参与路径拼接，但为防御性一致仍校验，
 * 防止下游消费者把 pointer.releaseId 误用到路径拼接时逃逸治理目录。
 */
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assertSafeReleaseId(releaseId: string): void {
  if (typeof releaseId !== "string" || releaseId.length === 0) {
    throw new Error(`releaseId 非法：必须为非空字符串`);
  }
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(
      `releaseId 非法：包含不允许的字符（仅允许 [a-zA-Z0-9_-]）：${JSON.stringify(releaseId)}`,
    );
  }
}

function pointerFileName(kind: PointerKind): string {
  return kind === "development" ? "active-development.json" : "active-production.json";
}

function historyFileName(kind: PointerKind): string {
  return kind === "development"
    ? "rollback-history-development.jsonl"
    : "rollback-history-production.jsonl";
}

function pointerPath(configDir: string, kind: PointerKind): string {
  return join(configDir, pointerFileName(kind));
}

function historyPath(configDir: string, kind: PointerKind): string {
  return join(configDir, historyFileName(kind));
}

/** 原子写入。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/** 校验 pointer 结构。 */
function validatePointer(input: unknown): ReleasePointer {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("pointer 必须是对象");
  }
  const obj = input as Record<string, unknown>;
  if (obj.schemaId !== EVOLUTION_POINTER_SCHEMA_ID) {
    throw new Error(
      `pointer schemaId 未知：${JSON.stringify(obj.schemaId)}（期望 ${EVOLUTION_POINTER_SCHEMA_ID}）`,
    );
  }
  if (obj.schemaVersion !== EVOLUTION_POINTER_SCHEMA_VERSION) {
    throw new Error(
      `pointer schemaVersion 不匹配：${JSON.stringify(obj.schemaVersion)}（期望 ${EVOLUTION_POINTER_SCHEMA_VERSION}）`,
    );
  }
  if (obj.kind !== "development" && obj.kind !== "production") {
    throw new Error(`pointer kind 非法：${JSON.stringify(obj.kind)}`);
  }
  if (typeof obj.releaseId !== "string" || obj.releaseId.length === 0) {
    throw new Error("pointer releaseId 必须为非空字符串");
  }
  if (typeof obj.reason !== "string") throw new Error("pointer reason 必须为字符串");
  if (typeof obj.actor !== "string") throw new Error("pointer actor 必须为字符串");
  if (typeof obj.switchedAt !== "string") throw new Error("pointer switchedAt 必须为字符串");
  return obj as unknown as ReleasePointer;
}

/** 校验历史条目结构。 */
function parseHistoryEntry(line: string, lineNumber: number): PointerHistoryEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error(
      `rollback-history 第 ${lineNumber} 行 JSON 解析失败：${(e as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`rollback-history 第 ${lineNumber} 行不是对象`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaId !== "pinovel.evolution-release-pointer-history") {
    throw new Error(`rollback-history 第 ${lineNumber} 行 schemaId 未知`);
  }
  if (obj.operation !== "switch" && obj.operation !== "rollback" && obj.operation !== "revoke") {
    throw new Error(`rollback-history 第 ${lineNumber} 行 operation 非法：${obj.operation}`);
  }
  if (obj.kind !== "development" && obj.kind !== "production") {
    throw new Error(`rollback-history 第 ${lineNumber} 行 kind 非法：${obj.kind}`);
  }
  return obj as unknown as PointerHistoryEntry;
}

/**
 * 检查 actor 是否有权操作指定 kind 的 pointer。
 *
 * P0-2 修复：production pointer 只允许 user 切换。
 * - 旧逻辑只阻断 evaluation/test，导致 system / gpt5.6-sol-proxy 可把任意不存在、
 *   未审批的 release 直接设为 production active。
 * - 新逻辑收紧为：production pointer 只能由 user 切换。system / gpt5.6-sol-proxy
 *   不得直接操作 production pointer；它们要影响生产必须通过用户授权 + manifest 校验。
 * - development pointer 仍允许所有 actor（开发期可由 evaluation/test 切换）。
 *
 * 注意：actor 校验是第一道闸门；manifest 校验是第二道闸门（见 assertProductionManifestApproved）。
 */
function assertActorCanModify(kind: PointerKind, actor: PointerActor): void {
  if (kind === "production" && actor !== "user") {
    throw new Error(
      `actor "${actor}" 禁止修改 production pointer（生产 pointer 只能由 user 切换；system/gpt5.6-sol-proxy/evaluation/test 均无权）`,
    );
  }
}

/**
 * P0-2 修复：production pointer 切换前的 manifest 存在性 + 状态校验。
 *
 * 仅当 options.resolveManifestForValidation 提供时执行；未提供时退化为兼容行为。
 *
 * 校验规则：
 * 1. manifest 必须存在（resolver 返回非 null）
 * 2. status 必须是 candidate_prod 或 active_prod（active_prod 用于 reaffirm/rollback）
 * 3. approvalRef 必须非空（必须经过代理审批）
 *
 * 任一条件不满足直接抛错，阻断 production pointer 切换。
 */
function assertProductionManifestApproved(
  releaseId: string,
  resolver: ManifestResolver | undefined,
): void {
  if (resolver === undefined) {
    // 未提供 resolver：兼容开发期/1A 测试（仅 actor 校验）
    return;
  }
  const manifest = resolver(releaseId);
  if (manifest === null) {
    throw new Error(
      `production pointer 切换失败：release "${releaseId}" 的 manifest 不存在（未审批/未冻结的 release 不得直接设为 production active）`,
    );
  }
  if (manifest.releaseId !== releaseId) {
    throw new Error(
      `production pointer 切换失败：resolver 返回的 releaseId "${manifest.releaseId}" 与请求的 "${releaseId}" 不一致`,
    );
  }
  if (manifest.status !== "candidate_prod" && manifest.status !== "active_prod") {
    throw new Error(
      `production pointer 切换失败：release "${releaseId}" status="${manifest.status}"，必须是 candidate_prod 或 active_prod（未审批/未上线就绪的 release 不得设为 production active）`,
    );
  }
  if (manifest.approvalRef === null || manifest.approvalRef === "") {
    throw new Error(
      `production pointer 切换失败：release "${releaseId}" approvalRef 为空（必须经过代理审批才能设为 production active）`,
    );
  }
}

// ============================================================================
// createReleasePointerStore
// ============================================================================

export function createReleasePointerStore(
  options: ReleasePointerStoreOptions,
): ReleasePointerStore {
  const { configDir, resolveManifestForValidation } = options;

  function readActive(kind: PointerKind): ReleasePointer | null {
    const filePath = pointerPath(configDir, kind);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`pointer JSON 解析失败（${filePath}）：${(e as Error).message}`);
    }
    return validatePointer(parsed);
  }

  function loadAllHistory(kind: PointerKind): PointerHistoryEntry[] {
    const filePath = historyPath(configDir, kind);
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const entries: PointerHistoryEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      entries.push(parseHistoryEntry(line, i + 1));
    }
    return entries;
  }

  /**
   * 读取 append-only 回滚历史（仅 rollback 操作）。
   * 文件本身存储所有操作（switch + rollback），rollback 逻辑需要 switch 记录定位前状态；
   * 公开 API 只返回 rollback 操作，用于审计"执行过哪些回滚"。
   */
  function loadRollbackHistory(kind: PointerKind): PointerHistoryEntry[] {
    return loadAllHistory(kind).filter((e) => e.operation === "rollback");
  }

  function appendHistory(entry: PointerHistoryEntry): void {
    const filePath = historyPath(configDir, entry.kind);
    mkdirSync(configDir, { recursive: true });
    const existing = existsSync(filePath) ? loadAllHistory(entry.kind) : [];
    const all = [...existing, entry];
    const content = all.map((e) => JSON.stringify(e)).join("\n") + (all.length > 0 ? "\n" : "");
    atomicWrite(filePath, content);
  }

  function commitPointerAndHistory(
    kind: PointerKind,
    pointer: ReleasePointer,
    historyEntry: PointerHistoryEntry,
  ): void {
    const filePath = pointerPath(configDir, kind);
    const previousContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;

    mkdirSync(configDir, { recursive: true });
    atomicWrite(filePath, JSON.stringify(pointer, null, 2) + "\n");
    try {
      appendHistory(historyEntry);
    } catch (historyError) {
      try {
        if (previousContent === null) {
          rmSync(filePath, { force: true });
        } else {
          atomicWrite(filePath, previousContent);
        }
      } catch (restoreError) {
        const historyMessage = historyError instanceof Error ? historyError.message : String(historyError);
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `pointer/history 事务失败且 pointer 恢复失败：history=${historyMessage}; restore=${restoreMessage}`,
        );
      }
      throw historyError;
    }
  }

  function switchActive(
    kind: PointerKind,
    releaseId: string,
    opts: SwitchActiveOptions,
  ): ReleasePointer | null {
    assertActorCanModify(kind, opts.actor);
    // P1-2 路径穿越守护（防御性：releaseId 不参与路径拼接，但下游可能误用）
    assertSafeReleaseId(releaseId);
    // P0-2: production pointer 切换前必须校验 manifest 存在 + 状态就绪 + 已审批
    if (kind === "production") {
      assertProductionManifestApproved(releaseId, resolveManifestForValidation);
    }

    const previous = readActive(kind);
    const now = new Date().toISOString();
    const newPointer: ReleasePointer = {
      schemaId: EVOLUTION_POINTER_SCHEMA_ID,
      schemaVersion: EVOLUTION_POINTER_SCHEMA_VERSION,
      kind,
      releaseId,
      reason: opts.reason,
      actor: opts.actor,
      switchedAt: now,
    };

    const historyEntry: PointerHistoryEntry = {
      schemaId: "pinovel.evolution-release-pointer-history",
      schemaVersion: 1,
      kind,
      fromReleaseId: previous?.releaseId ?? null,
      toReleaseId: releaseId,
      operation: "switch",
      reason: opts.reason,
      actor: opts.actor,
      timestamp: now,
    };
    commitPointerAndHistory(kind, newPointer, historyEntry);

    return previous;
  }

  /**
   * P1-1 修复：计算 rollback 目标 releaseId（共享逻辑，供 rollback + peekRollbackTarget 复用）。
   *
   * 算法（括号匹配 consume 跟踪）：
   * - 从后向前扫描 history：每遇到一条 rollback，就标记它前面最近的一条未消费 switch 为已消费。
   * - 然后找最近一条未被消费、且 toReleaseId === 当前 pointer 的 switch。
   * - 该 switch 的 fromReleaseId 即为 rollback 目标。
   *
   * 返回值：
   * - { target: string } — 找到合法目标
   * - { target: null } — 已到初始状态（所有 switch 已消费，或最近未消费 switch 的 fromReleaseId=null）
   *
   * 抛错：history 不一致（最近未消费 switch 的 toReleaseId !== 当前 pointer）
   */
  function computeRollbackTarget(
    kind: PointerKind,
    history: PointerHistoryEntry[],
    current: ReleasePointer,
  ): { target: string | null } {
    // 1. 计算已被后续 rollback 消费的 switch 索引（括号匹配）
    const consumed = new Set<number>();
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].operation === "rollback") {
        for (let j = i - 1; j >= 0; j--) {
          if (history[j].operation === "switch" && !consumed.has(j)) {
            consumed.add(j);
            break;
          }
        }
      }
    }

    // 2. 找最近一条未被消费、且 toReleaseId === 当前 pointer 的 switch
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.operation !== "switch" || consumed.has(i)) continue;
      if (entry.toReleaseId !== current.releaseId) {
        throw new Error(
          `rollback 失败：history 不一致 — 最近未消费 switch 指向 ${entry.toReleaseId}，` +
            `但当前 pointer 是 ${current.releaseId}（history 可能已损坏或被外部修改）`,
        );
      }
      // fromReleaseId=null 表示首次切换（null→A），无可回滚目标
      return { target: entry.fromReleaseId };
    }

    // 3. 所有 switch 已被消费 — 已到初始状态
    return { target: null };
  }

  function peekRollbackTarget(kind: PointerKind): string | null {
    const history = loadAllHistory(kind);
    if (history.length === 0) {
      return null;
    }
    const current = readActive(kind);
    if (!current) {
      return null;
    }
    return computeRollbackTarget(kind, history, current).target;
  }

  function rollback(kind: PointerKind, opts: RollbackOptions): ReleasePointer | null {
    assertActorCanModify(kind, opts.actor);

    const history = loadAllHistory(kind);
    if (history.length === 0) {
      throw new Error(`rollback 失败：${kind} pointer 无历史可回滚`);
    }

    const current = readActive(kind);
    if (!current) {
      throw new Error(`rollback 失败：当前 ${kind} 无 active pointer`);
    }

    // P1-1 修复：用括号匹配 consume 跟踪找目标
    let { target: targetFromId } = computeRollbackTarget(kind, history, current);
    if (targetFromId === null && opts.designatedTargetReleaseId) {
      targetFromId = opts.designatedTargetReleaseId;
    }
    if (targetFromId === null) {
      throw new Error(
        `rollback 失败：${kind} pointer 已到初始状态，无前序可回滚` +
          `（所有 switch 已被消费或为首次切换 fromReleaseId=null）`,
      );
    }

    // P1-2 防御性：targetFromId 也校验字符集
    assertSafeReleaseId(targetFromId);

    const now = new Date().toISOString();
    const newPointer: ReleasePointer = {
      schemaId: EVOLUTION_POINTER_SCHEMA_ID,
      schemaVersion: EVOLUTION_POINTER_SCHEMA_VERSION,
      kind,
      releaseId: targetFromId,
      reason: opts.reason,
      actor: opts.actor,
      switchedAt: now,
    };

    const historyEntry: PointerHistoryEntry = {
      schemaId: "pinovel.evolution-release-pointer-history",
      schemaVersion: 1,
      kind,
      fromReleaseId: current.releaseId,
      toReleaseId: targetFromId,
      operation: "rollback",
      reason: opts.reason,
      actor: opts.actor,
      timestamp: now,
    };
    commitPointerAndHistory(kind, newPointer, historyEntry);

    return newPointer;
  }

  function revokeActive(kind: PointerKind, opts: SwitchActiveOptions): ReleasePointer {
    assertActorCanModify(kind, opts.actor);
    const current = readActive(kind);
    if (current === null) {
      throw new Error(`revoke 失败：当前 ${kind} 无 active pointer`);
    }
    const now = new Date().toISOString();
    const historyEntry: PointerHistoryEntry = {
      schemaId: "pinovel.evolution-release-pointer-history",
      schemaVersion: 1,
      kind,
      fromReleaseId: current.releaseId,
      toReleaseId: "",
      operation: "revoke",
      reason: opts.reason,
      actor: opts.actor,
      timestamp: now,
    };
    const filePath = pointerPath(configDir, kind);
    const previousContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
    mkdirSync(configDir, { recursive: true });
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
    try {
      appendHistory(historyEntry);
    } catch (historyError) {
      if (previousContent !== null) {
        try {
          atomicWrite(filePath, previousContent);
        } catch (restoreError) {
          const historyMessage = historyError instanceof Error ? historyError.message : String(historyError);
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new Error(
            `pointer revoke 失败且 pointer 恢复失败：history=${historyMessage}; restore=${restoreMessage}`,
          );
        }
      }
      throw historyError;
    }
    return current;
  }

  return {
    readActive,
    switchActive,
    rollback,
    revokeActive,
    peekRollbackTarget,
    loadRollbackHistory,
  };
}
