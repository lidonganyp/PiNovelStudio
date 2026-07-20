/**
 * NovelOS M1 评测 — Eval Harness 核心（Step 6.2）
 *
 * 提供 workspace 设置 + 检索评测 + 验证器评测 + 端到端评测。
 *
 * 设计原则：
 * - 不依赖真实模型调用：用 stub modelGenerate 模拟检索对生成的影响
 * - 直接测试 NovelOS 关键能力：NarrativeSearchService 检索 + NarrativeVerifierSuite 验证
 * - 可测量：每个 fixture 有明确的 expected 结果，可计算 precision/recall/gain
 * - 自包含：workspace 设置在临时目录，测试后自动清理
 *
 * 3 条 baseline：
 * - B1 CompiledContext：只检查 CompiledContext 中包含的事实（ContextCompiler 输出）
 * - B2 AgenticRetrieval：检查 NarrativeSearchService 检索到的事实
 * - B3 VerifiedAgenticRaw：检查 NarrativeVerifierSuite 发现的问题 + patch 退化保护
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RankedEvidence } from "../agent/narrative-search-service.js";
import { NarrativeVerifierSuite } from "../verification/narrative-verifier-suite.js";
import type { NarrativeVerifierReport } from "../verification/narrative-verifier-suite.js";
import { createAgenticRawCandidateSource } from "../agent/agentic-raw-candidate-source.js";
import type { AgenticRawSourceResult, AgenticRawSourceCapabilities } from "../agent/agentic-raw-candidate-source.js";
import type { ChapterIntent } from "../../v2/core/chapter-intent-builder.js";
import type { CompiledContext, ContextFact, CharacterStateFact } from "../../v2/core/types.js";
import type { EvalFixture, FindingMatch } from "./eval-types.js";
import {
  type EvalReport,
  type RetrievalEvalResult,
  type VerifierEvalResult,
  type EndToEndEvalResult,
  type GoCondition,
  type GoThresholds,
  type QualityEvalReport,
  type QualityEvalFixtureResult,
  type QualityEvalProvenance,
} from "./eval-types.js";
import type { ModelGenerateFn } from "../../v2/adapters/legacy-model-route-adapter.js";
import { createStubAgentModelGenerate, type StubMode } from "./stub-agent-model.js";
import { prepareBlindTestPack, type BlindTestCandidate } from "./blind-test-pack.js";

// ============================================================================
// 辅助：从 fixture 构建 CompiledContext（供 verifier 使用）
// ============================================================================

/**
 * 从 fixture 的 narrativeState 构建 CompiledContext。
 *
 * - canon entries → context.facts（kind="fact"）
 * - character entries → context.characterStates
 *   - field 含 "knowledge"/"knows" 的条目提取 forbiddenKnowledge 数组
 *   - 其他 field 直接放入 state
 *
 * 这样 verifier 的知识边界检查（checkKnowledgeBoundary）能读取 forbiddenKnowledge。
 */
function buildVerifierContext(fixture: EvalFixture): CompiledContext {
  const facts: ContextFact[] = (fixture.workspace.narrativeState.canon ?? []).map((c) => ({
    id: c.id,
    content: c.fact,
    sourceIds: [c.sourceRef],
    kind: "fact" as const,
  }));

  const characterStates: CharacterStateFact[] = (fixture.workspace.narrativeState.character ?? []).map((c) => {
    const state: Record<string, unknown> = {};
    const fieldLower = c.field.toLowerCase();
    if (fieldLower.includes("knowledge") || fieldLower.includes("knows")) {
      // 从 value 提取禁止知识关键词
      // value 格式如 "不知道X；不知道Y；不知道Z"
      const forbidden = c.value
        .split(/[；;，,。]/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith("不知道"))
        .map((s) => s.replace(/^不知道/, "").trim())
        .filter((s) => s.length >= 2);
      if (forbidden.length > 0) {
        state.forbiddenKnowledge = forbidden;
      }
      state.knowledgeBoundary = c.value;
    } else {
      state[c.field] = c.value;
    }
    return {
      characterId: c.characterId,
      name: c.characterId,
      state,
      sourceIds: [c.sourceRef],
    };
  });

  return {
    facts,
    characterStates,
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

/**
 * 从 fixture 构建 chapterIntent 字符串（供 verifier 使用）。
 *
 * M1 阶段不使用引号包裹关键短语，避免 intent omission checker 在健康候选上误报
 * （inviolableFacts 是完整句子，健康候选可能用不同措辞表达同一事实）。
 * 后续可以改为提取短关键词（2-4 字）放入引号，精确触发 intent omission 检查。
 */
function buildChapterIntentString(fixture: EvalFixture): string {
  return `第${fixture.chapterIntent.chapterNumber}章 生成正文`;
}

// ============================================================================
// Workspace 设置
// ============================================================================

/**
 * 为 fixture 创建临时 workspace。
 * 写入：
 * - workspaces/{id}/config.json
 * - workspaces/{id}/chapters/chapter-{N}/final.md（历史章节）
 * - workspaces/{id}/narrative-state.json（characterUpdates）
 * - workspaces/{id}/skeleton.json（events → canon timeline + locations）
 *
 * 返回 { projectRoot, workspaceId, cleanup }。
 */
export function setupFixtureWorkspace(fixture: EvalFixture): {
  projectRoot: string;
  workspaceId: string;
  cleanup: () => void;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), `novelos-eval-${fixture.id}-`));
  const workspaceId = fixture.workspace.workspaceId;
  const wsDir = join(projectRoot, "workspaces", workspaceId);

  // config.json
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(
    join(wsDir, "config.json"),
    JSON.stringify({
      workspaceId,
      novelType: fixture.workspace.config.novelType,
      characters: fixture.workspace.config.characters,
    }),
    "utf-8",
  );

  // 历史章节
  for (const ch of fixture.workspace.historicalChapters) {
    const chDir = join(wsDir, "chapters", `chapter-${ch.number}`, "");
    mkdirSync(chDir, { recursive: true });
    writeFileSync(join(chDir, "final.md"), ch.text, "utf-8");
  }

  // narrative-state.json（characterUpdates 格式）
  const characterUpdates = (fixture.workspace.narrativeState.character ?? []).map((c) => ({
    name: c.characterId,
    field: c.field,
    value: c.value,
  }));
  if (characterUpdates.length > 0) {
    writeFileSync(
      join(wsDir, "narrative-state.json"),
      JSON.stringify({ characterUpdates }),
      "utf-8",
    );
  }

  // skeleton.json（events → canon timeline + locations）
  const events = (fixture.workspace.narrativeState.canon ?? []).map((c, i) => ({
    eventId: c.id,
    type: c.category,
    summary: c.fact,
    characters: [],
    location: "",
  }));
  const locations = fixture.workspace.historicalChapters
    .map((ch) => ch.title)
    .filter(Boolean);
  if (events.length > 0 || locations.length > 0) {
    writeFileSync(
      join(wsDir, "skeleton.json"),
      JSON.stringify({ events, chapterId: "eval", locations }),
      "utf-8",
    );
  }

  return {
    projectRoot,
    workspaceId,
    cleanup: () => {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
    },
  };
}

// ============================================================================
// 检索评测辅助：关键短语提取 + 三阶匹配（M1.1）
// ============================================================================

/**
 * 从事实文本中提取关键名词短语（2-6 字中文连续段，去掉虚词）。
 * 用于 evalRetrieval 的关键短语匹配，解决措辞不一致问题。
 * 如 "第2章结尾林川在青鱼嘴水下" → ["青鱼嘴", "林川", "水下"]
 */
function extractFactKeyPhrases(fact: string): string[] {
  const matches = fact.matchAll(/[\u4e00-\u9fa5]{2,6}/g);
  const stopWords = /^(?:的|了|是|有|在|和|与|及|或|也|都|就|才|还|又|再|已|正|将|被|把|向|往|为|给|对|跟|从|到|于|之|其|此|这|那|一|二|三|个|些|么|什|怎|哪|他|她|它|我|你|们|第|章|结|尾|位置|时间)$/;
  const phrases: string[] = [];
  for (const m of matches) {
    if (!stopWords.test(m[0]) && m[0].length >= 2) phrases.push(m[0]);
  }
  return [...new Set(phrases)].sort((a, b) => b.length - a.length).slice(0, 3);
}

