/**
 * orchestrator-factguard - 统一主链路"事实校验 + 证据扫描"相位
 *
 * 从 unified-orchestrator.ts 抽出（行为保持重构 Step 5）。
 * 包含：FactGuard（事实连续性校验）、LanguageRiskAnalysis、结构/信息释放/章末收束证据扫描、
 * craft evidence envelope、raw craft advisory。10 个纯函数（runRawCraftAdvisory 内部调
 * 3 个 scanRaw*，已转直接调用）。
 */

import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";
import type { Candidate } from "./types.js";
import {
  createFactContinuityGuard,
  type FactContinuityInput,
  type FactContinuityReport,
} from "./fact-continuity-guard.js";
import { createLanguageRiskLibrary } from "./language-risk-library.js";
import {
  scanStructuralEvidence,
  toChapterQualityEvidence,
  skippedChapterQualityEvidence,
  type StructuralEvidenceScanInput,
} from "./structural-evidence-scanner.js";
import type { ChapterQualityEvidence } from "./chapter-quality-evidence.js";
import {
  scanInformationReleaseEvidence,
  toInformationReleaseEvidenceReport,
  skippedInformationReleaseEvidence,
  type InformationReleaseScanInput,
  type InformationReleaseEvidenceReport,
} from "./information-release-evidence-scanner.js";
import {
  scanEndingCraftEvidence,
  toEndingCraftEvidenceReport,
  skippedEndingCraftEvidence,
  type EndingCraftScanInput,
  type EndingCraftEvidenceReport,
} from "./ending-craft-evidence-scanner.js";
import {
  buildCraftEvidenceEnvelope,
  skippedCraftEvidenceEnvelope,
  type BuildCraftEvidenceEnvelopeInput,
} from "./craft-evidence-envelope.js";
import { compileIdentityContract } from "./identity-contract-compiler.js";
import { compileOntologyContract, type OntologyContract } from "./ontology-contract-compiler.js";
import {
  compileEditorialOpportunityAdvisory,
  skippedEditorialOpportunityAdvisory,
  type EditorialOpportunityAdvisory,
} from "./editorial-opportunity-advisory.js";
import {
  compileImmutableFacts,
  checkUnauthorizedHighImpactSettings,
  type ImmutableFactsInput,
  type UnauthorizedHighImpactDiagnostic,
} from "./immutable-facts-compiler.js";
import type { Diagnostic } from "./types.js";

// ==========================================================================
// FactGuard（候选事实校验，raw 与 editorial 共用）
// ==========================================================================

/**
 * 候选事实校验。使用 FactContinuityGuard 做 6 类硬阻断检查。
 * 适用于 raw 候选、editorial 候选、最终正文复检。
 * 只阻断事实硬伤（格式损坏/大段重复/实体幻觉/连续性断裂/世界冲突），不阻断软风险。
 *
 * IMMUTABLE-FACTS-COMPILER-1：在 FactContinuityGuard.check 之后接入
 * "高影响新设定来源授权检查"。当前为 review 级别（只诊断不阻断），
 * 满足任务规格"FactGuard 不只检查与已知事实冲突，还要检查高影响新设定是否存在来源授权"。
 * 后续如需升级为 hard block（阻止模型凭空新增秘法/封印/组织计划/神器/升级结果），
 * 把 unauthorizedDiagnostics 转 Diagnostic 后追加到 report.hardBlocks 并设 hasHardBlock=true。
 */
