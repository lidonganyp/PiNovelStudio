/**
 * Replay generation runner.
 *
 * This module prepares replay workspaces and invokes the existing
 * novel_generate_chapter command path. It does not generate chapter prose.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// P30: 章节身份与路径 canonical resolver
import { resolveGenerateResultFile } from "../utils/chapter-path.js";
import { createDefaultNarrativeState } from "../craft/narrative-state-store.js";
import {
  analyzeReplayDelta,
  extractCandidateRules,
  type ReplaySample,
} from "./replay-delta-analyzer.js";
import {
  decodeNovelSourceBuffer,
  hashReplayBody,
  padChapter,
  resolveReplayReferenceBody,
  sanitizeReplayId,
  sanitizeReplayProtagonistName,
  writeReplayCases,
} from "./replay-case-extractor.js";
import type { WorldItem } from "../dag/types.js";
import type {
  CreateReplayWorkspaceOptions,
  ReplayCase,
  ReplayGenerationFailure,
  ReplayGenerationReport,
  ReplayInvokeCommand,
  ReplayInvokeGenerateChapter,
  ReplayInvokeResult,
  ReplayRunSummary,
  ReplayWorkspaceInput,
} from "./replay-types.js";
import type { RunReplayCasesOptions } from "./replay-types.js";
import { createFailureEnvelope } from "../craft/failure-envelope.js";
import { flushFailureEnvelopeToTraceFile } from "../craft/failure-envelope-reporter.js";

const REPLAY_PROTAGONIST_FALLBACK = "主角";
const REPLAY_PROTAGONIST_ALIASES = ["主角", "我", "他", "她"];
const REPLAY_TIMEOUT_EXIT_CODE = 124;
const REPLAY_FORCE_KILL_GRACE_MS = 2_000;
const REPLAY_DEFAULT_INVOKE_TIMEOUT_MS = 600_000;
const REPLAY_INVOKE_TIMEOUT_ENV = "PINOVEL_REPLAY_INVOKE_TIMEOUT_MS";

export function createReplayWorkspaceInput(
  replayCase: ReplayCase,
  options: CreateReplayWorkspaceOptions
): ReplayWorkspaceInput {
  const styleProfile = options.styleProfile ?? "default";
  const sanitizedReplay = sanitizeReplayCaseForGeneration(replayCase);
  const protagonistName = sanitizedReplay.protagonistName;
  const generationCase = sanitizedReplay.replayCase;

  return {
    workspaceId: options.workspaceId,
    config: {
      workspaceId: options.workspaceId,
      novelName: options.novelName,
      genre: options.genre,
      subGenres: options.subGenres ?? [options.genre],
      styleProfile,
      styleOverrides: {},
      brainholePreferences: {
        enabledPatterns: ["identity-reversal", "iceberg", "mirror-enemy", "mask-layer"],
        aggressiveness: 0.55,
        autoApplyThreshold: 0.6,
        maxInjectionsPerChapter: 1,
      },
      qualityGates: {
        antiAiThreshold: 0.15,
        emotionMetronome: "strict",
        dependencyCheck: "strict",
        minSatisfactionDensity: 0.0002,
        maxOppressionLength: 3000,
      },
      targetWordCount: {
        perChapter: { min: 1800, max: 3200 },
        total: 2000000,
      },
      chapterProgress: {
        completed: Math.max(0, generationCase.chapterNumber - 1),
        current: generationCase.chapterNumber,
      },
      generatedFromReplay: true,
      replayCase: {
        bookId: generationCase.bookId,
        chapterNumber: generationCase.chapterNumber,
        chapterTitle: generationCase.chapterTitle,
        originalChapterPath: generationCase.originalChapterPath,
        originalHash: generationCase.originalHash,
      },
      characters: [
        {
          id: "replay_protagonist",
          name: protagonistName,
          role: "protagonist",
          aliases: sanitizedReplay.protagonistAliases,
        },
      ],
      generationPreflight: {
        enabled: true,
        allowUnregisteredCharacters: true,
        maxUnregisteredCharacters: 5,
      },
    },
    outline: buildReplayOutline(generationCase),
    characterProfile: buildReplayCharacterProfile(generationCase, protagonistName),
    worldItems: buildReplayWorldItems(generationCase),
    skeleton: createReplaySkeleton(generationCase),
    narrativeState: createDefaultNarrativeState(generationCase.chapterNumber) as unknown as Record<string, unknown>,
    unsettledDetails: [],
  };
}

export async function runReplayCases(options: RunReplayCasesOptions): Promise<ReplayRunSummary> {
  const projectRoot = resolve(options.projectRoot);
  const loadedCases = options.cases.map((entry) => loadReplayCase(entry));
  const bookId = loadedCases[0]?.bookId ?? "replay-book";
  const runId = options.runId ?? createRunId();
  const runRoot = resolve(options.runRoot ?? join(projectRoot, ".pi", "replay-runs"));
  const runPath = join(runRoot, sanitizeReplayId(bookId), sanitizeReplayId(runId));
  const dirs = {
    cases: join(runPath, "cases"),
    generated: join(runPath, "generated"),
    reports: join(runPath, "reports"),
    traces: join(runPath, "traces"),
  };

  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
  }

  const reports: string[] = [];
  const failures: ReplayGenerationFailure[] = [];
  const failureBreakdown = createEmptyFailureBreakdown();
  const replayInvokeTimeoutMs = resolveReplayInvokeTimeoutMs(options.invokeTimeoutMs);
  let completed = 0;
  let failed = 0;

  for (const replayCase of loadedCases) {
    writeReplayCases([replayCase], dirs.cases);

    const chapterId = String(replayCase.chapterNumber);
    const workspaceId = [
      "replay",
      sanitizeReplayId(replayCase.bookId),
      sanitizeReplayId(runId),
      `ch${padChapter(replayCase.chapterNumber)}`,
    ].join("-");
    const workspaceInput = createReplayWorkspaceInput(replayCase, {
      workspaceId,
      novelName: `${replayCase.bookId} Replay`,
      genre: inferGenre(replayCase),
      styleProfile: "default",
    });

    writeReplayWorkspace(projectRoot, workspaceInput);

    // P30: 走 canonical resolver（chapterId 已 canonical = String(chapterNumber)）
    const resultPath = resolveGenerateResultFile(
      join(projectRoot, "workspaces", workspaceId),
      chapterId,
    );
    const command = buildInvokeCommand(
      projectRoot,
      workspaceId,
      chapterId,
      replayCase.chapterNumber,
      Boolean(options.mockAgent),
      resultPath,
      replayInvokeTimeoutMs
    );
    const invoke = options.invokeGenerateChapter ?? defaultInvokeGenerateChapter;
    const invocation = await invoke(command);
    const result = readJsonIfExists(resultPath) ?? {
      status: "missing_result",
      exitCode: invocation.exitCode,
    };

    // P30: 以下 ch${padChapter(...)} mirror 路径是 replay 报告命名约定（padded 便于排序），
    // 非 workspace 章节产物，不参与 canonical 归一化，保留原样。
    const qualityTracePath = join(dirs.traces, `ch${padChapter(replayCase.chapterNumber)}-quality-trace.json`);
    mirrorGeneratedResult(resultPath, join(dirs.generated, `ch${padChapter(replayCase.chapterNumber)}-generate-result.json`));
    mirrorTrace(projectRoot, workspaceId, chapterId, qualityTracePath);

    const report: ReplayGenerationReport = {
      schemaVersion: 1,
      bookId: replayCase.bookId,
      runId,
      workspaceId,
      chapterId,
      chapterNumber: replayCase.chapterNumber,
      case: replayCase,
      command,
      invocation,
      result,
      metadata: {
        generatedBy: "novel_generate_chapter",
        candidate: {
          generationTool: "novel_generate_chapter",
          workspaceId,
          chapterId,
          resultPath,
          tracePath: qualityTracePath,
        },
        reference: {
          originalChapterPath: replayCase.originalChapterPath,
          originalHash: replayCase.originalHash,
        },
      },
      createdAt: new Date().toISOString(),
    };

    const qualityOutputPath = join(dirs.reports, `ch${padChapter(replayCase.chapterNumber)}-quality-report.json`);
    const qualitySkippedPath = join(dirs.reports, `ch${padChapter(replayCase.chapterNumber)}-quality-report.skipped.json`);
    const qualityReportPath = writeReplayQualityReport({
      projectRoot,
      replayCase,
      result,
      reportMetadata: report.metadata,
      candidatePath: join(dirs.generated, `ch${padChapter(replayCase.chapterNumber)}-candidate.txt`),
      referencePath: join(dirs.reports, `ch${padChapter(replayCase.chapterNumber)}-reference.txt`),
      metadataPath: join(dirs.reports, `ch${padChapter(replayCase.chapterNumber)}-quality-metadata.json`),
      outputPath: qualityOutputPath,
      skippedPath: qualitySkippedPath,
    });

    const completedGeneration = isCompletedReplayGeneration({
      invocation,
      result,
      qualityReportPath,
      expectedQualityReportPath: qualityOutputPath,
    });
    if (completedGeneration) {
      completed += 1;
    } else {
      failed += 1;
      const failure = classifyReplayGenerationFailure({
        invocation,
        result,
        qualityReportPath,
        expectedQualityReportPath: qualityOutputPath,
      });
      report.failure = failure;
      failures.push(failure);
      failureBreakdown[failure.kind] += 1;
    }

    const reportPath = join(dirs.reports, `ch${padChapter(replayCase.chapterNumber)}-generation-report.json`);
    writeJson(reportPath, report);
    reports.push(reportPath);
    reports.push(qualityReportPath);
  }

  const invokeFailedCount = failures.filter((f) => f.kind === "invoke_failed").length;
  const generatedCount = loadedCases.length - invokeFailedCount;
  const validDenominator = failures.filter((f) => f.kind !== "invoke_failed").length + completed;

  // P9 Replay 流水化接入：从 quality reports 提取 ReplaySample，
  // 调用 analyzeReplayDelta + extractCandidateRules，生成 delta 报告和候选规则。
  // humanApproved 可通过 options 或环境变量 PINOVEL_REPLAY_HUMAN_APPROVED=1 启用，
  // 启用且 canPromote=true 时，将 candidate rules 晋级写入 validated-craft-rules.json。
  const humanApproved = options.humanApproved === true
    || process.env.PINOVEL_REPLAY_HUMAN_APPROVED === "1"
    || process.env.PINOVEL_REPLAY_HUMAN_APPROVED === "true";
  const replaySamples = collectReplaySamples(reports);
  const deltaReport = analyzeReplayDelta(replaySamples, {
    activeRuleInTrace: replaySamples.some((s) => (s.ruleHits?.length ?? 0) > 0),
    humanApproved,
  });
  const candidateRules = extractCandidateRules(replaySamples);
  const deltaReportPath = join(runPath, "replay-delta-report.json");
  const candidateRulesPath = join(runPath, "candidate-rules.json");
  writeJson(deltaReportPath, deltaReport);
  writeJson(candidateRulesPath, {
    schemaVersion: 1,
    runId,
    bookId,
    generatedAt: new Date().toISOString(),
    sampleSize: replaySamples.length,
    candidateRules,
  });
  reports.push(deltaReportPath, candidateRulesPath);

  // P9 真实晋级证据：当 humanApproved=true 且 deltaReport.canPromote=true 时，
  // 将 candidate rules 晋级写入 data/runtime/validated-craft-rules.json
  let promotionResult: { promoted: boolean; reason: string; promotedPath?: string; promotedCount?: number } | undefined;
  if (humanApproved && deltaReport.promotionDecision.canPromote && candidateRules.length > 0) {
    try {
      const validatedRulesPath = join(projectRoot, "data", "runtime", "validated-craft-rules.json");
      promotionResult = promoteCandidateRulesToValidated(validatedRulesPath, candidateRules, bookId, runId);
    } catch (e) {
      promotionResult = { promoted: false, reason: `晋级写入异常: ${(e as Error).message}` };
    }
  } else {
    promotionResult = {
      promoted: false,
      reason: !humanApproved
        ? "humanApproved=false（默认安全边界，需人工 flag 或 PINOVEL_REPLAY_HUMAN_APPROVED=1 启用晋级）"
        : !deltaReport.promotionDecision.canPromote
          ? `canPromote=false: ${deltaReport.promotionDecision.reason}`
          : "candidateRules 为空",
    };
  }
  // 写入晋级结果到 runPath 供审计
  writeJson(join(runPath, "promotion-result.json"), {
    schemaVersion: 1,
    runId,
    bookId,
    generatedAt: new Date().toISOString(),
    humanApproved,
    canPromote: deltaReport.promotionDecision.canPromote,
    ...promotionResult,
  });

  const summary: ReplayRunSummary = {
    schemaVersion: 1,
    bookId,
    runId,
    runPath,
    totalCases: loadedCases.length,
    completed,
    failed,
    failures,
    failureBreakdown,
    reports,
    createdAt: new Date().toISOString(),
    generatedCount,
    invokeFailedCount,
    validDenominator,
  };

  writeJson(join(runPath, "summary.json"), summary);
  return summary;
}

interface SanitizedReplayForGeneration {
  replayCase: ReplayCase;
  protagonistName: string;
  protagonistAliases: string[];
}

function sanitizeReplayCaseForGeneration(replayCase: ReplayCase): SanitizedReplayForGeneration {
  const rawProtagonistName = readReplayProtagonistCandidate(replayCase);
  const protagonistName = inferProtagonistName(replayCase);
  const rejectedFragments = rawProtagonistName &&
    rawProtagonistName !== protagonistName &&
    rawProtagonistName !== REPLAY_PROTAGONIST_FALLBACK &&
    rawProtagonistName !== "Replay主角"
    ? [rawProtagonistName]
    : [];
  const fragmentSanitizedCase = rejectedFragments.length > 0
    ? replaceReplayCaseFragments(replayCase, rejectedFragments, protagonistName)
    : replayCase;

  return {
    replayCase: sanitizeReplayCaseTextForGeneration(fragmentSanitizedCase, protagonistName),
    protagonistName,
    protagonistAliases: uniqueStrings([protagonistName, ...REPLAY_PROTAGONIST_ALIASES]),
  };
}

function sanitizeReplayCaseTextForGeneration(replayCase: ReplayCase, protagonistName: string): ReplayCase {
  return {
    ...replayCase,
    abstractOutline: sanitizeReplayGenerationText(replayCase.abstractOutline, protagonistName),
    characterState: sanitizeReplayGenerationText(replayCase.characterState, protagonistName),
    worldState: sanitizeReplayGenerationText(replayCase.worldState, protagonistName),
    keyEvents: replayCase.keyEvents.map((event) => sanitizeReplayGenerationText(event, protagonistName)),
    emotionalBeats: replayCase.emotionalBeats.map((beat) => sanitizeReplayGenerationText(beat, protagonistName)),
    conflictTarget: sanitizeReplayGenerationText(replayCase.conflictTarget, protagonistName),
    endingHook: sanitizeReplayGenerationText(replayCase.endingHook, protagonistName),
  };
}

function sanitizeReplayGenerationText(value: string, protagonistName: string): string {
  const normalized = normalizeLegacyReplayTemplate(value.trim(), protagonistName);
  return normalized || value;
}

function normalizeLegacyReplayTemplate(value: string, protagonistName: string): string {
  const beatTranslation = translateLegacyReplayBeat(value);
  if (beatTranslation) {
    return beatTranslation;
  }

  let match = value.match(/^Primary character:\s*([^;]+);\s*active pressure:\s*cautious investigation;\s*state should shift from observation to decision\.?$/i);
  if (match) {
    const actor = cleanReplayTemplateTerm(match[1], protagonistName);
    return `主角：${actor}；当前压力：谨慎调查；状态变化：从观察转向决断。`;
  }

  match = value.match(/^Scene cluster:\s*([^;]+);\s*genre signals:\s*anomaly,\s*clue,\s*delayed disclosure;\s*continuity needs explicit transitions between locations\.?$/i);
  if (match) {
    const cluster = cleanReplayTemplateTerm(match[1], "核心场景");
    return `场景簇：${cluster}；类型信号：异常、线索、延迟揭示；连续性要求：空间切换必须有明确过门。`;
  }

  match = value.match(/^Open\s+(.+?)\s+with\s+(.+?)\s+encountering an unstable situation rather than exposition\.?$/i);
  if (match) {
    const scene = cleanReplayTemplateTerm(match[1], "本章异常场景");
    const actor = cleanReplayTemplateTerm(match[2], protagonistName);
    return `以${scene}开场，让${actor}立刻卷入异常处境。`;
  }

  match = value.match(/^Expose\s+(.+?)\s+as actionable evidence that changes the scene objective\.?$/i);
  if (match) {
    const clue = cleanReplayTemplateTerm(match[1], "关键线索");
    return `让${clue}成为改变现场目标的行动线索。`;
  }

  match = value.match(/^Force\s+(.+?)\s+into\s+(.+?)\s+under\s+(.+?)(?:,\s*)?with visible cost or hesitation\.?$/i);
  if (match) {
    const actor = cleanReplayTemplateTerm(match[1], protagonistName);
    const choice = cleanReplayTemplateTerm(match[2], "关键选择");
    const pressure = cleanReplayTemplateTerm(match[3], "外部压力");
    return `在${pressure}逼近时，迫使${actor}做出${choice}，并呈现代价或犹豫。`;
  }

  if (/^Close on a new pressure signal that makes the next chapter necessary(?: hook)?\.?$/i.test(value)) {
    return "以新的压力信号收束，让下一章成为必要。";
  }

  match = value.match(/^End\s+(.+?)\s+with\s+(.+?)\s+returning before the clue is fully explained\.?$/i);
  if (match) {
    const scene = cleanReplayTemplateTerm(match[1], "本章线索");
    const pressure = cleanReplayTemplateTerm(match[2], "未解压力");
    return `以${pressure}再次逼近收束，保留${scene}未完全解释的追读压力。`;
  }

  match = value.match(/^Protect or interpret\s+(.+?)\s+while\s+(.+?)\s+narrows the protagonist's options\.?$/i);
  if (match) {
    const clue = cleanReplayTemplateTerm(match[1], "关键线索");
    const pressure = cleanReplayTemplateTerm(match[2], "外部压力");
    return `在${pressure}逼近时，保护或解读${clue}，让主角选择空间收窄。`;
  }

  return removeLegacyReplayEnglishScaffold(value, protagonistName);
}

function translateLegacyReplayBeat(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const translations: Record<string, string> = {
    "quiet observation": "安静观察",
    "rising unease": "不安上升",
    "controlled decision": "受控决断",
    "suspense hook": "悬念钩子",
  };

  return translations[normalized] ?? null;
}

function cleanReplayTemplateTerm(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[.。]+$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return cleaned || fallback;
}

function removeLegacyReplayEnglishScaffold(value: string, protagonistName: string): string {
  const cleaned = value
    .replace(/\bprotagonist\b/gi, protagonistName)
    .replace(
      /\b(?:Open|Expose|Force|Close|End|Protect|interpret|while|with|as|actionable|evidence|changes|scene|objective|encountering|an|unstable|situation|rather|than|exposition|into|under|external|pressure|visible|cost|or|hesitation|on|new|signal|makes|next|chapter|necessary|returning|before|clue|fully|explained|the|options|narrows|hook)\b/gi,
      " "
    )
    .replace(/[A-Za-z][A-Za-z0-9_'-]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？；：])/g, "$1")
    .trim();

  return cleaned || value;
}

function replaceReplayCaseFragments(
  replayCase: ReplayCase,
  fragments: string[],
  replacement: string
): ReplayCase {
  return {
    ...replayCase,
    abstractOutline: replaceTextFragments(replayCase.abstractOutline, fragments, replacement),
    characterState: replaceTextFragments(replayCase.characterState, fragments, replacement),
    worldState: replaceTextFragments(replayCase.worldState, fragments, replacement),
    keyEvents: replayCase.keyEvents.map((event) => replaceTextFragments(event, fragments, replacement)),
    emotionalBeats: replayCase.emotionalBeats.map((beat) => replaceTextFragments(beat, fragments, replacement)),
    conflictTarget: replaceTextFragments(replayCase.conflictTarget, fragments, replacement),
    endingHook: replaceTextFragments(replayCase.endingHook, fragments, replacement),
  };
}

function replaceTextFragments(value: string, fragments: string[], replacement: string): string {
  return fragments.reduce((text, fragment) => text.split(fragment).join(replacement), value);
}

function readReplayProtagonistCandidate(replayCase: ReplayCase): string | null {
  const match = replayCase.characterState.match(/主角[:：]\s*([^;；]+)/) ?? replayCase.characterState.match(/Primary character: ([^;]+)/);
  return match?.[1]?.trim() ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildReplayOutline(replayCase: ReplayCase): string {
  const eventBlocks = replayCase.keyEvents.map((event, index) => {
    const beat = replayCase.emotionalBeats[index] ?? replayCase.emotionalBeats.at(-1) ?? "受控紧张";
    return [
      `#### 事件${index + 1}：${eventTitle(index)}`,
      `- **内容**：${event}`,
      `- **场景类型**：${index === 0 ? "setup" : index === replayCase.keyEvents.length - 1 ? "hook" : "conflict"}`,
      `- **情绪节拍**：${beat}`,
      `- **钩子**：${index === replayCase.keyEvents.length - 1 ? replayCase.endingHook : replayCase.conflictTarget}`,
    ].join("\n");
  });

  return [
    "# Replay Outline",
    "",
    `## 第${replayCase.chapterNumber}章：${replayCase.chapterTitle}`,
    "",
    "### 抽象大纲",
    replayCase.abstractOutline,
    "",
    "### 角色状态",
    replayCase.characterState,
    "",
    "### 世界状态",
    replayCase.worldState,
    "",
    "### 冲突目标",
    replayCase.conflictTarget,
    "",
    "### 章节事件",
    ...eventBlocks.flatMap((block) => ["", block]),
    "",
    "### 结尾追读钩子",
    replayCase.endingHook,
  ].join("\n");
}

function buildReplayCharacterProfile(replayCase: ReplayCase, protagonistName: string): string {
  return [
    "# 回放角色状态",
    "",
    `- 姓名：${protagonistName}`,
    "- 角色：主角",
    `- 当前状态：${replayCase.characterState}`,
    `- 冲突目标：${replayCase.conflictTarget}`,
    "- 写作约束：保留动机、压力和选择逻辑，不仿写原文句子。",
  ].join("\n");
}

function createReplaySkeleton(replayCase: ReplayCase): Record<string, unknown> {
  return {
    version: "replay-1",
    source: "replay-runner",
    chapterSkeletons: {},
    globalFacts: [
      `Replay source book: ${replayCase.bookId}`,
      `Current abstract chapter: ${replayCase.chapterTitle}`,
    ],
    characterStates: {},
    worldRules: [],
    activeForeshadows: [],
  };
}

function buildReplayWorldItems(replayCase: ReplayCase): WorldItem[] {
  const now = new Date().toISOString();
  const summary = compactReplayWorldText(replayCase.worldState);
  const fullDescription = [
    replayCase.worldState,
    `冲突目标：${replayCase.conflictTarget}`,
    `关键事件：${replayCase.keyEvents.join("；")}`,
    `结尾钩子：${replayCase.endingHook}`,
  ].filter(Boolean).join("\n");

  return [
    {
      id: "REPLAY-WORLD-001",
      name: `${replayCase.chapterTitle}世界状态`,
      type: "RULE",
      tags: ["replay", replayCase.bookId, `chapter-${padChapter(replayCase.chapterNumber)}`],
      summary,
      fullDescription,
      revealVersions: [
        {
          depth: "surface",
          content: summary,
          chapter: replayCase.chapterNumber,
          spoilerProtection: false,
          explainability: "active",
        },
      ],
      dependencies: {
        hard: [],
        soft: [],
      },
      plotBindings: replayCase.keyEvents.slice(0, 3).map((event, index) => ({
        bindingType: index === 0 ? "BACKGROUND" : "TRIGGER",
        triggerEvent: event,
        intensity: index === 0 ? 0.55 : 0.72,
      })),
      releaseStrategy: {
        explainability: "active",
        preferredTechnique: "conflict_exposure",
        forbiddenChapters: [],
        forcedChapter: replayCase.chapterNumber,
        styleOverride: null,
        deferability: 0.15,
        manualOverrides: [],
      },
      status: "planned",
      earliestChapter: replayCase.chapterNumber,
      optimalChapter: replayCase.chapterNumber,
      latestChapter: replayCase.chapterNumber,
      actualChapter: null,
      createdBy: "replay-runner",
      createdAt: now,
      lastModified: now,
      priorityScore: 0,
    },
  ];
}

function compactReplayWorldText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "场景簇：核心场景；类型信号：异常、线索、延迟揭示。";
  }
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

function writeReplayWorkspace(projectRoot: string, input: ReplayWorkspaceInput): void {
  const workspacePath = join(projectRoot, "workspaces", input.workspaceId);
  const seriesPath = join(workspacePath, "series");
  const charactersPath = join(workspacePath, "characters");
  const chaptersPath = join(workspacePath, "chapters");
  const worldbuildingPath = join(workspacePath, "worldbuilding");

  for (const dir of [workspacePath, seriesPath, charactersPath, chaptersPath, worldbuildingPath]) {
    mkdirSync(dir, { recursive: true });
  }

  writeJson(join(workspacePath, "config.json"), input.config);
  writeFileSync(join(seriesPath, "outline.md"), input.outline + "\n", "utf-8");
  writeFileSync(join(charactersPath, "replay-character.md"), input.characterProfile + "\n", "utf-8");
  writeJson(join(seriesPath, "world-items.json"), {
    items: input.worldItems,
    lastUpdated: new Date().toISOString(),
  });
  writeJson(join(seriesPath, "skeleton.json"), input.skeleton);
  writeJson(join(seriesPath, "narrative-state.json"), input.narrativeState);
  writeJson(join(seriesPath, "unsettled-details.json"), input.unsettledDetails);
}

function buildInvokeCommand(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
  chapterNumber: number,
  mockAgent: boolean,
  resultPath: string,
  timeoutMs?: number
): ReplayInvokeCommand {
  const args = [
    "scripts/invoke-generate-chapter.mjs",
    workspaceId,
    chapterId,
    String(chapterNumber),
  ];
  if (mockAgent) {
    args.push("mock");
  }

  return {
    toolName: "novel_generate_chapter",
    executable: process.execPath,
    args,
    cwd: projectRoot,
    workspaceId,
    chapterId,
    chapterNumber,
    mockAgent,
    resultPath,
    timeoutMs,
  };
}

export async function defaultInvokeGenerateChapter(command: ReplayInvokeCommand): Promise<ReplayInvokeResult> {
  const startedAt = Date.now();
  return new Promise((resolveInvoke) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: Omit<ReplayInvokeResult, "durationMs">): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolveInvoke({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };

    const timeoutMs = normalizeInvokeTimeoutMs(command.timeoutMs);
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `${stderr ? "\n" : ""}novel_generate_chapter timed out after ${timeoutMs}ms; child process was terminated.`;
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        forceKillTimer = setTimeout(() => {
          if (!settled && !child.killed) {
            child.kill("SIGKILL");
          }
        }, REPLAY_FORCE_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error: Error) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: stderr + error.message,
        timedOut,
      });
    });
    child.on("close", (code: number | null) => {
      // R46: 进程已完全退出后写入 timeout FailureEnvelope，确保不与子进程写 trace 冲突
      if (timedOut) {
        try {
          const workspacesRoot = resolve(command.cwd, "..", "..", "..", "workspaces");
          const timeoutEnvelope = createFailureEnvelope({
            stage: "orchestration",
            gate: "model_timeout",
            severity: "hard_block",
            reason: `model_timeout: ${command.toolName} ${command.workspaceId}#${command.chapterNumber} timed out after ${timeoutMs}ms`,
            evidence: { workspaceId: command.workspaceId, chapterNumber: command.chapterNumber, timeoutMs },
            recoverable: false,
            userActionRequired: ["检查模型服务可用性/网络，或调大 PINOVEL_REPLAY_INVOKE_TIMEOUT_MS 后重试"],
          });
          flushFailureEnvelopeToTraceFile(workspacesRoot, command.workspaceId, command.chapterId, timeoutEnvelope);
        } catch (envelopeError) {
          stderr += `\n[Warning] Failed to write timeout FailureEnvelope: ${envelopeError}`;
        }
      }
      finish({
        exitCode: timedOut ? REPLAY_TIMEOUT_EXIT_CODE : code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function normalizeInvokeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

function resolveReplayInvokeTimeoutMs(timeoutMs: number | undefined): number {
  return normalizeInvokeTimeoutMs(timeoutMs) ??
    normalizeInvokeTimeoutMs(Number(process.env[REPLAY_INVOKE_TIMEOUT_ENV])) ??
    REPLAY_DEFAULT_INVOKE_TIMEOUT_MS;
}

function loadReplayCase(entry: string | ReplayCase): ReplayCase {
  if (typeof entry !== "string") {
    return entry;
  }
  return JSON.parse(readFileSync(entry, "utf-8")) as ReplayCase;
}

function inferProtagonistName(replayCase: ReplayCase): string {
  return sanitizeReplayProtagonistName(readReplayProtagonistCandidate(replayCase)) ?? REPLAY_PROTAGONIST_FALLBACK;
}

function inferGenre(replayCase: ReplayCase): string {
  const text = `${replayCase.worldState}\n${replayCase.conflictTarget}\n${replayCase.endingHook}`;
  if (/anomaly|clue|悬疑|异常|线索/.test(text)) {
    return "悬疑";
  }
  return "都市";
}

function eventTitle(index: number): string {
  const titles = ["入场异常", "线索推进", "选择加压", "结尾钩子"];
  return titles[index] ?? `推进点${index + 1}`;
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

interface ReplayQualityReportInput {
  projectRoot: string;
  replayCase: ReplayCase;
  result: Record<string, unknown>;
  reportMetadata: ReplayGenerationReport["metadata"];
  candidatePath: string;
  referencePath: string;
  metadataPath: string;
  outputPath: string;
  skippedPath: string;
}

interface ReplayGenerationCompletionInput {
  invocation: ReplayInvokeResult;
  result: Record<string, unknown>;
  qualityReportPath: string;
  expectedQualityReportPath: string;
}

function isCompletedReplayGeneration(input: ReplayGenerationCompletionInput): boolean {
  return input.invocation.exitCode === 0 &&
    isSuccessfulGenerationResult(input.result) &&
    Boolean(extractCandidateText(input.result)) &&
    input.qualityReportPath === input.expectedQualityReportPath &&
    existsSync(input.qualityReportPath);
}

function isSuccessfulGenerationResult(result: Record<string, unknown>): boolean {
  const status = readResultStatus(result);
  // P0: completed_with_review 需要人工复核，不能自动视为成功
  // 只有明确的 success 才算成功
  return status === "success";
}

function classifyReplayGenerationFailure(input: ReplayGenerationCompletionInput): ReplayGenerationFailure {
  const upstreamRewrite = extractStage8StructuralRewriteFailure(input.result);
  if (upstreamRewrite) {
    return upstreamRewrite;
  }

  const status = readResultStatus(input.result);
  const hasValidResult = status && status !== "missing_result";
  if ((input.invocation.timedOut || input.invocation.exitCode !== 0) && !hasValidResult) {
    return {
      kind: "invoke_failed",
      status: status || undefined,
      message: input.invocation.timedOut ? input.invocation.stderr || "novel_generate_chapter timed out" : input.invocation.stderr,
    };
  }

  if (status && !isSuccessfulGenerationResult(input.result)) {
    return {
      kind: "generation_error",
      status,
      stage: readStringValue(input.result.stage),
      message: readStringValue(input.result.message),
    };
  }

  if (!extractCandidateText(input.result)) {
    return {
      kind: "candidate_text_missing",
      status: status || undefined,
      stage: readStringValue(input.result.stage),
      message: readStringValue(input.result.message),
    };
  }

  if (input.qualityReportPath !== input.expectedQualityReportPath) {
    const qualityReport = readJsonIfExists(input.qualityReportPath);
    return {
      kind: "quality_report_unavailable",
      status: readStringValue(qualityReport?.status),
      message: readStringValue(qualityReport?.reason),
      qualityReportPath: input.qualityReportPath,
    };
  }

  return {
    kind: "replay_incomplete",
    status: status || undefined,
    stage: readStringValue(input.result.stage),
    message: readStringValue(input.result.message),
    qualityReportPath: input.qualityReportPath,
  };
}

function extractStage8StructuralRewriteFailure(result: Record<string, unknown>): ReplayGenerationFailure | null {
  const stageResults = readObjectValue(result.stageResults);
  const stage8 = readObjectValue(stageResults?.stage8);
  const structuralIntegrity = readObjectValue(stage8?.structuralIntegrity);
  if (!structuralIntegrity) {
    return null;
  }

  const route = readStringValue(structuralIntegrity.route);
  const shouldRequestUpstreamRewrite = structuralIntegrity.shouldRequestUpstreamRewrite === true;
  if (route !== "stage2_rewrite" && !shouldRequestUpstreamRewrite) {
    return null;
  }

  return {
    kind: "upstream_rewrite_requested",
    gate: "structural_integrity",
    stage: readStringValue(result.stage) ?? "8-structural-integrity",
    route: "stage2_rewrite",
    status: readResultStatus(result) || undefined,
    message: readStringValue(result.message) ?? readStringValue(structuralIntegrity.message),
    issueTypes: readStringArrayValue(structuralIntegrity.issueTypes),
    blockingIssueTypes: readStringArrayValue(structuralIntegrity.blockingIssueTypes),
    shouldRequestUpstreamRewrite: true,
  };
}

function isReviewableStage8RepairableAntiAIResult(result: Record<string, unknown>): boolean {
  return extractStage8StructuralRewriteFailure(result) === null &&
    extractStage8RepairableAntiAIFailure(result) !== null;
}

function extractStage8RepairableAntiAIFailure(result: Record<string, unknown>): ReplayGenerationFailure | null {
  const stageResults = readObjectValue(result.stageResults);
  const stage8 = readObjectValue(stageResults?.stage8);
  if (!stage8) {
    return null;
  }

  const antiAI = readObjectValue(stage8.antiAI);
  const directGate = readStringValue(antiAI?.routeGate);
  const routeEntry = readStage8AntiAIRoute(stage8);
  const routeGate = directGate ?? routeEntry?.gate;
  if (routeGate !== "anti_ai_repairable") {
    return null;
  }

  const shouldRequestUpstreamRewrite = antiAI?.shouldRequestUpstreamRewrite === true ||
    routeEntry?.shouldRequestUpstreamRewrite === true;
  if (shouldRequestUpstreamRewrite) {
    return null;
  }

  return {
    kind: "stage8_repairable_warning",
    gate: "anti_ai_repairable",
    stage: readStringValue(antiAI?.routeStage) ?? routeEntry?.stage ?? readStringValue(result.stage) ?? "8-anti-ai",
    route: "stage8_local_repair",
    status: readResultStatus(result) || undefined,
    message: readStringValue(result.message) ?? readStringValue(antiAI?.routeMessage),
    issueTypes: routeEntry?.issueTypes,
    blockingIssueTypes: routeEntry?.blockingIssueTypes,
    repairableIssueTypes: readStringArrayValue(antiAI?.repairableIssueTypes) ?? routeEntry?.repairableIssueTypes,
    shouldRequestUpstreamRewrite: false,
  };
}

function readStage8AntiAIRoute(stage8: Record<string, unknown>): {
  gate?: string;
  stage?: string;
  issueTypes?: string[];
  blockingIssueTypes?: string[];
  repairableIssueTypes?: string[];
  shouldRequestUpstreamRewrite?: boolean;
} | null {
  if (!Array.isArray(stage8.antiAIRoutes)) {
    return null;
  }
  for (const item of stage8.antiAIRoutes) {
    const route = readObjectValue(item);
    if (!route) {
      continue;
    }
    if (readStringValue(route.gate) === "anti_ai_repairable") {
      return {
        gate: readStringValue(route.gate),
        stage: readStringValue(route.stage),
        issueTypes: readStringArrayValue(route.issueTypes),
        blockingIssueTypes: readStringArrayValue(route.blockingIssueTypes),
        repairableIssueTypes: readStringArrayValue(route.repairableIssueTypes),
        shouldRequestUpstreamRewrite: route.shouldRequestUpstreamRewrite === true,
      };
    }
  }
  return null;
}

function createEmptyFailureBreakdown(): Record<ReplayGenerationFailure["kind"], number> {
  return {
    upstream_rewrite_requested: 0,
    human_review_required: 0,
    stage8_repairable_warning: 0,
    invoke_failed: 0,
    generation_error: 0,
    candidate_text_missing: 0,
    quality_report_unavailable: 0,
    replay_incomplete: 0,
  };
}

function readResultStatus(result: Record<string, unknown>): string {
  const directStatus = result.status;
  if (typeof directStatus === "string") {
    return directStatus.trim().toLowerCase();
  }

  const details = result.details;
  if (details && typeof details === "object") {
    const nestedStatus = (details as Record<string, unknown>).status;
    if (typeof nestedStatus === "string") {
      return nestedStatus.trim().toLowerCase();
    }
  }

  return "";
}

function readObjectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readArrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function writeReplayQualityReport(input: ReplayQualityReportInput): string {
  const candidateText = extractCandidateText(input.result);
  if (!candidateText) {
    writeJson(input.skippedPath, {
      schemaVersion: 1,
      status: "skipped",
      reason: "candidate text missing from novel_generate_chapter result",
      metadata: input.reportMetadata,
      createdAt: new Date().toISOString(),
    });
    return input.skippedPath;
  }

  const reference = extractReferenceText(input.replayCase);
  if (!reference.ok) {
    writeJson(input.skippedPath, {
      schemaVersion: 1,
      status: "skipped",
      reason: reference.reason,
      metadata: input.reportMetadata,
      createdAt: new Date().toISOString(),
    });
    return input.skippedPath;
  }

  writeFileSync(input.candidatePath, candidateText.trim() + "\n", "utf-8");
  writeFileSync(input.referencePath, reference.text.trim() + "\n", "utf-8");
  writeJson(input.metadataPath, buildReplayQualityMetadata(input.replayCase, input.reportMetadata));

  const python = process.env.PYTHON ?? "python";
  const evaluator = join(input.projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
  const evaluation = spawnSync(
    python,
    [
      evaluator,
      "--reference",
      input.referencePath,
      "--candidate",
      input.candidatePath,
      "--metadata",
      input.metadataPath,
      "--output",
      input.outputPath,
      "--min-delta",
      "0",
    ],
    {
      cwd: input.projectRoot,
      encoding: "utf-8",
      shell: false,
    }
  );

  if (evaluation.status !== 0 || !existsSync(input.outputPath)) {
    writeJson(input.skippedPath, {
      schemaVersion: 1,
      status: "failed",
      reason: "replay quality evaluator failed",
      metadata: input.reportMetadata,
      evaluator: {
        executable: python,
        exitCode: evaluation.status ?? 1,
        stderr: evaluation.stderr,
      },
      createdAt: new Date().toISOString(),
    });
    return input.skippedPath;
  }

  return input.outputPath;
}

function extractCandidateText(result: Record<string, unknown>): string {
  if (!isSuccessfulGenerationResult(result)) {
    return "";
  }

  const directKeys = ["text", "chapterText", "content", "finalText"];
  for (const key of directKeys) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const nestedCandidates = [result.chapter, result.details, result.result];
  for (const nested of nestedCandidates) {
    if (!nested || typeof nested !== "object") continue;
    for (const key of directKeys) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }

  const reviewableStage8Text = extractReviewableStage8AntiAIRevisedText(result);
  if (reviewableStage8Text) {
    return reviewableStage8Text;
  }

  return "";
}

function extractReviewableStage8AntiAIRevisedText(result: Record<string, unknown>): string {
  if (!isReviewableStage8RepairableAntiAIResult(result)) {
    return "";
  }

  const stageResults = readObjectValue(result.stageResults);
  const stage8 = readObjectValue(stageResults?.stage8);
  const antiAI = readObjectValue(stage8?.antiAI);
  const revisedText = readStringValue(antiAI?.revisedText);
  return revisedText ?? "";
}

type ReplayReferenceResolution =
  | { ok: true; text: string }
  | { ok: false; reason: string };

function extractReferenceText(replayCase: ReplayCase): ReplayReferenceResolution {
  if (!existsSync(replayCase.originalChapterPath)) {
    return { ok: false, reason: "reference text missing or unreadable for replay evaluator" };
  }

  const decoded = decodeNovelSourceBuffer(readFileSync(replayCase.originalChapterPath)).text;
  const body = resolveReplayReferenceBody(decoded, replayCase);
  if (body === null) {
    return {
      ok: false,
      reason: "reference hash mismatch: source span no longer maps to a chapter slice",
    };
  }

  if (hashReplayBody(body) !== replayCase.originalHash) {
    return {
      ok: false,
      reason: "reference hash mismatch: extracted reference body does not match originalHash",
    };
  }

  return { ok: true, text: body };
}

function buildReplayQualityMetadata(
  replayCase: ReplayCase,
  metadata: ReplayGenerationReport["metadata"]
): Record<string, unknown> {
  const trace = readTraceForReplayQualityMetadata(metadata);
  const getdraftDialogueRules = buildGetDraftDialogueCandidateRules(trace);
  const localRepairEvidence = buildGetDraftLocalRepairEvidence(trace);

  return {
    ...metadata,
    bookId: replayCase.bookId,
    chapterId: String(replayCase.chapterNumber),
    chapterNumber: replayCase.chapterNumber,
    chapterTitle: replayCase.chapterTitle,
    contentPoints: replayCase.keyEvents,
    events: replayCase.keyEvents.map((event, index) => ({
      id: `event_${index + 1}`,
      sceneType: index === replayCase.keyEvents.length - 1 ? "hook" : index === 0 ? "setup" : "conflict",
      contentPoints: [event],
      emotionalBeat: replayCase.emotionalBeats[index] ?? replayCase.emotionalBeats.at(-1) ?? "",
    })),
    endingHook: replayCase.endingHook,
    conflictTarget: replayCase.conflictTarget,
    ...(getdraftDialogueRules.length > 0 ? { candidateRules: getdraftDialogueRules } : {}),
    ...(localRepairEvidence.triggers.length > 0 ? { localRepairEvidence } : {}),
  };
}

function readTraceForReplayQualityMetadata(metadata: ReplayGenerationReport["metadata"]): Record<string, unknown> | null {
  const tracePath = metadata.candidate.tracePath;
  if (!tracePath || !existsSync(tracePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(tracePath, "utf-8")) as unknown;
    return readObjectValue(parsed);
  } catch {
    return null;
  }
}

interface GetDraftDialogueEventEvidence {
  eventId: string;
  eventType?: string;
  narrativeBeat?: string;
  dialoguePropulsionScore?: number;
  stateDelta?: boolean;
  choiceDelta?: number;
  riskDelta?: number;
  causalChain?: boolean;
  protagonistActive?: boolean;
  contractCoverage?: number;
}

interface GetDraftDialogueCandidateRule {
  id: "DP-001" | "DP-002" | "HC-001" | "HC-002";
  axis: "dialogue_propulsion" | "hook_causality";
  source: "getdraft_dialogue";
  validationStatus: "candidate";
  runtimeDefaultEnabled: false;
  requiresReplayPromotion: true;
  patchUnit: "event" | "chapter_end";
  triggeredEventIds: string[];
  // Fields required by promote_validated_rules.py normalize_rule():
  // craftMove is mandatory (returned null if missing); mustDo/avoid/
  // sceneType/appliesWhen/microExample let the promotion output carry
  // the full craft-rule shape into candidate-rules.json.
  craftMove: string;
  sceneType: string;
  appliesWhen: string[];
  mustDo: string[];
  avoid: string[];
  microExample?: string;
}

/**
 * GetDraft Stage 2 candidate rule templates.
 *
 * Mirrors the Python STAGE2_TEMPLATES in normalize_getdraft_candidate_rules.py
 * so that replay-runner emits the same craftMove/mustDo/avoid shape that
 * promote_validated_rules.py expects. Without these fields the promotion
 * normalize_rule() silently drops every rule.
 */
