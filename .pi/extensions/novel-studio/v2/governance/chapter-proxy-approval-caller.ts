/**
 * ChapterProxyApprovalCaller — 章节级 stub caller + 审批 caller 接口（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / Phase G7
 *
 * G7-Runner 切片3 起同时提供 stub caller 与真实 gpt5.6-sol caller：
 * - stub caller：本地端到端测试，零网络调用
 * - real caller：调用真实 gpt5.6-sol API（需独立授权卡；测试用 callChatCompletions 注入 mock）
 *
 * 提供：
 * - ChapterProxyApprovalCaller 接口（stub 与真实 caller 共用）
 * - createStubChapterProxyApprovalCaller：stub caller（可配置 forward/reverse verdict +
 *   recommendedCandidateId；零网络调用）
 * - createRealGpt56SolChapterProxyApprovalCaller：真实 gpt5.6-sol caller（切片3 新增；
 *   接受可注入的 callChatCompletions 函数；测试用 mock，生产用内置 fetch 适配）
 *
 * 设计原则（计划 §6.3）：
 * - stub caller identity="stub"，零网络调用（不调用真实 gpt5.6-sol）
 * - real caller identity="gpt5.6-sol"，调用真实 gpt5.6-sol API（需独立授权卡）
 * - reviewerType 永远 "validated_human_proxy"，reviewerModel 永远 "gpt5.6-sol"
 * - forward+reverse=2 calls；budget.maxCalls < 2 拒绝
 * - caller 接收 packet + mapping，real caller 用 mapping.forward/reverse 反推 recommendedCandidateId
 * - slight/uncertain 等非正式 verdict 经 normalizeChapterVerdict 映射为 HOLD_FOR_REGENERATION
 * - forward≠reverse → finalStatus=HOLD_FOR_REGENERATION（顺序敏感保守）
 * - forward/reverse 推荐候选不一致 → finalStatus=HOLD_FOR_REGENERATION（保守）
 * - QUARANTINE 路径把 quarantineReason 写入 rationale 与 risks
 *
 * 与 1B ProxyApprovalCaller 的隔离：
 * - 不复用 release 级 caller 接口 / verdict 枚举；
 * - 章节级 caller 输出 ChapterProxyApprovalStatus（PROXY_APPROVED/HOLD_FOR_REGENERATION），
 *   不输出 release 级 APPROVE_DEV/HOLD/REJECT/QUARANTINE；
 * - 章节级 caller 不判定 release 晋级，只产出可交付用户的代理审批稿。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - stub caller 不调用模型、不联网
 * - real caller 通过 callChatCompletions 注入；生产路径用内置 fetch 适配器（需独立授权卡）
 */

import {
  normalizeChapterVerdict,
} from "./chapter-proxy-approval-schema.js";
import type {
  ChapterProxyApprovalStatus,
  RawChapterVerdict,
  ChapterReviewerType,
  RecommendedSource,
  AnonymousMapping,
} from "./chapter-proxy-approval-types.js";
import { localizeLlmMessages, localizeLlmText } from "../../utils/llm-language-guard.js";
import {
  CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
} from "./chapter-proxy-approval-types.js";
import type {
  AnonymousChapterApprovalPacket,
} from "./chapter-proxy-approval-packet-builder.js";

// ============================================================================
// 类型
// ============================================================================

/** caller 调用选项 */
export interface ChapterProxyCallerCallOptions {
  promptHash: string;
  modelVersion: string;
  budget: { maxCalls: number; timeoutMs: number };
}

/** caller 调用返回的原始结果（未构成完整 artifact） */
export interface ChapterProxyCallerResult {
  /** 正向顺序 verdict（A=候选1 B=候选2） */
  forwardVerdict: ChapterProxyApprovalStatus;
  /** 反向顺序 verdict（A=候选2 B=候选1） */
  reverseVerdict: ChapterProxyApprovalStatus;
  /** 归一化最终状态；forward≠reverse 时为 HOLD_FOR_REGENERATION */
  finalStatus: ChapterProxyApprovalStatus;
  /** 代理推荐的候选 ID（caller 根据匿名映射反推） */
  recommendedCandidateId: string;
  /** 推荐候选来源（raw/editorial/system_selected） */
  recommendedSource: RecommendedSource;
  reviewerType: ChapterReviewerType;
  reviewerModel: "gpt5.6-sol";
  reviewerModelVersion: string;
  promptHash: string;
  budgetUsed: { calls: number; timeoutMs: number };
  /** 审批理由 */
  rationale: string;
  /** 胜出 span 引用（来自匿名审批包 spans，不暴露候选身份） */
  winningSpans: string[];
  /** 失分 span 引用 */
  losingSpans: string[];
  /** 风险声明 */
  risks: string[];
}