export function checkCandidateFactGuard(text: string, input: UnifiedOrchestratorInput): { ok: boolean; errors: string[]; report: FactContinuityReport; constraintManifestHash?: string } {
  const guard = createFactContinuityGuard();
  // CANON-IDENTITY-1: 从 characterStates 编译身份契约，传给 FactGuard
  const identityInputs = (input.context.characterStates ?? []).length > 0
    ? (input.context.characterStates ?? []).map((c) => ({
      name: c.name,
      role: typeof c.state?.role === "string" ? c.state.role : undefined,
      aliases: Array.isArray(c.state?.aliases) ? c.state.aliases as string[] : [],
      characterId: c.characterId,
    }))
    : Array.from(new Set(input.characterNames ?? [])).map((name) => ({ name }));
  const identityContract = compileIdentityContract(identityInputs);
  const ontologyContract = compileOntologyContract(input.ontologyLevels ?? []);
  const guardInput: FactContinuityInput = {
    text,
    context: input.context,
    knownCharacterNames: input.characterNames,
    constraintManifest: input.contextSafety?.manifest,
    expectedChapterNumber: input.chapterNumber,
    identityContract,
    ontologyContract,
  };
  const report = guard.check(guardInput);

  // ── IMMUTABLE-FACTS-COMPILER-1：高影响新设定来源授权检查（review 级别接入） ──
  // 从 6 来源编译本章硬事实，扫描正文未授权高影响新设定（秘法/封印/组织计划/神器/升级结果）。
  // 当前为 review 级别（只诊断不阻断），追加到 report.allDiagnostics 供 trace 审计。
  // 接入异常不阻断生成（缺失可补，正文污染不可逆）。
  try {
    const immutableInput: ImmutableFactsInput = {
      worldRules: input.context.worldRules,
      constitution: input.constitution,
      characterStates: input.context.characterStates,
      bridgeContext: input.context.bridgeContext,
      chapterAnchors: input.intent?.inviolableFacts,
      ontologyLevels: input.ontologyLevels,
      openPromises: input.intent?.selectedPromisesToAdvance?.map((p) => ({
        id: p.promiseId,
        description: p.description,
      })),
      openLoops: input.context.openLoops,
    };
    const compiled = compileImmutableFacts(immutableInput);
    const unauthorizedDiagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
    if (unauthorizedDiagnostics.length > 0) {
      const diags = unauthorizedDiagnostics.map((d, idx) => toUnauthorizedHighImpactDiagnostic(d, idx));
      report.allDiagnostics.push(...diags);
    }
  } catch {
    // 接入失败不阻断生成（软诊断，缺失可补）
  }

  const errors = report.hardBlocks.map((d) => `${d.id}: ${d.evidence}`);
  return { ok: !report.hasHardBlock, errors, report, constraintManifestHash: report.constraintManifestHash };
}

/**
 * 把 UnauthorizedHighImpactDiagnostic 转为 FactGuard Diagnostic（review 级别）。
 *
 * severity="review"：只诊断不阻断，写入 trace 供人工复核。
 * domain="continuity"：高影响新设定属于连续性领域（凭空新增设定破坏世界连续性）。
 * source="unauthorized_high_impact_setting"：标识本检查来源。
 */
function toUnauthorizedHighImpactDiagnostic(
  d: UnauthorizedHighImpactDiagnostic,
  idx: number,
): Diagnostic {
  return {
    id: `diag:unauthorized_high_impact_setting:${idx}`,
    source: "unauthorized_high_impact_setting",
    severity: "review",
    domain: "continuity",
    span: d.span,
    evidence: `未授权高影响新设定 "${d.term}"（category=${d.category}）：${d.reason}`,
  };
}

// ==========================================================================
// LanguageRiskAnalyzer — 全候选语言风险扫描（A4，计划 §3 FactGuard/RiskAnalyzer）
// ==========================================================================

/**
 * 对给定候选列表调用 LanguageRiskLibrary.scan()，记录 per-candidate 报告到
 * stageResults.languageRisk 供 trace 审计；red-level density 推送 warning。
 *
 * 设计原则（language-risk-library.ts）：
 * - 软风险最高 review，绝不 hard block（语言风险不阻断生成）
 * - 检测结果带 span，可追溯
 * - 本地扫描（legacy AntiAIDetector，无 LLM 调用）
 *
 * 扫描异常不阻断生成（语言风险是诊断增强，缺失可补，正文污染不可逆）。
 */