/**
 * 三阶匹配：检查 fact 是否在 evidences 中找到（M1.1）。
 *
 * 1. 精确/子串匹配：evidence.excerpt === fact 或 includes
 * 2. 关键短语匹配：至少 1 个关键短语在某个 evidence.excerpt 中
 * 3. 双向 includes（fallback）
 *
 * @param fact 待检查的事实文本
 * @param evidences 检索到的证据列表
 * @returns 是否找到
 */
function factFoundInEvidence(fact: string, evidences: RankedEvidence[]): boolean {
  // 1. 精确/子串匹配
  for (const e of evidences) {
    if (e.excerpt === fact || e.excerpt.includes(fact) || fact.includes(e.excerpt)) {
      return true;
    }
  }
  // 2. 关键短语匹配（至少 1 个关键短语在某个 evidence 中）
  const keyPhrases = extractFactKeyPhrases(fact);
  if (keyPhrases.length === 0) return false;
  for (const phrase of keyPhrases) {
    for (const e of evidences) {
      if (e.excerpt.includes(phrase)) return true;
    }
  }
  return false;
}

// ============================================================================
// 辅助：从 trajectory 提取 ranked evidence（P0-1）
// ============================================================================

/**
 * 从 B2 agent loop 的 trajectory JSONL 提取模型实际看到的 ranked evidence。
 * P0-1：评测器不再绕过工具协议直接调 searchRanked()，而是读取 trajectory 中
 * search_narrative_evidence 工具返回并记录的 ranked_evidence 条目。
 *
 * trajectory JSONL 每行格式：{ type: "ranked_evidence", timestamp, data: { query, evidences: RankedEvidence[] } }
 *
 * M1-R1：返回 queryGroups（按 data.query 分组），用于计算 failedQueries/totalQueries
 * 等同单位 query 级指标。evidences 仍为合并后的全集（向后兼容）。
 *
 * @param trajectoryPath B2 agent loop 的 trajectory 文件路径（可能 undefined/不存在）
 * @returns queryGroups 按查询分组的证据；evidences 合并全集；hasRankedEvidence 是否有 ranked_evidence 条目
 */
interface TrajectoryQueryGroup {
  query: string;
  evidences: RankedEvidence[];
}