const STAGE2_RULE_TEMPLATES: Record<string, Omit<GetDraftDialogueCandidateRule, "id" | "axis" | "patchUnit" | "triggeredEventIds">> = {
  "DP-001": {
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    requiresReplayPromotion: true,
    sceneType: "general",
    appliesWhen: ["axis:dialogue_propulsion", "stage:stage2", "metric:state_delta", "metric:choice_delta", "metric:risk_delta"],
    craftMove: "Make each dialogue event end with a visible state, choice, or risk delta.",
    mustDo: [
      "Before closing a dialogue event, name the state shift (information, choice, risk).",
      "Tie at least one turn to a forced choice, raised risk, or new knowledge.",
      "Carry the changed state into the next beat instead of resetting to talk-only exchange.",
    ],
    avoid: ["Banter or restated positions that leave leverage unchanged.", "Closing on emotion-only beats without any delta."],
    microExample: "[abstract] A reply forces a choice, raises risk, or delivers new information before the exchange exits.",
  },
  "DP-002": {
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    requiresReplayPromotion: true,
    sceneType: "general",
    appliesWhen: ["axis:dialogue_propulsion", "stage:stage2", "beat:revelation", "beat:confrontation", "beat:decision", "metric:protagonist_active"],
    craftMove: "In revelation/confrontation/decision dialogue, keep the protagonist active.",
    mustDo: [
      "Give the protagonist at least one turn that questions, challenges, or asserts.",
      "Refuse passive acceptance during revelation, confrontation, or decision beats.",
      "Tie the protagonist's active turn to a downstream consequence or commitment.",
    ],
    avoid: ["Letting the protagonist only react with internal monologue during high-stakes beats.", "Replacing protagonist agency with bystander narration."],
    microExample: "[abstract] In a revelation beat, the protagonist names the stake, asks the cornering question, or refuses the framing.",
  },
  "HC-001": {
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    requiresReplayPromotion: true,
    sceneType: "general",
    appliesWhen: ["axis:hook_causality", "stage:stage2", "scope:chapter_end", "metric:hook_evidence_chain"],
    craftMove: "Anchor the chapter-end hook in evidence introduced earlier in the chapter.",
    mustDo: [
      "Reuse a prior fact, action, or risk seeded earlier when forming the hook.",
      "Let the final turn reframe earlier material rather than introducing brand-new elements.",
      "Leave a precise next question rather than a generic warning.",
    ],
    avoid: ["Hook lines that could be attached to any chapter.", "Final turns that introduce wholly new entities or facts not seeded before."],
    microExample: "[abstract] A clue from earlier returns at the end with a new implication and a specific next question.",
  },
  "HC-002": {
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    requiresReplayPromotion: true,
    sceneType: "general",
    appliesWhen: ["axis:hook_causality", "stage:stage2", "scope:chapter_end", "metric:hook_movement", "metric:information_delta", "metric:risk_delta"],
    craftMove: "Make the chapter-end hook move state — information, risk, or commitment must change.",
    mustDo: [
      "Make the closing beat raise risk, deliver new information, or force a commitment.",
      "Show why waiting would be costly — the next chapter's first problem must be legible.",
      "Avoid restating the same suspense already present at chapter open.",
    ],
    avoid: ["Endings that only restate atmosphere or repeat opening uncertainty.", "Stacking new mysteries without giving the reader new leverage."],
    microExample: "[abstract] The chapter ends with new leverage, new pressure, and one clear question for the next chapter.",
  },
};

