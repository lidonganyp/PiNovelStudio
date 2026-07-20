/**
 * ChapterProxyApprovalPacketBuilder — 章节级匿名审批包生成器（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / Phase G7
 *
 * 纯函数模块，无 fs 依赖。提供：
 * - buildAnonymousChapterApprovalPacket：把章节候选侧输入转成匿名 A/B 正反顺序审批包
 * - computeChapterPacketHash：审批包规范化 hash（用于 artifact.inputArtifactHash 双向绑定）
 * - verifyChapterPacketAnonymity：检测包内是否泄露禁用词（候选身份/实现名称/judge 结论/开发者预期）
 * - buildAnonymousMapping：构造候选 ID ↔ 匿名标签双向映射（forward/reverse 顺序）
 *
 * 匿名化原则（计划 §6.3）：
 * - forward：A=候选1 B=候选2；reverse：A=候选2 B=候选1（标签互换，文本不变）
 * - 不暴露候选身份（candidateId）、候选类型（raw/editorial/system_selected）、
 *   系统 winner、策略名称、生产 judge 结论、开发者预期
 * - 候选侧 input 中的 releaseId / workspaceId / chapterId 不进入 packet（仅 artifact 持有）
 * - spans 用 A/B 标签，不用 candidate 身份
 * - 固定 case/model/seed/budget 直接保留（这些是冻结环境配置，非候选身份）
 *
 * 与 1B ReleaseProxyApprovalPacketBuilder 的隔离原则：
 * - 不复用 release 级 schemaId / packet 类型；
 * - 章节级 packet 专注双候选 A/B 复判，不携带 release manifest hash / changeClass / R3 标记；
 * - 章节级 packet 不判定 release 晋级，只产出可交付用户的代理审批稿。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 * - 仅纯函数，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

import { createHash } from "node:crypto";

import type {
  AnonymousMapping,
  RecommendedSource,
} from "./chapter-proxy-approval-types.js";

// ============================================================================
// Schema 常量
// ============================================================================

/**
 * ChapterProxyApprovalPacket schemaId。
 * 必须与 ReleaseProxyApprovalPacket 的 "pinovel.release-proxy-approval-packet" 不同，
 * 防止章节级审批包与 release 级审批包互相覆盖或误用。
 */
export const CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID =
  "pinovel.chapter-proxy-approval-packet" as const;

export const CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 候选侧输入类型
// ============================================================================

/**
 * 候选来源类型（仅在 input 中存在，不进入 packet）。
 * - "raw"：raw 候选
 * - "editorial"：editorial 候选
 * - "system_selected"：系统选定稿（统一编排器 PairwiseJudge 的胜出者）
 *
 * 注意：candidateKind 不进入匿名 packet，防止泄露候选身份。
 * caller 在结果中根据匿名映射反推 recommendedSource。
 */
export type ChapterCandidateKind = "raw" | "editorial" | "system_selected";

/** 候选侧输入条目 */
export interface ChapterCandidateInput {
  /** 候选 ID（全局唯一；不进入 packet，仅 artifact 持有） */
  candidateId: string;
  /** 候选来源类型（不进入 packet） */
  candidateKind: ChapterCandidateKind;
  /** 候选正文文本 */
  text: string;
  /** 该候选的胜出/失分 span（来自系统 judge，必须被匿名化为 A/B 标签） */
  spans: Array<{ id: string; text: string; side: "candidate" }>;
}

/** 章节审批包输入（候选侧数据，由调用方提供） */
export interface ChapterApprovalPacketInput {
  /** 关联的 release ID（不进入 packet，仅 artifact 持有） */
  releaseId: string;
  /** workspace ID（不进入 packet） */
  workspaceId: string;
  /** 章节 ID（不进入 packet） */
  chapterId: string;
  /**
   * 参与匿名审批的候选列表。
   * G7-Runner 切片限定为恰好 2 个候选（双候选 A/B 复判）：
   *   - 至少包含 raw 与系统选定稿（计划 §6.3）；
   *   - 多候选场景（>2）留待后续切片实现。
   */
  candidates: [ChapterCandidateInput, ChapterCandidateInput];
  /** FactGuard 报告（结构化对照数据，直接保留） */
  factGuardReport: unknown;
  /** 状态一致性报告 */
  stateConsistency: unknown;
  /** 成本/延迟 profile */
  costProfile: unknown;
  /** 生产 judge 结论；必须被匿名化，不进入 packet */
  systemJudgeConclusion?: string;
  /** 开发者预期；必须被匿名化，不进入 packet */
  developerExpectation?: string;
  /** 预算上限（forward + reverse = 2 calls） */
  budgetMaxCalls: number;
  /** 单次调用超时 */
  timeoutMs: number;
  /** 固定 case 标识（冻结环境配置，非候选身份） */
  fixedCase: string;
  /** 固定模型标识 */
  fixedModel: string;
  /** 固定随机种子 */
  fixedSeed: number;
}

