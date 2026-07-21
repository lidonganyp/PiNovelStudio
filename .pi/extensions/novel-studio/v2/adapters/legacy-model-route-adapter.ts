/**
 * V2 Legacy Model Route Adapter（P4）
 *
 * 包装 legacy novel-studio 的模型调用链路（api/fallback-manager.callWithFallback），
 * 暴露给 V2 CandidateGenerator。提供 4 类候选生成入口：
 *   - generateDirectBaseline：最小编辑型 prompt，无契约无风格
 *   - generateRawStage2：复用 legacy stopAfterStage:"stage2" 路径
 *   - generateSceneContractCandidate：SceneContract 驱动的编辑型 prompt
 *   - generateStyleAwareCandidate：风格指纹驱动的编辑型 prompt
 *
 * 设计原则（规格 P4）：
 * - 提示词改为"编辑型"，不是"控制型"
 * - 禁止要求固定对白比例、固定段落长度、必须按清单逐条写
 * - 每个候选记录 model、route、prompt profile、context hash
 * - 保存所有候选正文，不允许覆盖
 *
 * 为支持 P4 单元测试（无真实 API key），提供 createStubModelGenerateFn；
 * 真实链路 createLegacyModelGenerateFn 动态 import legacy fallback-manager，
 * 在 P10/P12 端到端验收时启用。
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import type { Candidate } from "../core/types.js";
import { loadModelRoutingSync } from "../../utils/config.js";
import { localizeLlmMessages } from "../../utils/llm-language-guard.js";

// ============================================================================
// ModelGenerateFn — 模型调用统一接口
// ============================================================================

export interface ModelGenerateInput {
  /** 路由名（如 v2_direct_gpt / narrator_primary / v2_amplified） */
  route: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 用户提示词 */
  userPrompt: string;
  /** 候选 kind，用于 stub 区分返回内容 */
  kind: string;
  /** Optional bounded output budget for structured auxiliary calls. */
  maxTokens?: number;
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际请求的路由（route lock wrap 设置）。
   *
   * 与 `route` 区分：`route` 是候选语义路由（v2_rawstage2/v2_amplified），
   * `requestedRoute` 是底层调用真实走的路由（锁定 GLM 时为 nb4_*_glm）。
   *
   * 用途：当底层调用失败时，wrapModelFn 的 catch 路径无法拿到 output，
   * 但仍需记录"锁定目标 provider/route"证据（计划 §trace + 总控要求
   * "失败 modelCalls 也记录 requestedRoute/provider，至少记录锁定目标 provider=glm"）。
   * wrapModelGenerateLockedToRoute 设置此字段，wrapModelFn catch 读它推导 provider。
   *
   * 未锁定时省略（undefined）；wrapModelFn catch 回退用 genInput.route。
   */
  requestedRoute?: string;
  /** MODEL-PROMPT-ADAPTER-1：本次调用使用的提示词表达层，供 trace/消融切片。 */
  promptProfile?: string;
}

export interface ModelGenerateOutput {
  text: string;
  model: string;
  route: string;
  durationMs: number;
  finishReason?: string;
  maxTokens?: number;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际使用的 provider（如 "glm" / "doubao" / "openai" / "anthropic"）。
   * 由 legacy fallback-manager 的 FallbackResult.usedProvider 透传，或 stub 按 route 推导。
   * 用于 modelCalls 真实 usedProvider 证据（计划 §trace requestedRoute/actualProvider/actualModel）。
   */
  provider?: string;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际请求的路由名（如 "nb4_generate_glm"）。
   * 与 `route` 区分：`route` 是候选语义路由（v2_rawstage2/v2_amplified，保持选择/trace 契约），
   * `requestedRoute` 是底层调用真实走的路由（锁定 GLM 时为 nb4_*_glm）。
   * 仅在 wrap 锁定时由 wrap 层设置；未锁定时与 route 一致或省略。
   */
  requestedRoute?: string;
}

export type ModelGenerateFn = (input: ModelGenerateInput) => Promise<ModelGenerateOutput>;

const MAX_GENERATION_TOKENS = 32768;

export function resolveGenerationMaxTokens(): number | undefined {
  const raw = process.env.PINOVEL_GENERATION_MAX_TOKENS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_GENERATION_TOKENS) {
    return undefined;
  }
  return parsed;
}

// ============================================================================
// Stub 实现（用于 P4 单元测试）
// ============================================================================