/**
 * caller 接口（stub 与真实 caller 共用）。
 *
 * call 接收 packet + mapping：
 * - packet：匿名 A/B 审批包（不暴露候选身份）
 * - mapping：候选 ID ↔ 匿名标签双向映射（forward/reverse 顺序）
 *   real caller 用 mapping 反推 recommendedCandidateId；stub caller 直接返回配置值
 */
export interface ChapterProxyApprovalCaller {
  identity: "stub" | "gpt5.6-sol";
  call(
    packet: AnonymousChapterApprovalPacket,
    mapping: AnonymousMapping,
    opts: ChapterProxyCallerCallOptions,
  ): Promise<ChapterProxyCallerResult>;
}

/** stub caller 构造选项 */
export interface StubChapterProxyApprovalCallerOptions {
  /** 正向顺序原始 verdict（未归一化） */
  forwardVerdict: RawChapterVerdict;
  /** 反向顺序原始 verdict */
  reverseVerdict: RawChapterVerdict;
  /** stub 推荐的候选 ID（必须存在于候选列表中，由 executor 校验） */
  recommendedCandidateId: string;
  /** 推荐候选来源（raw/editorial/system_selected） */
  recommendedSource: RecommendedSource;
  /** HOLD_FOR_REGENERATION 原因；写入 rationale 与 risks */
  holdReason?: string;
  /** 默认 modelVersion；被 opts.modelVersion 覆盖 */
  modelVersion?: string;
  /** 胜出 span 引用（可选；默认空数组） */
  winningSpans?: string[];
  /** 失分 span 引用 */
  losingSpans?: string[];
}

// ============================================================================
// createStubChapterProxyApprovalCaller
// ============================================================================

/**
 * 创建 stub 章节代理审批 caller。
 *
 * - identity="stub"，零网络调用
 * - forward+reverse=2 calls；budget.maxCalls < 2 抛错
 * - slight/uncertain 等非正式 verdict 经 normalizeChapterVerdict 映射为 HOLD_FOR_REGENERATION
 * - forward≠reverse → finalStatus=HOLD_FOR_REGENERATION（顺序敏感保守）
 * - holdReason 写入 rationale 与 risks（用于 HOLD 路径诊断）
 * - reviewerType 永远 "validated_human_proxy"，reviewerModel 永远 "gpt5.6-sol"
 *
 * @param options stub caller 构造选项
 */
export function createStubChapterProxyApprovalCaller(
  options: StubChapterProxyApprovalCallerOptions,
): ChapterProxyApprovalCaller {
  const {
    forwardVerdict,
    reverseVerdict,
    recommendedCandidateId,
    recommendedSource,
    holdReason,
    modelVersion,
    winningSpans = [],
    losingSpans = [],
  } = options;

  if (!recommendedCandidateId || recommendedCandidateId.length === 0) {
    throw new Error(
      "createStubChapterProxyApprovalCaller: recommendedCandidateId 不能为空（stub caller 必须声明推荐的候选）",
    );
  }

  return {
    identity: "stub",
    async call(
      _packet: AnonymousChapterApprovalPacket,
      _mapping: AnonymousMapping,
      opts: ChapterProxyCallerCallOptions,
    ): Promise<ChapterProxyCallerResult> {
      // 预算守护：forward + reverse = 2 calls
      const requiredCalls = 2;
      if (opts.budget.maxCalls < requiredCalls) {
        throw new Error(
          `预算不足：forward+reverse 需要 ${requiredCalls} 次调用，但 budget.maxCalls=${opts.budget.maxCalls}`,
        );
      }

      // 归一化 verdict
      const normForward = normalizeChapterVerdict(forwardVerdict);
      const normReverse = normalizeChapterVerdict(reverseVerdict);

      // forward≠reverse → HOLD_FOR_REGENERATION（顺序敏感保守）
      const consistent = normForward === normReverse;
      const finalStatus: ChapterProxyApprovalStatus = consistent
        ? normForward
        : "HOLD_FOR_REGENERATION";

      // reviewerModelVersion：opts 优先，fallback 到 caller 默认
      const reviewerModelVersion = opts.modelVersion || modelVersion || "";

      // rationale
      let rationale: string;
      let risks: string[];
      if (finalStatus === "HOLD_FOR_REGENERATION") {
        if (!consistent) {
          rationale = `HOLD_FOR_REGENERATION: forward/reverse 不一致（forward=${normForward}, reverse=${normReverse}），顺序敏感保守不输出代理审批稿`;
          risks = [];
        } else if (holdReason) {
          rationale = `HOLD_FOR_REGENERATION: ${holdReason}`;
          risks = [holdReason];
        } else {
          rationale = `HOLD_FOR_REGENERATION: forward=${normForward}, reverse=${normReverse}（未提供具体原因）`;
          risks = [];
        }
      } else {
        // PROXY_APPROVED
        rationale = `stub ${finalStatus}: forward=${normForward}, reverse=${normReverse}, recommendedCandidateId=${recommendedCandidateId}`;
        risks = [];
      }

      return {
        forwardVerdict: normForward,
        reverseVerdict: normReverse,
        finalStatus,
        recommendedCandidateId,
        recommendedSource,
        reviewerType: "validated_human_proxy",
        reviewerModel: CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
        reviewerModelVersion,
        promptHash: opts.promptHash,
        budgetUsed: { calls: requiredCalls, timeoutMs: opts.budget.timeoutMs },
        rationale,
        winningSpans: [...winningSpans],
        losingSpans: [...losingSpans],
        risks,
      };
    },
  };
}