// ============================================================================
// 匿名审批包类型
// ============================================================================

/** 匿名 span：side 只允许 "A" 或 "B"，不暴露 candidateId / candidateKind */
export interface AnonymousChapterSpan {
  id: string;
  text: string;
  side: "A" | "B";
}

/** 匿名候选条目（不暴露 candidateId / candidateKind） */
export interface AnonymousChapterCandidate {
  /** 匿名标签 A 或 B */
  label: "A" | "B";
  text: string;
  spans: AnonymousChapterSpan[];
}

/** 正反顺序单侧包 */
export interface AnonymousChapterPacketSide {
  labelA: "A";
  labelB: "B";
  candidateA: AnonymousChapterCandidate;
  candidateB: AnonymousChapterCandidate;
}

/** 匿名章节审批包（gpt5.6-sol 输入） */
export interface AnonymousChapterApprovalPacket {
  schemaId: typeof CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID;
  schemaVersion: typeof CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_VERSION;
  /** 正向顺序：A=候选1 B=候选2 */
  forward: AnonymousChapterPacketSide;
  /** 反向顺序：A=候选2 B=候选1（标签互换，文本不变） */
  reverse: AnonymousChapterPacketSide;
  /** FactGuard 报告（结构化数据，不暴露候选身份） */
  factGuard: unknown;
  /** 状态一致性报告 */
  stateConsistency: unknown;
  /** 成本/延迟 profile */
  costProfile: unknown;
  /** 预算上限 */
  budgetMaxCalls: number;
  /** 单次调用超时 */
  timeoutMs: number;
  /** 固定 case 标识 */
  fixedCase: string;
  /** 固定模型标识 */
  fixedModel: string;
  /** 固定随机种子 */
  fixedSeed: number;
  /** 候选数量（不暴露候选身份；G7-Runner 切片固定为 2） */
  candidateCount: 2;
}

// ============================================================================
// buildAnonymousMapping
// ============================================================================

/**
 * 构造候选 ID ↔ 匿名标签双向映射。
 *
 * forward: A=candidates[0], B=candidates[1]
 * reverse: A=candidates[1], B=candidates[0]（标签互换，对应同一对候选）
 *
 * 反向顺序的 A/B 标签对应候选与正向相反，使 gpt5.6-sol 无法通过标签稳定推断候选身份。
 *
 * @param candidates 候选列表（恰好 2 个）
 * @param seed 匿名标签分配随机种子（用于复现）
 */
export function buildAnonymousMapping(
  candidates: [ChapterCandidateInput, ChapterCandidateInput],
  seed: number,
): AnonymousMapping {
  if (candidates.length !== 2) {
    throw new Error(
      `buildAnonymousMapping 要求恰好 2 个候选，实际 ${candidates.length} 个（G7-Runner 切片限定双候选 A/B 复判）`,
    );
  }
  // 候选 ID → kind 映射；不进入匿名 packet，仅供 real caller 反推 recommendedSource。
  // stub caller 在构造时已配置 recommendedSource，不消费此字段。
  const candidateKinds: { [candidateId: string]: RecommendedSource } = {
    [candidates[0].candidateId]: candidates[0].candidateKind,
    [candidates[1].candidateId]: candidates[1].candidateKind,
  };
  return {
    forward: { A: candidates[0].candidateId, B: candidates[1].candidateId },
    reverse: { A: candidates[1].candidateId, B: candidates[0].candidateId },
    seed,
    candidateKinds,
  };
}

// ============================================================================
// buildAnonymousChapterApprovalPacket
// ============================================================================

/**
 * 把候选侧输入转成匿名 A/B 正反顺序审批包。
 *
 * 匿名化映射：
 * - forward: candidateA=candidates[0]（标签 A），candidateB=candidates[1]（标签 B）
 * - reverse: candidateA=candidates[1]（标签 A），candidateB=candidates[0]（标签 B）
 * - candidates[i].candidateId / candidateKind 不进入 packet
 * - candidates[i].spans 的 side="candidate" 被匿名化为对应标签 A/B
 * - factGuard/stateConsistency/costProfile 直接保留（结构化对照数据）
 * - releaseId / workspaceId / chapterId / systemJudgeConclusion / developerExpectation 不进入 packet
 * - candidateCount 固定为 2（不暴露候选身份）
 *
 * @param input 候选侧输入
 */