export function buildGetDraftDialogueCandidateRules(trace: Record<string, unknown> | null): GetDraftDialogueCandidateRule[] {
  if (!trace) {
    return [];
  }

  const plannedDialogueIds = readPlannedDialogueEventIds(trace);
  const events = Array.isArray(trace.events)
    ? trace.events.filter((event): event is Record<string, unknown> => readObjectValue(event) !== null)
    : [];
  const evidence = events.map((event) => readGetDraftDialogueEventEvidence(event, plannedDialogueIds));
  const dp001Events = evidence.filter(isDp001Trigger).map((event) => event.eventId);
  const dp002Events = evidence.filter(isDp002Trigger).map((event) => event.eventId);
  const rules: GetDraftDialogueCandidateRule[] = [];

  if (dp001Events.length > 0) {
    rules.push(createDialogueCandidateRule("DP-001", "dialogue_propulsion", "event", dp001Events));
  }
  if (dp002Events.length > 0) {
    rules.push(createDialogueCandidateRule("DP-002", "dialogue_propulsion", "event", dp002Events));
  }

  // Hook causality is a chapter-end signal — derived from the last event's
  // progression evidence. We trigger only when the last event clearly fails
  // the hook movement / chain criteria, so promotion evidence is honest.
  const hookEvidence = readChapterEndingHookEvidence(events);
  if (hookEvidence !== null) {
    if (isHc001Trigger(hookEvidence)) {
      rules.push(createDialogueCandidateRule("HC-001", "hook_causality", "chapter_end", [hookEvidence.eventId]));
    }
    if (isHc002Trigger(hookEvidence)) {
      rules.push(createDialogueCandidateRule("HC-002", "hook_causality", "chapter_end", [hookEvidence.eventId]));
    }
  }

  return rules;
}