// ============================================================================
// createRealGpt56SolChapterProxyApprovalCaller（切片3 新增）
// ============================================================================

/** gpt5.6-sol 调用返回的 OpenAI Chat Completions 兼容结构 */
export interface Gpt56SolCallResult {
  text: string;
  model: string;
  durationMs: number;
}

/** gpt5.6-sol 调用函数签名（测试用 mock；生产用内置 fetch 适配器） */
export type CallChatCompletionsFn = (
  messages: Array<{ role: string; content: string }>,
  options?: { timeoutMs?: number; responseFormat?: "json_object" | "json_schema" },
) => Promise<Gpt56SolCallResult>;

/** gpt5.6-sol 模型输出 JSON 结构 */
interface Gpt56SolVerdictOutput {
  verdict: RawChapterVerdict;
  /** forward/reverse 顺序下推荐的匿名标签（"A" 或 "B"） */
  recommendedLabel: "A" | "B";
  rationale?: string;
  winningSpans?: string[];
  losingSpans?: string[];
}

/** real caller 构造选项 */
export interface RealGpt56SolChapterProxyApprovalCallerOptions {
  /** gpt5.6-sol API key（生产从 NOVELOS_JUDGE_API_KEY 加载） */
  apiKey: string;
  /** gpt5.6-sol API base URL（生产从 NOVELOS_JUDGE_BASE_URL 加载） */
  apiBaseUrl: string;
  /** gpt5.6-sol 模型 ID（如 "gpt-5.6-sol"；生产从 NOVELOS_JUDGE_MODEL 加载） */
  modelId: string;
  /**
   * 可注入的 chat completions 调用函数。
   * 测试用 mock（不触发真实网络）；生产用内置 fetch 适配器（callOpenAIChatCompletions）。
   */
  callChatCompletions: CallChatCompletionsFn;
}

/**
 * 系统提示词：让 gpt5.6-sol 输出结构化 JSON 审批结论。
 * 提示词强调匿名 A/B 复判、forward/reverse 顺序无关、必须返回 verdict 与 recommendedLabel。
 */
const GPT56_SOL_SYSTEM_PROMPT = `你是章节代理审批复核员。
你将收到一对匿名候选甲乙、各自正文片段与事实守卫、状态一致性对照数据。
你的任务是匿名复判：在不暴露候选身份的前提下，基于文学质量、事实守卫和状态一致性，
输出结构化数据：{"结论":"代理批准或暂缓再生","推荐标签":"甲或乙","理由":"具体理由","胜出片段":[],"落败片段":[]}。

规则：
- 仅当某一候选明确胜出时使用“代理批准”；任何轻微胜出、不确定或未知情况一律使用“暂缓再生”。
- 推荐标签必须为“甲”或“乙”，不得为候选身份或候选文本。
- 你不知道正向或反向顺序；不得通过标签稳定推断候选身份。
- 输出必须是合法结构化数据，不得附加代码块或自然语言解释。`;