export function runLanguageRiskAnalysis(
  candidatesToScan: Candidate[],
  characterNames: string[],
  stageResults: Record<string, unknown>,
  warnings: string[],
): void {
  try {
    const lib = createLanguageRiskLibrary();
    const reports = candidatesToScan.map((c) => {
      const report = lib.scan(c.text, characterNames);
      return {
        candidateId: c.id,
        candidateKind: c.kind,
        density: report.density,
        level: report.level,
        entryCount: report.entries.length,
        reviewEntryCount: report.entries.filter((e) => e.severity === "review").length,
        topRisks: report.entries.slice(0, 5).map((e) => ({
          riskId: e.riskId,
          category: e.category,
          severity: e.severity,
          description: e.description,
        })),
      };
    });
    stageResults.languageRisk = {
      scannedCandidateCount: reports.length,
      reports,
    };
    // red-level density 推送 warning（软风险，不阻断，建议人工复核）
    for (const r of reports) {
      if (r.level === "red") {
        warnings.push(
          `候选 ${r.candidateId} 语言风险 red（density=${r.density.toFixed(3)}, reviewEntryCount=${r.reviewEntryCount}），建议人工复核`
        );
      }
    }
  } catch (e: unknown) {
    // 语言风险扫描失败不阻断生成（软风险诊断，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`语言风险扫描异常（不阻断生成）：${msg}`);
    stageResults.languageRisk = { error: msg };
  }
}

/**
 * QUALITY-3：运行结构证据扫描并写入 stageResults.chapterQualityEvidence。
 *
 * 权限边界（任务规格 QUALITY-3 §7）：
 * - 只提供 span、证据、置信度、读者影响和建议 owner。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不提交长期状态，不阻断生成（扫描异常只写 warning）。
 * - 不含 aggregateQualityScore / totalScore。
 *
 * 接入位置：在 finalText 确定后、最终 trace 返回前调用。
 * raw fallback / eval B3 / 主成功路径均调用此方法。
 */
export function runStructuralEvidenceScan(
  finalText: string,
  finalCandidateId: string,
  input: UnifiedOrchestratorInput,
  stageResults: Record<string, unknown>,
  warnings: string[],
): void {
  try {
    const scanInput: StructuralEvidenceScanInput = {
      finalText,
      finalCandidateId,
      intent: input.intent,
      context: input.context,
      constitution: input.constitution,
    };
    const scanResult = scanStructuralEvidence(scanInput);
    stageResults.chapterQualityEvidence = toChapterQualityEvidence(scanResult);
    // 结构风险只推 warning（advisory，不阻断，不触发改文）
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk" || e.status === "contradicted"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `结构证据扫描发现 ${riskCount} 条 risk/contradicted 证据（advisory，不阻断，建议人工复核）`
      );
    }
  } catch (e: unknown) {
    // 结构证据扫描失败不阻断生成（advisory 诊断，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`结构证据扫描异常（不阻断生成）：${msg}`);
    stageResults.chapterQualityEvidence = skippedChapterQualityEvidence(
      finalCandidateId,
      `scanner 异常：${msg}`
    );
  }
}

/**
 * QUALITY-8：运行信息释放证据扫描并写入 stageResults.informationReleaseEvidence。
 *
 * 权限边界（任务规格 QUALITY-8 §5）：
 * - 只提供 span、证据、置信度、读者影响和建议 owner。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不提交长期状态，不阻断生成（扫描异常只写 skipped + warning）。
 * - 不调用模型，不生成正文，不启动 Demo/Longform。
 * - 不含 aggregateQualityScore / totalScore / 文学总分。
 *
 * 接入位置：在 finalText 确定后、最终 trace 返回前调用。
 * raw fallback / eval B3 / 主成功路径均调用此方法。
 */
export function runInformationReleaseScan(
  finalText: string,
  finalCandidateId: string,
  input: UnifiedOrchestratorInput,
  stageResults: Record<string, unknown>,
  warnings: string[],
): void {
  try {
    const scanInput: InformationReleaseScanInput = {
      finalText,
      finalCandidateId,
      intent: input.intent,
    };
    const scanResult = scanInformationReleaseEvidence(scanInput);
    stageResults.informationReleaseEvidence = toInformationReleaseEvidenceReport(scanResult);
    // 信息释放风险只推 warning（advisory，不阻断，不触发改文）
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `信息释放扫描发现 ${riskCount} 条 risk 证据（advisory，不阻断，建议人工复核）`
      );
    }
  } catch (e: unknown) {
    // 信息释放扫描失败不阻断生成（advisory 诊断，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`信息释放扫描异常（不阻断生成）：${msg}`);
    stageResults.informationReleaseEvidence = skippedInformationReleaseEvidence(
      finalCandidateId,
      `scanner 异常：${msg}`
    );
  }
}