function createDialogueCandidateRule(
  id: GetDraftDialogueCandidateRule["id"],
  axis: GetDraftDialogueCandidateRule["axis"],
  patchUnit: GetDraftDialogueCandidateRule["patchUnit"],
  triggeredEventIds: string[]
): GetDraftDialogueCandidateRule {
  const template = STAGE2_RULE_TEMPLATES[id];
  return {
    id,
    axis,
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    requiresReplayPromotion: true,
    patchUnit,
    triggeredEventIds,
    craftMove: template.craftMove,
    sceneType: template.sceneType,
    appliesWhen: [...template.appliesWhen],
    mustDo: [...template.mustDo],
    avoid: [...template.avoid],
    microExample: template.microExample,
  };
}

function readPlannedDialogueEventIds(trace: Record<string, unknown>): Set<string> {
  const chapterContract = readObjectValue(trace.chapterContract);
  const dialoguePlan = readObjectValue(chapterContract?.dialoguePlan);
  const ids = Array.isArray(dialoguePlan?.dialogueBearingEventIds) ? dialoguePlan.dialogueBearingEventIds : [];
  return new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
}

function readGetDraftDialogueEventEvidence(
  event: Record<string, unknown>,
  plannedDialogueIds: Set<string>
): GetDraftDialogueEventEvidence {
  const bridge = readObjectValue(event.getdraftDialogueTrace);
  const craftGate = readObjectValue(event.craftGate);
  const craftMetrics = readObjectValue(craftGate?.metrics);
  const progression = readObjectValue(event.progression);
  const progressionEvidence = readObjectValue(progression?.evidence);
  const progressionMetrics = readObjectValue(progressionEvidence?.metrics);
  const eventId = readStringValue(event.eventId) ?? readStringValue(event.id) ?? "unknown-event";
  const bridgeEventType = readStringValue(bridge?.event_type);
  const inferredDialogue = bridgeEventType === "dialogue" ||
    plannedDialogueIds.has(eventId) ||
    readObjectValue(event.dialogueContract) !== null ||
    (readNumberValue(craftMetrics?.dialogueRatio) ?? 0) > 0;

  return {
    eventId,
    eventType: bridgeEventType ?? (inferredDialogue ? "dialogue" : readStringValue(event.type)),
    narrativeBeat: readStringValue(bridge?.narrative_beat) ?? readStringValue(event.narrativeBeat) ?? readStringValue(event.sceneType),
    dialoguePropulsionScore: readNumberValue(bridge?.dialogue_propulsion_score) ?? readNumberValue(craftMetrics?.dialoguePropulsion),
    stateDelta: readBooleanValue(bridge?.state_delta) ?? readBooleanValue(readObjectValue(progressionMetrics?.state_delta)?.passed),
    choiceDelta: readNumberValue(bridge?.choice_delta),
    riskDelta: readNumberValue(bridge?.risk_delta) ?? readNumberValue(readObjectValue(progressionEvidence?.riskDelta)?.score),
    causalChain: readBooleanValue(bridge?.causal_chain) ?? readBooleanValue(readObjectValue(progressionMetrics?.causal_chain)?.passed),
    protagonistActive: readBooleanValue(bridge?.protagonist_active) ?? readBooleanValue(readObjectValue(progressionMetrics?.protagonist_active)?.passed),
    contractCoverage: readNumberValue(bridge?.contract_coverage) ?? readNumberValue(craftMetrics?.contractCoverage),
  };
}