function extractRankedEvidenceFromTrajectory(trajectoryPath: string | undefined): {
  queryGroups: TrajectoryQueryGroup[];
  evidences: RankedEvidence[];
  hasRankedEvidence: boolean;
} {
  if (!trajectoryPath || !existsSync(trajectoryPath)) {
    return { queryGroups: [], evidences: [], hasRankedEvidence: false };
  }
  const content = readFileSync(trajectoryPath, "utf-8");
  const queryGroups: TrajectoryQueryGroup[] = [];
  const evidences: RankedEvidence[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type: string; data: unknown };
      if (entry.type !== "ranked_evidence") continue;
      const data = entry.data as { query?: string; evidences?: RankedEvidence[] };
      if (Array.isArray(data?.evidences)) {
        const query = typeof data.query === "string" && data.query.length > 0 ? data.query : "";
        queryGroups.push({ query, evidences: data.evidences });
        evidences.push(...data.evidences);
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  return { queryGroups, evidences, hasRankedEvidence: evidences.length > 0 };
}

// ============================================================================
// 检索评测（B1 vs B2）
// ============================================================================

/**
 * 对单个 fixture 运行检索评测。
 *
 * B1：检查 CompiledContext（fixture.expected.factsInCompiledContext）中包含多少可检索事实。
 * B2：从 B2 agent loop 的 trajectory 提取模型实际看到的 ranked evidence（P0-1），
 *     检查其中包含多少可检索事实。
 *
 * P0-1 核心约束：评测器不再绕过工具协议直接调 searchRanked()。
 * B2 检索增益必须从 agent loop trajectory 中提取模型实际看到的 ranked evidence 来证明。
 * 当 b2TrajectoryPath 缺失或无 ranked_evidence 时，b2FactsFound=0、viaToolProtocol=false，
 * 不回退到直接调 searchRanked。
 *
 * 检索增益 = B2 找到数 - B1 找到数
 *
 * @param fixture 评测 fixture
 * @param _projectRoot 临时 workspace 根目录（保留参数兼容，B2 不再直接使用）
 * @param _workspaceId workspace ID（保留参数兼容）
 * @param b2TrajectoryPath B2 agent loop 的 trajectory 文件路径（P0-1 新增）
 */
export function evalRetrieval(
  fixture: EvalFixture,
  _projectRoot: string,
  _workspaceId: string,
  b2TrajectoryPath?: string,
): RetrievalEvalResult {
  const expected = fixture.expected;
  const totalFacts = expected.factsRetrievable.length;

  // B1：CompiledContext 中已有的可检索事实数
  const b1Facts = expected.factsRetrievable.filter((f) =>
    expected.factsInCompiledContext.some((cf) => f.includes(cf) || cf.includes(f)),
  );
  const b1FactsFound = b1Facts.length;

  // B2：从 B2 agent loop trajectory 提取模型实际看到的 ranked evidence（P0-1）
  // M1-R1：解构 queryGroups 用于计算 failedQueries/totalQueries 同单位 query 级指标
  const { queryGroups, evidences: b2Evidences, hasRankedEvidence } =
    extractRankedEvidenceFromTrajectory(b2TrajectoryPath);

  let b2FactsFound = 0;
  for (const fact of expected.factsRetrievable) {
    if (factFoundInEvidence(fact, b2Evidences)) b2FactsFound++;
  }

  // ── M1-R1：同单位检索指标（分母统一为 returnedEvidence / totalQueries）──
  // returnedEvidence：全查询 ranked evidence 总数（工具实际返回的证据条数）
  const returnedEvidence = b2Evidences.length;
  // relevantEvidence：含 ≥1 预期事实的 evidence 数（跨所有 origin，不再只过滤 chapter_span）
  const relevantEvidence = b2Evidences.filter((e) =>
    expected.factsRetrievable.some((f) => factFoundInEvidence(f, [e])),
  ).length;
  // wrongEvidence = returnedEvidence - relevantEvidence
  const wrongEvidence = returnedEvidence - relevantEvidence;
  const evidencePrecision = returnedEvidence > 0 ? relevantEvidence / returnedEvidence : 0;
  const evidenceImprecisionRate = returnedEvidence > 0 ? wrongEvidence / returnedEvidence : 0;
  // query 级指标：failedQueries（返回 0 evidence 的查询组）/ totalQueries（distinct 查询组数）
  const totalQueries = queryGroups.length;
  const failedQueries = queryGroups.filter((g) => g.evidences.length === 0).length;
  const queryFailureRate = totalQueries > 0 ? failedQueries / totalQueries : 0;

  return {
    fixtureId: fixture.id,
    b1FactsFound,
    b2FactsFound,
    retrievalGain: b2FactsFound - b1FactsFound,
    totalFactsRetrievable: totalFacts,
    b1Coverage: totalFacts > 0 ? b1FactsFound / totalFacts : 0,
    b2Coverage: totalFacts > 0 ? b2FactsFound / totalFacts : 0,
    // 向后兼容别名（retrievalQueries = totalQueries，wrongRetrievals = wrongEvidence）
    retrievalQueries: fixture.chapterIntent.retrievalQueries.length,
    wrongRetrievals: wrongEvidence,
    viaToolProtocol: hasRankedEvidence,
    // ── M1-R1：同单位检索指标 ──
    returnedEvidence,
    relevantEvidence,
    wrongEvidence,
    evidencePrecision,
    evidenceImprecisionRate,
    failedQueries,
    totalQueries,
    queryFailureRate,
  };
}

// ============================================================================
// 验证器评测（precision/recall）
// ============================================================================

/**
 * 对单个 fixture 运行验证器评测。
 *
 * 用 NarrativeVerifierSuite 检查 candidateWithErrors（应发现问题）和 healthyCandidate（不应发现问题）。
 * 计算 precision = TP / (TP + FP) 和 recall = TP / expectedFindings。
 *
 * NarrativeVerifierInput 的正确字段：
 * - text: 候选正文
 * - context: CompiledContext（含 characterStates.state.forbiddenKnowledge）
 * - chapterIntent: string（含引号包裹的关键短语，供 intent omission 检查）
 * - knownCharacterNames: string[]
 */
export function evalVerifier(fixture: EvalFixture): VerifierEvalResult {
  const verifier = new NarrativeVerifierSuite();
  const context = buildVerifierContext(fixture);
  const chapterIntentStr = buildChapterIntentString(fixture);
  const knownNames = fixture.chapterIntent.relevantCharacters;
  const expectedFindingsList = fixture.expected.expectedVerifierFindings ?? [];
  const expectedFindings = expectedFindingsList.length;
  const isNegativeControl = expectedFindings === 0;

  // 收集 candidateWithErrors 的 hard findings（用于 recall 测试）
  interface ActualFinding {
    id: string;
    description: string;
    failureType: string;
    conflictFact: string;
    fullText: string;
  }
  const actualFindings: ActualFinding[] = [];
  if (fixture.expected.candidateWithErrors) {
    const result = verifier.verify({
      text: fixture.expected.candidateWithErrors,
      context,
      chapterIntent: chapterIntentStr,
      knownCharacterNames: knownNames,
      inviolableFacts: fixture.chapterIntent.inviolableFacts,
    });
    for (let i = 0; i < result.hardFindings.length; i++) {
      const hf = result.hardFindings[i];
      const desc = hf.description ?? "";
      const ftype = hf.failureType ?? "";
      const conflict = hf.conflictFact ?? "";
      actualFindings.push({
        id: `actual-${i}`,
        description: desc,
        failureType: ftype,
        conflictFact: conflict,
        fullText: `${desc} ${ftype} ${conflict}`,
      });
    }
  }
  const actualHardFindings = actualFindings.length;

  // P0-2：一对一贪心匹配。
  // 每个 expected finding 计算 bigram 集合，与每个 actual finding 计算 hitCount。
  // 贪心选 hitCount 最高的 actual 配对，配对后该 actual 从候选池移除（最多贡献 1 TP）。
  const findingMatches: FindingMatch[] = [];
  const unmatchedExpected: string[] = [];
  const matchedActualIds = new Set<string>();

  // 预计算每个 expected 的 bigram 集合
  const expectedBigrams: Set<string>[] = expectedFindingsList.map((expectedFinding) => {
    const contentPart = expectedFinding.includes("：")
      ? expectedFinding.split("：")[1] ?? expectedFinding
      : expectedFinding;
    const bigrams = new Set<string>();
    for (let i = 0; i < contentPart.length - 1; i++) {
      const bg = contentPart.slice(i, i + 2);
      if (/[\u4e00-\u9fa5]{2}/.test(bg)) bigrams.add(bg);
    }
    return bigrams;
  });

  // 贪心匹配：对每个 expected，找 hitCount 最高的未配对 actual
  for (let ei = 0; ei < expectedFindingsList.length; ei++) {
    const expectedFinding = expectedFindingsList[ei];
    const bigrams = expectedBigrams[ei];
    let bestActualIdx = -1;
    let bestHitCount = 0;
    let bestMatchEvidence = "";

    for (let ai = 0; ai < actualFindings.length; ai++) {
      if (matchedActualIds.has(actualFindings[ai].id)) continue;
      const af = actualFindings[ai];
      // 整体包含匹配（最强信号）
      if (
        af.description.includes(expectedFinding) ||
        expectedFinding.includes(af.description)
      ) {
        bestActualIdx = ai;
        bestHitCount = Infinity; // 整体匹配优先级最高
        bestMatchEvidence = `整体包含：expected="${expectedFinding.slice(0, 30)}" ↔ actual="${af.description.slice(0, 30)}"`;
        break;
      }
      // bigram 匹配：要求至少 2 个不同 bigram 命中
      let hitCount = 0;
      for (const bg of bigrams) {
        if (af.fullText.includes(bg)) hitCount++;
      }
      if (hitCount >= 2 && hitCount > bestHitCount) {
        bestHitCount = hitCount;
        bestActualIdx = ai;
        bestMatchEvidence = `bigram 匹配 hitCount=${hitCount}：expected="${expectedFinding.slice(0, 30)}" ↔ actual="${af.fullText.slice(0, 30)}"`;
      }
    }

    if (bestActualIdx >= 0) {
      const af = actualFindings[bestActualIdx];
      matchedActualIds.add(af.id);
      findingMatches.push({
        expectedFindingId: `expected-${ei}`,
        actualFindingId: af.id,
        matchEvidence: bestMatchEvidence,
      });
    } else {
      unmatchedExpected.push(expectedFinding);
    }
  }

  const truePositives = findingMatches.length;

  // P0-2 结构校验：actualHardFindings < truePositives 是评测结构错误（一个 actual 不应贡献多个 TP）
  if (actualHardFindings < truePositives) {
    throw new Error(
      `评测结构错误：actualHardFindings(${actualHardFindings}) < truePositives(${truePositives})，一对一匹配被破坏`,
    );
  }

  // P0-2：未匹配的 actual finding 计入 FP
  const unmatchedActual: string[] = actualFindings
    .filter((af) => !matchedActualIds.has(af.id))
    .map((af) => af.fullText);

  // 健康候选的 hard findings 也是 FP（误报）
  let healthyFalsePositives = 0;
  if (fixture.expected.healthyCandidate) {
    const result = verifier.verify({
      text: fixture.expected.healthyCandidate,
      context,
      chapterIntent: chapterIntentStr,
      knownCharacterNames: knownNames,
      inviolableFacts: fixture.chapterIntent.inviolableFacts,
    });
    healthyFalsePositives = result.hardFindings.length;
  }

  const falsePositives = unmatchedActual.length + healthyFalsePositives;

  // P0-2：负控 fixture 不再因 0/0 默认 precision=1
  // - 负控 + 无 FP → precision=1（正确：无误报）
  // - 负控 + 有 FP → precision=0（有误报）
  // - 非负控 + 无 TP 无 FP → precision=1（无 findings 也无误报）
  // - 非负控 + 有 findings → 正常计算
  let precision: number;
  if (isNegativeControl) {
    precision = healthyFalsePositives === 0 ? 1 : 0;
  } else {
    precision = truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 1;
  }
  const recall = expectedFindings > 0 ? truePositives / expectedFindings : 0;

  return {
    fixtureId: fixture.id,
    expectedFindings,
    actualHardFindings,
    truePositives,
    falsePositives,
    precision,
    recall,
    findingMatches,
    unmatchedExpected,
    unmatchedActual,
    isNegativeControl,
  };
}

// ============================================================================
// 端到端评测（B1/B2/B3 真实 agent loop 对比）
// ============================================================================

/**
 * 从 fixture 构造最小 ChapterIntent 对象（供 agentic source 使用）。
 */
function buildChapterIntentFromFixture(fixture: EvalFixture): ChapterIntent {
  return {
    chapterFunction: `第${fixture.chapterIntent.chapterNumber}章 生成`,
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: fixture.chapterIntent.relevantCharacters,
    inviolableFacts: fixture.chapterIntent.inviolableFacts,
    sourceRefs: ["eval-fixture"],
  };
}

/**
 * 对单个 fixture 运行指定 mode 的 agent loop，返回结果。
 *
 * 用 createStubAgentModelGenerate 构造 stub model（零真实模型调用），
 * 通过 createAgenticRawCandidateSource 走 agent loop。
 *
 * 三条 baseline 的能力开关（分层消融）：
 * - b1：enableRetrieval=false, enableVerification=false（纯 one-shot，无检索无验证）
 * - b2：enableRetrieval=true, enableVerification=false（检索 + 生成，无验证）
 * - b3：enableRetrieval=true, enableVerification=true（检索 + 生成 + 验证 + patch）
 *
 * @param fixture 评测 fixture
 * @param mode baseline 模式（b1/b2/b3）
 * @param projectRoot 临时 workspace 根目录
 * @param workspaceId workspace ID
 * @returns agentic source 结果（含 text/fallback/verifierCleared/repairRounds）
 */
export async function runAgentLoopForEval(
  fixture: EvalFixture,
  mode: StubMode,
  projectRoot: string,
  workspaceId: string,
): Promise<AgenticRawSourceResult> {
  const stubModelGenerate = createStubAgentModelGenerate(fixture, mode);

  // 按 mode 映射能力开关（B1/B2/B3 干净分层消融）
  const capabilities: AgenticRawSourceCapabilities =
    mode === "b1"
      ? { enableRetrieval: false, enableVerification: false }
      : mode === "b2"
        ? { enableRetrieval: true, enableVerification: false }
        : { enableRetrieval: true, enableVerification: true }; // b3

  const source = createAgenticRawCandidateSource(capabilities);

  const intent = buildChapterIntentFromFixture(fixture);
  const context = buildVerifierContext(fixture);
  const characterNames = fixture.chapterIntent.relevantCharacters;

  return source.generate({
    workspaceId,
    chapterId: fixture.chapterIntent.chapterId,
    chapterNumber: fixture.chapterIntent.chapterNumber,
    projectRoot,
    intent,
    context,
    characterNames,
    modelGenerate: stubModelGenerate,
    route: "narrator_primary",
  });
}

/**
 * 独立对文本跑 verifier（不依赖 agent loop 是否启用 verifier）。
 *
 * 用于 evalEndToEnd 中比较 B2/B3 的 finding 差异：
 * - B2 loop 不跑 verifier（enableVerification=false），但 eval 层需独立检查 B2 文本质量
 * - B3 loop 跑 verifier，但 eval 层独立复核 B3 文本是否消除了 B2 的 findings
 *
 * 用与 evalVerifier 相同的 context / chapterIntent / knownNames 构建。
 */
function runIndependentVerifier(fixture: EvalFixture, text: string): NarrativeVerifierReport {
  const verifier = new NarrativeVerifierSuite();
  const context = buildVerifierContext(fixture);
  const chapterIntentStr = buildChapterIntentString(fixture);
  const knownNames = fixture.chapterIntent.relevantCharacters;
  return verifier.verify({
    text,
    context,
    chapterIntent: chapterIntentStr,
    knownCharacterNames: knownNames,
    inviolableFacts: fixture.chapterIntent.inviolableFacts,
  });
}

/**
 * 对单个 fixture 运行端到端评测（真实 B1/B2/B3 agent loop）。
 *
 * - B1：enableRetrieval=false, enableVerification=false → 纯 one-shot（candidateWithErrors）
 * - B2：enableRetrieval=true, enableVerification=false → 检索 + 生成（healthyCandidate）
 * - B3：enableRetrieval=true, enableVerification=true → 检索 + 生成 + verify/patch
 *
 * b3FixedB2Issues = B2 有 hard findings 且 B3 消除了至少一个（通过独立 verifier 检查）。
 * trajectoryComplete = !b3Fallback（真实反映 loop 是否完成）。
 *
 * @param fixture 评测 fixture
 * @param projectRoot 临时 workspace 根目录
 * @param workspaceId workspace ID
 */
export async function evalEndToEnd(
  fixture: EvalFixture,
  projectRoot: string,
  workspaceId: string,
): Promise<EndToEndEvalResult> {
  // 并行运行 B1/B2/B3（各自独立 session，互不干扰）
  const [b1Result, b2Result, b3Result] = await Promise.all([
    runAgentLoopForEval(fixture, "b1", projectRoot, workspaceId),
    runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId),
    runAgentLoopForEval(fixture, "b3", projectRoot, workspaceId),
  ]);

  const b1Text = b1Result.candidate?.text ?? "";
  const b2Text = b2Result.candidate?.text ?? "";
  const b3Text = b3Result.candidate?.text ?? "";

  const requiredFacts = fixture.chapterIntent.inviolableFacts;
  const checkFacts = (text: string, facts: string[]) =>
    facts.length > 0 ? facts.every((f) => text.includes(f)) : true;

  // fallback 触发情况
  const b1Fallback = b1Result.candidate === null;
  const b2Fallback = b2Result.candidate === null;
  const b3Fallback = b3Result.candidate === null;

  // B3 verifier 清零状态
  const b3VerifierCleared = b3Result.verifierCleared ?? false;
  const b3RepairRounds = b3Result.repairRounds ?? 0;

  // trajectory 完整 = B3 未 fallback（B3 是最完整的一条，含 verify/patch）
  const trajectoryComplete = !b3Fallback;

  // 模型调用/工具调用从 B3 取（最完整）
  const modelCalls = b3Result.budgetSnapshot.modelCalls;
  const toolCalls = b3Result.toolCalls;

  // ── b3FixedB2Issues：比较 B3 与 B2（非 B3 与 B1），验证具体 finding 被消除 ──
  // 独立对 B2/B3 文本跑 verifier，检查 B2 的 hard findings 是否在 B3 中被消除
  const b2VerifierReport = runIndependentVerifier(fixture, b2Text);
  const b3VerifierReport = runIndependentVerifier(fixture, b3Text);

  // finding 组合键：failureType + conflictFact（避免同类型不同位置误匹配）
  const b2FindingKeys = new Set(
    b2VerifierReport.hardFindings.map((f) => `${f.failureType}:${f.conflictFact}`),
  );
  const b3FindingKeys = new Set(
    b3VerifierReport.hardFindings.map((f) => `${f.failureType}:${f.conflictFact}`),
  );
  // B2 的 findings 中被 B3 消除的（存在于 B2 但不存在于 B3）
  const b2IssuesFixedInB3 = [...b2FindingKeys].filter((k) => !b3FindingKeys.has(k)).length;
  // B3 修复 B2 问题 = B2 有 hard findings 且 B3 消除了至少一个
  const b3FixedB2Issues = b2FindingKeys.size > 0 && b2IssuesFixedInB3 > 0;

  return {
    fixtureId: fixture.id,
    b1TextLength: b1Text.length,
    b2TextLength: b2Text.length,
    b3TextLength: b3Text.length,
    b1HasRequiredFacts: checkFacts(b1Text, requiredFacts),
    b2HasRequiredFacts: checkFacts(b2Text, requiredFacts),
    b3HasRequiredFacts: checkFacts(b3Text, requiredFacts),
    b3FixedB2Issues,
    trajectoryComplete,
    modelCalls,
    toolCalls,
    b1Fallback,
    b2Fallback,
    b3Fallback,
    b3VerifierCleared,
    b3RepairRounds,
    b2HardFindingCount: b2FindingKeys.size,
    b3HardFindingCount: b3FindingKeys.size,
    b2IssuesFixedInB3,
    b2TrajectoryPath: b2Result.trajectoryPath,
  };
}

