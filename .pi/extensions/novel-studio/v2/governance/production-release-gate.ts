/**
 * ProductionReleaseGate — 生产入口发行治理门禁（EVOLUTION-RELEASE-GOVERNANCE-G6）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §Phase G6 / §11
 *
 * G6 要求：
 * - novel_generate_chapter preflight 读取 active production release；
 * - manifest 与当前运行环境不一致时 hard block 或显式进入非生产开发模式；
 * - 未审批策略、prompt 和 dirty build 不得静默进入生产；
 * - trace / stageResults 写入 releaseId/environmentFingerprint/approvalRef；
 * - eval/test 模式不得修改 active pointer（eval 模式跳过 G6 门禁，由调用方决定）。
 *
 * 本模块由统一主链路入口（v2/core/unified-entry.ts）在 ContextCompiler 之前调用。
 * 失败时返回结构化 FailureEnvelope（stage=g6_release_gate, severity=preflight,
 * degradedTo=hard_block），与统一主链路其他 failureEnvelope 形状一致。
 *
 * 设计原则：
 * - dev mode（PINOVEL_DEV_MODE=1）显式 bypass：用于非生产开发/测试/eval
 * - 生产模式必须存在 active production pointer + manifest status=active_prod + fingerprint 匹配
 * - 不修改 active pointer（只读）；不调用模型；不写长期状态
 * - 默认环境指纹采集复用 environment-fingerprint.ts + 1A CLI 的默认配置（单一真相源）
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 只读 evolutionRoot 下的 pointer/manifest，不修改
 * - 默认指纹采集只读 projectRoot 下的配置/代码文件，不修改用户 WIP
 */

import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

import { createReleasePointerStore } from "./release-pointer-store.js";
import { createEvolutionReleaseRegistry } from "./evolution-release-registry.js";
import { createProxyApprovalRegistry } from "./release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "./evolution-release-schema.js";
import { verifyManifestBinding } from "./release-proxy-approval-schema.js";
import { createCanaryTraceStore } from "./canary-trace-store.js";
import {
  evaluateCanaryCompletionLink,
  evaluateCanaryPromotionGate,
  verifyCanaryResultArtifacts,
} from "./canary-promotion-gate.js";
import {
  collectDefaultEnvironmentFingerprint,
  computeConstitutionHash as computeConstitutionHashFromFingerprint,
  computeFingerprintHash,
  DEFAULT_RELEASE_FINGERPRINT_SPEC,
  diffBehavioralFingerprintFields,
  explainFingerprintMismatch,
  extractBehavioralFingerprintFields,
  formatCurrentFingerprintSummary,
  loadPersistedEnvironmentFingerprint,
} from "./environment-fingerprint.js";
import {
  validateBundleIdConsistency,
  compareManifestComponentHashes,
  BEHAVIOR_COMPONENT_FIELDS,
} from "./behavior-bundle.js";
import { captureDefaultBehaviorSnapshot } from "./behavior-snapshot.js";
import type { EvolutionReleaseManifest } from "./evolution-release-types.js";

// ============================================================================
// 类型
// ============================================================================

export interface ReleaseGateInput {
  /** 项目根目录（用于默认指纹采集与 evolutionRoot 相对路径解析） */
  projectRoot: string;
  /**
   * 治理数据根目录（含 releases/ + active-production.json）。
   * 未提供时按以下顺序解析：
   *   1. process.env.PINOVEL_EVOLUTION_ROOT（绝对路径或相对 projectRoot）
   *   2. 默认 {projectRoot}/.pi/extensions/novel-studio/config/evolution-release/
   */
  evolutionRoot?: string;
  /**
   * 当前环境指纹 hash（主要用于测试注入）。
   * 未提供时调用 captureDefaultEnvironmentFingerprint(projectRoot) 现场采集。
   */
  currentFingerprintHash?: string;
  /**
   * 指纹采集根。production_like 子进程的 projectRoot 是 scratch，
   * 必须用源仓干净树采集指纹，否则无法与 active manifest 对齐。
   * 未提供时读 PINOVEL_FINGERPRINT_ROOT，再回退 projectRoot。
   */
  fingerprintRoot?: string;
  /** 兼容注入：明确的 canary workspace 路径。 */
  workspacePath?: string;
  /** workspace 根目录；默认 {projectRoot}/workspaces，用事件中的 workspaceId 定位 canary。 */
  workspacesRoot?: string;
  /**
   * 指定要校验的 release（production_like 候选验收）。
   * 设置后不读 active production pointer，也不要求 status=active_prod。
   * 真实生产入口不得传此字段。
   */
  targetReleaseId?: string;
  /**
   * 是否要求 active_prod + 真实审批。默认 true。
   * production_like 候选验收传 false：证据先于审批与指针切换。
   */
  requireActiveApproval?: boolean;
}