function isDp001Trigger(event: GetDraftDialogueEventEvidence): boolean {
  if (event.eventType !== "dialogue") {
    return false;
  }

  const weakStateShift = event.stateDelta === false &&
    (event.choiceDelta === undefined || event.choiceDelta <= 0) &&
    (event.riskDelta === undefined || event.riskDelta <= 0);
  return (event.dialoguePropulsionScore !== undefined && event.dialoguePropulsionScore < 80) || weakStateShift;
}

function isDp002Trigger(event: GetDraftDialogueEventEvidence): boolean {
  if (event.eventType !== "dialogue" || event.protagonistActive !== false) {
    return false;
  }

  return ["revelation", "confrontation", "decision"].includes((event.narrativeBeat ?? "").toLowerCase());
}

interface ChapterEndingHookEvidence {
  eventId: string;
  informationDeltaScore: number;
  riskDeltaScore: number;
  informationHits: string[];
  earlierInformationHits: string[];
}

function readChapterEndingHookEvidence(events: Record<string, unknown>[]): ChapterEndingHookEvidence | null {
  // HC-001 needs at least one earlier event to compare against — with a
  // single-event chapter there's no chain to reuse evidence from.
  if (events.length < 2) {
    return null;
  }
  const lastEvent = events[events.length - 1];
  const lastEventId =
    readStringValue(lastEvent.eventId) ?? readStringValue(lastEvent.id) ?? "unknown-event";
  const lastInformationEvidence = readObjectValue(
    readObjectValue(readObjectValue(lastEvent.progression)?.evidence)?.informationDelta
  );
  const lastRiskEvidence = readObjectValue(
    readObjectValue(readObjectValue(lastEvent.progression)?.evidence)?.riskDelta
  );
  if (lastInformationEvidence === null && lastRiskEvidence === null) {
    return null;
  }
  const earlierInformationHits: string[] = [];
  for (const earlier of events.slice(0, -1)) {
    const evidence = readObjectValue(
      readObjectValue(readObjectValue(earlier.progression)?.evidence)?.informationDelta
    );
    earlierInformationHits.push(...readStringArray(evidence?.hits));
  }
  return {
    eventId: lastEventId,
    informationDeltaScore: readNumberValue(lastInformationEvidence?.score) ?? 0,
    riskDeltaScore: readNumberValue(lastRiskEvidence?.score) ?? 0,
    informationHits: readStringArray(lastInformationEvidence?.hits),
    earlierInformationHits,
  };
}