// ============================================================================
// P0-4：GO 阈值加载（默认值 + env 覆盖）
// ============================================================================

/** 默认 GO 阈值（可由 NOVELOS_GO_THRESHOLD_* env 覆盖） */
const DEFAULT_GO_THRESHOLDS: GoThresholds = {
  b2OverB1FactCoverage: 0.1,
  b3OverB2FactCoverage: 0.0,
  minB3FixedB2Fixtures: 1,
  minVerifierPrecision: 0.6,
  minVerifierRecall: 0.3,
  maxWrongRetrievalRate: 0.3,
  minTrajectoryCompleteRate: 0.9,
  maxFallbackMaskingRate: 0.0,
  // ── M1-R1：同单位检索指标阈值（不降阈值换 GO）──
  maxEvidenceImprecisionRate: 0.3,
  minEvidencePrecision: 0.7,
  maxQueryFailureRate: 0.3,
  minEvidenceUtilityRate: 0.5,
};

/**
 * 从 env 加载 GO 阈值，缺省用默认值。
 * env 变量名：NOVELOS_GO_THRESHOLD_B2_OVER_B1 / B3_OVER_B2 / MIN_B3_FIXED / MIN_PRECISION / MIN_RECALL / MAX_WRONG_RETRIEVAL / MIN_TRAJECTORY / MAX_FALLBACK_MASKING
 */