export function createStubModelGenerateFn(): ModelGenerateFn {
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    const start = Date.now();
    const model = stubRouteToModel(input.route);
    const provider = deriveProviderFromRoute(input.route);
    // REAL-QUALITY-1-PREFLIGHT：按 kind 返回结构化内容，让统一主链路完整跑通
    // （opportunity 产生 hypothesis → editorial 候选生成 → pairwise 非降级 verdict）。
    // 只有 raw_chapter / opportunity_judge / editorial_amplified / literary_judge
    // 四类 v2 主链路 kind 走结构化分支；其他 kind（direct_baseline/scene_contract 等
    // legacy CandidateGenerator 测试用例）保持 buildStubText 占位行为，向后兼容。
    const text = buildStubTextByKind(input.kind, input.route, input.userPrompt);
    return {
      text,
      model,
      route: input.route,
      provider,
      durationMs: Date.now() - start,
    };
  };
}

function stubRouteToModel(route: string): string {
  // MODEL-ROUTING-CLAUDE46-1A: 先查 v2 生产路由的 config 显式声明
  const configModel = lookupV2RouteModel(route);
  if (configModel) return configModel;
  if (route.includes("gpt")) return "gpt-5.5";
  if (route.includes("claude")) return "claude-opus-4.8";
  if (route.includes("doubao")) return "doubao-seed-2.1-pro";
  if (route.includes("ernie")) return "ernie-5.1";
  // REAL-QUALITY-1-PREFLIGHT：对齐 model-routing.json 中所有 GLM 路由的 model=glm-5.2
  // （narrator_testing_glm / nb4_generate_glm / nb4_judge_glm 均为 glm-5.2）。
  if (route.includes("glm")) return "glm-5.2";
  return "stub-model";
}

/**
 * MODEL-ROUTING-CLAUDE46-1A: v2 生产路由 model 缓存（与 provider 缓存对称）。
 *
 * 复用 lookupV2RouteProvider 的 lazy load 模式：失败时返回 null，
 * 关键字匹配 fallback 仍可用。
 */
let v2RouteModelCache: Map<string, string> | null = null;

function lookupV2RouteModel(route: string): string | null {
  if (!v2RouteModelCache) {
    try {
      const config = loadModelRoutingSync();
      const agentRouting = config.agent_routing ?? {};
      const cache = new Map<string, string>();
      for (const [name, entry] of Object.entries(agentRouting)) {
        if (!name.startsWith("v2_")) continue;
        if (entry && typeof entry === "object" && typeof entry.model === "string") {
          cache.set(name, entry.model);
        }
      }
      v2RouteModelCache = cache;
    } catch {
      v2RouteModelCache = null;
      return null;
    }
  }
  return v2RouteModelCache.get(route) ?? null;
}

/**
 * REAL-QUALITY-1-PREFLIGHT：按 route 推导 provider，对齐 model-routing.json。
 *
 * 导出供 orchestrator 的 wrapModelFn catch 路径使用：失败 modelCalls 也需记录
 * "锁定目标 provider"证据（总控要求"至少记录锁定目标 provider=glm"）。
 * 成功路径直接读 output.provider（由 stub/legacy 透传），不用此函数。
 *
 * 语义：route 含 provider 关键字即推导对应 provider；未匹配返回 "stub"。
 * 与 stubRouteToModel 配合，使 stub 调用也能产出 provider 证据。
 *
 * MODEL-ROUTING-CLAUDE46-1A: 对 v2 生产路由（v2_rawstage2 / v2_amplified /
 * v2_chinese_calibration / v2_opportunity_judge / v2_literary_judge），
 * 从 model-routing.json 显式读取 provider（派工卡 §3 Required Change #7：
 * trace modelCalls 必须能证明生成与裁判异源）。
 * 这些路由名不含 provider 关键字，旧版关键字匹配会全部返回 "stub"，
 * 导致异源分轨断言无法验证。本版本从 config 显式读取，使 stub 调用
 * 也能产出 claude / doubao / openai 证据。
 *
 * 关键字匹配保留用于其他路由（narrator_testing_gpt / nb4_generate_glm /
 * v2_direct_claude 等含关键字的路由），向后兼容。
 */
