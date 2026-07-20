/**
 * ProxyApprovalCaller — stub caller + 审批编排（EVOLUTION-RELEASE-GOVERNANCE-1B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * 1B 阶段使用 stub caller（不调用真实 gpt5.6-sol）；真实模型调用为 REQUIRES_AUTH。
 *
 * 提供：
 * - createStubProxyApprovalCaller：stub caller（4 verdict 路径 + 预算守护 + 正反顺序归一化）
 * - executeProxyApproval：完整编排（build packet → caller.call → construct artifact →
 *   schema 校验 → registry 写入 → manifest 绑定 → R3 自审批阻断 → reviewer shopping 检测）
 *
 * 设计原则：
 * - stub caller identity="stub"，零网络调用（不调用真实 gpt5.6-sol）
 * - reviewerType 永远 "validated_human_proxy"，reviewerModel 永远 "gpt5.6-sol"
 * - forward+reverse=2 calls；budget.maxCalls < 2 拒绝
 * - R3 治理根变更代理不得自审批；canPromote=false，blockReason 提示用户审批
 * - 非 APPROVE_DEV 一律 canPromote=false
 * - 审批后检测 reviewer shopping（同 releaseId 多 reviewer 版本 / 多 verdict 冲突）
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - stub caller 不调用模型、不联网
 * - 真实 gpt5.6-sol 调用需单独提交预算与授权卡（1B 阶段不实现）
 */

import { createHash, randomUUID } from "node:crypto";
import {
  buildAnonymousApprovalPacket,
  computePacketHash,
} from "./approval-packet-builder.js";
import {
  normalizeVerdict,
  isR3SelfApproval,
  detectReviewerShopping,
} from "./release-proxy-approval-schema.js";
import type {
  ProxyApprovalVerdict,
  RawVerdict,
  ReleaseProxyApprovalArtifact,
  ApprovalPacketInput,
  AnonymousApprovalPacket,
} from "./release-proxy-approval-types.js";
import type { ProxyApprovalRegistry } from "./release-proxy-approval-registry.js";
import {
  callOpenAIChatCompletions,
  validateJudgeEndpoint,
} from "./chapter-proxy-approval-caller.js";
import { localizeLlmMessages, localizeLlmText } from "../../utils/llm-language-guard.js";

// ============================================================================
// 类型
// ============================================================================

/** caller 调用选项 */
export interface ProxyCallerCallOptions {
  promptHash: string;
  modelVersion: string;
  budget: { maxCalls: number; timeoutMs: number };
}

/** caller 调用返回的原始 verdict 数据（未构成完整 artifact） */
export interface ProxyCallerResult {
  forwardVerdict: ProxyApprovalVerdict;
  reverseVerdict: ProxyApprovalVerdict;
  finalVerdict: ProxyApprovalVerdict;
  reviewerType: "validated_human_proxy";
  reviewerModel: "gpt5.6-sol";
  reviewerModelVersion: string;
  promptHash: string;
  budgetUsed: { calls: number; timeoutMs: number };
  rationale: string;
  winningSpans: string[];
  losingSpans: string[];
  risks: string[];
}

/** caller 接口（stub 与真实 caller 共用） */
export interface ProxyApprovalCaller {
  identity: "stub" | "gpt5.6-sol";
  call(
    packet: AnonymousApprovalPacket,
    opts: ProxyCallerCallOptions,
  ): Promise<ProxyCallerResult>;
}

/** stub caller 构造选项 */
export interface StubProxyApprovalCallerOptions {
  forwardVerdict: RawVerdict;
  reverseVerdict: RawVerdict;
  /** QUARANTINE 原因；写入 rationale 与 risks */
  quarantineReason?: string;
  /** 默认 modelVersion；被 opts.modelVersion 覆盖 */
  modelVersion?: string;
}

const REAL_PROXY_APPROVAL_SYSTEM_PROMPT = `你是独立的生产发布复核员。
比较匿名的甲乙证据包，不得推断实现身份。用户消息会说明哪个匿名标签是待审发布候选。
只输出结构化数据，字段为：结论、理由、胜出片段、落败片段、风险。
只有当候选整体明确胜出，且不存在事实、状态一致性、来源或协议否决时，结论才可为“批准开发”。
当前基线明显更好时用“拒绝”；证据不足、冲突、平局或顺序敏感时用“暂缓”；
存在污染、身份泄漏或协议违规时用“隔离”。片段数组只能包含证据包中已有的片段编号。`;