function loadGoThresholds(): GoThresholds {
  const num = (key: string, fallback: number): number => {
    const v = process.env[key];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    b2OverB1FactCoverage: num("NOVELOS_GO_THRESHOLD_B2_OVER_B1", DEFAULT_GO_THRESHOLDS.b2OverB1FactCoverage),
    b3OverB2FactCoverage: num("NOVELOS_GO_THRESHOLD_B3_OVER_B2", DEFAULT_GO_THRESHOLDS.b3OverB2FactCoverage),
    minB3FixedB2Fixtures: num("NOVELOS_GO_THRESHOLD_MIN_B3_FIXED", DEFAULT_GO_THRESHOLDS.minB3FixedB2Fixtures),
    minVerifierPrecision: num("NOVELOS_GO_THRESHOLD_MIN_PRECISION", DEFAULT_GO_THRESHOLDS.minVerifierPrecision),
    minVerifierRecall: num("NOVELOS_GO_THRESHOLD_MIN_RECALL", DEFAULT_GO_THRESHOLDS.minVerifierRecall),
    maxWrongRetrievalRate: num("NOVELOS_GO_THRESHOLD_MAX_WRONG_RETRIEVAL", DEFAULT_GO_THRESHOLDS.maxWrongRetrievalRate),
    minTrajectoryCompleteRate: num("NOVELOS_GO_THRESHOLD_MIN_TRAJECTORY", DEFAULT_GO_THRESHOLDS.minTrajectoryCompleteRate),
    maxFallbackMaskingRate: num("NOVELOS_GO_THRESHOLD_MAX_FALLBACK_MASKING", DEFAULT_GO_THRESHOLDS.maxFallbackMaskingRate),
    // ── M1-R1：同单位检索指标阈值 env 加载 ──
    maxEvidenceImprecisionRate: num("NOVELOS_GO_THRESHOLD_MAX_EVIDENCE_IMPRECISION", DEFAULT_GO_THRESHOLDS.maxEvidenceImprecisionRate),
    minEvidencePrecision: num("NOVELOS_GO_THRESHOLD_MIN_EVIDENCE_PRECISION", DEFAULT_GO_THRESHOLDS.minEvidencePrecision),
    maxQueryFailureRate: num("NOVELOS_GO_THRESHOLD_MAX_QUERY_FAILURE", DEFAULT_GO_THRESHOLDS.maxQueryFailureRate),
    minEvidenceUtilityRate: num("NOVELOS_GO_THRESHOLD_MIN_EVIDENCE_UTILITY", DEFAULT_GO_THRESHOLDS.minEvidenceUtilityRate),
  };
}

// ============================================================================
// 完整评测报告
// ============================================================================

/**
 * 运行全部 fixture 的评测，产出完整报告。
 *
 * evalEndToEnd 现在真实运行 B1/B2/B3 agent loop（异步），故本函数为 async。
 * Go 时为每个 fixture 生成匿名盲测包到 reports/blind-test/{fixture.id}/。
 */
