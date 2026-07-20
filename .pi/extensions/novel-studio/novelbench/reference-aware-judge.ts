/**
 * NB-5：Reference-aware Judge（匿名 pairwise + 反向复判 + 多数投票）
 *
 * 在 NB-4 Generation Matrix 产出 B0-B4 候选后，本模块做严格文学裁判：
 * - 匿名 pairwise：A/B 标签不暴露 B0-B4 身份
 * - reference-aware：裁判可看 reference 正文，评估事实准确性与连续性
 * - 5 维度评分：中文自然度 / 情节推进 / 人物质感 / 细节画面 / 章末张力
 * - span 引用：每个 verdict 必须引用胜出/落败 span（可验证的文本片段）
 * - 反向复判：每轮 forward + reverse（交换 A/B），只有两向一致才算有效
 * - 多数投票：N 轮有效 verdict 多数胜出
 * - < 2 有效 verdict → needsManualReview
 *
 * 架构边界（evaluator 进程）：
 * - 本模块是 evaluator 进程，可访问 reference 正文（由 CLI 调 registry.resolve() 后传入）
 * - 不直接 import reference-registry（CLI 处理 FS，本模块只接收 referenceText 字符串）
 * - 不 import generator-bundle / chapter-splitter / dataset-builder
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import type { LayerName } from "./generation-matrix-runner.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
  ModelGenerateOutput,
} from "../v2/adapters/legacy-model-route-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 5 个评判维度 */
export type JudgeDimension =
  | "中文自然度"
  | "情节推进"
  | "人物质感"
  | "细节画面"
  | "章末张力";

/** 全部维度（有序，用于校验 verdict 完整性） */
export const ALL_DIMENSIONS: JudgeDimension[] = [
  "中文自然度",
  "情节推进",
  "人物质感",
  "细节画面",
  "章末张力",
];

/** 文本 span（引用候选文本的可验证片段） */
export interface JudgeTextSpan {
  /** 候选标签（A 或 B） */
  letter: "A" | "B";
  /** 文本摘录（必须是候选正文的子串，用于验证） */
  excerpt: string;
}

/** 单维度评分 */
export interface DimensionScore {
  dimension: JudgeDimension;
  /** 该维度胜出方（A/B/tie） */
  winner: "A" | "B" | "tie";
  /** 评分理由 */
  reason: string;
}

/** 单轮单次判定（forward 或 reverse 之一） */
export interface SingleVerdict {
  /** 轮次（从 1 开始） */
  round: number;
  /** 是否为反向复判 */
  reversed: boolean;
  /** 裁判选出的胜出标签 */
  winnerLetter: "A" | "B";
  /** 总体理由 */
  reason: string;
  /** 5 维度评分（必须完整且不重复） */
  dimensions: DimensionScore[];
  /** 胜出 span（引用胜出候选的文本片段） */
  winningSpans: JudgeTextSpan[];
  /** 落败 span（引用落败候选的文本片段） */
  losingSpans: JudgeTextSpan[];
  /** 匿名映射：A/B → 层名 */
  anonymizedMapping: { A: LayerName; B: LayerName };
  /** 是否有效（维度完整 / span 非空 / JSON 可解析） */
  valid: boolean;
  /** 无效原因（valid=false 时填） */
  invalidReason?: string;
}

/** 一对候选的比较结果（含多轮 verdict） */
export interface PairResult {
  /** 比较的层对 */
  pair: [LayerName, LayerName];
  /** 所有单次 verdict（forward + reverse × N 轮） */
  verdicts: SingleVerdict[];
  /** 有效的一致 verdict（forward 和 reverse 选同一候选） */
  consistentVerdicts: SingleVerdict[];
  /** 多数投票胜出层（无多数时为 null） */
  majorityWinner: LayerName | null;
  /** 是否需要人工审查（< 2 有效一致 verdict） */
  needsManualReview: boolean;
  /** 置信度（一致 verdict 中胜出层占比，0-1） */
  confidence: number;
}