function isHc001Trigger(evidence: ChapterEndingHookEvidence): boolean {
  // HC-001: ending hook must reuse evidence introduced earlier in chapter.
  // We only flag this when the last event presents named information hits
  // and none of them appeared earlier — that is, the hook came from
  // nowhere. When the last event has no informationHits at all, we lack
  // signal to evaluate chain reuse and avoid a false positive.
  if (evidence.informationHits.length === 0) {
    return false;
  }
  const earlierSet = new Set(evidence.earlierInformationHits);
  const overlaps = evidence.informationHits.some((hit) => earlierSet.has(hit));
  return !overlaps;
}

function isHc002Trigger(evidence: ChapterEndingHookEvidence): boolean {
  // HC-002: chapter end must move state — information OR risk delta non-zero.
  return evidence.informationDeltaScore === 0 && evidence.riskDeltaScore === 0;
}

interface LocalRepairTrigger {
  ruleId: "LC-001" | "LC-002" | "AA-001" | "AA-002";
  axis: "location_continuity" | "anti_ai_span_repair";
  observationMode: boolean;
  patchUnit: "span";
  triggeredEventIds: string[];
}

interface LocalRepairEvidence {
  source: "getdraft_dialogue";
  validationStatus: "candidate";
  runtimeDefaultEnabled: false;
  triggers: LocalRepairTrigger[];
}