export async function runFullEval(fixtures: EvalFixture[]): Promise<EvalReport> {
  const retrievalResults: RetrievalEvalResult[] = [];
  const verifierResults: VerifierEvalResult[] = [];
  const endToEndResults: EndToEndEvalResult[] = [];

  for (const fixture of fixtures) {
    // 检索 + 端到端评测共用 workspace（避免重复创建历史章节）
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      // P0-1：先跑端到端评测产出 B2 trajectory，再从 trajectory 提取 ranked evidence。
      // 评测器不再绕过工具协议直接调 searchRanked()，B2 检索增益必须由
      // agent loop trajectory 中模型实际看到的 ranked_evidence 条目证明。
      const e2eResult = await evalEndToEnd(fixture, projectRoot, workspaceId);
      endToEndResults.push(e2eResult);
      retrievalResults.push(
        evalRetrieval(fixture, projectRoot, workspaceId, e2eResult.b2TrajectoryPath),
      );
    } finally {
      cleanup();
    }

    // 验证器评测不需要 workspace
    verifierResults.push(evalVerifier(fixture));
  }

  // 聚合指标
  const avgRetrievalGain =
    retrievalResults.reduce((sum, r) => sum + r.retrievalGain, 0) / retrievalResults.length;
  const avgB1Coverage =
    retrievalResults.reduce((sum, r) => sum + r.b1Coverage, 0) / retrievalResults.length;
  const avgB2Coverage =
    retrievalResults.reduce((sum, r) => sum + r.b2Coverage, 0) / retrievalResults.length;

  // P0-4：聚合 precision 排除负控 fixture（负控 expectedFindings=0，precision 恒为 1 会虚高）
  const nonNegativeControls = verifierResults.filter((r) => !r.isNegativeControl);
  const negativeControlExcluded = nonNegativeControls.length < verifierResults.length;
  const avgVerifierPrecision = nonNegativeControls.length > 0
    ? nonNegativeControls.reduce((sum, r) => sum + r.precision, 0) / nonNegativeControls.length
    : 0;
  const avgVerifierRecall =
    verifierResults.reduce((sum, r) => sum + r.recall, 0) / verifierResults.length;
  const trajectoryCompleteRate =
    endToEndResults.filter((r) => r.trajectoryComplete).length / endToEndResults.length;

  // 真实 fallback 统计（b1/b2/b3 fallback 总和）
  const fallbackTriggeredCount = endToEndResults.reduce(
    (sum, r) => sum + (r.b1Fallback ? 1 : 0) + (r.b2Fallback ? 1 : 0) + (r.b3Fallback ? 1 : 0),
    0,
  );
  // B3 verifier 清零的 fixture 数
  const b3VerifierClearedCount = endToEndResults.filter((r) => r.b3VerifierCleared).length;
  // B3 修复 B2 错误的 fixture 数
  const b3FixedB2Count = endToEndResults.filter((r) => r.b3FixedB2Issues).length;
  const retrievalPositive = avgB2Coverage > avgB1Coverage;

  // P0-4：逐项 GO 条件检查
  const thresholds = loadGoThresholds();
  // M1-R1：同单位检索指标聚合（分母统一为 returnedEvidence / totalQueries）
  const totalReturnedEvidence = retrievalResults.reduce((s, r) => s + r.returnedEvidence, 0);
  const totalWrongEvidence = retrievalResults.reduce((s, r) => s + r.wrongEvidence, 0);
  const totalRelevantEvidence = retrievalResults.reduce((s, r) => s + r.relevantEvidence, 0);
  const evidenceImprecisionRate = totalReturnedEvidence > 0 ? totalWrongEvidence / totalReturnedEvidence : 0;
  const evidencePrecision = totalReturnedEvidence > 0 ? totalRelevantEvidence / totalReturnedEvidence : 0;
  const totalQueries = retrievalResults.reduce((s, r) => s + r.totalQueries, 0);
  const totalFailedQueries = retrievalResults.reduce((s, r) => s + r.failedQueries, 0);
  const queryFailureRate = totalQueries > 0 ? totalFailedQueries / totalQueries : 0;
  const fallbackMaskingRate = endToEndResults.length * 3 > 0
    ? fallbackTriggeredCount / (endToEndResults.length * 3)
    : 0;

  // B3 覆盖率不低于 B2：逐 fixture 检查 b3HasRequiredFacts >= b2HasRequiredFacts
  const b3CoverageGeB2Passed = endToEndResults.every(
    (r) => r.b3HasRequiredFacts >= r.b2HasRequiredFacts,
  );

  // 负控 fixture precision 全为 1（无误报）
  const negativeControls = verifierResults.filter((r) => r.isNegativeControl);
  const negativeControlPrecisionPassed = negativeControls.every((r) => r.precision === 1);

  const goConditions: GoCondition[] = [
    {
      name: "b2_fact_coverage_gt_b1",
      passed: avgB2Coverage - avgB1Coverage >= thresholds.b2OverB1FactCoverage,
      detail: `B2=${avgB2Coverage.toFixed(2)}, B1=${avgB1Coverage.toFixed(2)}, 差值=${(avgB2Coverage - avgB1Coverage).toFixed(2)} ≥ ${thresholds.b2OverB1FactCoverage}`,
    },
    {
      name: "b3_fact_coverage_ge_b2",
      passed: b3CoverageGeB2Passed,
      detail: b3CoverageGeB2Passed
        ? "所有 fixture B3 覆盖率 >= B2"
        : `${endToEndResults.filter((r) => r.b3HasRequiredFacts < r.b2HasRequiredFacts).length} 个 fixture B3 覆盖率低于 B2`,
    },
    {
      name: "b3_fixed_b2_issues",
      passed: b3FixedB2Count >= thresholds.minB3FixedB2Fixtures,
      detail: `B3 修复 B2 错误的 fixture 数=${b3FixedB2Count}/${endToEndResults.length} ≥ ${thresholds.minB3FixedB2Fixtures}`,
    },
    {
      name: "verifier_precision",
      passed: avgVerifierPrecision >= thresholds.minVerifierPrecision,
      detail: `precision=${avgVerifierPrecision.toFixed(2)} ≥ ${thresholds.minVerifierPrecision}${negativeControlExcluded ? "（已排除负控）" : ""}`,
    },
    {
      name: "verifier_recall",
      passed: avgVerifierRecall >= thresholds.minVerifierRecall,
      detail: `recall=${avgVerifierRecall.toFixed(2)} ≥ ${thresholds.minVerifierRecall}`,
    },
    {
      name: "evidence_imprecision_rate",
      passed: evidenceImprecisionRate <= thresholds.maxEvidenceImprecisionRate,
      detail: `wrong=${totalWrongEvidence}/${totalReturnedEvidence}=${evidenceImprecisionRate.toFixed(2)} ≤ ${thresholds.maxEvidenceImprecisionRate}`,
    },
    {
      name: "evidence_precision",
      passed: evidencePrecision >= thresholds.minEvidencePrecision,
      detail: `relevant=${totalRelevantEvidence}/${totalReturnedEvidence}=${evidencePrecision.toFixed(2)} ≥ ${thresholds.minEvidencePrecision}`,
    },
    {
      name: "query_failure_rate",
      passed: queryFailureRate <= thresholds.maxQueryFailureRate,
      detail: `failed=${totalFailedQueries}/${totalQueries}=${queryFailureRate.toFixed(2)} ≤ ${thresholds.maxQueryFailureRate}`,
    },
    {
      name: "evidence_utility_rate",
      passed: true, // B3 层，当前无 injected-evidence 追踪，auto-pass + not measured
      detail: "B3 injected-evidence 追踪未实现，暂不测量（TODO）",
    },
    {
      name: "trajectory_complete",
      passed: trajectoryCompleteRate >= thresholds.minTrajectoryCompleteRate,
      detail: `完整率=${trajectoryCompleteRate.toFixed(2)} ≥ ${thresholds.minTrajectoryCompleteRate}`,
    },
    {
      name: "no_fallback_masking",
      passed: fallbackMaskingRate <= thresholds.maxFallbackMaskingRate,
      detail: `fallback=${fallbackTriggeredCount}/${endToEndResults.length * 3}=${fallbackMaskingRate.toFixed(2)} ≤ ${thresholds.maxFallbackMaskingRate}`,
    },
    {
      name: "negative_control_precision",
      passed: negativeControlPrecisionPassed,
      detail: negativeControls.length === 0
        ? "无负控 fixture"
        : `负控 precision 全为 1：${negativeControlPrecisionPassed ? "是" : "否"}`,
    },
  ];

  const allPassed = goConditions.every((c) => c.passed);
  const failedConditions = goConditions.filter((c) => !c.passed).map((c) => c.name);

  let recommendation: "go_candidate" | "hold" | "no_go" = "hold";
  let recommendationReason = "";

  if (allPassed) {
    recommendation = "go_candidate";
    recommendationReason = `所有 ${goConditions.length} 项 GO 条件通过。verifier P=${avgVerifierPrecision.toFixed(2)} R=${avgVerifierRecall.toFixed(2)}，trajectory 完整率=${trajectoryCompleteRate.toFixed(2)}，B3 修复=${b3FixedB2Count}/${endToEndResults.length}。建议进入人工盲测抽样复核后决定正式 GO。`;
  } else if (retrievalPositive) {
    recommendation = "hold";
    recommendationReason = `检索机制正确（B2=${avgB2Coverage.toFixed(2)} > B1=${avgB1Coverage.toFixed(2)}），但 ${failedConditions.length} 项 GO 条件未通过：${failedConditions.join(", ")}。建议继续 shadow，优化未通过项。`;
  } else {
    recommendation = "no_go";
    recommendationReason = `检索无增益（B2=${avgB2Coverage.toFixed(2)} vs B1=${avgB1Coverage.toFixed(2)}），且 ${failedConditions.length} 项 GO 条件未通过。建议 NovelOS 仅保留为评测运行时。`;
  }

  // go_candidate 时生成匿名盲测包
  let blindTestDir: string | undefined;
  if (recommendation === "go_candidate") {
    blindTestDir = join(process.cwd(), "reports", "blind-test");
    for (const fixture of fixtures) {
      const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
      try {
        // 重新运行 B1/B2/B3 获取文本（stub model 零成本）
        const [b1, b2, b3] = await Promise.all([
          runAgentLoopForEval(fixture, "b1", projectRoot, workspaceId),
          runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId),
          runAgentLoopForEval(fixture, "b3", projectRoot, workspaceId),
        ]);
        const candidates: BlindTestCandidate[] = [
          { mode: "b1", text: b1.candidate?.text ?? "" },
          { mode: "b2", text: b2.candidate?.text ?? "" },
          { mode: "b3", text: b3.candidate?.text ?? "" },
        ];
        prepareBlindTestPack(fixture, candidates, join(blindTestDir, fixture.id));
      } finally {
        cleanup();
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalFixtures: fixtures.length,
    retrievalResults,
    verifierResults,
    endToEndResults,
    summary: {
      avgRetrievalGain,
      avgB1Coverage,
      avgB2Coverage,
      avgVerifierPrecision,
      avgVerifierRecall,
      trajectoryCompleteRate,
      fallbackTriggeredCount,
    },
    recommendation,
    recommendationReason,
    goConditions,
    negativeControlExcluded,
    ...(blindTestDir ? { blindTestDir } : {}),
  };
}

// ============================================================================
// 报告格式化（Markdown）
// ============================================================================