/** Reference-aware Judge 输入 */
export interface ReferenceAwareJudgeInput {
  /** Case ID */
  caseId: string;
  /** B0-B4 候选文本 */
  candidates: Record<LayerName, string>;
  /** 参考正文（来自 registry.resolve()，evaluator 传入） */
  referenceText: string;
  /** 要比较的层对列表（如 [["B0","B4"]] 证明 B4>B0） */
  pairs: Array<[LayerName, LayerName]>;
  /** 模型调用函数 */
  modelGenerate: ModelGenerateFn;
  /** 裁判路由名 */
  route: string;
  /** 每对的比较轮数（默认 3，必须为奇数以保证多数投票有结论） */
  rounds?: number;
  /** 随机种子（匿名映射可复现） */
  seed?: number;
  /** 单次模型调用超时 ms（默认 600000） */
  timeoutMs?: number;
}

/** Reference-aware Judge 输出 */
export interface ReferenceAwareJudgeResult {
  caseId: string;
  pairResults: PairResult[];
  totalModelCalls: number;
  totalDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_ROUNDS = 3;
/** 单次 verdict JSON 解析失败时的最大重试次数 */
const VERDICT_PARSE_MAX_RETRIES = 1;
/** span 验证失败时的最大重试次数（带反馈给模型，要求重新精确引用） */
const SPAN_VALIDATION_MAX_RETRIES = 1;
/** 需要 ≥ 2 个一致 verdict 才能多数投票，否则人工审查 */
const MIN_CONSISTENT_VERDICTS_FOR_MAJORITY = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造裁判 prompt。
 *
 * 匿名化：textA / textB 由调用方按 seed + round 决定映射，裁判不知道 A/B 对应哪层。
 * reference 正文用于评估事实准确性与连续性（裁判可见，但 reference 不是候选）。
 */
function buildJudgePrompts(
  textA: string,
  textB: string,
  referenceText: string,
): { system: string; user: string } {
  const system = [
    `你是资深文学评委。请比较以下两段中文网文正文（A 和 B），选择文学质量更好的一段。`,
    `你还会看到该章的参考正文（已出版的实际章节），用于评估事实准确性和连续性，但参考正文不是候选。`,
    ``,
    `评判维度（5 维，必须全部完成且不重复）：`,
    `1. 中文自然度：是否有翻译腔、AI 腔，对白是否口语化`,
    `2. 情节推进：事件是否有实质进展，是否与参考正文的情节方向一致`,
    `3. 人物质感：人物是否鲜活立体，是否符合参考正文中的人物设定`,
    `4. 细节画面：场景是否有画面感，细节是否具体`,
    `5. 章末张力：是否有吸引读者的钩子`,
    ``,
    `输出格式（严格 JSON，不要其他内容）：`,
    `{`,
    `  "winner": "A" 或 "B",`,
    `  "reason": "总体选择理由（50-100字）",`,
    `  "dimensions": [`,
    `    {"dimension": "中文自然度", "winner": "A"或"B"或"tie", "reason": "维度理由"},`,
    `    {"dimension": "情节推进", "winner": "A"或"B"或"tie", "reason": "维度理由"},`,
    `    {"dimension": "人物质感", "winner": "A"或"B"或"tie", "reason": "维度理由"},`,
    `    {"dimension": "细节画面", "winner": "A"或"B"或"tie", "reason": "维度理由"},`,
    `    {"dimension": "章末张力", "winner": "A"或"B"或"tie", "reason": "维度理由"}`,
    `  ],`,
    `  "winningSpans": [{"letter": "A"或"B", "excerpt": "胜出候选的文本片段（必须从该候选正文中逐字复制）"}],`,
    `  "losingSpans": [{"letter": "A"或"B", "excerpt": "落败候选的文本片段（必须从该候选正文中逐字复制）"}]`,
    `}`,
    ``,
    `要求：`,
    `- 5 个维度必须全部出现，不得遗漏或重复`,
    `- winningSpans 和 losingSpans 各至少 1 条`,
    `- 语义绑定：winningSpans 中每条的 letter 必须等于 winner；losingSpans 中每条的 letter 必须等于落败方（winner 为 A 时落败方为 B，反之亦然）。引用证据与结论必须一致，禁止把胜出片段标成落败方`,
    `- excerpt 必须从对应候选（A 或 B）正文中逐字复制，不得修改、改写、缩写或扩充任何字符`,
    `- excerpt 长度 15-100 字，必须是候选正文中实际出现的连续文字`,
    `- 如果无法找到合适的片段，请选择候选正文开头或结尾的完整句子`,
    `- 只输出 JSON，不要其他内容`,
  ].join("\n");

  const user = [
    `【参考正文】（已出版实际章节，用于评估准确性，不是候选）`,
    `${referenceText.slice(0, 4000)}${referenceText.length > 4000 ? "\n...(参考正文过长，已截断)" : ""}`,
    ``,
    `【正文 A】`,
    `${textA}`,
    ``,
    `【正文 B】`,
    `${textB}`,
    ``,
    `请比较 A 和 B 的文学质量，输出严格 JSON。`,
  ].join("\n");

  return { system, user };
}

/**
 * 构造带反馈的重试 prompt。
 *
 * 当 validation 失败（span excerpt 不是候选子串，或语义绑定失败）时，
 * 在 user prompt 末尾追加反馈，要求模型重新从候选正文中逐字复制并保持 letter 与 winner 一致。
 */
function buildRetryPrompts(
  basePrompts: { system: string; user: string },
  validationError: string,
): { system: string; user: string } {
  const isSemanticBindingError = validationError.includes("语义绑定失败");
  const retryHint = isSemanticBindingError
    ? [
        ``,
        `⚠️ 上次输出验证失败：${validationError}`,
        `请重新输出 JSON，并修正 letter 标签：`,
        `- winningSpans 中每条的 letter 必须等于 winner（你选的胜出方）`,
        `- losingSpans 中每条的 letter 必须等于落败方（winner 为 A 时落败方为 B，反之亦然）`,
        `- excerpt 必须从对应 letter 的候选正文中逐字复制，不得改写、缩写或扩充`,
      ].join("\n")
    : [
        ``,
        `⚠️ 上次输出验证失败：${validationError}`,
        `请重新输出 JSON，确保 winningSpans 和 losingSpans 的 excerpt 是对应候选（A 或 B）正文中实际出现的连续文字。`,
        `必须从候选正文中逐字复制，不得改写、缩写或扩充。建议直接选择候选正文开头或结尾的完整句子。`,
      ].join("\n");

  return {
    system: basePrompts.system,
    user: basePrompts.user + "\n" + retryHint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 基于 seed + round + reversed 决定匿名映射。
 * 保证可复现：同 seed + round + reversed → 同映射。
 *
 * 规则：(seed + round + (reversed ? 1 : 0)) % 2 === 0 → A=layer1, B=layer2
 *       否则 → A=layer2, B=layer1
 */
function resolveAnonymizedMapping(
  layer1: LayerName,
  layer2: LayerName,
  seed: number | undefined,
  round: number,
  reversed: boolean,
): { A: LayerName; B: LayerName } {
  const base = (seed ?? 0) + round + (reversed ? 1 : 0);
  return base % 2 === 0
    ? { A: layer1, B: layer2 }
    : { A: layer2, B: layer1 };
}

/** 解析裁判返回的 JSON（容错） */
interface ParsedVerdict {
  winnerLetter: "A" | "B" | null;
  reason: string;
  dimensions: DimensionScore[];
  winningSpans: JudgeTextSpan[];
  losingSpans: JudgeTextSpan[];
}

function parseVerdictJson(rawText: string): ParsedVerdict {
  const trimmed = rawText.trim();

  // 尝试直接 parse
  let obj: any = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // fallthrough to regex extraction
  }

  // 容错：提取 JSON 片段
  if (!obj) {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        obj = JSON.parse(jsonMatch[0]);
      } catch {
        // fallthrough
      }
    }
  }

