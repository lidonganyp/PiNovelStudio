/**
 * EvolutionReleaseRegistry — Manifest 与状态事件持久化（EVOLUTION-RELEASE-GOVERNANCE-1A）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 *
 * fs 持久化层，委托 schema 校验给纯函数（evolution-release-schema.ts）。提供：
 * - writeManifest：frozen 不可变守护 + 原子写入
 * - loadManifest：损坏 JSON / 未知 schema 明确抛错
 * - listManifests：列出全部已写入 manifest
 * - recordStateEvent：append-only + 重复 eventId 拒绝 + 状态迁移校验
 * - loadStateEvents：损坏 jsonl 明确抛错
 *
 * 目录布局：
 *   {releasesDir}/{releaseId}/manifest.json
 *   {releasesDir}/{releaseId}/state-events.jsonl
 *
 * 设计原则：
 * - 只写 releasesDir，不触碰外部文件（不修改用户 WIP）
 * - 原子写入（temp → rename），不残留 .tmp
 * - append-only 状态事件：load → append → rewrite（jsonl 全量重写，但事件只增不删）
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 不进入生产闭包（仅 dist-test/，未来 Phase G6 才接入生产）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import {
  validateManifest,
  assertFrozenImmutable,
  isStatusTransitionValid,
  computeReleasePayloadHash,
} from "./evolution-release-schema.js";
import { verifyManifestBinding } from "./release-proxy-approval-schema.js";
import type {
  EvolutionReleaseManifest,
  ReleaseStateEvent,
  ReleaseStatus,
} from "./evolution-release-types.js";
import type { ReleaseProxyApprovalArtifact } from "./release-proxy-approval-types.js";

// ============================================================================
// 类型
// ============================================================================

export interface EvolutionReleaseRegistryOptions {
  /** releases 根目录（reports/evolution-releases/ 或测试临时目录） */
  releasesDir: string;
}