export interface ReleaseGateOkResult {
  ok: true;
  /** 是否处于 dev mode（PINOVEL_DEV_MODE=1 bypass） */
  devMode: boolean;
  /** active release id（dev mode 为 null） */
  releaseId: string | null;
  /** manifest 上记录的环境指纹 hash（dev mode 为 null） */
  environmentFingerprint: string | null;
  /** 代理审批 artifact 引用（dev mode 为 null） */
  approvalRef: string | null;
  /** manifest 引用（dev mode 为 null） */
  manifest: EvolutionReleaseManifest | null;
  /** R2/R3 完成态 canary run；R0/R1/dev mode 为 null。 */
  canaryEvidenceRunId: string | null;
  /**
   * DG-3 行为身份（bundleId + modelVersion + 组件 hash + evalProtocolVersion）。
   * 用于生产 trace 写入 release 行为身份。dev mode / 旧 manifest（未捕获）时为全 null。
   */
  behaviorIdentity: BehaviorIdentityTrace;
}

/**
 * DG-3 行为身份 trace（bundleId + modelVersion + 组件 hash + evalProtocolVersion）。
 * 与 behavior-bundle.ts 的组件 hash 字段一一对应；字段为 null 表示 manifest 未捕获该身份。
 */
export interface BehaviorIdentityTrace {
  bundleId: string | null;
  modelVersion: string | null;
  promptBundleHash: string | null;
  modelRoutingHash: string | null;
  toolSchemaHash: string | null;
  contextCompilerHash: string | null;
  qualityPolicyHash: string | null;
  recoveryPolicyHash: string | null;
  knowledgeSnapshotHash: string | null;
  runtimeFingerprint: string | null;
  capabilityPackageSetHash: string | null;
  evalProtocolVersion: string | null;
}

export interface ReleaseGateFailureEnvelope {
  stage: "g6_release_gate";
  severity: "preflight";
  reason: string;
  recoverable: false;
  degradedTo: "hard_block";
}

export interface ReleaseGateBlockedResult {
  ok: false;
  devMode: boolean;
  failureEnvelope: ReleaseGateFailureEnvelope;
}

export type ReleaseGateResult = ReleaseGateOkResult | ReleaseGateBlockedResult;

// ============================================================================
// 默认环境指纹配置（与 scripts/evolution-cli.mjs captureFingerprint 单一真相源）
// ============================================================================
//
// 1A CLI（scripts/evolution-cli.mjs）的 captureFingerprint() 内联了一份默认配置；
// G6 门禁在生产入口运行时也需要采集当前指纹做对比，必须使用同一份配置，
// 否则 CLI capture 的 release 与门禁验证的 hash 会因配置差异而不一致。
//
// 任何对此默认配置的修改必须同步 evolution-cli.mjs。

/**
 * 默认评测协议版本（与 scripts/evolution-cli.mjs 的 DEFAULT_EVAL_PROTOCOL_VERSION 一致）。
 * 仅当 manifest 未捕获 evalProtocolVersion 时兜底使用；manifest 已捕获时以 manifest 为准。
 */
const DEFAULT_EVAL_PROTOCOL_VERSION = "2026-08-01";

/**
 * 计算 CreativeConstitution hash。实现已收敛到 environment-fingerprint.ts。
 */