  if (!obj) {
    return {
      winnerLetter: null,
      reason: trimmed.slice(0, 200),
      dimensions: [],
      winningSpans: [],
      losingSpans: [],
    };
  }

  // 解析 winner
  const winnerLetter: "A" | "B" | null =
    obj.winner === "A" ? "A" : obj.winner === "B" ? "B" : null;

  // 解析 dimensions
  const dimensions: DimensionScore[] = [];
  if (Array.isArray(obj.dimensions)) {
    for (const d of obj.dimensions) {
      if (
        d &&
        typeof d.dimension === "string" &&
        ALL_DIMENSIONS.includes(d.dimension as JudgeDimension) &&
        (d.winner === "A" || d.winner === "B" || d.winner === "tie")
      ) {
        dimensions.push({
          dimension: d.dimension as JudgeDimension,
          winner: d.winner,
          reason: typeof d.reason === "string" ? d.reason : "",
        });
      }
    }
  }

  // 解析 spans
  const parseSpans = (arr: any): JudgeTextSpan[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (s) =>
          s &&
          (s.letter === "A" || s.letter === "B") &&
          typeof s.excerpt === "string" &&
          s.excerpt.length > 0,
      )
      .map((s) => ({ letter: s.letter as "A" | "B", excerpt: s.excerpt as string }));
  };

  return {
    winnerLetter,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    dimensions,
    winningSpans: parseSpans(obj.winningSpans),
    losingSpans: parseSpans(obj.losingSpans),
  };
}

