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

import { basename, join, resolve, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
  collectEnvironmentFingerprint,
  computeFingerprintHash,
} from "./environment-fingerprint.js";
import {
  validateBundleIdConsistency,
  compareManifestComponentHashes,
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
  /** 兼容注入：明确的 canary workspace 路径。 */
  workspacePath?: string;
  /** workspace 根目录；默认 {projectRoot}/workspaces，用事件中的 workspaceId 定位 canary。 */
  workspacesRoot?: string;
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
   * DG-3 行为身份（bundleId + modelVersion + 8 组件 hash + evalProtocolVersion）。
   * 用于生产 trace 写入 release 行为身份。dev mode / 旧 manifest（未捕获）时为全 null。
   */
  behaviorIdentity: BehaviorIdentityTrace;
}

/**
 * DG-3 行为身份 trace（bundleId + modelVersion + 8 组件 hash + evalProtocolVersion）。
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

const DEFAULT_MODEL_ROUTING_PATH = "config/model-routing.json";

const DEFAULT_RUNTIME_FILE_PATHS = [
  ".pi/extensions/novel-studio/index.ts",
  ".pi/extensions/novel-studio/tsconfig.prod.json",
  ".pi/extensions/novel-studio/tsconfig.eval.json",
  ".pi/extensions/novel-studio/tsconfig.test.json",
];

const DEFAULT_BUILD_ARTIFACT_PATHS = [
  ".pi/extensions/novel-studio/dist/index.js",
];

/**
 * 构建产物目录：递归收集 dist/ 下所有 .js 纳入 buildArtifactHash。
 * 保证任一生产源码变化（如 v2/core/final-state-commit.ts → final-state-commit.js）
 * 都改变 environment fingerprint（与 behavior-snapshot.ts 的 runtimeFingerprint 覆盖一致）。
 * 必须与 scripts/evolution-cli.mjs captureFingerprint() 的 buildArtifactDirs 保持一致。
 */
const DEFAULT_BUILD_ARTIFACT_DIRS = [
  ".pi/extensions/novel-studio/dist",
];

const DEFAULT_ENV_SWITCH_NAMES = [
  "V2_FORCE_STUB",
  "NOVEL_TEST_TOOLS",
  "NOVEL_DEBUG_TOOLS",
  "PINOVEL_UNIFIED_PIPELINE",
  "PINOVEL_DISABLE_FALLBACK",
  // F4-4：eval 回放传输 env 属确定性测试开关；生产环境若误设，
  // 会以预录/合成结果冒充真实模型输出，release gate 必须拦截。
  "PINOVEL_EVAL_REPLAY_TRANSPORT",
  "PINOVEL_EVAL_RECORDED_RESULTS_PATH",
  "PINOVEL_EVAL_SYNTHETIC_FAULTS",
  "PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH",
];

const DEFAULT_SECRET_ENV_NAMES = [
  "GLM_API_KEY",
  "DEEPSEEK_API_KEY",
  "QWEN_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "GPT_API_KEY",
  "ARK_API_KEY",
  "ERNIE_API_KEY",
];

const DEFAULT_GENERATION_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_JUDGE_MODEL = "gpt5.6-sol";
const DEFAULT_PROXY_APPROVAL_MODEL = "gpt5.6-sol";

/**
 * 默认评测协议版本（与 scripts/evolution-cli.mjs 的 DEFAULT_EVAL_PROTOCOL_VERSION 一致）。
 * 仅当 manifest 未捕获 evalProtocolVersion 时兜底使用；manifest 已捕获时以 manifest 为准。
 */
const DEFAULT_EVAL_PROTOCOL_VERSION = "2026-08-01";

/**
 * 计算 CreativeConstitution hash（CORE-WRITING-PRINCIPLES.md + WORLDBUILDING-CANON.md）。
 * 与 evolution-cli.mjs constitutionHash() 一致。
 * CONCURRENCY-WAVE4：导出供 commit-stale-guard 在提交边界做 constitution_changed 检测。
 */
export function computeConstitutionHash(projectRoot: string): string {
  const extRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
  const candidates = [
    join(extRoot, "CORE-WRITING-PRINCIPLES.md"),
    join(extRoot, "WORLDBUILDING-CANON.md"),
  ];
  const hashes: string[] = [];
  for (const p of candidates) {
    if (existsSync(p)) {
      hashes.push(createHash("sha256").update(readFileSync(p, "utf-8"), "utf-8").digest("hex"));
    }
  }
  return hashes.length > 0
    ? createHash("sha256").update(hashes.join("\n"), "utf-8").digest("hex")
    : "";
}

/**
 * 采集当前环境默认指纹并返回 fingerprintHash。
 *
 * 生产入口（runUnifiedPipeline）在未注入 currentFingerprintHash 时调用此函数。
 * 配置与 evolution-cli.mjs captureFingerprint() 完全一致，保证 CLI 冻结的 release
 * 与门禁验证的 hash 可比较。
 */