export function deriveProviderFromRoute(route: string): string {
  // MODEL-ROUTING-CLAUDE46-1A: 先查 v2 生产路由的 config 显式声明
  const configProvider = lookupV2RouteProvider(route);
  if (configProvider) {
    // 对齐关键字匹配的 provider 命名（claude→anthropic, gpt→openai）
    if (configProvider === "claude") return "anthropic";
    if (configProvider === "gpt") return "openai";
    return configProvider; // doubao / ernie / glm 等已对齐
  }
  if (route.includes("gpt")) return "openai";
  if (route.includes("claude")) return "anthropic";
  if (route.includes("doubao")) return "doubao";
  if (route.includes("ernie")) return "ernie";
  if (route.includes("glm")) return "glm";
  return "stub";
}

/**
 * MODEL-ROUTING-CLAUDE46-1A: v2 生产路由 provider 缓存。
 *
 * model-routing.json 在进程内不变化，缓存避免每次 stub 调用都读文件。
 * 失败时（文件缺失/解析错误）返回 null，关键字匹配 fallback 仍可用，
 * 不阻断 stub 调用。
 */
let v2RouteProviderCache: Map<string, string> | null = null;

function lookupV2RouteProvider(route: string): string | null {
  if (!v2RouteProviderCache) {
    try {
      const config = loadModelRoutingSync();
      const agentRouting = config.agent_routing ?? {};
      const cache = new Map<string, string>();
      // 缓存所有 v2_* 路由的 provider（也覆盖 v2_direct_* / v2_editorial_planner 等）
      for (const [name, entry] of Object.entries(agentRouting)) {
        if (!name.startsWith("v2_")) continue;
        if (typeof entry === "string") {
          cache.set(name, entry);
        } else if (entry && typeof entry.provider === "string") {
          cache.set(name, entry.provider);
        }
      }
      v2RouteProviderCache = cache;
    } catch {
      // 文件缺失或解析错误：返回 null，关键字匹配 fallback
      v2RouteProviderCache = null;
      return null;
    }
  }
  return v2RouteProviderCache.get(route) ?? null;
}

/**
 * REAL-QUALITY-1-PREFLIGHT：按 kind 返回结构化 stub 内容。
 *
 * 四类 v2 主链路 kind 返回合法结构化内容，让完整链路可跑通：
 * - raw_chapter：固定 raw 正文（含可被 opportunity 引用的章末片段）
 * - opportunity_judge：合法 opportunity verdict JSON（evidenceExcerpt 必须在 raw 中存在）
 * - editorial_amplified：editorial 候选正文（章末增加新悬念，与 raw 可区分）
 * - literary_judge：合法 pairwise verdict JSON（winner=tie，不依赖匿名映射，非降级）
 *
 * 其他 kind（direct_baseline/scene_contract 等 legacy CandidateGenerator 测试用例）
 * 保持原 buildStubText 占位行为，向后兼容（candidate-generator.test.mjs 依赖
 * 不同 kind 返回可区分正文）。
 */
function buildStubTextByKind(kind: string, route: string, userPrompt: string): string {
  switch (kind) {
    case "raw_chapter":
      return STUB_RAW_TEXT;
    case "opportunity_judge":
      return STUB_OPPORTUNITY_VERDICT;
    case "editorial_amplified":
      return STUB_EDITORIAL_TEXT;
    case "literary_judge":
      return STUB_PAIRWISE_VERDICT;
    default:
      return buildStubText(kind, route, userPrompt);
  }
}

/**
 * 固定 raw 正文：末段"他咬牙继续下潜，肺中的氧气即将耗尽。"无钩子信号，
 * 可被 opportunity verdict 的 evidenceExcerpt 引用（span 强制：excerpt 必须在 raw 中存在）。
 */
const STUB_RAW_TEXT = [
  "青鱼嘴的水下，浑浊的水面下暗流涌动。",
  "叶尘屏息潜入，水草缠住脚踝，他用力挣脱。",
  "黑影从深处掠过，他猛地转身，手中短剑刺出。",
  "水流变急，前方出现一道模糊的轮廓。",
  "他咬牙继续下潜，肺中的氧气即将耗尽。",
].join("\n");

/**
 * 合法 opportunity verdict JSON：evidenceExcerpt 是 STUB_RAW_TEXT 末段（真实存在）。
 * opportunityType=chapter_end_pressure 是合法值，diagnosis/expectedReaderGain/damageRisks 齐全。
 * 让 EditorialOpportunityJudge.judgeWithLLM 解析成功 → llmJudged=true + 1 个 hypothesis。
 */