export const REAL_PROXY_APPROVAL_PROMPT_HASH =
  "sha256:" + createHash("sha256").update(REAL_PROXY_APPROVAL_SYSTEM_PROMPT, "utf-8").digest("hex");

interface RealProxyVerdictOutput {
  verdict: ProxyApprovalVerdict;
  rationale: string;
  winningSpans: string[];
  losingSpans: string[];
  risks: string[];
}

function parseRealProxyVerdictOutput(text: string): RealProxyVerdictOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`gpt5.6-sol release proxy output is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("gpt5.6-sol release proxy output must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const verdictValue = obj.verdict ?? obj["结论"];
  if (typeof verdictValue !== "string") {
    throw new Error("gpt5.6-sol release proxy output is missing verdict");
  }
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const localizedVerdicts: Record<string, RawVerdict> = {
    批准开发: "APPROVE_DEV",
    拒绝: "REJECT",
    暂缓: "HOLD",
    隔离: "QUARANTINE",
  };
  const rationaleValue = obj.rationale ?? obj["理由"];
  return {
    verdict: normalizeVerdict(localizedVerdicts[verdictValue] ?? verdictValue as RawVerdict),
    rationale: typeof rationaleValue === "string" ? rationaleValue : "",
    winningSpans: stringArray(obj.winningSpans ?? obj["胜出片段"]),
    losingSpans: stringArray(obj.losingSpans ?? obj["落败片段"]),
    risks: stringArray(obj.risks ?? obj["风险"]),
  };
}

/** Create the release-level real reviewer from trusted NOVELOS_JUDGE_* environment config. */
export function createRealGpt56SolReleaseProxyApprovalCallerFromEnv(): ProxyApprovalCaller {
  const apiKey = process.env.NOVELOS_JUDGE_API_KEY;
  const apiBaseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const modelId = process.env.NOVELOS_JUDGE_MODEL;
  if (!apiKey || !apiBaseUrl || !modelId) {
    throw new Error(
      "API configuration missing: real release proxy review requires " +
        "NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL",
    );
  }
  validateJudgeEndpoint(apiBaseUrl);

  return {
    identity: "gpt5.6-sol",
    async call(packet, opts): Promise<ProxyCallerResult> {
      const requiredCalls = 2;
      if (opts.budget.maxCalls < requiredCalls) {
        throw new Error(
          `release proxy budget insufficient: forward/reverse requires ${requiredCalls} calls, ` +
            `budget.maxCalls=${opts.budget.maxCalls}`,
        );
      }

      const review = async (
        candidateLabel: "A" | "B",
        comparison: AnonymousApprovalPacket["forward"],
      ): Promise<{ output: RealProxyVerdictOutput; model: string }> => {
        const response = await callOpenAIChatCompletions(localizeLlmMessages([
          { role: "system", content: REAL_PROXY_APPROVAL_SYSTEM_PROMPT },
          {
            role: "user",
            content: localizeLlmText(JSON.stringify({
              待审候选标签: candidateLabel === "A" ? "甲" : "乙",
              匿名比较: {
                甲方正文: comparison.textA,
                乙方正文: comparison.textB,
                证据片段: comparison.spans.map((span) => ({
                  片段编号: span.id,
                  原文: span.text,
                  所属候选: span.side === "A" ? "甲" : "乙",
                })),
              },
              原始基线: packet.rawBaseline.text,
              固定样例: packet.fixedCase,
              固定模型: packet.fixedModel,
              固定随机种子: packet.fixedSeed,
              事实守卫: packet.factGuard,
              状态一致性: packet.stateConsistency,
              成本概况: packet.costProfile,
            })),
          },
        ]), {
          timeoutMs: opts.budget.timeoutMs,
          responseFormat: "json_object",
        });
        return { output: parseRealProxyVerdictOutput(response.text), model: response.model };
      };

      const forward = await review("A", packet.forward);
      const reverse = await review("B", packet.reverse);
      const orderConsistent = forward.output.verdict === reverse.output.verdict;
      const modelConsistent = forward.model === reverse.model;
      const finalVerdict: ProxyApprovalVerdict =
        orderConsistent && modelConsistent ? forward.output.verdict : "HOLD";
      const risks = [...forward.output.risks, ...reverse.output.risks];
      if (!orderConsistent) risks.push("forward_reverse_verdict_conflict");
      if (!modelConsistent) risks.push("forward_reverse_model_version_mismatch");

      return {
        forwardVerdict: forward.output.verdict,
        reverseVerdict: reverse.output.verdict,
        finalVerdict,
        reviewerType: "validated_human_proxy",
        reviewerModel: "gpt5.6-sol",
        reviewerModelVersion: modelConsistent
          ? forward.model
          : `${forward.model}|${reverse.model}`,
        promptHash: opts.promptHash,
        budgetUsed: { calls: requiredCalls, timeoutMs: opts.budget.timeoutMs },
        rationale: orderConsistent && modelConsistent
          ? `forward=${forward.output.rationale}; reverse=${reverse.output.rationale}`
          : "HOLD: forward/reverse review was not consistent",
        winningSpans: [...forward.output.winningSpans, ...reverse.output.winningSpans],
        losingSpans: [...forward.output.losingSpans, ...reverse.output.losingSpans],
        risks,
      };
    },
  };
}

/** executeProxyApproval 选项 */
export interface ExecuteProxyApprovalOptions {
  packetInput: ApprovalPacketInput;
  caller: ProxyApprovalCaller;
  registry: ProxyApprovalRegistry;
  promptHash: string;
  modelVersion: string;
  budget: { maxCalls: number; timeoutMs: number };
}

/** executeProxyApproval 返回 */
export interface ExecuteProxyApprovalResult {
  finalVerdict: ProxyApprovalVerdict;
  canPromote: boolean;
  artifact: ReleaseProxyApprovalArtifact;
  blockReason?: string;
  reviewerShoppingDetected?: boolean;
}

// ============================================================================
// createStubProxyApprovalCaller
// ============================================================================

/**
 * 创建 stub 代理审批 caller。
 * - identity="stub"，零网络调用
 * - forward+reverse=2 calls；budget.maxCalls < 2 抛错
 * - slight/uncertain 等非正式 verdict 经 normalizeVerdict 映射为 HOLD
 * - forward≠reverse → HOLD
 * - QUARANTINE 路径把 quarantineReason 写入 rationale 与 risks
 */
export function createStubProxyApprovalCaller(
  options: StubProxyApprovalCallerOptions,
): ProxyApprovalCaller {
  const { forwardVerdict, reverseVerdict, quarantineReason, modelVersion } = options;

  return {
    identity: "stub",
    async call(
      packet: AnonymousApprovalPacket,
      opts: ProxyCallerCallOptions,
    ): Promise<ProxyCallerResult> {
      // 预算守护：forward + reverse = 2 calls
      const requiredCalls = 2;
      if (opts.budget.maxCalls < requiredCalls) {
        throw new Error(
          `预算不足：forward+reverse 需要 ${requiredCalls} 次调用，但 budget.maxCalls=${opts.budget.maxCalls}`,
        );
      }

      // 归一化 verdict
      const normForward = normalizeVerdict(forwardVerdict);
      const normReverse = normalizeVerdict(reverseVerdict);
      const finalVerdict = normalizeVerdict(forwardVerdict, reverseVerdict);

      // reviewerModelVersion：opts 优先，fallback 到 caller 默认
      const reviewerModelVersion = opts.modelVersion || modelVersion || "";

      // rationale
      let rationale: string;
      let risks: string[];
      if (finalVerdict === "QUARANTINE" && quarantineReason) {
        rationale = `QUARANTINE: ${quarantineReason}`;
        risks = [quarantineReason];
      } else if (finalVerdict === "HOLD") {
        rationale = `HOLD: forward/reverse 不一致或 verdict 不明确（forward=${normForward}, reverse=${normReverse}）`;
        risks = [];
      } else {
        rationale = `stub ${finalVerdict}: forward=${normForward}, reverse=${normReverse}`;
        risks = [];
      }

      return {
        forwardVerdict: normForward,
        reverseVerdict: normReverse,
        finalVerdict,
        reviewerType: "validated_human_proxy",
        reviewerModel: "gpt5.6-sol",
        reviewerModelVersion,
        promptHash: opts.promptHash,
        budgetUsed: { calls: requiredCalls, timeoutMs: opts.budget.timeoutMs },
        rationale,
        winningSpans: [],
        losingSpans: [],
        risks,
      };
    },
  };
}

// ============================================================================
// executeProxyApproval
// ============================================================================

/**
 * 执行代理审批完整编排：
 * 1. 构建匿名审批包
 * 2. caller.call(packet, opts) 获取 verdict
 * 3. 构造完整 artifact（含 approvalId / releaseId / manifestHash / decidedAt）
 * 4. R3 自审批阻断：changeClass=R3 → canPromote=false，blockReason 提示用户审批
 * 5. 非 APPROVE_DEV → canPromote=false
 * 6. 写入 registry（append-only）
 * 7. 检测 reviewer shopping
 *
 * R3 治理根变更代理不得自审批；即使用户配置 changeClass=R3 且 proxy 返回 APPROVE_DEV，
 * canPromote 仍为 false，必须由用户审批。
 */
export async function executeProxyApproval(
  options: ExecuteProxyApprovalOptions,
): Promise<ExecuteProxyApprovalResult> {
  const { packetInput, caller, registry, promptHash, modelVersion, budget } = options;

  // 1. 构建匿名审批包
  const packet = buildAnonymousApprovalPacket(packetInput);
  const inputArtifactHash = computePacketHash(packet);

  // 2. caller.call
  const callerResult = await caller.call(packet, { promptHash, modelVersion, budget });

  // 3. 构造完整 artifact
  const approvalId = `approval-${packetInput.releaseId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const artifact: ReleaseProxyApprovalArtifact = {
    schemaId: "pinovel.release-proxy-approval" as const,
    schemaVersion: 1 as const,
    approvalId,
    releaseId: packetInput.releaseId,
    releaseManifestHash: packetInput.releaseManifestHash,
    reviewerType: callerResult.reviewerType,
    reviewerModel: callerResult.reviewerModel,
    reviewerModelVersion: callerResult.reviewerModelVersion,
    reviewTransport: caller.identity === "gpt5.6-sol" ? "network" : "stub",
    promptHash: callerResult.promptHash,
    inputArtifactHash,
    forwardVerdict: callerResult.forwardVerdict,
    reverseVerdict: callerResult.reverseVerdict,
    finalVerdict: callerResult.finalVerdict,
    winningSpans: callerResult.winningSpans,
    losingSpans: callerResult.losingSpans,
    risks: callerResult.risks,
    rationale: callerResult.rationale,
    decidedAt: new Date().toISOString(),
    budgetUsed: callerResult.budgetUsed,
    changeClass: packetInput.changeClass,
    // proxy 永远不声称自审批权限；R3 由 canPromote=false + blockReason 阻断
    r3SelfApproval: false,
  };

  // 4. R3 自审批阻断
  const r3SelfApproval = isR3SelfApproval({
    changeClass: packetInput.changeClass,
    r3SelfApproval: false, // proxy 不声称自审批，但 R3 仍需用户审批
  });
  // R3 变更即使用户未标记 r3SelfApproval，代理审批也不能晋级
  if (packetInput.changeClass === "R3") {
    // 写入 artifact 作为代理 verdict 证据，但不可晋级
    registry.writeArtifact(artifact);
    return {
      finalVerdict: artifact.finalVerdict,
      canPromote: false,
      artifact,
      blockReason: "R3 治理根变更必须由用户审批，gpt5.6-sol 代理不得自审批",
    };
  }

  // 5. 写入 registry（非 R3）
  registry.writeArtifact(artifact);

  // 6. reviewer shopping 检测（必须在 canPromote 判定之前）
  //    P0-1 修复：检测到 reviewer shopping 时一律阻断晋级，即使 verdict=APPROVE_DEV 也不可晋级
  //    计划 §6.4 veto：评审身份泄露、reviewer shopping、事后换阈值不得晋级
  const allApprovals = registry.listByReleaseId(packetInput.releaseId);
  const shoppingResult = detectReviewerShopping(allApprovals);

  // 7. canPromote：只有 APPROVE_DEV 且无 reviewer shopping 可晋级
  const verdictApproved = artifact.finalVerdict === "APPROVE_DEV";
  const canPromote = verdictApproved && !shoppingResult.detected;

  let blockReason: string | undefined;
  if (shoppingResult.detected) {
    blockReason = `reviewer shopping 检测到，不可晋级：${shoppingResult.reason ?? ""}`;
  } else if (!verdictApproved) {
    blockReason = `verdict=${artifact.finalVerdict}，非 APPROVE_DEV 不可晋级`;
  }

  return {
    finalVerdict: artifact.finalVerdict,
    canPromote,
    artifact,
    blockReason,
    reviewerShoppingDetected: shoppingResult.detected,
  };
}