/**
 * QUALITY-9：运行章末收束/钩子证据扫描并写入 stageResults.endingCraftEvidence。
 *
 * 权限边界（任务规格 QUALITY-9 §接入边界）：
 * - 只提供 span、证据、置信度、读者影响和建议 owner。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不提交长期状态，不阻断生成（扫描异常只写 skipped + warning）。
 * - 不调用模型，不生成正文，不启动 Demo/Longform。
 * - 不含 aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定。
 *
 * 接入位置：在 finalText 确定后、最终 trace 返回前调用。
 * raw fallback / eval B3 / 主成功路径均调用此方法。
 */
export function runEndingCraftScan(
  finalText: string,
  finalCandidateId: string,
  input: UnifiedOrchestratorInput,
  stageResults: Record<string, unknown>,
  warnings: string[],
): void {
  try {
    const scanInput: EndingCraftScanInput = {
      finalText,
      finalCandidateId,
      intent: input.intent,
    };
    const scanResult = scanEndingCraftEvidence(scanInput);
    stageResults.endingCraftEvidence = toEndingCraftEvidenceReport(scanResult);
    // 章末收束风险只推 warning（advisory，不阻断，不触发改文）
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `章末收束扫描发现 ${riskCount} 条 risk 证据（advisory，不阻断，建议人工复核）`
      );
    }
  } catch (e: unknown) {
    // 章末收束扫描失败不阻断生成（advisory 诊断，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`章末收束扫描异常（不阻断生成）：${msg}`);
    stageResults.endingCraftEvidence = skippedEndingCraftEvidence(
      finalCandidateId,
      `scanner 异常：${msg}`
    );
  }
}

/**
 * QUALITY-10：运行质量证据统一汇总并写入 stageResults.craftEvidenceEnvelope。
 *
 * 聚合三个 source report（chapterQualityEvidence / informationReleaseEvidence /
 * endingCraftEvidence）的 diagnostic 证据为一个可读可回放证据包。
 *
 * 权限边界（任务规格 QUALITY-10 §接入边界）：
 * - 只汇总，不评分，不改文，不阻断。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不改 judge/selection，不提交长期状态，不调用模型。
 * - 不含 aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定 /
 *   自动改文建议 / hard gate 字段。
 * - 缺某个 source report 时不抛错，记录到 meta.missingSources。
 * - hardBlock 路径也调用此方法（三个 source 已写为 skipped，envelope 自动识别）。
 * - envelope 异常不能阻断生成，只写 skipped envelope + warning。
 *
 * 接入位置：在三个 source scanner 都运行后调用。
 * raw fallback / eval B3 / 主成功路径 / hardBlock 路径均调用此方法。
 */
export function runCraftEvidenceEnvelope(
  finalText: string,
  finalCandidateId: string,
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  try {
    const envelopeInput: BuildCraftEvidenceEnvelopeInput = {
      finalText,
      finalCandidateId,
      chapterQualityEvidence:
        (stageResults.chapterQualityEvidence as ChapterQualityEvidence | null | undefined) ??
        null,
      informationReleaseEvidence:
        (stageResults.informationReleaseEvidence as InformationReleaseEvidenceReport | null | undefined) ??
        null,
      endingCraftEvidence:
        (stageResults.endingCraftEvidence as EndingCraftEvidenceReport | null | undefined) ??
        null,
    };
    const envelope = buildCraftEvidenceEnvelope(envelopeInput);
    stageResults.craftEvidenceEnvelope = envelope;
    // envelope 本身不推 warning（advisory 汇总，无新风险信号）；
    // risk/human_review/partial 已由各 source scanner 自己推过 warning，
    // 此处不重复推，避免 warning 膨胀。
    // 仅在 envelope 自身标记 skipped 且非 hardBlock 路径时推一条提示。
    if (envelope.meta.skipped && finalText.length > 0) {
      warnings.push(
        `质量证据汇总标记 skipped（advisory，不阻断）：${envelope.meta.skippedReason ?? "无可用证据"}`
      );
    }
  } catch (e: unknown) {
    // envelope 构建失败不阻断生成（advisory 汇总，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`质量证据汇总异常（不阻断生成）：${msg}`);
    stageResults.craftEvidenceEnvelope = skippedCraftEvidenceEnvelope(
      finalCandidateId,
      `envelope 异常：${msg}`
    );
  }
}