/**
 * 校验 verdict 有效性：
 * - winnerLetter 非 null
 * - dimensions 5 个维度完整且不重复
 * - winningSpans 和 losingSpans 各至少 1 条
 * - span excerpt 必须是候选正文的原文字串片段
 * - span 语义绑定：winningSpans[].letter === winnerLetter，losingSpans[].letter === loserLetter
 *   （Fix-4：防止模型把胜出 span 标成落败方、落败 span 标成胜出方，避免证据与结论错位）
 */
function validateVerdict(
  parsed: ParsedVerdict,
  textA: string,
  textB: string,
): { valid: boolean; invalidReason?: string } {
  if (parsed.winnerLetter === null) {
    return { valid: false, invalidReason: "winner 解析失败（非 A/B）" };
  }

  // 维度完整性：5 个维度全部出现
  if (parsed.dimensions.length !== ALL_DIMENSIONS.length) {
    return {
      valid: false,
      invalidReason: `维度数量不足：${parsed.dimensions.length}/${ALL_DIMENSIONS.length}`,
    };
  }
  const dimSet = new Set(parsed.dimensions.map((d) => d.dimension));
  for (const dim of ALL_DIMENSIONS) {
    if (!dimSet.has(dim)) {
      return { valid: false, invalidReason: `缺失维度：${dim}` };
    }
  }

  // span 非空
  if (parsed.winningSpans.length === 0) {
    return { valid: false, invalidReason: "winningSpans 为空" };
  }
  if (parsed.losingSpans.length === 0) {
    return { valid: false, invalidReason: "losingSpans 为空" };
  }

  // Fix-4：span 语义绑定。
  // winningSpans 必须全部指向 winnerLetter；losingSpans 必须全部指向 loserLetter。
  // 否则证据与结论错位（典型表现：模型把胜出 span 标成落败方的引文，或反之），
  // 即使 excerpt 子串校验通过，verdict 仍应判无效并要求重判。
  const winnerLetter = parsed.winnerLetter;
  const loserLetter: "A" | "B" = winnerLetter === "A" ? "B" : "A";

  for (const span of parsed.winningSpans) {
    if (span.letter !== winnerLetter) {
      return {
        valid: false,
        invalidReason: `winningSpan letter=${span.letter} 与 winner=${winnerLetter} 不一致（语义绑定失败）`,
      };
    }
  }
  for (const span of parsed.losingSpans) {
    if (span.letter !== loserLetter) {
      return {
        valid: false,
        invalidReason: `losingSpan letter=${span.letter} 与 loser=${loserLetter} 不一致（语义绑定失败）`,
      };
    }
  }

  // span excerpt 必须是候选正文子串（支持空白归一化匹配）
  const textByLetter = { A: textA, B: textB };
  for (const span of [...parsed.winningSpans, ...parsed.losingSpans]) {
    const sourceText = textByLetter[span.letter];
    const matchResult = isExcerptInCandidate(span.excerpt, sourceText);
    if (!matchResult.matched) {
      return {
        valid: false,
        invalidReason: `span excerpt 不是候选 ${span.letter} 的子串：${span.excerpt.slice(0, 50)}...`,
      };
    }
  }

  return { valid: true };
}