export function buildGetDraftLocalRepairEvidence(trace: Record<string, unknown> | null): LocalRepairEvidence {
  const empty: LocalRepairEvidence = {
    source: "getdraft_dialogue",
    validationStatus: "candidate",
    runtimeDefaultEnabled: false,
    triggers: [],
  };
  if (!trace) return empty;

  // Honour repair observations persisted by stage5/stage8 (the authoritative
  // signal that a GetDraft candidate spec was active during this generation).
  const persistedObservations = readArrayOfObjects(trace.repairObservations);
  const observationTriggerMap: Map<string, LocalRepairTrigger> = new Map();
  for (const obs of persistedObservations) {
    const ruleId = readStringValue(obs.ruleId) as LocalRepairTrigger["ruleId"] | undefined;
    if (!ruleId || !["LC-001", "LC-002", "AA-001", "AA-002"].includes(ruleId)) continue;
    const existing = observationTriggerMap.get(ruleId);
    if (existing) continue; // dedupe: one trigger per rule ID per chapter
    const observationMode = ruleId.startsWith("AA-");
    observationTriggerMap.set(ruleId, {
      ruleId,
      axis: ruleId.startsWith("LC") ? "location_continuity" : "anti_ai_span_repair",
      observationMode,
      patchUnit: "span",
      triggeredEventIds: [],
    });
  }
  const triggers: LocalRepairTrigger[] = [...observationTriggerMap.values()];

  const events = Array.isArray(trace.events)
    ? trace.events.filter((event): event is Record<string, unknown> => readObjectValue(event) !== null)
    : [];
  if (events.length === 0 && triggers.length === 0) return empty;

  // LC-001 location_continuity: adjacent events with different locations and
  // no transition anchor evidence in the second event's setup support.
  const lc001Events: string[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    const prevLocation = readStringValue(prev.eventLocation) ?? readStringValue(prev.location);
    const curLocation = readStringValue(cur.eventLocation) ?? readStringValue(cur.location);
    if (!prevLocation || !curLocation || prevLocation === curLocation) continue;
    const setupSupport = readObjectValue(
      readObjectValue(readObjectValue(cur.progression)?.evidence)?.setupSupportEvidence
    );
    const hits = readStringArray(setupSupport?.hits);
    if (hits.length === 0) {
      lc001Events.push(readStringValue(cur.eventId) ?? readStringValue(cur.id) ?? `event-${i}`);
    }
  }
  if (lc001Events.length > 0) {
    triggers.push({
      ruleId: "LC-001",
      axis: "location_continuity",
      observationMode: false,
      patchUnit: "span",
      triggeredEventIds: lc001Events,
    });
  }

  // LC-002 entry_evidence: first appearance of named entity without entry
  // anchor evidence. Conservative proxy: events flagged with
  // abnormalEntryEvidence missing hits at first character introduction.
  const lc002Events: string[] = [];
  for (const event of events) {
    const abnormalEntry = readObjectValue(
      readObjectValue(readObjectValue(event.progression)?.evidence)?.abnormalEntryEvidence
    );
    if (!abnormalEntry) continue;
    const hits = readStringArray(abnormalEntry.hits);
    const expected = readNumberValue(abnormalEntry.expected) ?? 0;
    if (expected > 0 && hits.length === 0) {
      lc002Events.push(readStringValue(event.eventId) ?? readStringValue(event.id) ?? "unknown-event");
    }
  }
  if (lc002Events.length > 0) {
    triggers.push({
      ruleId: "LC-002",
      axis: "location_continuity",
      observationMode: false,
      patchUnit: "span",
      triggeredEventIds: lc002Events,
    });
  }

  // AA-001 anti_ai_span_repair: events whose craft gate flags ai phrasing.
  // observationMode=true so trace records but does not block.
  const aa001Events: string[] = [];
  for (const event of events) {
    const craftMetrics = readObjectValue(readObjectValue(event.craftGate)?.metrics);
    const aiPhrasing = readNumberValue(craftMetrics?.aiPhrasing);
    if (typeof aiPhrasing === "number" && aiPhrasing > 0) {
      aa001Events.push(readStringValue(event.eventId) ?? readStringValue(event.id) ?? "unknown-event");
    }
  }
  if (aa001Events.length > 0) {
    triggers.push({
      ruleId: "AA-001",
      axis: "anti_ai_span_repair",
      observationMode: true,
      patchUnit: "span",
      triggeredEventIds: aa001Events,
    });
  }

  // AA-002 over_explanation: events whose craft gate contractCoverage is high
  // BUT dialoguePropulsion is low — proxy for over-explained narration.
  const aa002Events: string[] = [];
  for (const event of events) {
    const craftMetrics = readObjectValue(readObjectValue(event.craftGate)?.metrics);
    const contractCoverage = readNumberValue(craftMetrics?.contractCoverage);
    const dialoguePropulsion = readNumberValue(craftMetrics?.dialoguePropulsion);
    if (
      typeof contractCoverage === "number" &&
      typeof dialoguePropulsion === "number" &&
      contractCoverage >= 90 &&
      dialoguePropulsion < 60
    ) {
      aa002Events.push(readStringValue(event.eventId) ?? readStringValue(event.id) ?? "unknown-event");
    }
  }
  if (aa002Events.length > 0) {
    triggers.push({
      ruleId: "AA-002",
      axis: "anti_ai_span_repair",
      observationMode: true,
      patchUnit: "span",
      triggeredEventIds: aa002Events,
    });
  }

  return { ...empty, triggers };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): string => (typeof item === "string" ? item : ""))
    .filter((item: string): boolean => item.length > 0);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