/**
 * 创建真实 gpt5.6-sol 章节代理审批 caller（切片3 新增）。
 *
 * 行为：
 * - identity="gpt5.6-sol"
 * - forward+reverse=2 calls；budget.maxCalls < 2 抛错
 * - forward 调用：messages = [system, user(packet.forward)]，模型输出 forwardVerdict + forwardRecommendedLabel
 * - reverse 调用：messages = [system, user(packet.reverse)]，模型输出 reverseVerdict + reverseRecommendedLabel
 * - 归一化 verdict：slight_win/uncertain 等 → HOLD_FOR_REGENERATION
 * - 反推 recommendedCandidateId：
 *   - forwardCandidateId = mapping.forward[forwardRecommendedLabel]
 *   - reverseCandidateId = mapping.reverse[reverseRecommendedLabel]
 * - finalStatus：
 *   - verdict 一致 && 推荐一致 && verdict === PROXY_APPROVED → PROXY_APPROVED
 *   - 否则 → HOLD_FOR_REGENERATION
 * - recommendedCandidateId 始终指向 forward 推荐的合法候选（schema 要求属于 candidateIds）
 * - recommendedSource 从 mapping.candidateKinds 反推；缺失时回退 "system_selected"
 *
 * @param options apiKey/apiBaseUrl/modelId/callChatCompletions
 */
export function createRealGpt56SolChapterProxyApprovalCaller(
  options: RealGpt56SolChapterProxyApprovalCallerOptions,
): ChapterProxyApprovalCaller {
  const { apiKey, apiBaseUrl, modelId, callChatCompletions } = options;

  // 必填字段校验（早期失败，避免运行时模糊错误）
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "createRealGpt56SolChapterProxyApprovalCaller: apiKey 不能为空（生产从 NOVELOS_JUDGE_API_KEY 加载）",
    );
  }
  if (!apiBaseUrl || apiBaseUrl.length === 0) {
    throw new Error(
      "createRealGpt56SolChapterProxyApprovalCaller: apiBaseUrl 不能为空（生产从 NOVELOS_JUDGE_BASE_URL 加载）",
    );
  }
  if (!modelId || modelId.length === 0) {
    throw new Error(
      "createRealGpt56SolChapterProxyApprovalCaller: modelId 不能为空（生产从 NOVELOS_JUDGE_MODEL 加载）",
    );
  }
  if (typeof callChatCompletions !== "function") {
    throw new Error(
      "createRealGpt56SolChapterProxyApprovalCaller: callChatCompletions 必须为函数（测试用 mock，生产用内置 fetch 适配器）",
    );
  }

  return {
    identity: "gpt5.6-sol",
    async call(
      packet: AnonymousChapterApprovalPacket,
      mapping: AnonymousMapping,
      opts: ChapterProxyCallerCallOptions,
    ): Promise<ChapterProxyCallerResult> {
      // 预算守护：forward + reverse = 2 calls
      const requiredCalls = 2;
      if (opts.budget.maxCalls < requiredCalls) {
        throw new Error(
          `预算不足：forward+reverse 需要 ${requiredCalls} 次调用，但 budget.maxCalls=${opts.budget.maxCalls}`,
        );
      }

      // 1. forward 调用
      const forwardMessages = localizeLlmMessages([
        { role: "system", content: GPT56_SOL_SYSTEM_PROMPT },
        { role: "user", content: localizeLlmText(JSON.stringify(packet.forward)) },
      ]);
      const forwardResp = await callChatCompletions(forwardMessages, {
        timeoutMs: opts.budget.timeoutMs,
        responseFormat: "json_object",
      });
      const forwardOutput = parseGpt56SolVerdictOutput(forwardResp.text);

      // 2. reverse 调用
      const reverseMessages = localizeLlmMessages([
        { role: "system", content: GPT56_SOL_SYSTEM_PROMPT },
        { role: "user", content: localizeLlmText(JSON.stringify(packet.reverse)) },
      ]);
      const reverseResp = await callChatCompletions(reverseMessages, {
        timeoutMs: opts.budget.timeoutMs,
        responseFormat: "json_object",
      });
      const reverseOutput = parseGpt56SolVerdictOutput(reverseResp.text);

      // 3. 归一化 verdict
      const normForward = normalizeChapterVerdict(forwardOutput.verdict);
      const normReverse = normalizeChapterVerdict(reverseOutput.verdict);

      // 4. 反推 recommendedCandidateId
      const forwardCandidateId = resolveLabel(mapping.forward, forwardOutput.recommendedLabel);
      const reverseCandidateId = resolveLabel(mapping.reverse, reverseOutput.recommendedLabel);

      // 5. 判断一致性
      const verdictConsistent = normForward === normReverse;
      const recommendationConsistent = forwardCandidateId === reverseCandidateId;

      // 6. finalStatus：必须 verdict 一致 + 推荐一致 + verdict=PROXY_APPROVED
      const finalStatus: ChapterProxyApprovalStatus =
        verdictConsistent && recommendationConsistent && normForward === "PROXY_APPROVED"
          ? "PROXY_APPROVED"
          : "HOLD_FOR_REGENERATION";

      // 7. recommendedCandidateId 始终指向 forward 推荐的合法候选
      //    （schema 要求属于 candidateIds；executor 会校验）
      const recommendedCandidateId = forwardCandidateId;

      // 8. recommendedSource：从 mapping.candidateKinds 反推；缺失时回退 "system_selected"
      //    （executor 会用 resolveRecommendedSource 反查 candidateKind 覆盖不一致的值）
      const recommendedSource: RecommendedSource =
        (mapping.candidateKinds && mapping.candidateKinds[recommendedCandidateId]) ||
        "system_selected";

      // 9. rationale
      let rationale: string;
      if (!verdictConsistent) {
        rationale = `HOLD_FOR_REGENERATION: forward/reverse verdict 不一致（forward=${normForward}, reverse=${normReverse}），顺序敏感保守不输出代理审批稿`;
      } else if (!recommendationConsistent) {
        rationale = `HOLD_FOR_REGENERATION: forward/reverse 推荐候选不一致（forward=${forwardCandidateId}, reverse=${reverseCandidateId}），保守不输出代理审批稿`;
      } else if (normForward !== "PROXY_APPROVED") {
        rationale = `HOLD_FOR_REGENERATION: forward/reverse verdict=${normForward}（模型未明确推荐胜出候选）`;
      } else {
        rationale = `PROXY_APPROVED: forward/reverse 一致推荐 candidateId=${recommendedCandidateId}（rationale: forward=${forwardOutput.rationale ?? ""}, reverse=${reverseOutput.rationale ?? ""}）`;
      }

      // 10. 合并 spans（forward + reverse）
      const winningSpans = [
        ...(forwardOutput.winningSpans ?? []),
        ...(reverseOutput.winningSpans ?? []),
      ];
      const losingSpans = [
        ...(forwardOutput.losingSpans ?? []),
        ...(reverseOutput.losingSpans ?? []),
      ];

      return {
        forwardVerdict: normForward,
        reverseVerdict: normReverse,
        finalStatus,
        recommendedCandidateId,
        recommendedSource,
        reviewerType: "validated_human_proxy",
        reviewerModel: CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
        reviewerModelVersion: opts.modelVersion,
        promptHash: opts.promptHash,
        budgetUsed: { calls: requiredCalls, timeoutMs: opts.budget.timeoutMs },
        rationale,
        winningSpans,
        losingSpans,
        risks: [],
      };
    },
  };
}