/**
 * 检查 excerpt 是否为 candidate 的子串。
 *
 * 匹配策略（从严到宽）：
 * 1. 精确子串匹配
 * 2. 空白归一化匹配（去除所有空白后比较，处理 \n vs \r\n vs 空格差异）
 *
 * 中文正文不依赖空格分词，去除空白不影响语义。归一化后仍需完整子串匹配，
 * 不做模糊匹配或前缀匹配，避免接受幻觉引用。
 */
function isExcerptInCandidate(excerpt: string, candidate: string): { matched: boolean } {
  // 1. 精确匹配
  if (candidate.includes(excerpt)) {
    return { matched: true };
  }
  // 2. 空白归一化匹配
  const normalize = (s: string): string => s.replace(/\s+/g, "");
  const normCandidate = normalize(candidate);
  const normExcerpt = normalize(excerpt);
  if (normExcerpt.length >= 10 && normCandidate.includes(normExcerpt)) {
    return { matched: true };
  }
  return { matched: false };
}

/** 调用裁判模型并构造 SingleVerdict */
async function callJudge(
  input: {
    round: number;
    reversed: boolean;
    mapping: { A: LayerName; B: LayerName };
    textA: string;
    textB: string;
    referenceText: string;
    route: string;
    modelGenerate: ModelGenerateFn;
    timeoutMs: number;
  },
): Promise<{ verdict: SingleVerdict | null; modelCalls: number }> {
  const basePrompts = buildJudgePrompts(
    input.textA,
    input.textB,
    input.referenceText,
  );

  let modelCalls = 0;
  let lastError = "";
  let parsed: ParsedVerdict | null = null;
  let rawOutput: ModelGenerateOutput | null = null;
  let validationError = "";

  // 重试预算分离：
  // - parseRetries：model 抛错或 JSON 解析失败时消耗
  // - validationRetries：JSON 解析成功但 span validation 失败时消耗
  let parseRetriesUsed = 0;
  let validationRetriesUsed = 0;

  while (true) {
    // 根据是否有 validationError 选择 prompt
    const prompts = validationError
      ? buildRetryPrompts(basePrompts, validationError)
      : basePrompts;

    const judgeInput: ModelGenerateInput = {
      route: input.route,
      systemPrompt: prompts.system,
      userPrompt: prompts.user,
      kind: "nb5_judge",
      timeoutMs: input.timeoutMs,
    };
    try {
      const output = await input.modelGenerate(judgeInput);
      modelCalls += 1;
      rawOutput = output;
      const p = parseVerdictJson(output.text);
      if (p.winnerLetter === null) {
        // JSON 解析失败 - 消耗 parse retry 预算
        lastError = `verdict JSON 解析失败`;
        validationError = "";
        if (parseRetriesUsed >= VERDICT_PARSE_MAX_RETRIES) break;
        parseRetriesUsed += 1;
        continue;
      }
      // JSON 解析成功，校验有效性
      const validation = validateVerdict(p, input.textA, input.textB);
      if (validation.valid) {
        parsed = p;
        validationError = "";
        break;
      }
      // validation 失败 - 消耗 validation retry 预算
      lastError = validation.invalidReason ?? "验证失败";
      validationError = lastError;
      parsed = p; // 保留最后一次解析结果作为 fallback
      if (validationRetriesUsed >= SPAN_VALIDATION_MAX_RETRIES) break;
      validationRetriesUsed += 1;
    } catch (e: unknown) {
      modelCalls += 1;
      lastError = e instanceof Error ? e.message : String(e);
      validationError = "";
      // model 抛错 - 消耗 parse retry 预算
      if (parseRetriesUsed >= VERDICT_PARSE_MAX_RETRIES) break;
      parseRetriesUsed += 1;
    }
  }

  if (!parsed || !rawOutput) {
    return { verdict: null, modelCalls };
  }

  // 最终校验（可能仍为 invalid，保留 invalid 状态）
  const validation = validateVerdict(parsed, input.textA, input.textB);
  const winnerLetter = parsed.winnerLetter;

  const verdict: SingleVerdict = {
    round: input.round,
    reversed: input.reversed,
    winnerLetter: winnerLetter ?? "A",
    reason: parsed.reason || lastError,
    dimensions: parsed.dimensions,
    winningSpans: parsed.winningSpans,
    losingSpans: parsed.losingSpans,
    anonymizedMapping: input.mapping,
    valid: validation.valid,
    invalidReason: validation.invalidReason,
  };

  return { verdict, modelCalls };
}