/**
 * QUALITY-11：运行 raw 阶段 craft evidence advisory 编译。
 *
 * 在 rawCandidate 通过 FactGuard 后、EditorialOpportunityJudge 前，基于 rawText 运行
 * QUALITY-3/8/9 三源本地证据扫描，用 QUALITY-10 envelope 构建 rawCraftEvidenceEnvelope，
 * 再用 QUALITY-11 advisory compiler 编译为 editorialOpportunityAdvisory。
 *
 * 权限边界（任务规格 QUALITY-11 §核心原则）：
 * - 只读 rawText，不改 finalText，不触发 StyleShaper / candidate / judge / selection。
 * - 不新增硬门槛；advisory 只是上下文，opportunity 返回 no-op 时仍交付 raw。
 * - 不引入文学总分/pass/fail/grade/weightedScore/rankedScore（由 advisory compiler 自身守护）。
 * - 不调用模型；advisory 编译是纯本地字段搬运。
 * - scanner/advisory 异常只写 skipped + warning，不阻断流程。
 * - 不替代 QUALITY-10 finalText 后 envelope；此处是 raw 阶段 advisory evidence，
 *   写入 stageResults.rawCraftEvidenceEnvelope + editorialOpportunityAdvisory。
 *
 * 接入位置：Stage 2（FactGuard）后、Stage 3（EditorialOpportunityJudge）前（Stage 2.5）。
 * 返回编译后的 advisory（可能为 skipped/empty，调用方据此决定是否注入 prompt）。
 *
 * 注意：此处的三源扫描结果不写入 stageResults.chapterQualityEvidence 等终态键
 * （那些键保留给 finalText 阶段的 QUALITY-3/8/9 扫描），只写入 rawCraftEvidenceEnvelope
 * 汇总结果 + editorialOpportunityAdvisory 编译结果。
 */
export function runRawCraftAdvisory(
  rawText: string,
  rawCandidateId: string,
  input: UnifiedOrchestratorInput,
  stageResults: Record<string, unknown>,
  warnings: string[]
): EditorialOpportunityAdvisory {
  try {
    // 1. 运行三源本地证据扫描（基于 rawText，不写入终态 stageResults 键）
    //    单个 scanner 异常只降级该源为 skipped report，不阻断整体 advisory 编译。
    const chapterQualityEvidence = scanRawStructuralEvidence(
      rawText, rawCandidateId, input, warnings
    );
    const informationReleaseEvidence = scanRawInformationRelease(
      rawText, rawCandidateId, input, warnings
    );
    const endingCraftEvidence = scanRawEndingCraft(
      rawText, rawCandidateId, input, warnings
    );

    // 2. 构建 rawCraftEvidenceEnvelope（QUALITY-10）
    const envelope = buildCraftEvidenceEnvelope({
      finalText: rawText,
      finalCandidateId: rawCandidateId,
      chapterQualityEvidence,
      informationReleaseEvidence,
      endingCraftEvidence,
    });
    stageResults.rawCraftEvidenceEnvelope = envelope;

    // 3. 编译 advisory（QUALITY-11）
    const advisory = compileEditorialOpportunityAdvisory({ envelope });
    stageResults.editorialOpportunityAdvisory = advisory;

    // advisory 本身不推 warning（无新风险信号；scanner 风险已在各自方法内推过 warning）。
    // 仅在 advisory 标记 skipped/empty 且非 hardBlock 路径时推一条提示（便于人工复核）。
    if (advisory.emptyReason) {
      warnings.push(
        `raw craft advisory 空（advisory，不阻断）：${advisory.emptyReason}`
      );
    }
    return advisory;
  } catch (e: unknown) {
    // advisory 编译整体异常不阻断生成（advisory 是上下文，缺失可补）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`raw craft advisory 编译异常（不阻断生成）：${msg}`);
    const skipped = skippedEditorialOpportunityAdvisory(`orchestrator 异常：${msg}`);
    stageResults.editorialOpportunityAdvisory = skipped;
    // envelope 也写 skipped（若构建失败）
    if (!stageResults.rawCraftEvidenceEnvelope) {
      stageResults.rawCraftEvidenceEnvelope = skippedCraftEvidenceEnvelope(
        rawCandidateId,
        `orchestrator 异常：${msg}`
      );
    }
    return skipped;
  }
}