const STUB_OPPORTUNITY_VERDICT = JSON.stringify({
  craftPhenomena: [
    {
      domain: "ending_and_closure",
      status: "observed",
      phenomenon: "章末压力存在，但尚未形成新的因果问题",
      evidenceExcerpt: "他咬牙继续下潜，肺中的氧气即将耗尽。",
      contextEvidenceRefs: [],
      readerImpact: "读者能感到即时危险，但后续牵引仍可加强",
      confidence: 0.7,
    },
  ],
  opportunities: [
    {
      opportunityType: "chapter_end_pressure",
      craftDomain: "ending_and_closure",
      diagnosis: "章末缺少翻页牵引力，末段无新问题或压力",
      evidenceExcerpt: "他咬牙继续下潜，肺中的氧气即将耗尽。",
      expectedReaderGain: "章末抛出新悬念或压力，提升翻页牵引力",
      damageRisks: ["强行加钩子可能与本章已建立的事实冲突"],
      contextEvidenceRefs: [],
      confidence: 0.7,
    },
  ],
  noOpReason: null,
});

/**
 * editorial 候选正文：与 raw 可区分，章末增加新悬念（"某种古老的呼吸正在苏醒"）。
 * 让 EditorialCandidateGenerator 生成 editorial_amplified 候选。
 */
const STUB_EDITORIAL_TEXT = [
  "青鱼嘴的水下，浑浊的水面下暗流涌动。",
  "叶尘屏息潜入，水草缠住脚踝，他用力挣脱。",
  "黑影从深处掠过，他猛地转身，手中短剑刺出——剑锋划过黑影，竟是一具沉没的浮尸。",
  "水流变急，前方出现一道模糊的轮廓，那轮廓似乎在向他招手。",
  "他咬牙继续下潜，肺中的氧气即将耗尽，而更深的黑暗里，某种古老的呼吸正在苏醒。",
].join("\n");

/**
 * 合法 pairwise verdict JSON：winner=tie，不依赖匿名映射（A/B 随机化不影响）。
 * decisiveReasons 含 1 条合法结构（betterCandidate=neither，evidenceA/B 各 1 条 span）。
 * 让 PairwiseLiteraryJudge 解析成功 → non-degraded（degraded=false）。
 *
 * tie 选择理由：让 JudgeArbitrator 触发反向复判（needsReverseReview=true），
 * 两轮一致 tie → 保留 raw（finalSelectedSource=rawStage2，projectGain=neutral）。
 * arbitrate 仍返回非 null ArbitratorResult（满足断言 judgeArbitration 非 null）。
 */
const STUB_PAIRWISE_VERDICT = JSON.stringify({
  winner: "tie",
  confidence: "slight",
  decisiveReasons: [
    {
      dimension: "章末钩子",
      betterCandidate: "neither",
      evidenceA: [{ start: 0, end: 10, excerpt: "青鱼嘴的水下，浑浊" }],
      evidenceB: [{ start: 0, end: 10, excerpt: "青鱼嘴的水下，浑浊" }],
      explanation: "两候选章末均有钩子空间，质量接近，判 tie",
    },
  ],
  factualRisks: [],
  regressionRisks: [],
  constitutionAlignment: "两候选均对齐作品宪法",
});

/**
 * 占位 stub 正文（非主链路 kind 用，向后兼容 legacy CandidateGenerator 测试）。
 * 按 kind+route 生成可区分正文（candidate-generator.test.mjs 依赖不同 kind 返回不同文本）。
 */
function buildStubText(kind: string, route: string, userPrompt: string): string {
  const promptPreview = userPrompt.slice(0, 40).replace(/\n/g, " ");
  return [
    `【stub 候选】kind=${kind} route=${route}`,
    `【prompt 预览】${promptPreview}...`,
    `【正文】这是一段由 stub 模型生成的占位正文，用于 P4 单元测试。`,
    `它包含水下救援场景的基本元素：青鱼嘴、浑浊水面、暗流拉扯、水怪黑影。`,
    `主角面临选择，风险递增，动作连续。`,
  ].join("\n");
}

// ============================================================================
// Legacy 真实实现（动态 import，P10/P12 启用）
// ============================================================================