export function computeConstitutionHash(projectRoot: string): string {
  return computeConstitutionHashFromFingerprint(projectRoot);
}

/**
 * 采集当前环境默认指纹并返回 fingerprintHash。
 * 与 CLI capture / production_like 共用 collectDefaultEnvironmentFingerprint。
 */
export function captureDefaultEnvironmentFingerprint(projectRoot: string): string {
  return computeFingerprintHash(collectDefaultEnvironmentFingerprint(projectRoot));
}

// ============================================================================
// evolutionRoot 解析
// ============================================================================

const REPO_EVOLUTION_SEGMENTS = [
  ".pi",
  "extensions",
  "novel-studio",
  "config",
  "evolution-release",
] as const;

function repoLayoutEvolutionRoot(root: string): string {
  return join(root, ...REPO_EVOLUTION_SEGMENTS);
}

function extLayoutEvolutionRoot(root: string): string {
  return join(root, "config", "evolution-release");
}

function evolutionRootLooksPresent(dir: string): boolean {
  return existsSync(join(dir, "active-production.json")) || existsSync(dir);
}

/**
 * 解析生产治理根（active-production.json 所在目录）。
 *
 * projectRoot 可能是仓库根或扩展根：
 *   - 仓库根：{repo}/.pi/extensions/novel-studio/config/evolution-release
 *   - 扩展根：{ext}/config/evolution-release
 * 不得在扩展根上再套一层 `.pi/extensions/novel-studio`。
 */
export function resolveProductionEvolutionRoot(
  projectRoot: string,
  evolutionRoot?: string,
): string {
  if (evolutionRoot) {
    return isAbsolute(evolutionRoot)
      ? evolutionRoot
      : resolve(projectRoot, evolutionRoot);
  }
  const env = process.env.PINOVEL_EVOLUTION_ROOT;
  if (env) {
    return isAbsolute(env) ? env : resolve(projectRoot, env);
  }

  const start = resolve(projectRoot);
  const repoAtStart = repoLayoutEvolutionRoot(start);
  const extAtStart = extLayoutEvolutionRoot(start);
  if (evolutionRootLooksPresent(repoAtStart)) return repoAtStart;
  if (evolutionRootLooksPresent(extAtStart)) return extAtStart;

  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const repo = repoLayoutEvolutionRoot(dir);
    const ext = extLayoutEvolutionRoot(dir);
    if (existsSync(join(repo, "active-production.json"))) return repo;
    if (existsSync(join(ext, "active-production.json"))) return ext;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return repoAtStart;
}

function resolveEvolutionRoot(input: ReleaseGateInput): string {
  return resolveProductionEvolutionRoot(input.projectRoot, input.evolutionRoot);
}

function resolveFingerprintRoot(input: ReleaseGateInput): string {
  if (input.fingerprintRoot && input.fingerprintRoot.trim().length > 0) {
    return isAbsolute(input.fingerprintRoot)
      ? input.fingerprintRoot
      : resolve(input.projectRoot, input.fingerprintRoot);
  }
  const env = process.env.PINOVEL_FINGERPRINT_ROOT;
  if (env && env.trim().length > 0) {
    return isAbsolute(env) ? env : resolve(input.projectRoot, env);
  }
  return input.projectRoot;
}

// ============================================================================
// 行为身份 trace 提取（DG-3）
// ============================================================================

const BEHAVIOR_IDENTITY_TRACE_FIELDS = [
  "bundleId",
  "modelVersion",
  "promptBundleHash",
  "modelRoutingHash",
  "toolSchemaHash",
  "contextCompilerHash",
  "qualityPolicyHash",
  "recoveryPolicyHash",
  "knowledgeSnapshotHash",
  "runtimeFingerprint",
  "capabilityPackageSetHash",
  "evalProtocolVersion",
] as const;

/**
 * 从 manifest 提取行为身份 trace。字段缺失/为空 → null（旧 v1 manifest 未捕获）。
 * 不校验一致性（校验在 evaluateProductionReleaseGate 内进行）。
 */