/**
 * 比较一对候选（多轮 forward + reverse）。
 *
 * 每轮：
 * 1. forward：A=layer1, B=layer2（或 seed 决定）→ 裁判选 winner
 * 2. reverse：交换 A/B → 裁判选 winner
 * 3. 一致性检查：forward 和 reverse 去匿名后是否选同一层
 * 4. 一致 → 记为 1 个一致 verdict
 */
async function judgePair(
  pair: [LayerName, LayerName],
  input: ReferenceAwareJudgeInput,
  seed: number | undefined,
  rounds: number,
  timeoutMs: number,
): Promise<{ result: PairResult; modelCalls: number }> {
  const [layer1, layer2] = pair;
  const text1 = input.candidates[layer1] ?? "";
  const text2 = input.candidates[layer2] ?? "";

  const allVerdicts: SingleVerdict[] = [];
  let modelCalls = 0;

  for (let round = 1; round <= rounds; round++) {
    // forward
    const fwdMapping = resolveAnonymizedMapping(layer1, layer2, seed, round, false);
    const textA_fwd = fwdMapping.A === layer1 ? text1 : text2;
    const textB_fwd = fwdMapping.A === layer1 ? text2 : text1;
    const fwdResult = await callJudge({
      round,
      reversed: false,
      mapping: fwdMapping,
      textA: textA_fwd,
      textB: textB_fwd,
      referenceText: input.referenceText,
      route: input.route,
      modelGenerate: input.modelGenerate,
      timeoutMs,
    });
    modelCalls += fwdResult.modelCalls;
    if (fwdResult.verdict) allVerdicts.push(fwdResult.verdict);

    // reverse（交换 A/B）
    const revMapping = resolveAnonymizedMapping(layer1, layer2, seed, round, true);
    const textA_rev = revMapping.A === layer1 ? text1 : text2;
    const textB_rev = revMapping.A === layer1 ? text2 : text1;
    const revResult = await callJudge({
      round,
      reversed: true,
      mapping: revMapping,
      textA: textA_rev,
      textB: textB_rev,
      referenceText: input.referenceText,
      route: input.route,
      modelGenerate: input.modelGenerate,
      timeoutMs,
    });
    modelCalls += revResult.modelCalls;
    if (revResult.verdict) allVerdicts.push(revResult.verdict);
  }

  // 一致性检查：forward 和 reverse 去匿名后选同一层
  const consistentVerdicts: SingleVerdict[] = [];
  for (let round = 1; round <= rounds; round++) {
    const fwd = allVerdicts.find(
      (v) => v.round === round && !v.reversed && v.valid,
    );
    const rev = allVerdicts.find(
      (v) => v.round === round && v.reversed && v.valid,
    );
    if (!fwd || !rev) continue;

    const fwdWinnerLayer = fwd.anonymizedMapping[fwd.winnerLetter];
    const revWinnerLayer = rev.anonymizedMapping[rev.winnerLetter];

    if (fwdWinnerLayer === revWinnerLayer) {
      // 一致：取 forward verdict 作为代表（附加 reverse 信息到 reason）
      consistentVerdicts.push({
        ...fwd,
        reason: `${fwd.reason} [反向复判一致：${revWinnerLayer}]`,
      });
    }
  }

  // 多数投票
  const voteCounts = new Map<LayerName, number>();
  for (const v of consistentVerdicts) {
    const winnerLayer = v.anonymizedMapping[v.winnerLetter];
    voteCounts.set(winnerLayer, (voteCounts.get(winnerLayer) ?? 0) + 1);
  }

  let majorityWinner: LayerName | null = null;
  let maxVotes = 0;
  for (const [layer, count] of voteCounts) {
    if (count > maxVotes) {
      maxVotes = count;
      majorityWinner = layer;
    } else if (count === maxVotes) {
      // 平票 → null
      majorityWinner = null;
    }
  }

  const needsManualReview = consistentVerdicts.length < MIN_CONSISTENT_VERDICTS_FOR_MAJORITY;
  const confidence =
    consistentVerdicts.length > 0 && majorityWinner
      ? (voteCounts.get(majorityWinner) ?? 0) / consistentVerdicts.length
      : 0;

  return {
    result: {
      pair,
      verdicts: allVerdicts,
      consistentVerdicts,
      majorityWinner,
      needsManualReview,
      confidence,
    },
    modelCalls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主函数：runReferenceAwareJudge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行 reference-aware pairwise judge。
 *
 * 流程：
 * 1. 对每个 pair，做 N 轮 forward + reverse 判定
 * 2. 一致性检查：forward 和 reverse 去匿名后选同一层 → 一致 verdict
 * 3. 多数投票：一致 verdict 中多数胜出
 * 4. < 2 一致 verdict → needsManualReview
 *
 * 所有 verdict（含无效）保留在 result.pairResults[].verdicts。
 */
export async function runReferenceAwareJudge(
  input: ReferenceAwareJudgeInput,
): Promise<ReferenceAwareJudgeResult> {
  const totalStart = Date.now();
  const seed = input.seed;
  const rounds = input.rounds ?? DEFAULT_ROUNDS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let totalModelCalls = 0;

  const pairResults: PairResult[] = [];

  for (const pair of input.pairs) {
    // 跳过空候选
    const text1 = input.candidates[pair[0]] ?? "";
    const text2 = input.candidates[pair[1]] ?? "";
    if (text1.length === 0 || text2.length === 0) {
      pairResults.push({
        pair,
        verdicts: [],
        consistentVerdicts: [],
        majorityWinner: null,
        needsManualReview: true,
        confidence: 0,
      });
      continue;
    }

    const { result, modelCalls } = await judgePair(pair, input, seed, rounds, timeoutMs);
    totalModelCalls += modelCalls;
    pairResults.push(result);
  }

  return {
    caseId: input.caseId,
    pairResults,
    totalModelCalls,
    totalDurationMs: Date.now() - totalStart,
  };
}