// ============================================================================
// callOpenAIChatCompletions — 内置 OpenAI Chat Completions fetch 适配器（生产路径）
// ============================================================================

/**
 * 内置 OpenAI Chat Completions fetch 适配器（切片3 新增）。
 *
 * 生产路径用：从 NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL
 * 读取配置，调用 OpenAI 兼容 Chat Completions API，返回 { text, model, durationMs }。
 *
 * 测试路径不调用此函数（runRealChapterProxyReview 用 callerOverride 注入 mock
 * callChatCompletions；无 callerOverride 且无 env 时 runner 在创建 caller 前就抛
 * "API 配置缺失"）。因此本函数不需要 mock，也不会触发真实网络。
 *
 * 边界（REQUIRES_AUTH）：
 * - 真实网络调用，仅在生产路径（独立授权卡通过后）执行
 * - bounded timeout（AbortController；超时抛错，不无限等待）
 * - 仅依赖全局 fetch（Node 18+）+ node:http AbortController
 * - 不写文件、不持久化、不缓存
 *
 * @param messages OpenAI chat messages（role/content）
 * @param options timeoutMs（默认 60000）+ responseFormat（json_object/json_schema）
 */
export async function callOpenAIChatCompletions(
  messages: Array<{ role: string; content: string }>,
  options?: { timeoutMs?: number; responseFormat?: "json_object" | "json_schema" },
): Promise<Gpt56SolCallResult> {
  const apiKey = process.env.NOVELOS_JUDGE_API_KEY;
  const apiBaseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const modelId = process.env.NOVELOS_JUDGE_MODEL;
  if (!apiKey || !apiBaseUrl || !modelId) {
    throw new Error(
      "callOpenAIChatCompletions: API 配置缺失（NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL 未设置）",
    );
  }

  const url = `${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: modelId,
    messages: localizeLlmMessages(messages),
    temperature: 0,
  };
  if (options?.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  } else if (options?.responseFormat === "json_schema") {
    body.response_format = { type: "json_schema" };
  }

  const timeoutMs = options?.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(
        `callOpenAIChatCompletions: HTTP ${resp.status} ${resp.statusText}（body: ${errText.slice(0, 200)}）`,
      );
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `callOpenAIChatCompletions: 响应缺少 choices[0].message.content（响应：${JSON.stringify(data).slice(0, 200)}）`,
      );
    }
    return {
      text: content,
      model: data.model ?? modelId,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `callOpenAIChatCompletions: 请求超时（timeoutMs=${timeoutMs}）`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 内部辅助：解析 gpt5.6-sol JSON 输出 + 反推候选 ID
// ============================================================================

/**
 * 解析 gpt5.6-sol 模型输出的 JSON 审批结论。
 * 模型输出必须是合法 JSON，包含 verdict 与 recommendedLabel 字段。
 * 解析失败或字段缺失 → 抛错（让 executor 走 envelope 失败恢复路径）。
 */
function parseGpt56SolVerdictOutput(text: string): Gpt56SolVerdictOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `gpt5.6-sol 输出 JSON 解析失败：${(e as Error).message}（原始输出：${text.slice(0, 200)}）`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("gpt5.6-sol 输出必须为 JSON 对象");
  }
  const obj = parsed as Record<string, unknown>;
  const rawVerdict = obj.verdict ?? obj["结论"];
  const verdict = rawVerdict === "代理批准"
    ? "PROXY_APPROVED"
    : rawVerdict === "暂缓再生"
      ? "HOLD_FOR_REGENERATION"
      : rawVerdict;
  const rawRecommendedLabel = obj.recommendedLabel ?? obj["推荐标签"];
  const recommendedLabel = rawRecommendedLabel === "甲"
    ? "A"
    : rawRecommendedLabel === "乙"
      ? "B"
      : rawRecommendedLabel;
  if (verdict === undefined || verdict === null) {
    throw new Error("gpt5.6-sol 输出缺少 verdict 字段");
  }
  if (recommendedLabel !== "A" && recommendedLabel !== "B") {
    throw new Error(
      `gpt5.6-sol 输出 recommendedLabel 必须为 "A" 或 "B"，实际为 ${JSON.stringify(recommendedLabel)}`,
    );
  }
  return {
    verdict: verdict as RawChapterVerdict,
    recommendedLabel,
    rationale: typeof (obj.rationale ?? obj["理由"]) === "string" ? String(obj.rationale ?? obj["理由"]) : undefined,
    winningSpans: Array.isArray(obj.winningSpans ?? obj["胜出片段"])
      ? ((obj.winningSpans ?? obj["胜出片段"]) as string[])
      : undefined,
    losingSpans: Array.isArray(obj.losingSpans ?? obj["落败片段"])
      ? ((obj.losingSpans ?? obj["落败片段"]) as string[])
      : undefined,
  };
}

/**
 * 根据匿名标签 A/B 反查候选 ID。
 * mapping.forward/reverse 的 A/B 字段为候选 ID 字符串。
 */
function resolveLabel(
  side: { A: string; B: string },
  label: "A" | "B",
): string {
  return side[label];
}

// ============================================================================
// createOpenAIChatCompletionsFn — 内置 fetch 适配器工厂（切片3 新增）
// ============================================================================

/**
 * OpenAI Chat Completions 兼容 API 调用工厂。
 *
 * 返回一个 CallChatCompletionsFn，调用 `${apiBaseUrl}/chat/completions`，
 * 携带 Bearer apiKey 鉴权与 response_format json_object（如请求 JSON 输出）。
 *
 * 用途：
 * - 生产路径：runner 从 NOVELOS_JUDGE_* env 加载配置后调用此工厂创建内置 fetch 适配器
 * - 测试路径：测试通过 callerOverride 注入 mock caller，不触发此工厂的真实网络调用
 *
 * 设计原则：
 * - 凭据在工厂调用时绑定（闭包），返回的 CallChatCompletionsFn 不再接受 apiKey/apiBaseUrl/modelId
 * - 遵守 PINOVEL_MODEL_REQUEST_TIMEOUT_MS bounded timeout：opts.timeoutMs 控制 AbortController
 * - 仅解析 OpenAI Chat Completions 兼容响应结构（choices[0].message.content）
 * - 错误信息携带 HTTP status + 响应体前 500 字符，便于诊断
 *
 * @param options apiKey/apiBaseUrl/modelId（必填）
 * @returns CallChatCompletionsFn 闭包
 */
export function createOpenAIChatCompletionsFn(options: {
  apiKey: string;
  apiBaseUrl: string;
  modelId: string;
}): CallChatCompletionsFn {
  const { apiKey, apiBaseUrl, modelId } = options;

  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "createOpenAIChatCompletionsFn: apiKey 不能为空（生产从 NOVELOS_JUDGE_API_KEY 加载）",
    );
  }
  if (!apiBaseUrl || apiBaseUrl.length === 0) {
    throw new Error(
      "createOpenAIChatCompletionsFn: apiBaseUrl 不能为空（生产从 NOVELOS_JUDGE_BASE_URL 加载）",
    );
  }
  if (!modelId || modelId.length === 0) {
    throw new Error(
      "createOpenAIChatCompletionsFn: modelId 不能为空（生产从 NOVELOS_JUDGE_MODEL 加载）",
    );
  }

  // 规范化 base URL：去掉尾部斜杠后拼接 /chat/completions
  const normalizedBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/chat/completions`;

  return async (
    messages: Array<{ role: string; content: string }>,
    callOpts?: { timeoutMs?: number; responseFormat?: "json_object" | "json_schema" },
  ): Promise<Gpt56SolCallResult> => {
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: localizeLlmMessages(messages),
      temperature: 0,
    };
    if (callOpts?.responseFormat === "json_object") {
      requestBody.response_format = { type: "json_object" };
    }

    // bounded timeout：默认 300000ms（与 PINOVEL_MODEL_REQUEST_TIMEOUT_MS 默认一致）
    const timeoutMs = callOpts?.timeoutMs ?? 300000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startMs = Date.now();

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(
          `gpt5.6-sol 调用失败：HTTP ${resp.status} ${resp.statusText}${errText ? ` - ${errText.slice(0, 500)}` : ""}`,
        );
      }

      const data = (await resp.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data?.choices?.[0]?.message?.content ?? "";
      const model = data?.model ?? modelId;
      const durationMs = Date.now() - startMs;

      return { text, model, durationMs };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // 区分超时与其他错误，便于上层 envelope 归因
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `gpt5.6-sol 调用超时：在 ${timeoutMs}ms 内未收到响应（messages=${messages.length} 条）`,
        );
      }
      throw new Error(`gpt5.6-sol 调用异常：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

// ============================================================================
// validateJudgeEndpoint — SSRF 防护（P0-1 修复，核验结论第二轮 2026-07-17）
// ============================================================================

/**
 * 校验 gpt5.6-sol endpoint 是否符合安全白名单（SSRF 防护）。
 *
 * 真相源：用户核验结论（2026-07-17 第二轮）
 *   - "runner 从 env 读取 NOVELOS_JUDGE_BASE_URL 时必须做 endpoint 白名单校验
 *      （拒绝非 HTTPS / 回环 / 私网地址），防止把 NOVELOS_JUDGE_API_KEY 作为 Bearer
 *      发往调用方指定地址"
 *
 * 校验规则（全部必须通过）：
 * 1. 必须是合法 URL
 * 2. protocol 必须为 https:（拒绝明文 http，防止 Bearer token 被嗅探）
 * 3. hostname 不得为回环地址：localhost / 127.x / ::1 / 0.0.0.0
 * 4. hostname 不得为私网地址：10.x / 172.16-31.x / 192.168.x / 169.254.x（link-local）
 * 5. hostname 不得为 IPv6 回环或 IPv6 私网（fc00::/7, ::1）
 *
 * 校验在创建 caller 之前执行（早期失败），确保不会把 NOVELOS_JUDGE_API_KEY
 * 作为 Bearer 发往非预期地址。测试用 callerOverride 注入 mock caller 时不触发此校验。
 *
 * @param endpoint 待校验的 API base URL（从 NOVELOS_JUDGE_BASE_URL 读取）
 * @throws Error 当 endpoint 违反任一白名单规则时抛出（消息包含 endpoint/SSRF/HTTPS/不允许 之一）
 */
export function validateJudgeEndpoint(endpoint: string): void {
  if (!endpoint || typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error(
      `SSRF 防护：endpoint 不允许为空（NOVELOS_JUDGE_BASE_URL 必须为 HTTPS 公网地址）`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(
      `SSRF 防护：endpoint 不是合法 URL，不允许创建 caller：${endpoint}`,
    );
  }

  // 1. 必须为 HTTPS
  if (parsed.protocol !== "https:") {
    throw new Error(
      `SSRF 防护：endpoint 必须为 HTTPS，不允许 ${parsed.protocol}（防止 Bearer token 明文外泄）：${endpoint}`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  // 2. 拒绝回环地址
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host === "[::1]") {
    throw new Error(
      `SSRF 防护：endpoint 不允许为回环地址（防止把 NOVELOS_JUDGE_API_KEY 发往本机服务）：${host}`,
    );
  }

  // 3. 拒绝 IPv4 私网 / link-local
  //    10.x.x.x / 172.16-31.x.x / 192.168.x.x / 169.254.x.x
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number) as unknown as number[];
    if (
      a === 10 ||                                    // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12
      (a === 192 && b === 168) ||                    // 192.168.0.0/16
      (a === 169 && b === 254)                       // 169.254.0.0/16 link-local
    ) {
      throw new Error(
        `SSRF 防护：endpoint 不允许为私网/链路本地地址（防止内网探测）：${host}`,
      );
    }
  }

  // 4. 拒绝 IPv6 私网（fc00::/7）和 IPv6 回环（::1 已在上面检查）
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    throw new Error(
      `SSRF 防护：endpoint 不允许为 IPv6 私网/链路本地地址（防止内网探测）：${host}`,
    );
  }
}

// ============================================================================
// createRealGpt56SolCallerFromEnv — 从 env 加载配置 + SSRF 校验（P0-1 修复）
// ============================================================================

/**
 * 从 NOVELOS_JUDGE_* 环境变量加载配置并创建真实 gpt5.6-sol caller。
 *
 * 真相源：用户核验结论（2026-07-17 第二轮）
 *   - "公共入口删除 callerOverride/apiKey/apiBaseUrl/modelId；生产配置只能从可信环境/config 读取"
 *   - "runner 从 env 读取 NOVELOS_JUDGE_BASE_URL 时必须做 endpoint 白名单校验"
 *
 * 流程：
 * 1. 从 env 读取 NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL
 * 2. 任一缺失 → throw API 配置缺失错误（不接受调用方传入）
 * 3. 调用 validateJudgeEndpoint(envApiBaseUrl) 做 SSRF 白名单校验（创建 caller 之前）
 * 4. 调用 createRealGpt56SolChapterProxyApprovalCaller 创建 caller（内置 fetch 适配器）
 *
 * 与 runner 的关系：
 * - runner 调用此工厂创建生产 caller（不再从 options 读取 apiKey/apiBaseUrl/modelId）
 * - 测试场景通过 callerOverride 注入 mock caller，不调用此工厂（不触发 SSRF 校验）
 *
 * @returns ChapterProxyApprovalCaller（identity=gpt5.6-sol，内置 fetch 适配器）
 * @throws Error 当 env 配置缺失或 endpoint 不符合 SSRF 白名单时
 */
export function createRealGpt56SolCallerFromEnv(): ChapterProxyApprovalCaller {
  const envApiKey = process.env.NOVELOS_JUDGE_API_KEY;
  const envApiBaseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const envModelId = process.env.NOVELOS_JUDGE_MODEL;

  if (!envApiKey || !envApiBaseUrl || !envModelId) {
    throw new Error(
      `API 配置缺失：真实 gpt5.6-sol 章节代理审批需 NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL 环境变量（生产网络配置只能从可信 env 读取，不接受调用方传入）。当前 env: apiKey=${envApiKey ? "set" : "unset"}, apiBaseUrl=${envApiBaseUrl ? "set" : "unset"}, modelId=${envModelId ?? "unset"}`,
    );
  }

  // SSRF 防护：在创建 caller 之前校验 endpoint（拒绝非 HTTPS / 回环 / 私网）
  validateJudgeEndpoint(envApiBaseUrl);

  return createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: envApiKey,
    apiBaseUrl: envApiBaseUrl,
    modelId: envModelId,
    callChatCompletions: createOpenAIChatCompletionsFn({
      apiKey: envApiKey,
      apiBaseUrl: envApiBaseUrl,
      modelId: envModelId,
    }),
  });
}