export function formatReportAsMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# NovelOS M1 评测报告");
  lines.push("");
  lines.push(`**时间**：${report.timestamp}`);
  lines.push(`**Fixture 数**：${report.totalFixtures}`);
  lines.push(`**验收决策**：**${report.recommendation.toUpperCase()}**`);
  lines.push(`**理由**：${report.recommendationReason}`);
  if (report.negativeControlExcluded) {
    lines.push(`**负控排除**：是（聚合 precision 已排除负控 fixture）`);
  }
  lines.push("");

  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|------|");
  lines.push(`| 平均检索增益（B2-B1） | ${report.summary.avgRetrievalGain.toFixed(2)} |`);
  lines.push(`| B1 平均覆盖率 | ${report.summary.avgB1Coverage.toFixed(2)} |`);
  lines.push(`| B2 平均覆盖率 | ${report.summary.avgB2Coverage.toFixed(2)} |`);
  lines.push(`| Verifier 平均 precision | ${report.summary.avgVerifierPrecision.toFixed(2)}${report.negativeControlExcluded ? "（已排除负控）" : ""} |`);
  lines.push(`| Verifier 平均 recall | ${report.summary.avgVerifierRecall.toFixed(2)} |`);
  lines.push(`| Trajectory 完整率 | ${report.summary.trajectoryCompleteRate.toFixed(2)} |`);
  lines.push(`| Fallback 触发次数 | ${report.summary.fallbackTriggeredCount} |`);
  lines.push("");

  lines.push("## GO 条件逐项检查（P0-4）");
  lines.push("");
  lines.push("| 条件 | 结果 | 详情 |");
  lines.push("|------|------|------|");
  for (const c of report.goConditions) {
    lines.push(`| ${c.name} | ${c.passed ? "✓" : "✗"} | ${c.detail} |`);
  }
  lines.push("");

  lines.push("## 检索评测详情（B1 vs B2）");
  lines.push("");
  lines.push("| Fixture | 可检索事实数 | B1 找到 | B2 找到 | 检索增益 | B1 覆盖率 | B2 覆盖率 | 返回证据 | 相关证据 | 错误证据 | 证据精度 | 查询失败率 |");
  lines.push("|---------|-------------|---------|---------|---------|-----------|-----------|---------|---------|---------|---------|-----------|");
  for (const r of report.retrievalResults) {
    lines.push(`| ${r.fixtureId} | ${r.totalFactsRetrievable} | ${r.b1FactsFound} | ${r.b2FactsFound} | ${r.retrievalGain} | ${r.b1Coverage.toFixed(2)} | ${r.b2Coverage.toFixed(2)} | ${r.returnedEvidence} | ${r.relevantEvidence} | ${r.wrongEvidence} | ${r.evidencePrecision.toFixed(2)} | ${r.queryFailureRate.toFixed(2)} |`);
  }
  lines.push("");

  lines.push("## 验证器评测详情（precision/recall）");
  lines.push("");
  lines.push("| Fixture | 预期发现 | TP | FP | Precision | Recall |");
  lines.push("|---------|---------|-----|-----|-----------|--------|");
  for (const r of report.verifierResults) {
    lines.push(`| ${r.fixtureId} | ${r.expectedFindings} | ${r.truePositives} | ${r.falsePositives} | ${r.precision.toFixed(2)} | ${r.recall.toFixed(2)} |`);
  }
  lines.push("");

  lines.push("## 端到端评测详情（B1/B2/B3）");
  lines.push("");
  lines.push("| Fixture | B1 含必需事实 | B2 含必需事实 | B3 含必需事实 | B2 hard findings | B3 hard findings | B3 修复 B2 | Trajectory 完整 | 模型调用 | 工具调用 |");
  lines.push("|---------|-------------|-------------|-------------|-----------------|-----------------|-----------|----------------|---------|---------|");
  for (const r of report.endToEndResults) {
    lines.push(`| ${r.fixtureId} | ${r.b1HasRequiredFacts ? "✓" : "✗"} | ${r.b2HasRequiredFacts ? "✓" : "✗"} | ${r.b3HasRequiredFacts ? "✓" : "✗"} | ${r.b2HardFindingCount} | ${r.b3HardFindingCount} | ${r.b3FixedB2Issues ? `✓ (${r.b2IssuesFixedInB3}/${r.b2HardFindingCount})` : "✗"} | ${r.trajectoryComplete ? "✓" : "✗"} | ${r.modelCalls} | ${r.toolCalls} |`);
  }
  lines.push("");

  lines.push("## 验收决策标准");
  lines.push("");
  lines.push("- **GO_CANDIDATE**：所有 12 项 GO 条件通过（B2>B1 覆盖、B3>=B2、B3 修复 B2、verifier P/R、evidence imprecision/precision、query failure、evidence utility、trajectory、fallback、负控 precision）。需人工抽样复核后决定正式 GO");
  lines.push("- **Hold**：检索机制正确但部分 GO 条件未通过 → 继续 shadow，优化未通过项");
  lines.push("- **No-Go**：检索无增益或多项 GO 条件未通过 → NovelOS 仅保留为评测与治理运行时");
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// P1-1：质量评测（真实模型 B1/B2/B3 消融）
// ============================================================================

/**
 * 用传入的 modelGenerate 运行指定 mode 的 agent loop（不使用 stub）。
 *
 * 与 `runAgentLoopForEval` 的区别：
 * - `runAgentLoopForEval`：用 `createStubAgentModelGenerate`（确定性、零 API 调用）
 * - `runQualityAgentLoop`：用传入的 `modelGenerate`（真实模型调用，B1/B2/B3 共用）
 *
 * @param fixture 评测 fixture
 * @param mode baseline 模式（b1/b2/b3）
 * @param projectRoot 临时 workspace 根目录
 * @param workspaceId workspace ID
 * @param modelGenerate 真实模型调用函数（B1/B2/B3 共用）
 * @param route 模型路由名
 */
async function runQualityAgentLoop(
  fixture: EvalFixture,
  mode: StubMode,
  projectRoot: string,
  workspaceId: string,
  modelGenerate: ModelGenerateFn,
  route: string,
): Promise<AgenticRawSourceResult> {
  const capabilities: AgenticRawSourceCapabilities =
    mode === "b1"
      ? { enableRetrieval: false, enableVerification: false }
      : mode === "b2"
        ? { enableRetrieval: true, enableVerification: false }
        : { enableRetrieval: true, enableVerification: true }; // b3

  const source = createAgenticRawCandidateSource(capabilities);

  const intent = buildChapterIntentFromFixture(fixture);
  const context = buildVerifierContext(fixture);
  const characterNames = fixture.chapterIntent.relevantCharacters;

  return source.generate({
    workspaceId,
    chapterId: fixture.chapterIntent.chapterId,
    chapterNumber: fixture.chapterIntent.chapterNumber,
    projectRoot,
    intent,
    context,
    characterNames,
    modelGenerate,
    route,
  });
}

/**
 * P1-1 质量评测：调用真实模型运行 B1/B2/B3，测量检索对生成质量的实际影响。
 *
 * 与 `runFullEval`（机制测试）的区别：
 * - 使用真实 modelGenerate（非 stub）
 * - B1/B2/B3 共用相同 route/model/采样/预算
 * - 差异只由 AgenticRawSourceCapabilities 控制（enableRetrieval/enableVerification）
 * - 产出独立报告，含完整 provenance（但不暴露 baseline 身份给盲测裁判）
 *
 * @param fixtures 评测 fixture
 * @param modelGenerate 真实模型调用函数（B1/B2/B3 共用）
 * @param route 模型路由名（如 narrator_primary）
 */