// P9 真实晋级证据：将 candidate rules 晋级写入 validated-craft-rules.json
// 当 humanApproved=true 且 canPromote=true 时调用。
// 合并策略：按 ruleId 去重，已存在则更新 evidence，不存在则追加。
// 返回晋级结果（promotedCount / promotedPath / reason）供审计。
export function promoteCandidateRulesToValidated(
  validatedRulesPath: string,
  candidateRules: readonly import("./replay-delta-analyzer.js").CandidateRule[],
  bookId: string,
  runId: string
): { promoted: boolean; reason: string; promotedPath: string; promotedCount: number } {
  type ValidatedEntry = {
    id: string;
    sceneType?: string;
    appliesWhen?: unknown[];
    craftMove?: string;
    mustDo?: string[];
    avoid?: string[];
    evidence?: {
      source: string;
      sampleSize: number;
      wins: number;
      losses: number;
      winRate: number;
      validatedWinRate: number;
      lastValidatedAt: string;
      benchmarkIds: string[];
      promotedFromRun?: string;
    };
  };
  type ValidatedRulesFile = {
    schemaVersion: number;
    generatedAt: string;
    entries: ValidatedEntry[];
  };

  let existing: ValidatedRulesFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: [],
  };
  if (existsSync(validatedRulesPath)) {
    try {
      const raw = JSON.parse(readFileSync(validatedRulesPath, "utf-8")) as ValidatedRulesFile;
      if (raw && Array.isArray(raw.entries)) {
        existing = raw;
      }
    } catch {
      // 解析失败则用空结构
    }
  }

  const now = new Date().toISOString();
  const entriesById = new Map<string, ValidatedEntry>(existing.entries.map(e => [e.id, e]));
  let promotedCount = 0;

  for (const candidate of candidateRules) {
    const ruleId = candidate.ruleId;
    const wins = Math.round(candidate.winRate * candidate.sampleSize);
    const losses = candidate.sampleSize - wins;
    const evidence = {
      source: "replay_benchmark",
      sampleSize: candidate.sampleSize,
      wins,
      losses,
      winRate: candidate.winRate,
      validatedWinRate: candidate.winRate,
      lastValidatedAt: now,
      benchmarkIds: [...candidate.extractedFrom],
      promotedFromRun: runId,
    };
    const existingEntry = entriesById.get(ruleId);
    if (existingEntry) {
      // 已存在则更新 evidence（保留原有 craftMove/mustDo/avoid）
      existingEntry.evidence = evidence;
      promotedCount++;
    } else {
      // 新增 entry（candidate rule 缺少 craftMove/mustDo/avoid，仅写入 evidence）
      const newEntry: ValidatedEntry = {
        id: ruleId,
        sceneType: "scene",
        appliesWhen: [],
        craftMove: `Promoted from replay run ${runId}; see evidence.`,
        mustDo: [],
        avoid: [],
        evidence,
      };
      entriesById.set(ruleId, newEntry);
      existing.entries.push(newEntry);
      promotedCount++;
    }
  }

  existing.generatedAt = now;
  writeJson(validatedRulesPath, existing);

  return {
    promoted: promotedCount > 0,
    reason: promotedCount > 0
      ? `晋级成功：${promotedCount} 条 candidate rules 已写入 validated-craft-rules.json（runId=${runId}, bookId=${bookId}）`
      : "无 candidate rules 可晋级",
    promotedPath: validatedRulesPath,
    promotedCount,
  };
}

// P9 Replay 流水化：从 quality-report.json 文件列表中提取 ReplaySample[]
// quality-report.json 由 scripts/replay-benchmark/run_replay_benchmark.py 生成，
// 包含 candidateMetrics（progression/hookMovement/readerNeedToContinue/ai_filler_density 等）
// 和 candidateRules（ruleId 列表）。
function collectReplaySamples(reports: readonly string[]): ReplaySample[] {
  const samples: ReplaySample[] = [];
  for (const reportPath of reports) {
    if (!reportPath.endsWith("-quality-report.json")) continue;
    if (!existsSync(reportPath)) continue;
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(reportPath, "utf-8"));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const metrics = raw.candidateMetrics || raw.referenceMetrics;
    if (!metrics) continue;
    const candidateRules: any[] = Array.isArray(raw.candidateRules) ? raw.candidateRules : [];
    const ruleHits = candidateRules
      .map((r: any) => typeof r?.id === "string" ? r.id : null)
      .filter((id: string | null): id is string => id !== null);
    const benchmarkId = typeof raw.benchmarkId === "string" ? raw.benchmarkId : reportPath;
    const passed = raw.candidateWins === true;
    samples.push({
      sampleId: `sample-${samples.length + 1}`,
      chapterId: benchmarkId,
      passed,
      metrics: {
        progression: num(metrics.progression),
        hook: num(metrics.hookMovement),
        choiceStrength: num(metrics.choiceDelta),
        infoIncrement: num(metrics.evidenceDelta),
        readOn: num(metrics.readerNeedToContinue),
        antiAI: typeof metrics.ai_filler_density === "number"
          ? 1 - clamp01(metrics.ai_filler_density)
          : undefined,
      },
      ruleHits: ruleHits.length > 0 ? ruleHits : undefined,
    });
  }
  return samples;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mirrorGeneratedResult(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf-8"), "utf-8");
}

function mirrorTrace(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
  targetPath: string
): void {
  const sourcePath = join(projectRoot, "workspaces", workspaceId, "traces", `${chapterId}-quality-trace.json`);
  if (!existsSync(sourcePath)) {
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf-8"), "utf-8");
}

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `run-${stamp}`;
}