export function captureDefaultEnvironmentFingerprint(projectRoot: string): string {
  const fp = collectEnvironmentFingerprint({
    projectRoot,
    modelRoutingPath: DEFAULT_MODEL_ROUTING_PATH,
    promptBundlePaths: [],
    toolSchemaPaths: [],
    runtimeFilePaths: DEFAULT_RUNTIME_FILE_PATHS,
    buildArtifactPaths: DEFAULT_BUILD_ARTIFACT_PATHS,
    buildArtifactDirs: DEFAULT_BUILD_ARTIFACT_DIRS,
    activeStrategyIds: [],
    constitutionHash: computeConstitutionHash(projectRoot),
    datasetHash: "",
    evalProtocolHash: "",
    seed: 0,
    budgetMaxCalls: 10,
    timeoutMs: Number(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? 300000),
    fallbackPolicy: "hard_block",
    generationModel: DEFAULT_GENERATION_MODEL,
    judgeModel: DEFAULT_JUDGE_MODEL,
    proxyApprovalModel: DEFAULT_PROXY_APPROVAL_MODEL,
    envSwitchNames: DEFAULT_ENV_SWITCH_NAMES,
    secretEnvNames: DEFAULT_SECRET_ENV_NAMES,
  });
  return computeFingerprintHash(fp);
}

// ============================================================================
// evolutionRoot 解析
// ============================================================================

function resolveEvolutionRoot(input: ReleaseGateInput): string {
  if (input.evolutionRoot) {
    return isAbsolute(input.evolutionRoot)
      ? input.evolutionRoot
      : resolve(input.projectRoot, input.evolutionRoot);
  }
  const env = process.env.PINOVEL_EVOLUTION_ROOT;
  if (env) {
    return isAbsolute(env) ? env : resolve(input.projectRoot, env);
  }
  // 默认：{projectRoot}/.pi/extensions/novel-studio/config/evolution-release/
  return join(
    input.projectRoot,
    ".pi",
    "extensions",
    "novel-studio",
    "config",
    "evolution-release",
  );
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
 *   2. 读 active production pointer；不存在 → blocked
 *   3. 加载 manifest；不存在 → blocked
 *   4. status !== "active_prod" → blocked（未审批 release 不得生产运行）
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

  // 2. 读 active production pointer
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

  // 3. 加载 manifest
  const manifest = registry.loadManifest(pointer.releaseId);
  if (manifest === null) {
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

  // 4. 状态必须是 active_prod
  if (manifest.status !== "active_prod") {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${pointer.releaseId}" status="${manifest.status}"，必须是 active_prod 才能生产运行` +
          `（未审批/未晋级的 release 不得进入生产；需通过代理审批 + 用户授权完成晋级流程）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }

  // 5. P0 审批绑定守护（第一层）：active_prod 必须绑定非空 approvalRef。
  // 未审批 release 不得生产运行（计划 §4 / §11）。approvalRef=null/"" 视同未审批，
  // 阻断未审批 release 经 transitionStatus 缺陷或外部写入进入生产门禁。
  if (manifest.approvalRef === null || manifest.approvalRef.length === 0) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${pointer.releaseId}" status=active_prod 但 approvalRef 为空` +
          `（未审批 release 不得生产运行；需通过 gpt5.6-sol 代理审批 + 用户授权完成晋级流程后绑定 approvalRef）`,
        recoverable: false,
        degradedTo: "hard_block",
      },
    };
  }

  // 5b. P0 审批 artifact 真实性守护（第二层）：加载并验证 approvalRef 对应的真实 artifact。
  // 仅检查非空字符串不够（用户复现 approvalRef="fake-does-not-exist" 仍通过门禁）。
  // 必须加载 {evolutionRoot}/releases/{releaseId}/approvals/{approvalRef}.json，
  // 验证 approvalId / releaseId / finalVerdict=APPROVE_DEV / releaseManifestHash 双向绑定（计划 §6.4 / §11）。
  const approvalsDir = join(evolutionRoot, "releases", manifest.releaseId, "approvals");
  const approvalRegistry = createProxyApprovalRegistry({ approvalsDir });
  const approvalArtifact = approvalRegistry.loadArtifact(manifest.approvalRef);
  if (approvalArtifact === null) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `release "${pointer.releaseId}" approvalRef="${manifest.approvalRef}" 对应的审批 artifact 不存在` +
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

  // 6. 指纹对比
  const currentHash =
    input.currentFingerprintHash ?? captureDefaultEnvironmentFingerprint(input.projectRoot);
  if (manifest.environmentFingerprint !== currentHash) {
    return {
      ok: false,
      devMode: false,
      failureEnvelope: {
        stage: "g6_release_gate",
        severity: "preflight",
        reason:
          `environment fingerprint mismatch：recorded=${manifest.environmentFingerprint.slice(0, 16)}…, current=${currentHash.slice(0, 16)}…` +
          `（代码/配置/模型路由/构建产物等行为资产发生变化；需重新 capture release 并完成审批晋级流程）`,
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
  if (behaviorIdentity.bundleId !== null) {
    const consistency = validateBundleIdConsistency(manifest);
    if (!consistency.ok) {
      return releaseGateBlocked(
        `behavior bundleId 不一致（hash 漂移）：recorded=${(consistency.recorded ?? "").slice(0, 16)}…, recomputed=${(consistency.recomputed ?? "N/A").slice(0, 16)}…` +
          `（manifest 的 bundleId 不是由当前组件 hash 派生；需重新 capture 并完成审批晋级）`,
      );
    }
    const snapshot = captureDefaultBehaviorSnapshot(
      input.projectRoot,
      behaviorIdentity.modelVersion ?? DEFAULT_GENERATION_MODEL,
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
      approvalRef: manifest.approvalRef,
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
        approvalRef: manifest.approvalRef,
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