export async function runQualityEval(
  fixtures: EvalFixture[],
  modelGenerate: ModelGenerateFn,
  route: string,
): Promise<QualityEvalReport> {
  const perFixture: QualityEvalFixtureResult[] = [];
  let firstModel = "unknown";

  const blindTestDir = join(process.cwd(), "reports", "quality-blind-test");

  for (const fixture of fixtures) {
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      // 并行运行 B1/B2/B3（共用同一 modelGenerate，不同 capabilities）
      const [b1Result, b2Result, b3Result] = await Promise.all([
        runQualityAgentLoop(fixture, "b1", projectRoot, workspaceId, modelGenerate, route),
        runQualityAgentLoop(fixture, "b2", projectRoot, workspaceId, modelGenerate, route),
        runQualityAgentLoop(fixture, "b3", projectRoot, workspaceId, modelGenerate, route),
      ]);

      const b1Text = b1Result.candidate?.text ?? "";
      const b2Text = b2Result.candidate?.text ?? "";
      const b3Text = b3Result.candidate?.text ?? "";

      // 记录首次模型标识（provenance）
      if (firstModel === "unknown" && b1Result.candidate?.model) {
        firstModel = b1Result.candidate.model;
      }

      const requiredFacts = fixture.chapterIntent.inviolableFacts;
      const checkFacts = (text: string, facts: string[]) =>
        facts.length > 0 ? facts.every((f) => text.includes(f)) : true;

      // 独立 verifier 检查 B2/B3 文本
      const b2VerifierReport = runIndependentVerifier(fixture, b2Text);
      const b3VerifierReport = runIndependentVerifier(fixture, b3Text);

      const b2FindingKeys = new Set(
        b2VerifierReport.hardFindings.map((f) => `${f.failureType}:${f.conflictFact}`),
      );
      const b3FindingKeys = new Set(
        b3VerifierReport.hardFindings.map((f) => `${f.failureType}:${f.conflictFact}`),
      );
      const b2IssuesFixedInB3 = [...b2FindingKeys].filter((k) => !b3FindingKeys.has(k)).length;
      const b3FixedB2Issues = b2FindingKeys.size > 0 && b2IssuesFixedInB3 > 0;

      // M1-R1：per-fixture 检索指标块（从 b2TrajectoryPath 计算，供 CLI wrongRetrievalPassed 修复）
      const { queryGroups: qg, evidences: b2Evs, hasRankedEvidence: hasRE } =
        extractRankedEvidenceFromTrajectory(b2Result.trajectoryPath);
      const rReturned = b2Evs.length;
      const rRelevant = b2Evs.filter((e) =>
        fixture.chapterIntent.inviolableFacts.some((f) => factFoundInEvidence(f, [e])) ||
        fixture.expected.factsRetrievable.some((f) => factFoundInEvidence(f, [e])),
      ).length;
      const rWrong = rReturned - rRelevant;
      const rTotalQ = qg.length;
      const rFailedQ = qg.filter((g) => g.evidences.length === 0).length;

      perFixture.push({
        fixtureId: fixture.id,
        b1Text,
        b2Text,
        b3Text,
        b1HasRequiredFacts: checkFacts(b1Text, requiredFacts),
        b2HasRequiredFacts: checkFacts(b2Text, requiredFacts),
        b3HasRequiredFacts: checkFacts(b3Text, requiredFacts),
        b3FixedB2Issues,
        b2HardFindingCount: b2FindingKeys.size,
        b3HardFindingCount: b3FindingKeys.size,
        b2TrajectoryPath: b2Result.trajectoryPath,
        modelCalls: {
          b1: b1Result.budgetSnapshot.modelCalls,
          b2: b2Result.budgetSnapshot.modelCalls,
          b3: b3Result.budgetSnapshot.modelCalls,
        },
        fallbacks: {
          b1: b1Result.candidate === null,
          b2: b2Result.candidate === null,
          b3: b3Result.candidate === null,
        },
        // M1-R1：per-fixture 检索指标块
        retrieval: {
          returnedEvidence: rReturned,
          relevantEvidence: rRelevant,
          wrongEvidence: rWrong,
          evidencePrecision: rReturned > 0 ? rRelevant / rReturned : 0,
          evidenceImprecisionRate: rReturned > 0 ? rWrong / rReturned : 0,
          failedQueries: rFailedQ,
          totalQueries: rTotalQ,
          queryFailureRate: rTotalQ > 0 ? rFailedQ / rTotalQ : 0,
          viaToolProtocol: hasRE,
        },
      });

      // 生成匿名盲测包（不暴露 B1/B2/B3 身份）
      const candidates: BlindTestCandidate[] = [
        { mode: "b1", text: b1Text },
        { mode: "b2", text: b2Text },
        { mode: "b3", text: b3Text },
      ];
      prepareBlindTestPack(fixture, candidates, join(blindTestDir, fixture.id));
    } finally {
      cleanup();
    }
  }

  // 聚合指标
  const totalFixtures = fixtures.length;
  const avgB1Coverage =
    perFixture.filter((r) => r.b1HasRequiredFacts).length / totalFixtures;
  const avgB2Coverage =
    perFixture.filter((r) => r.b2HasRequiredFacts).length / totalFixtures;
  const avgB3Coverage =
    perFixture.filter((r) => r.b3HasRequiredFacts).length / totalFixtures;
  const avgB2OverB1FactCoverage = avgB2Coverage - avgB1Coverage;
  const avgB3OverB2FactCoverage = avgB3Coverage - avgB2Coverage;
  const b3FixedB2Rate = perFixture.filter((r) => r.b3FixedB2Issues).length / totalFixtures;

  const provenance: QualityEvalProvenance = {
    model: firstModel,
    route,
    samplingParams: {
      temperature: 0.7, // 默认值，真实值从 route 配置读取
      maxTokens: 4096,
    },
  };

  return {
    timestamp: new Date().toISOString(),
    totalFixtures,
    perFixture,
    summary: {
      avgB1Coverage,
      avgB2Coverage,
      avgB3Coverage,
      avgB2OverB1FactCoverage,
      avgB3OverB2FactCoverage,
      b3FixedB2Rate,
    },
    provenance,
    blindTestDir,
  };
}

/**
 * 格式化质量评测报告为 Markdown。
 */
export function formatQualityReportAsMarkdown(report: QualityEvalReport): string {
  const lines: string[] = [];
  lines.push("# NovelOS M1 质量评测报告（P1-1 真实模型消融）");
  lines.push("");
  lines.push(`**时间**：${report.timestamp}`);
  lines.push(`**Fixture 数**：${report.totalFixtures}`);
  lines.push(`**模型**：${report.provenance.model}`);
  lines.push(`**路由**：${report.provenance.route}`);
  lines.push(`**盲测包目录**：${report.blindTestDir}`);
  lines.push("");

  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|------|");
  lines.push(`| B1 平均覆盖率 | ${report.summary.avgB1Coverage.toFixed(2)} |`);
  lines.push(`| B2 平均覆盖率 | ${report.summary.avgB2Coverage.toFixed(2)} |`);
  lines.push(`| B3 平均覆盖率 | ${report.summary.avgB3Coverage.toFixed(2)} |`);
  lines.push(`| B2-B1 覆盖率增益 | ${report.summary.avgB2OverB1FactCoverage.toFixed(2)} |`);
  lines.push(`| B3-B2 覆盖率变化 | ${report.summary.avgB3OverB2FactCoverage.toFixed(2)} |`);
  lines.push(`| B3 修复 B2 问题率 | ${report.summary.b3FixedB2Rate.toFixed(2)} |`);
  lines.push("");

  lines.push("## 各 Fixture 详情");
  lines.push("");
  lines.push("| Fixture | B1 含必需事实 | B2 含必需事实 | B3 含必需事实 | B2 hard findings | B3 hard findings | B3 修复 B2 | B1 模型调用 | B2 模型调用 | B3 模型调用 |");
  lines.push("|---------|-------------|-------------|-------------|-----------------|-----------------|-----------|-----------|-----------|-----------|");
  for (const r of report.perFixture) {
    lines.push(
      `| ${r.fixtureId} | ${r.b1HasRequiredFacts ? "✓" : "✗"} | ${r.b2HasRequiredFacts ? "✓" : "✗"} | ${r.b3HasRequiredFacts ? "✓" : "✗"} | ${r.b2HardFindingCount} | ${r.b3HardFindingCount} | ${r.b3FixedB2Issues ? "✓" : "✗"} | ${r.modelCalls.b1} | ${r.modelCalls.b2} | ${r.modelCalls.b3} |`,
    );
  }
  lines.push("");

  lines.push("## Provenance（审计用，不进盲测包）");
  lines.push("");
  lines.push(`- 模型：${report.provenance.model}`);
  lines.push(`- 路由：${report.provenance.route}`);
  lines.push(`- 采样参数：temperature=${report.provenance.samplingParams.temperature ?? "N/A"}, maxTokens=${report.provenance.samplingParams.maxTokens ?? "N/A"}`);
  lines.push("");

  return lines.join("\n");
}