export interface EvolutionReleaseRegistry {
  /** 写入 manifest；frozen 后同 releaseId 覆盖抛错 */
  writeManifest(manifest: EvolutionReleaseManifest): void;
  /** 读取 manifest；不存在返回 null；损坏 JSON / 未知 schema 抛错 */
  loadManifest(releaseId: string): EvolutionReleaseManifest | null;
  /** 列出全部已写入 manifest */
  listManifests(): EvolutionReleaseManifest[];
  /** 追加状态事件；重复 eventId / 非法迁移抛错 */
  recordStateEvent(event: ReleaseStateEvent): void;
  /** 读取状态事件；不存在返回空数组；损坏 jsonl 抛错 */
  loadStateEvents(releaseId: string): ReleaseStateEvent[];
  /**
   * 状态机迁移：加载既有 manifest → 校验 isStatusTransitionValid → 审批绑定 / 角色守护 →
   * 更新 status（+ approvalRef）。绕过 frozen immutability 检查（因为状态迁移本身已由
   * isStatusTransitionValid + 审批/角色守护）。
   *
   * P0 审批绕过守护（计划 §4 / §6.4 / §11）：
   * - actor 必填（禁止隐式默认 system 绕过角色守护）
   * - 审批要求状态（approved_dev / active_dev / candidate_prod / active_prod）：
   *   最终 approvalRef（options.approvalRef ?? existing.approvalRef）必须非空
   * - 生产晋级状态（candidate_prod / active_prod）：actor 必须为 "user"
   *   （active_prod 必须由用户明确批准系统版本）
   * - 第二层 artifact 真实性守护（可选 resolveApprovalArtifact 注入）：
   *   当调用方注入 resolver 时，对审批要求状态额外验证 artifact 真实性
   *   （approvalId / releaseId / finalVerdict=APPROVE_DEV / releaseManifestHash 双向绑定）。
   *   未注入 resolver 时退化为字符串非空检查（开发期/1A 测试兼容；生产 G6 门禁会注入 fs resolver）。
   *
   * 用于 frozen → evaluated、evaluated → approved_dev/held/rejected/quarantined 等生命周期迁移。
   * 返回更新后的 manifest。
   */
  transitionStatus(
    releaseId: string,
    newStatus: ReleaseStatus,
    options: {
      /** 触发者；必填，禁止隐式默认 */
      actor: ReleaseStateEvent["actor"];
      /** 审批 artifact 引用；审批要求状态必须非空（可继承 existing.approvalRef） */
      approvalRef?: string;
      /**
       * 审批 artifact 解析器（可选，计划 §6.4 / §11 第二层守护）。
       * 注入后对审批要求状态额外验证 artifact 真实性：
       * - resolver 返回 null（artifact 不存在）→ 抛错
       * - artifact.approvalId !== approvalRef → 抛错
       * - artifact.releaseId !== manifest.releaseId → 抛错
       * - artifact.finalVerdict !== "APPROVE_DEV" → 抛错
       * - artifact.releaseManifestHash !== computeReleasePayloadHash(manifest) → 抛错
       * 未注入时退化为字符串非空检查（向后兼容）。
       */
      resolveApprovalArtifact?: (
        approvalRef: string,
        releaseId: string,
        manifestHash: string,
      ) => ReleaseProxyApprovalArtifact | null;
    },
  ): EvolutionReleaseManifest;
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * releaseId 安全字符集（P1-2 路径穿越守护）。
 * 只允许 [a-zA-Z0-9_-]，禁止 / ..\ 等可逃逸 releasesDir 的字符。
 */
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 校验 releaseId 字符集，防止路径穿越。
 * 在所有接受外部 releaseId 的公开函数入口调用。
 */
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

function releaseDir(releasesDir: string, releaseId: string): string {
  return join(releasesDir, releaseId);
}

function manifestPath(releasesDir: string, releaseId: string): string {
  return join(releaseDir(releasesDir, releaseId), "manifest.json");
}

function stateEventsPath(releasesDir: string, releaseId: string): string {
  return join(releaseDir(releasesDir, releaseId), "state-events.jsonl");
}

/** 原子写入：temp → rename。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/** 校验并解析 state event。 */
function parseStateEvent(line: string, lineNumber: number): ReleaseStateEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error(
      `state-events.jsonl 第 ${lineNumber} 行 JSON 解析失败：${(e as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`state-events.jsonl 第 ${lineNumber} 行不是对象`);
  }
  const obj = parsed as Record<string, unknown>;
  const required: Array<keyof ReleaseStateEvent> = [
    "eventId",
    "releaseId",
    "fromStatus",
    "toStatus",
    "reason",
    "actor",
    "timestamp",
  ];
  for (const field of required) {
    if (!(field in obj)) {
      throw new Error(`state-events.jsonl 第 ${lineNumber} 行缺少字段 ${field}`);
    }
  }
  return obj as unknown as ReleaseStateEvent;
}

// ============================================================================
// createEvolutionReleaseRegistry
// ============================================================================

export function createEvolutionReleaseRegistry(
  options: EvolutionReleaseRegistryOptions,
): EvolutionReleaseRegistry {
  const { releasesDir } = options;

  function writeManifest(manifest: EvolutionReleaseManifest): void {
    // P1-2 路径穿越守护
    assertSafeReleaseId(manifest.releaseId);
    // 先 schema 校验
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      throw new Error(
        `manifest schema 校验失败：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
      );
    }

    const filePath = manifestPath(releasesDir, manifest.releaseId);

    // frozen 不可变检查：若已存在同 releaseId 的 frozen manifest，则不允许覆盖（除非是状态机迁移且其他字段不变）
    if (existsSync(filePath)) {
      const existingRaw = readFileSync(filePath, "utf-8");
      const existingParsed: unknown = JSON.parse(existingRaw);
      const existingValidation = validateManifest(existingParsed);
      if (!existingValidation.ok) {
        throw new Error(
          `既有 manifest 损坏，拒绝覆盖：${existingValidation.error.code} at ${existingValidation.error.path}`,
        );
      }
      const existing = existingValidation.manifest!;
      const immutable = assertFrozenImmutable(existing, manifest);
      if (!immutable.ok) {
        throw new Error(
          `frozen manifest 不可原地修改（releaseId=${manifest.releaseId}），变更字段：${immutable.changedFields.join(", ")}。` +
            `如需修改请创建新 releaseId。`,
        );
      }
    }

    // 原子写入
    mkdirSync(releaseDir(releasesDir, manifest.releaseId), { recursive: true });
    atomicWrite(filePath, JSON.stringify(manifest, null, 2) + "\n");
  }

  function loadManifest(releaseId: string): EvolutionReleaseManifest | null {
    // P1-2 路径穿越守护
    assertSafeReleaseId(releaseId);
    const filePath = manifestPath(releasesDir, releaseId);
    if (!existsSync(filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (e) {
      throw new Error(`读取 manifest 失败（${filePath}）：${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`manifest.json JSON 解析失败（${filePath}）：${(e as Error).message}`);
    }
    const validation = validateManifest(parsed);
    if (!validation.ok) {
      throw new Error(
        `manifest 校验失败（${filePath}）：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
      );
    }
    return validation.manifest!;
  }

  function listManifests(): EvolutionReleaseManifest[] {
    if (!existsSync(releasesDir)) return [];
    const entries = readdirSync(releasesDir, { withFileTypes: true });
    const manifests: EvolutionReleaseManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = loadManifest(entry.name);
      if (m !== null) manifests.push(m);
    }
    return manifests;
  }

  function loadStateEvents(releaseId: string): ReleaseStateEvent[] {
    // P1-2 路径穿越守护
    assertSafeReleaseId(releaseId);
    const filePath = stateEventsPath(releasesDir, releaseId);
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const events: ReleaseStateEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      events.push(parseStateEvent(line, i + 1));
    }
    return events;
  }

  function recordStateEvent(event: ReleaseStateEvent): void {
    // P1-2 路径穿越守护
    assertSafeReleaseId(event.releaseId);
    // 校验状态迁移
    if (!isStatusTransitionValid(event.fromStatus, event.toStatus)) {
      throw new Error(
        `非法状态迁移：${event.fromStatus} → ${event.toStatus}（releaseId=${event.releaseId}）`,
      );
    }

    const filePath = stateEventsPath(releasesDir, event.releaseId);
    mkdirSync(releaseDir(releasesDir, event.releaseId), { recursive: true });

    // 加载既有事件，检查重复 eventId
    const existing = existsSync(filePath) ? loadStateEvents(event.releaseId) : [];
    if (existing.some((e) => e.eventId === event.eventId)) {
      throw new Error(`重复 eventId（${event.eventId}），状态事件 append-only 不允许覆盖`);
    }

    // append：全量重写 jsonl（事件只增不删）
    const allEvents = [...existing, event];
    const content =
      allEvents.map((e) => JSON.stringify(e)).join("\n") + (allEvents.length > 0 ? "\n" : "");
    atomicWrite(filePath, content);
  }

  function transitionStatus(
    releaseId: string,
    newStatus: ReleaseStatus,
    options: {
      actor: ReleaseStateEvent["actor"];
      approvalRef?: string;
      resolveApprovalArtifact?: (
        approvalRef: string,
        releaseId: string,
        manifestHash: string,
      ) => ReleaseProxyApprovalArtifact | null;
    },
  ): EvolutionReleaseManifest {
    // P1-2 路径穿越守护
    assertSafeReleaseId(releaseId);
    if (options === undefined || options.actor === undefined) {
      throw new Error(
        `transitionStatus 失败：actor 必填（releaseId=${releaseId}, newStatus=${newStatus}）` +
          `——禁止隐式默认绕过角色守护`,
      );
    }

    const existing = loadManifest(releaseId);
    if (!existing) {
      throw new Error(
        `transitionStatus 失败：releaseId ${releaseId} 的 manifest 不存在`,
      );
    }

    // 校验状态迁移合法性
    if (!isStatusTransitionValid(existing.status, newStatus)) {
      throw new Error(
        `非法状态迁移：${existing.status} → ${newStatus}（releaseId=${releaseId}）`,
      );
    }

    // P0 审批绑定守护（第一层）：审批要求状态最终 approvalRef 必须非空。
    // approvalRef 可由 options 传入或从 existing 继承（如 approved_dev → active_dev 沿链继承）。
    const finalApprovalRef = options.approvalRef ?? existing.approvalRef;
    const APPROVAL_REQUIRED: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
      "approved_dev",
      "active_dev",
      "candidate_prod",
      "active_prod",
    ]);
    if (
      APPROVAL_REQUIRED.has(newStatus) &&
      (finalApprovalRef === null || finalApprovalRef.length === 0)
    ) {
      throw new Error(
        `审批绑定缺失：状态迁移至 ${newStatus}（releaseId=${releaseId}）要求 approvalRef 非空，` +
          `实际 approvalRef=${JSON.stringify(finalApprovalRef)}` +
          `（需先完成 gpt5.6-sol 代理审批或用户授权并绑定 approvalRef）`,
      );
    }

    // P0 角色守护：生产晋级必须由 user 触发（active_prod 必须由用户明确批准系统版本）。
    const PRODUCTION_PROMOTION: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
      "candidate_prod",
      "active_prod",
    ]);
    if (PRODUCTION_PROMOTION.has(newStatus) && options.actor !== "user") {
      throw new Error(
        `角色越权：状态迁移至 ${newStatus}（releaseId=${releaseId}）必须由 actor="user" 触发，` +
          `实际 actor=${JSON.stringify(options.actor)}` +
          `（生产晋级必须由用户明确授权，system / gpt5.6-sol-proxy / evaluation 不得直接晋级生产）`,
      );
    }

    // P0 审批 artifact 真实性守护（第二层，计划 §6.4 / §11）：
    // 当调用方注入 resolveApprovalArtifact 时，对审批要求状态额外验证 artifact 真实性。
    // 未注入 resolver 时退化为字符串非空检查（向后兼容；生产 G6 门禁会注入 fs resolver）。
    // 用户复现：approvalRef="fake-does-not-exist" 字符串绕过第一层守护。
    if (
      APPROVAL_REQUIRED.has(newStatus) &&
      options.resolveApprovalArtifact !== undefined &&
      finalApprovalRef !== null &&
      finalApprovalRef.length > 0
    ) {
      // 使用 computeReleasePayloadHash（排除生命周期字段），保证 artifact hash 在状态迁移中稳定
      // （P0 生命周期 hash 绑定修复：existing 可能处于任意 evaluated 之后的中间状态，
      //   artifact 在 evaluated 状态生成，迁移到 active_prod 状态仍能通过绑定验证）。
      const manifestHash = computeReleasePayloadHash(existing);
      const artifact = options.resolveApprovalArtifact(
        finalApprovalRef,
        releaseId,
        manifestHash,
      );
      if (artifact === null) {
        throw new Error(
          `审批 artifact 不存在：approvalRef="${finalApprovalRef}"（releaseId=${releaseId}, newStatus=${newStatus}）` +
            `（approvalRef 不得为伪造字符串；需通过 gpt5.6-sol 代理审批生成真实 artifact 并绑定）`,
        );
      }
      if (artifact.approvalId !== finalApprovalRef) {
        throw new Error(
          `审批 artifact approvalId="${artifact.approvalId}" 与 approvalRef="${finalApprovalRef}" 不匹配` +
            `（releaseId=${releaseId}, newStatus=${newStatus}；approvalRef 必须指向 approvalId 一致的 artifact）`,
        );
      }
      if (artifact.releaseId !== releaseId) {
        throw new Error(
          `审批 artifact releaseId="${artifact.releaseId}" 与 manifest releaseId="${releaseId}" 不匹配` +
            `（newStatus=${newStatus}；审批 artifact 不得跨 release 复用）`,
        );
      }
      if (artifact.finalVerdict !== "APPROVE_DEV") {
        throw new Error(
          `审批 artifact finalVerdict="${artifact.finalVerdict}"，必须是 APPROVE_DEV 才能晋级` +
            `（releaseId=${releaseId}, newStatus=${newStatus}；HOLD/REJECT/QUARANTINE 均不得晋级）`,
        );
      }
      if (PRODUCTION_PROMOTION.has(newStatus) && artifact.reviewTransport !== "network") {
        throw new Error(
          `production promotion requires reviewTransport="network"` +
            ` (releaseId=${releaseId}, newStatus=${newStatus}, actual=${artifact.reviewTransport ?? "missing"})`,
        );
      }
      const binding = verifyManifestBinding(artifact, manifestHash);
      if (!binding.ok) {
        throw new Error(
          `审批 artifact releaseManifestHash 与当前 manifest hash 不匹配` +
            `（releaseId=${releaseId}, newStatus=${newStatus}；manifest 被篡改或 artifact 复用到不同 manifest）` +
            (binding.error ? `：${binding.error}` : ""),
        );
      }
    }

    // 构造更新后的 manifest：只更新 status 和 approvalRef（其他字段保持不变）
    const updated: EvolutionReleaseManifest = {
      ...existing,
      status: newStatus,
      approvalRef: finalApprovalRef,
    };

    // 原子写入（绕过 frozen immutability 检查；
    // 状态迁移已由 isStatusTransitionValid + 审批绑定 / 角色守护）
    const filePath = manifestPath(releasesDir, releaseId);
    mkdirSync(releaseDir(releasesDir, releaseId), { recursive: true });
    atomicWrite(filePath, JSON.stringify(updated, null, 2) + "\n");

    return updated;
  }

  return {
    writeManifest,
    loadManifest,
    listManifests,
    recordStateEvent,
    loadStateEvents,
    transitionStatus,
  };
}