export function createLegacyModelGenerateFn(): ModelGenerateFn {
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    const start = Date.now();
    // 动态 import legacy fallback-manager，避免 V2 typecheck 依赖 legacy 内部类型
    const fallbackMod: any = await import("../../api/fallback-manager.js");
    const candidateTimeoutMs = input.timeoutMs ?? 600000;
    const manager = fallbackMod.createAPIFallbackManager({ totalTimeoutMs: candidateTimeoutMs });
    const messages = localizeLlmMessages([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ]);
    // Use the same candidate budget for the chain and the in-flight HTTP request.
    // fetchWithTimeout aborts the request, so timeout does not leave a background retry alive.
    const maxTokens = input.maxTokens ?? (
      input.kind === "raw_chapter" || input.kind === "editorial_amplified"
        ? resolveGenerationMaxTokens()
        : undefined
    );
    const result = await manager.callWithFallback(
      input.route,
      messages,
      {
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        timeoutMs: candidateTimeoutMs,
        ...(input.route === "v2_literary_judge" ? { stream: true } : {}),
      },
    );
    const text = extractTextFromFallbackResult(result);
    const finishReason = extractFinishReasonFromFallbackResult(result);
    return {
      text,
      model: result.usedModel ?? "unknown",
      route: input.route,
      // REAL-QUALITY-1-PREFLIGHT：透传 fallback-manager 的 usedProvider 作为真实 provider 证据。
      provider: result.usedProvider ?? undefined,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      durationMs: Date.now() - start,
    };
  };
}

function extractTextFromFallbackResult(result: any): string {
  // GLMResponse: choices[0].message.content
  if (result?.response?.choices?.[0]?.message?.content) {
    return String(result.response.choices[0].message.content);
  }
  // Claude: response.content[0].text
  if (result?.response?.content?.[0]?.text) {
    return String(result.response.content[0].text);
  }
  // GPT: response.content
  if (typeof result?.response?.content === "string") {
    return result.response.content;
  }
  return "";
}

function extractFinishReasonFromFallbackResult(result: any): string | undefined {
  const choiceReason = result?.response?.choices?.[0]?.finish_reason;
  if (typeof choiceReason === "string" && choiceReason.trim()) return choiceReason;
  const stopReason = result?.response?.stop_reason;
  if (typeof stopReason === "string" && stopReason.trim()) return stopReason;
  const responseReason = result?.response?.finish_reason;
  return typeof responseReason === "string" && responseReason.trim()
    ? responseReason
    : undefined;
}

// ============================================================================
// 候选保存（不覆盖）
// ============================================================================

export interface CandidateSaveResult {
  candidateId: string;
  filePath: string;
  bytes: number;
  /** 是否因同名文件已存在而追加序号 */
  deduplicated: boolean;
}

/**
 * 保存候选正文到 workspace，文件名 {chapterId}-{kind}-{n}.md，不覆盖已存在文件。
 * 若同名文件已存在，追加 -{dedupeN} 后缀直到不冲突。
 */
export function saveCandidate(
  candidate: Candidate,
  workspacePath: string,
  chapterId: string
): CandidateSaveResult {
  const dir = join(workspacePath, "v2-candidates");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const baseName = `${chapterId}-${candidate.kind}`;
  let fileName = `${baseName}.md`;
  let deduplicated = false;
  let n = 1;
  while (existsSync(join(dir, fileName))) {
    deduplicated = true;
    fileName = `${baseName}-${n}.md`;
    n += 1;
  }

  const filePath = join(dir, fileName);
  const content = [
    `<!-- candidate-id: ${candidate.id} -->`,
    `<!-- kind: ${candidate.kind} -->`,
    `<!-- model: ${candidate.model} -->`,
    `<!-- route: ${candidate.route} -->`,
    `<!-- context-hash: ${candidate.contextHash} -->`,
    `<!-- generated-at: ${candidate.generatedAt} -->`,
    `<!-- prompt-profile: type=${candidate.promptProfile.type} containsDialogueRatio=${candidate.promptProfile.containsDialogueRatio} containsParagraphLengthConstraint=${candidate.promptProfile.containsParagraphLengthConstraint} -->`,
    ``,
    candidate.text,
  ].join("\n");

  writeFileSync(filePath, content, "utf-8");
  const bytes = statSync(filePath).size;

  return {
    candidateId: candidate.id,
    filePath,
    bytes,
    deduplicated,
  };
}

// ============================================================================
// 路由名常量（与 config/model-routing.json 对齐，Task 16 配置）
// ============================================================================

export const V2_ROUTES = {
  DIRECT_GPT: "v2_direct_gpt",
  DIRECT_CLAUDE: "v2_direct_claude",
  DIRECT_DOUBAO: "v2_direct_doubao",
  RAWSTAGE2: "v2_rawstage2",
  AMPLIFIED: "v2_amplified",
} as const;

export type V2RouteName = (typeof V2_ROUTES)[keyof typeof V2_ROUTES];