export function buildAnonymousChapterApprovalPacket(
  input: ChapterApprovalPacketInput,
): AnonymousChapterApprovalPacket {
  if (input.candidates.length !== 2) {
    throw new Error(
      `buildAnonymousChapterApprovalPacket 要求恰好 2 个候选，实际 ${input.candidates.length} 个（G7-Runner 切片限定双候选 A/B 复判）`,
    );
  }

  const [c0, c1] = input.candidates;

  // forward: A=c0, B=c1
  const forward: AnonymousChapterPacketSide = {
    labelA: "A",
    labelB: "B",
    candidateA: {
      label: "A",
      text: c0.text,
      spans: c0.spans.map((s) => ({ id: s.id, text: s.text, side: "A" })),
    },
    candidateB: {
      label: "B",
      text: c1.text,
      spans: c1.spans.map((s) => ({ id: s.id, text: s.text, side: "B" })),
    },
  };

  // reverse: A=c1, B=c0（标签互换，文本不变）
  const reverse: AnonymousChapterPacketSide = {
    labelA: "A",
    labelB: "B",
    candidateA: {
      label: "A",
      text: c1.text,
      spans: c1.spans.map((s) => ({ id: s.id, text: s.text, side: "A" })),
    },
    candidateB: {
      label: "B",
      text: c0.text,
      spans: c0.spans.map((s) => ({ id: s.id, text: s.text, side: "B" })),
    },
  };

  return {
    schemaId: CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID,
    schemaVersion: CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_VERSION,
    forward,
    reverse,
    factGuard: input.factGuardReport,
    stateConsistency: input.stateConsistency,
    costProfile: input.costProfile,
    budgetMaxCalls: input.budgetMaxCalls,
    timeoutMs: input.timeoutMs,
    fixedCase: input.fixedCase,
    fixedModel: input.fixedModel,
    fixedSeed: input.fixedSeed,
    candidateCount: 2,
  };
}

// ============================================================================
// computeChapterPacketHash
// ============================================================================

/**
 * 计算章节审批包规范化 hash。
 * 用于 artifact.inputArtifactHash 双向绑定，防止事后篡改审批包。
 *
 * 返回 "sha256:" 前缀 + 64 位小写 hex（与 1B computePacketHash 格式一致）。
 */
export function computeChapterPacketHash(
  packet: AnonymousChapterApprovalPacket,
): string {
  const canonical = JSON.stringify(packet);
  return "sha256:" + createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ============================================================================
// verifyChapterPacketAnonymity
// ============================================================================

/**
 * 检测章节审批包内是否泄露禁用词。
 * 禁用词包括：
 * - candidateId（候选身份）
 * - candidateKind 字符串（"raw" / "editorial" / "system_selected"，暴露候选类型）
 * - releaseId / workspaceId / chapterId（章节身份）
 * - systemJudgeConclusion（生产 judge 结论）
 * - developerExpectation（开发者预期）
 *
 * 注意：candidateKind 的字符串值（"raw" 等）作为禁用词过于宽泛（"raw" 可能出现在正文），
 * 因此本函数只检测候选 ID 与显式身份字段；candidateKind 由 builder 保证不进入 packet。
 *
 * @returns { ok: true, leakedTerms: [] } 或 { ok: false, leakedTerms: string[] }
 */
export function verifyChapterPacketAnonymity(
  packet: AnonymousChapterApprovalPacket,
  options: { forbiddenTerms: string[] },
): { ok: boolean; leakedTerms: string[] } {
  const packetStr = JSON.stringify(packet);
  const leakedTerms: string[] = [];
  for (const term of options.forbiddenTerms) {
    // 跳过空字符串与过短词（避免误报）
    if (term && term.length > 0 && packetStr.includes(term)) {
      leakedTerms.push(term);
    }
  }
  return { ok: leakedTerms.length === 0, leakedTerms };
}

// ============================================================================
// resolveRecommendedSource
// ============================================================================

/**
 * 根据候选 ID 反查候选来源类型（由 caller 在结果中调用）。
 *
 * caller 输出 recommendedCandidateId 后，executor 用此函数反查 recommendedSource：
 * - 候选 ID 在 input.candidates 中找到 → 返回对应 candidateKind
 * - 未找到 → 抛错（caller 返回了不存在的候选 ID）
 *
 * @param candidates 候选列表
 * @param recommendedCandidateId caller 推荐的候选 ID
 */
export function resolveRecommendedSource(
  candidates: ChapterCandidateInput[],
  recommendedCandidateId: string,
): RecommendedSource {
  const found = candidates.find((c) => c.candidateId === recommendedCandidateId);
  if (!found) {
    throw new Error(
      `caller 返回的 recommendedCandidateId=${recommendedCandidateId} 不在候选列表中（候选 ID：${candidates
        .map((c) => c.candidateId)
        .join(", ")}）`,
    );
  }
  // candidateKind 与 RecommendedSource 类型一致（raw/editorial/system_selected）
  return found.candidateKind as RecommendedSource;
}