function extractBehaviorIdentityTrace(
  manifest: EvolutionReleaseManifest,
): BehaviorIdentityTrace {
  const obj = manifest as unknown as Record<string, unknown>;
  const trace: Record<string, string | null> = {};
  for (const field of BEHAVIOR_IDENTITY_TRACE_FIELDS) {
    const value = obj[field];
    trace[field] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return trace as unknown as BehaviorIdentityTrace;
}

/** dev mode / 无 manifest 时的空行为身份 trace。 */
function nullBehaviorIdentityTrace(): BehaviorIdentityTrace {
  const trace: Record<string, string | null> = {};
  for (const field of BEHAVIOR_IDENTITY_TRACE_FIELDS) {
    trace[field] = null;
  }
  return trace as unknown as BehaviorIdentityTrace;
}

// ============================================================================
// evaluateProductionReleaseGate
// ============================================================================

/**
 * 生产入口发行治理门禁。
 *
 * 决策顺序：
 *   1. PINOVEL_DEV_MODE=1 → bypass（ok, devMode=true, 全部字段 null）
 *   2. 若 targetReleaseId 已设：加载该 manifest，跳过 pointer/active_prod；
 *      requireActiveApproval!==false 时仍校验审批。否则读 active production pointer。
 *   3. 加载 manifest；不存在 → blocked
 *   4. 非候选模式且 status !== "active_prod" → blocked（未审批 release 不得生产运行）
 *   5. approvalRef 为空 → blocked（P0 第一层：active_prod 必须绑定非空 approvalRef）
 *   5b. 加载并验证 approvalRef 对应的真实审批 artifact → blocked（P0 第二层：
 *       artifact 不存在 / approvalId 不匹配 / releaseId 不匹配 / finalVerdict≠APPROVE_DEV /
 *       releaseManifestHash 不匹配；防伪造 approvalRef 字符串绕过）
 *   6. 对比 fingerprint；不匹配 → blocked
 *   7. 全部通过 → ok + 携带 releaseId/environmentFingerprint/approvalRef
 *
 * 不修改任何文件；不调用模型；不写长期状态。
 */
export function evaluateProductionReleaseGate(
  input: ReleaseGateInput,
): ReleaseGateResult {
  // 1. dev mode bypass
  if (process.env.PINOVEL_DEV_MODE === "1") {
    return {
      ok: true,
      devMode: true,
      releaseId: null,
      environmentFingerprint: null,
      approvalRef: null,
      manifest: null,
      canaryEvidenceRunId: null,
      behaviorIdentity: nullBehaviorIdentityTrace(),
    };
  }

  const evolutionRoot = resolveEvolutionRoot(input);
  const store = createReleasePointerStore({ configDir: evolutionRoot });
  const registry = createEvolutionReleaseRegistry({
    releasesDir: join(evolutionRoot, "releases"),
  });

  const targetReleaseId = input.targetReleaseId?.trim() || "";
  const candidateEval = targetReleaseId.length > 0;
  const requireActiveApproval = candidateEval
    ? input.requireActiveApproval === true
    : input.requireActiveApproval !== false;

  // 2-3. 候选验收加载指定 release；否则读 active production pointer。
  let manifest: EvolutionReleaseManifest;
  if (candidateEval) {
    const loaded = registry.loadManifest(targetReleaseId);
    if (loaded === null) {
      return releaseGateBlocked(
        `target release "${targetReleaseId}" manifest 不存在` +
          `（production_like 候选必须先 capture；不得回退到 active_prod）`,
      );
    }
    manifest = loaded;
  } else {
    const pointer = store.readActive("production");
    if (pointer === null) {
      return {
        ok: false,
        devMode: false,
        failureEnvelope: {
          stage: "g6_release_gate",
          severity: "preflight",
          reason:
            "no active production release set；生产运行需先由 user 角色切换 active production pointer 到 status=active_prod 的 release，或设置 PINOVEL_DEV_MODE=1 进入非生产开发模式",
          recoverable: false,
          degradedTo: "hard_block",
        },
      };
    }
    const loaded = registry.loadManifest(pointer.releaseId);
    if (loaded === null) {
      return {
        ok: false,
        devMode: false,
        failureEnvelope: {
          stage: "g6_release_gate",
          severity: "preflight",
          reason:
            `active production pointer 指向的 release "${pointer.releaseId}" manifest 不存在` +
            `（pointer 引用了未注册的 releaseId；需先 capture 该 release 或切换 pointer 到已注册 release）`,
          recoverable: false,
          degradedTo: "hard_block",
        },
      };
    }
    manifest = loaded;
  }

  // 4. 真实生产必须是 active_prod。候选验收允许 draft/verified/…，证据先于指针切换。
  if (!candidateEval && manifest.status !== "active_prod") {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${manifest.releaseId}" status="${manifest.status}"，必须是 active_prod 才能生产运行` +
          `（未审批/未晋级的 release 不得进入生产；需通过代理审批 + 用户授权完成晋级流程）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }

  // 5. P0 审批绑定守护（第一层）：active_prod 必须绑定非空 approvalRef。
  // 未审批 release 不得生产运行（计划 §4 / §11）。approvalRef=null/"" 视同未审批，
  // 阻断未审批 release 经 transitionStatus 缺陷或外部写入进入生产门禁。
  if (
    requireActiveApproval &&
    (manifest.approvalRef === null || manifest.approvalRef.length === 0)
  ) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${manifest.releaseId}" status=active_prod 但 approvalRef 为空` +
          `（未审批 release 不得生产运行；需通过 gpt5.6-sol 代理审批 + 用户授权完成晋级流程后绑定 approvalRef）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }

  // 5b. P0 审批 artifact 真实性守护（第二层）。候选验收（requireActiveApproval=false）跳过。
  if (requireActiveApproval) {
  const approvalRef = manifest.approvalRef ?? "";
  const approvalsDir = join(evolutionRoot, "releases", manifest.releaseId, "approvals");
  const approvalRegistry = createProxyApprovalRegistry({ approvalsDir });
  const approvalArtifact = approvalRegistry.loadArtifact(approvalRef);
  if (approvalArtifact === null) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${manifest.releaseId}" approvalRef="${manifest.approvalRef}" 对应的审批 artifact 不存在` +
          `（approvalRef 不得为伪造字符串；需通过 gpt5.6-sol 代理审批生成真实 artifact 并绑定）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }
  // approvalId 必须等于 approvalRef（防止字符串拼接伪造）
  if (approvalArtifact.approvalId !== manifest.approvalRef) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `审批 artifact approvalId="${approvalArtifact.approvalId}" 与 manifest approvalRef="${manifest.approvalRef}" 不匹配` +
          `（approvalRef 必须指向 approvalId 一致的 artifact）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }
  // releaseId 必须匹配（防跨 release 复用审批）
  if (approvalArtifact.releaseId !== manifest.releaseId) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `审批 artifact releaseId="${approvalArtifact.releaseId}" 与 manifest releaseId="${manifest.releaseId}" 不匹配` +
          `（审批 artifact 不得跨 release 复用）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }
  // finalVerdict 必须为 APPROVE_DEV（HOLD/REJECT/QUARANTINE 不得晋级生产）
  if (approvalArtifact.finalVerdict !== "APPROVE_DEV") {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `审批 artifact finalVerdict="${approvalArtifact.finalVerdict}"，必须是 APPROVE_DEV 才能进入生产` +
          `（HOLD/REJECT/QUARANTINE 均不得晋级生产）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }
  // releaseManifestHash 双向绑定（防 manifest 篡改或 artifact 复用到不同 manifest）。
  // 使用 computeReleasePayloadHash（排除 status/approvalRef/activatedAt 生命周期字段），
  // 保证 artifact 在 evaluated 状态生成后，迁移到 active_prod 状态仍能通过绑定验证
  // （P0 生命周期 hash 绑定修复：合法审批链不应被 hash 失配错误阻断）。
  if (approvalArtifact.reviewTransport !== "network") {
    return releaseGateBlocked(
      `production requires approval reviewTransport="network"; actual=${approvalArtifact.reviewTransport ?? "missing"}`,
    );
  }
  const manifestHash = computeReleasePayloadHash(manifest);
  const binding = verifyManifestBinding(approvalArtifact, manifestHash);
  if (!binding.ok) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `审批 artifact releaseManifestHash 与当前 manifest hash 不匹配` +
          `（artifact=${approvalArtifact.releaseManifestHash.slice(0, 16)}…, manifest=${manifestHash.slice(0, 16)}…）` +
          `（manifest 被篡改或 artifact 复用到不同 manifest；需重新审批）` +
          (binding.error ? `：${binding.error}` : ""),
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }
  }

  // 6. 指纹对比
  const fingerprintRoot = resolveFingerprintRoot(input);
  const currentFp = collectDefaultEnvironmentFingerprint(fingerprintRoot);
  const currentHash = input.currentFingerprintHash ?? computeFingerprintHash(currentFp);
  if (manifest.environmentFingerprint !== currentHash) {
    const persisted = loadPersistedEnvironmentFingerprint(
      join(evolutionRoot, "releases", manifest.releaseId),
    );
    const diffs = persisted
      ? diffBehavioralFingerprintFields(persisted, extractBehavioralFingerprintFields(currentFp))
      : [];
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          explainFingerprintMismatch(
            manifest.environmentFingerprint,
            currentHash,
            diffs,
            formatCurrentFingerprintSummary(currentFp),
          ) +
          "（需在同一干净提交与同一环境下重新 capture，不得只比较短哈希）",
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }

  // 6b. DG-3 行为身份组件 hash 校验（计划 §5 DG-3 fail-closed）。
  // 对已捕获完整行为身份（bundleId 非空）的 manifest：
  //   (a) 校验 bundleId 与组件 hash 内部一致（hash 漂移 → hard block）
  //   (b) 校验组件 hash 与当前运行环境快照一致（行为资产变化未重新 capture → hard block）
  // 旧 manifest（无 bundleId）跳过组件校验；DG-6 迁移后强制完整身份。
  const behaviorIdentity = extractBehaviorIdentityTrace(manifest);
  if (manifest.status === "active_prod" && behaviorIdentity.bundleId === null) {
    return releaseGateBlocked(
      "active_prod 缺少完整行为身份（bundleId / capabilityPackageSetHash）；旧 manifest 不得作为默认生产输入",
    );
  }
  if (behaviorIdentity.bundleId !== null) {
    const otherComponentsComplete = BEHAVIOR_COMPONENT_FIELDS.every((field) => {
      const value = (manifest as unknown as Record<string, unknown>)[field];
      return typeof value === "string" && value.length > 0;
    });
    if (otherComponentsComplete && !behaviorIdentity.capabilityPackageSetHash) {
      return releaseGateBlocked(
        "capabilityPackageSetHash missing：生产 release 必须显式冻结 CapabilityPackageSet（CPG-1.5）",
      );
    }
    const consistency = validateBundleIdConsistency(manifest);
    if (!consistency.ok) {
      return releaseGateBlocked(
        `behavior bundleId 不一致（hash 漂移）：recorded=${(consistency.recorded ?? "").slice(0, 16)}…, recomputed=${(consistency.recomputed ?? "N/A").slice(0, 16)}…` +
          `（manifest 的 bundleId 不是由当前组件 hash 派生；需重新 capture 并完成审批晋级）`,
      );
    }
    const snapshot = captureDefaultBehaviorSnapshot(
      fingerprintRoot,
      behaviorIdentity.modelVersion ?? DEFAULT_RELEASE_FINGERPRINT_SPEC.generationModel,
      behaviorIdentity.evalProtocolVersion ?? DEFAULT_EVAL_PROTOCOL_VERSION,
    );
    const comparison = compareManifestComponentHashes(manifest, snapshot);
    if (!comparison.ok) {
      return releaseGateBlocked(
        `behavior component hash drift：${comparison.mismatchedFields.join(", ")}` +
          `（行为资产变化但 manifest 未重新 capture；需重新 capture release 并完成审批晋级）`,
      );
    }
  }

  let canaryEvidenceRunId: string | null = null;
  if (manifest.changeClass === "R2" || manifest.changeClass === "R3") {
    let events;
    try {
      events = registry.loadStateEvents(manifest.releaseId);
    } catch (error) {
      return releaseGateBlocked(`canary 晋级事件读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let evidenceRef: string | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.toStatus !== "active_prod" || event.actor !== "user") continue;
      const match = event.evidenceRefs?.find((ref) => ref.startsWith("canary:"));
      if (match) {
        evidenceRef = match;
        break;
      }
    }
    const evidenceMatch = evidenceRef?.match(/^canary:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (!evidenceMatch) {
      return releaseGateBlocked(
        `release "${manifest.releaseId}" 缺少合法的 active_prod canary 晋级证据事件`,
      );
    }
    const evidenceWorkspaceId = evidenceMatch[1];
    let canaryWorkspacePath: string;
    if (input.workspacesRoot) {
      const workspaceRoot = isAbsolute(input.workspacesRoot)
        ? input.workspacesRoot
        : resolve(input.projectRoot, input.workspacesRoot);
      canaryWorkspacePath = join(workspaceRoot, evidenceWorkspaceId);
    } else if (input.workspacePath) {
      canaryWorkspacePath = resolve(input.workspacePath);
      if (basename(canaryWorkspacePath) !== evidenceWorkspaceId) {
        return releaseGateBlocked(
          `canary 证据 workspaceId=${evidenceWorkspaceId} 与注入 workspacePath 不匹配`,
        );
      }
    } else {
      canaryWorkspacePath = join(input.projectRoot, "workspaces", evidenceWorkspaceId);
    }
    const traceStore = createCanaryTraceStore({
      canaryRunsDir: join(canaryWorkspacePath, "canary-runs"),
    });
    let completionTrace;
    let sourceTrace;
    try {
      completionTrace = traceStore.readCanaryTrace(evidenceMatch[2]);
      sourceTrace = completionTrace?.evidence.sourceRunId
        ? traceStore.readCanaryTrace(completionTrace.evidence.sourceRunId)
        : null;
    } catch (error) {
      return releaseGateBlocked(`canary trace 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const promotionGate = evaluateCanaryPromotionGate({
      releaseId: manifest.releaseId,
      changeClass: manifest.changeClass,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef ?? "",
      workspaceId: evidenceWorkspaceId,
      trace: completionTrace,
    });
    if (!promotionGate.ok) {
      return releaseGateBlocked(`${promotionGate.code}: ${promotionGate.reason}`);
    }
    const completionLink = evaluateCanaryCompletionLink(sourceTrace, completionTrace!);
    if (!completionLink.ok) {
      return releaseGateBlocked(`${completionLink.code}: ${completionLink.reason}`);
    }
    const artifactVerification = verifyCanaryResultArtifacts(
      canaryWorkspacePath,
      completionTrace!,
      {
        releaseId: manifest.releaseId,
        environmentFingerprint: manifest.environmentFingerprint,
        approvalRef: manifest.approvalRef ?? "",
      },
    );
    if (!artifactVerification.ok) {
      return releaseGateBlocked(
        `${artifactVerification.code}: ${artifactVerification.reason}`,
      );
    }
    canaryEvidenceRunId = promotionGate.evidenceRunId;
  }

  // 7. 全部通过
  return {
    ok: true,
    devMode: false,
    releaseId: manifest.releaseId,
    environmentFingerprint: manifest.environmentFingerprint,
    approvalRef: manifest.approvalRef,
    manifest,
    canaryEvidenceRunId,
    behaviorIdentity,
  };
}

function releaseGateBlocked(reason: string): ReleaseGateBlockedResult {
  return {
    ok: false,
    devMode: false,
    failureEnvelope: {
      stage: "g6_release_gate",
      severity: "preflight",
      reason,
      recoverable: false,
      degradedTo: "hard_block",
    },
  };
}