/**
 * QUALITY-11 辅助：对 rawText 运行 QUALITY-3 结构证据扫描。
 * 单个 scanner 异常只降级为 skipped report，不抛出（不阻断 advisory 编译）。
 * 不写入 stageResults.chapterQualityEvidence（该键保留给 finalText 阶段）。
 */
export function scanRawStructuralEvidence(
  rawText: string,
  rawCandidateId: string,
  input: UnifiedOrchestratorInput,
  warnings: string[]
): ChapterQualityEvidence {
  try {
    const scanInput: StructuralEvidenceScanInput = {
      finalText: rawText,
      finalCandidateId: rawCandidateId,
      intent: input.intent,
      context: input.context,
      constitution: input.constitution,
    };
    const scanResult = scanStructuralEvidence(scanInput);
    // raw 阶段扫描风险只推 warning（advisory，不阻断，不触发改文）
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk" || e.status === "contradicted"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `raw 结构证据扫描发现 ${riskCount} 条 risk/contradicted 证据（advisory，不阻断）`
      );
    }
    return toChapterQualityEvidence(scanResult);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`raw 结构证据扫描异常（降级 skipped，不阻断）：${msg}`);
    return skippedChapterQualityEvidence(
      rawCandidateId,
      `raw scanner 异常：${msg}`
    );
  }
}

/**
 * QUALITY-11 辅助：对 rawText 运行 QUALITY-8 信息释放证据扫描。
 * 单个 scanner 异常只降级为 skipped report，不抛出（不阻断 advisory 编译）。
 * 不写入 stageResults.informationReleaseEvidence（该键保留给 finalText 阶段）。
 */
export function scanRawInformationRelease(
  rawText: string,
  rawCandidateId: string,
  input: UnifiedOrchestratorInput,
  warnings: string[]
): InformationReleaseEvidenceReport {
  try {
    const scanInput: InformationReleaseScanInput = {
      finalText: rawText,
      finalCandidateId: rawCandidateId,
      intent: input.intent,
    };
    const scanResult = scanInformationReleaseEvidence(scanInput);
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `raw 信息释放扫描发现 ${riskCount} 条 risk 证据（advisory，不阻断）`
      );
    }
    return toInformationReleaseEvidenceReport(scanResult);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`raw 信息释放扫描异常（降级 skipped，不阻断）：${msg}`);
    return skippedInformationReleaseEvidence(
      rawCandidateId,
      `raw scanner 异常：${msg}`
    );
  }
}

/**
 * QUALITY-11 辅助：对 rawText 运行 QUALITY-9 章末收束证据扫描。
 * 单个 scanner 异常只降级为 skipped report，不抛出（不阻断 advisory 编译）。
 * 不写入 stageResults.endingCraftEvidence（该键保留给 finalText 阶段）。
 */
export function scanRawEndingCraft(
  rawText: string,
  rawCandidateId: string,
  input: UnifiedOrchestratorInput,
  warnings: string[]
): EndingCraftEvidenceReport {
  try {
    const scanInput: EndingCraftScanInput = {
      finalText: rawText,
      finalCandidateId: rawCandidateId,
      intent: input.intent,
    };
    const scanResult = scanEndingCraftEvidence(scanInput);
    const riskCount = scanResult.evidence.filter(
      (e) => e.status === "risk"
    ).length;
    if (riskCount > 0) {
      warnings.push(
        `raw 章末收束扫描发现 ${riskCount} 条 risk 证据（advisory，不阻断）`
      );
    }
    return toEndingCraftEvidenceReport(scanResult);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`raw 章末收束扫描异常（降级 skipped，不阻断）：${msg}`);
    return skippedEndingCraftEvidence(
      rawCandidateId,
      `raw scanner 异常：${msg}`
    );
  }
}
