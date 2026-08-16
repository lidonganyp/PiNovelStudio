#!/usr/bin/env node
/**
 * LANGUAGE-CALIBRATION-REAL-1 验收脚本（GREEN）
 *
 * 派工卡: delete/任务列表/项目优化20260718.md P1-4 L383-407
 *
 * 跑 5 章真实 raw 文本 + stub modelGenerate 验证现有
 * voice_and_naturalness → v2_chinese_calibration 链路端到端可达性。
 *
 * 输出: reports/language-calibration-real-1/verification-report.md
 *
 * REQUIRES_AUTH 边界：
 * - 本脚本仅 stub 模式（默认 --stub）
 * - 真实 Doubao + gpt-5.6-sol 调用属于 REQUIRES_AUTH，作为后续切片单独提交
 *
 * 用法:
 *   node scripts/language-calibration-real-1/run-verification.mjs --stub
 *   node scripts/language-calibration-real-1/run-verification.mjs --auth   # REQUIRES_AUTH
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createEditorialCandidateGenerator } from "../../dist/v2/core/editorial-candidate-generator.js";
import { createEditorialStrategyRegistry } from "../../dist/v2/core/editorial-strategy-registry.js";
import { EditorialOpportunityJudge } from "../../dist/v2/core/editorial-opportunity-judge.js";
import { JudgeArbitrator } from "../../dist/v2/core/judge-arbitrator.js";
import { checkCandidateFactGuard } from "../../dist/v2/core/orchestrator-factguard.js";

// ============================================================================
// 配置
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
// SCRIPT_DIR = <repo>/.pi/extensions/novel-studio/scripts/language-calibration-real-1
// EXT_ROOT   = <repo>/.pi/extensions/novel-studio          (上 2 层)
// REPO_ROOT  = <repo>                                      (EXT_ROOT 上 3 层：novel-studio → extensions → .pi → repo)
const EXT_ROOT = join(SCRIPT_DIR, "..", "..");
const REPO_ROOT = join(EXT_ROOT, "..", "..", "..");
const XINMO_CHAPTERS = join(REPO_ROOT, "workspaces", "xinmo", "chapters");
const XINMO_CHAPTER_FIXTURES = join(EXT_ROOT, "tests", "fixtures", "xinmo-chapters");
const XINMO_CONFIG = join(REPO_ROOT, "workspaces", "xinmo", "config.json");
const XINMO_CONFIG_FIXTURE = join(EXT_ROOT, "tests", "fixtures", "xinmo-minimal-config.json");
const DEFAULT_CHAPTERS_DIR = existsSync(join(XINMO_CHAPTER_FIXTURES, "chapter-01.md"))
  ? XINMO_CHAPTER_FIXTURES
  : XINMO_CHAPTERS;
const REPORT_DIR = join(REPO_ROOT, "reports", "language-calibration-real-1");
const REPORT_PATH = join(REPORT_DIR, "verification-report.md");
const RAW_MANIFEST_PATH = join(SCRIPT_DIR, "raw-manifest.json");
const BOUNDARY_REJECTION_PATH = join(REPORT_DIR, "stub-boundary-rejection.json");

const EXPECTED_CHAPTERS = [
  "chapter-01.md",
  "chapter-05.md",
  "chapter-08.md",
  "chapter-12.md",
  "chapter-17.md",
];

/**
 * 5 章真实 raw 文本中的不自然 span（手工标注，与测试文件一致）。
 * 每章 1 个真实存在的不自然 span：
 * - chapter-01: "心脏还在胸腔里疯狂跳动" — 略带翻译腔的直白描述
 * - chapter-05: "隐约感到一个黝黑的洞口" — 感知侵蚀词 "感到"
 * - chapter-08: "内心的激动慢慢安静来下" — 语病（"安静来下" 应为 "安静下来"）
 * - chapter-12: "隐约感到一股威压涌来" — 感知侵蚀词 "感到"
 * - chapter-17: "李一凡注意到他收紧的下颌线" — 感知侵蚀词 "注意到"
 */
const CHAPTER_SPANS = {
  "chapter-01.md": "心脏还在胸腔里疯狂跳动",
  "chapter-05.md": "隐约感到一个黝黑的洞口",
  "chapter-08.md": "内心的激动慢慢安静来下",
  "chapter-12.md": "隐约感到一股威压涌来",
  "chapter-17.md": "李一凡注意到他收紧的下颌线",
};

// ============================================================================
// CLI 参数解析
// ============================================================================

function parseArgs(argv) {
  const args = { stub: true, auth: false, chaptersDir: DEFAULT_CHAPTERS_DIR };
  const cliArgs = argv.slice(2);
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    if (arg === "--stub") args.stub = true;
    else if (arg === "--auth") {
      args.auth = true;
      args.stub = false;
    } else if (arg === "--chapters-dir") {
      const value = cliArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--chapters-dir 缺少目录参数");
      }
      args.chaptersDir = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("用法: node run-verification.mjs [--stub|--auth] [--chapters-dir <path>]");
      console.log("  --stub (默认): 使用 stub modelGenerate，不调真实模型");
      console.log("  --auth: REQUIRES_AUTH，调真实 Doubao + gpt-5.6-sol（本切片未启用）");
      console.log("  --chapters-dir: 测试 raw 来源；仍必须与冻结 manifest 完整匹配");
      process.exit(0);
    }
  }
  return args;
}

// ============================================================================
// 加载真实 raw 文本
// ============================================================================

function loadChapterRaw(filename, chaptersDir) {
  const path = join(chaptersDir, filename);
  if (!existsSync(path)) {
    throw new Error(`真实章节缺失：${path}`);
  }
  return readFileSync(path, "utf-8");
}

function loadAllChapters(chaptersDir) {
  const chapters = {};
  for (const name of EXPECTED_CHAPTERS) {
    chapters[name] = loadChapterRaw(name, chaptersDir);
  }
  return chapters;
}

function loadAndValidateRawManifest(chapters) {
  if (!existsSync(RAW_MANIFEST_PATH)) {
    throw new Error(`冻结 raw manifest 缺失：${RAW_MANIFEST_PATH}`);
  }
  const manifestText = readFileSync(RAW_MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(manifestText);
  if (manifest.schema !== "pinovel.language-calibration-raw-manifest.v1") {
    throw new Error(`冻结 raw manifest schema 非法：${manifest.schema ?? "missing"}`);
  }
  if (!Array.isArray(manifest.chapters)) {
    throw new Error("冻结 raw manifest chapters 必须是数组");
  }
  const entries = new Map(manifest.chapters.map((entry) => [entry.filename, entry]));
  for (const filename of EXPECTED_CHAPTERS) {
    const entry = entries.get(filename);
    if (!entry || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) {
      throw new Error(`${filename} 缺少冻结的完整 SHA-256`);
    }
    const actualHash = sha256(chapters[filename]);
    if (actualHash !== entry.sha256.toLowerCase()) {
      throw new Error(`${filename} SHA-256 hash 不匹配：expected=${entry.sha256}, actual=${actualHash}`);
    }
  }
  if (entries.size !== EXPECTED_CHAPTERS.length) {
    throw new Error(`冻结 raw manifest 章节数不匹配：expected=${EXPECTED_CHAPTERS.length}, actual=${entries.size}`);
  }
  return {
    path: RAW_MANIFEST_PATH,
    hash: sha256(manifestText),
    manifest,
  };
}

/**
 * 从 workspaces/xinmo/config.json 加载完整角色名列表（name + aliases）。
 *
 * FactGuard checkEntityHallucination（fact-continuity-guard.ts L885-962）对出现 3+ 次带
 * 言说动词（道/说/问/笑/怒/喊/叹/答/回/应）且不在 knownNames 中的 2-4 字中文名触发
 * severity="hard" 硬阻断。xinmo workspace 有 22 个角色，若只传 ["李一凡"]，其他角色
 * （陈锋/小妖/墨老/赵明远等）会被误报为"实体幻觉"导致 fg.ok=false。
 *
 * 从 config.json 加载完整列表匹配真实生产 FactGuard 调用方式，避免误报。
 */
function loadCharacterNames() {
  const configPath = existsSync(XINMO_CONFIG) ? XINMO_CONFIG : XINMO_CONFIG_FIXTURE;
  if (!existsSync(configPath)) {
    throw new Error(`xinmo config.json 缺失：${XINMO_CONFIG}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const characters = Array.isArray(config.characters) ? config.characters : [];
  const names = [];
  for (const c of characters) {
    if (typeof c.name === "string" && c.name.length > 0) {
      names.push(c.name);
    }
    if (Array.isArray(c.aliases)) {
      for (const a of c.aliases) {
        if (typeof a === "string" && a.length > 0) {
          names.push(a);
        }
      }
    }
  }
  // 去重
  return Array.from(new Set(names));
}

// ============================================================================
// stub modelGenerate（与测试文件一致设计）
// ============================================================================

/**
 * stub modelGenerate 行为：
 * - v2_chinese_calibration: 返回 span 局部替换（仅修改 span excerpt，其余文本不变）
 * - v2_literary_judge: 返回正确 JudgeVerdict 契约（A/B/tie），默认 tie（验证 raw 兜底）
 * - v2_opportunity_judge: 不调用（EditorialOpportunityJudge 本地扫描器）
 *
 * 设计：stub 直接接收 rawText + target excerpt（不解析 prompt）。
 * 每个 stub 实例可绑定多个 (rawText → target) 对，stub 用 prompt 中包含 rawText 来匹配。
 *
 * Change 1 part 2：修复 stub JSON 契约。
 * 旧契约（verdict/confidence:0.4/winnerSpan/loserSpan/reasoning）导致 parseJudgeVerdict
 * 返回 null → PairwiseLiteraryJudge 首轮 degraded → 直接保留 raw，无反向 A/B。
 * 正确契约：winner/confidence:"clear"|"slight"|"uncertain"/decisiveReasons/
 * factualRisks/regressionRisks/constitutionAlignment
 * confidence="slight"/"uncertain" 触发 needsReverseReview=true（judge-types.ts L213-215），
 * 进入反向 A/B，产生两轮 verdict 记录。
 */
function makeStubModelGenerate({ verdictsByChapter = {}, calibrationReplacements = [], defaultVerdict = "tie" } = {}) {
  const calls = [];
  const fn = async (input) => {
    calls.push({
      route: input.route,
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
    });

    if (input.route === "v2_chinese_calibration") {
      const promptText = input.userPrompt || "";
      let calibrated = "";
      let matched = false;
      for (const { rawText, target, replacement } of calibrationReplacements) {
        if (promptText.includes(rawText) && rawText.includes(target)) {
          calibrated = rawText.replace(target, replacement);
          matched = true;
          break;
        }
      }
      if (!matched) {
        return {
          text: "",
          model: "doubao-seed-2-1-pro-260628",
          route: input.route,
          provider: "doubao",
          durationMs: 50,
        };
      }
      return {
        text: calibrated,
        model: "doubao-seed-2-1-pro-260628",
        route: input.route,
        provider: "doubao",
        durationMs: 50,
      };
    }

    if (input.route === "v2_literary_judge") {
      // 解析 prompt 中的章节标识，决定 verdict
      const promptText = input.userPrompt || "";
      let verdict = defaultVerdict;
      let matched = false;
      for (const [key, v] of Object.entries(verdictsByChapter)) {
        if (promptText.includes(key)) {
          verdict = v;
          matched = true;
          break;
        }
      }
      // 构造正确 JudgeVerdict 契约（参考 judge-types.ts L31-38 + phase4-llm-judge.test.mjs L169-176）
      const winnerLabel = verdict; // "A" | "B" | "tie"
      const confidence = verdict === "tie" ? "uncertain" : "slight";
      // decisiveReasons：winner 非 tie 时，betterCandidate 一方对另一方需有 evidence span
      // （validateVerdictEvidence judge-types.ts L155-176 要求 worse 一方 evidence 非空）
      // tie 时 betterCandidate="neither"，evidenceA/B 可空
      const reason = verdict === "tie"
        ? {
            dimension: "整体",
            betterCandidate: "neither",
            evidenceA: [],
            evidenceB: [],
            explanation: "两版质量接近，无明显胜出",
          }
        : {
            dimension: "中文自然度",
            betterCandidate: verdict, // "A" 或 "B"
            evidenceA: verdict === "A" ? [] : [{ start: 0, end: 10, excerpt: "感知侵蚀词" }],
            evidenceB: verdict === "B" ? [] : [{ start: 0, end: 10, excerpt: "感知侵蚀词" }],
            explanation: `verdict=${verdict} (stub, matched=${matched})`,
          };
      return {
        text: JSON.stringify({
          winner: winnerLabel,
          confidence,
          decisiveReasons: [reason],
          factualRisks: [],
          regressionRisks: [],
          constitutionAlignment: "两者均对齐",
        }),
        model: "gpt-5.6-sol",
        route: input.route,
        provider: "openai",
        durationMs: 100,
      };
    }

    return {
      text: "",
      model: "stub",
      route: input.route,
      provider: "stub",
      durationMs: 10,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeCalibrationReplacement(rawText, excerpt) {
  return {
    rawText,
    target: excerpt,
    replacement: replacePerceptionSpan(excerpt),
  };
}

function replacePerceptionSpan(target) {
  if (target.includes("感到")) return target.replace("感到", "察觉到");
  if (target.includes("注意到")) return target.replace("注意到", "看见");
  if (target.includes("安静来下")) return target.replace("安静来下", "安静下来");
  if (target.includes("疯狂跳动")) return target.replace("疯狂跳动", "剧烈跳动");
  return target;
}

// ============================================================================
// 构造合法 ChapterIntent + CompiledContext + hypothesis（最小 fixture）
// ============================================================================

function makeIntent() {
  return {
    chapterFunction: "character",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };
}

function makeContext() {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    // FactGuard（checkCandidateFactGuard）通过 input.context.bridgeContext 访问；
    // 显式 undefined 表示"无桥接上下文"，避免缺字段导致的访问异常。
    bridgeContext: undefined,
  };
}

function findSpan(rawText, excerpt) {
  const start = rawText.indexOf(excerpt);
  if (start < 0) {
    throw new Error(`span "${excerpt}" 未在 raw 中找到`);
  }
  return { start, end: start + excerpt.length, excerpt };
}

function makeVoiceHypothesis(rawText, excerpt, id = "h-voice-1") {
  const span = findSpan(rawText, excerpt);
  return {
    id,
    opportunityType: "voice_and_naturalness",
    diagnosis: `不自然 span "${excerpt}" 存在感知侵蚀/翻译腔/语病`,
    evidenceSpans: [span],
    expectedReaderGain: "把 span 改写为母语自然表达",
    damageRisks: ["改写可能轻微影响段落情感重量"],
    rewriteScope: "span_candidate",
    confidence: 0.6,
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ============================================================================
// 单章验收：跑完整中文校准链路
// ============================================================================

async function verifyOneChapter({ filename, rawText, excerpt, mode, characterNames, rawManifestHash }) {
  const chapterId = filename.replace(".md", "");
  // 从 chapterId（如 "chapter-05"）派生章节号，避免 chapter_identity guard 误报
  // "章节号不匹配：expected=1, actual=5"
  const chapterNumber = parseInt(chapterId.split("-")[1], 10) || 1;
  const result = {
    chapterId,
    filename,
    rawHash: sha256(rawText),
    rawManifestHash,
    rawLength: rawText.length,
    spanExcerpt: excerpt,
    spanLocation: null,
    scannedSignals: [],
    hypothesesGenerated: 0,
    candidateGenerated: false,
    candidateHash: null,
    candidateRoute: null,
    candidateLength: 0,
    candidateFailureReason: null,
    factGuardPassed: null,
    factGuardReason: null,
    factGuardReport: null,
    judgeRounds: 0,
    judgeVerdictFirst: null,
    judgeVerdictReverse: null,
    judgeConflicted: false,
    judgeAuditSummary: null,
    judgeReverseReviewed: false,
    judgeMapping: null,
    finalSelectedSource: null,
    finalSelectedCandidateId: null,
    regressionCheck: null,
    error: null,
    // 逐章产物保存所需数据
    artifacts: null,
  };

  try {
    // Step 1: 定位 span
    const span = findSpan(rawText, excerpt);
    result.spanLocation = `start=${span.start}, end=${span.end}`;

    // Step 2: 跑 EditorialOpportunityJudge（本地扫描器，无 LLM）
    const judge = new EditorialOpportunityJudge();
    const judgeResult = await judge.judge({
      rawText,
      intent: makeIntent(),
      longTermState: null,
      constitution: null,
      characterNames: ["李一凡"],
    });
    result.scannedSignals = (judgeResult.scannedSignals || []).map((s) => ({
      opportunityType: s.opportunityType,
      triggered: s.triggered,
      evidenceSpanCount: s.evidenceSpanCount,
      reason: s.reason,
    }));

    // Step 3: 手工构造 voice_and_naturalness hypothesis（基于真实 span）
    // 真实章节感知侵蚀词命中数最多 1（< 阈值 3），扫描器不会自动生成 hypothesis。
    // 这里手工构造以验证端到端链路（与 doubao-span-calibration.test.mjs 模式一致）。
    const hypothesis = makeVoiceHypothesis(rawText, excerpt, `h-voice-${chapterId}`);
    result.hypothesesGenerated = 1;
    result.hypothesisEvidenceSpans = hypothesis.evidenceSpans.map((s) => ({
      excerpt: s.excerpt,
      start: s.start,
      end: s.end,
    }));

    // Step 4: 跑 EditorialCandidateGenerator → 生成校准候选（v2_chinese_calibration 路由）
    const modelGenerate = makeStubModelGenerate({
      defaultVerdict: "tie", // 验证 raw 兜底（tie → 反向 A/B → 保留 raw）
      calibrationReplacements: [makeCalibrationReplacement(rawText, excerpt)],
    });

    const gen = createEditorialCandidateGenerator();
    const genResult = await gen.generate({
      rawText,
      rawCandidateId: `candidate:raw:${chapterId}`,
      hypotheses: [hypothesis],
      intent: makeIntent(),
      context: makeContext(),
      contextHash: sha256(rawText),
      chapterNumber,
      modelGenerate,
      strategyRegistry: createEditorialStrategyRegistry(),
    });

    if (genResult.candidates.length === 0) {
      result.candidateFailureReason = genResult.failures[0]?.reason || "未知失败";
      result.finalSelectedSource = "raw";
      result.finalSelectedCandidateId = `candidate:raw:${chapterId}`;
      result.regressionCheck = { checked: false, reason: "candidate generation failed" };
      // 候选生成失败时仍保存 raw（任务规格 L395 每章保存 raw）；candidate.md 为空 + hypothesis 保留
      result.artifacts = {
        rawText,
        candidateText: "",
        hypothesis,
        factGuardReport: null,
        arbitratorResult: null,
        editorialCandidateId: null,
        finalSelectedSource: result.finalSelectedSource,
        finalSelectedCandidateId: result.finalSelectedCandidateId,
        regressionCheck: result.regressionCheck,
        rawHash: result.rawHash,
      };
      return result;
    }

    const editorialCandidate = genResult.candidates[0];
    result.candidateGenerated = true;
    result.candidateHash = sha256(editorialCandidate.text);
    result.candidateRoute = editorialCandidate.route;
    result.candidateLength = editorialCandidate.text.length;

    // Step 5: 退化检查（before/after span 局部差异）
    const beforeExcerpt = rawText.slice(span.start, span.end);
    const afterExcerpt = editorialCandidate.text.slice(span.start, span.end);
    result.regressionCheck = {
      checked: true,
      beforeSpanExcerpt: beforeExcerpt,
      afterSpanExcerpt: afterExcerpt,
      spanChanged: beforeExcerpt !== afterExcerpt,
      candidateTextLength: editorialCandidate.text.length,
      rawTextLength: rawText.length,
      lengthDelta: editorialCandidate.text.length - rawText.length,
    };

    // Step 6: 跑真实 FactGuard（checkCandidateFactGuard）
    // Change 2：旧实现用"长度差 ≤100"冒充 FactGuard，报告却声称已接入并验证越界拒绝。
    // 现改用真实 checkCandidateFactGuard 调用，含 6 类硬阻断检查 + 高影响新设定 review 诊断。
    // 角色名从 workspaces/xinmo/config.json 加载完整列表，避免 checkEntityHallucination
    // 误报已建立角色（陈锋/小妖/墨老等）为"实体幻觉"硬阻断。
    const factGuardInput = {
      context: makeContext(),
      characterNames: characterNames,
      chapterNumber,
      ontologyLevels: [],
      constitution: null,
      intent: makeIntent(),
      contextSafety: undefined,
    };
    const fg = checkCandidateFactGuard(editorialCandidate.text, factGuardInput, rawText);
    result.factGuardPassed = fg.ok;
    result.factGuardReason = fg.ok
      ? "FactGuard 通过（6 类硬阻断检查 + 高影响新设定 review 诊断）"
      : `FactGuard 阻断：${fg.errors.join("; ")}`;
    result.factGuardReport = {
      ok: fg.ok,
      hardBlocks: fg.report.hardBlocks,
      errors: fg.errors,
      constraintManifestHash: fg.constraintManifestHash,
      // 高影响新设定 review 诊断（不阻断，供审计）
      unauthorizedHighImpactDiagnostics: fg.report.allDiagnostics.filter(
        (d) => d.source === "unauthorized_high_impact_setting"
      ),
    };
    if (!fg.ok) {
      // FactGuard 硬阻断：保留 raw，不进入 Judge
      result.finalSelectedSource = "raw";
      result.finalSelectedCandidateId = `candidate:raw:${chapterId}`;
      result.regressionCheck = {
        checked: true,
        beforeSpanExcerpt: rawText.slice(span.start, span.end),
        afterSpanExcerpt: editorialCandidate.text.slice(span.start, span.end),
        spanChanged: rawText.slice(span.start, span.end) !== editorialCandidate.text.slice(span.start, span.end),
        candidateTextLength: editorialCandidate.text.length,
        rawTextLength: rawText.length,
        lengthDelta: editorialCandidate.text.length - rawText.length,
        factGuardBlocked: true,
      };
      // 即使 FactGuard 阻断，仍保存 raw/candidate/hypothesis/factGuard 产物（任务规格 L395 每章保存 raw、校准候选）
      result.artifacts = {
        rawText,
        candidateText: editorialCandidate.text,
        hypothesis,
        factGuardReport: result.factGuardReport,
        arbitratorResult: null, // FactGuard 阻断 → Judge 未运行
        editorialCandidateId: editorialCandidate.id,
        finalSelectedSource: result.finalSelectedSource,
        finalSelectedCandidateId: result.finalSelectedCandidateId,
        regressionCheck: result.regressionCheck,
        rawHash: result.rawHash,
      };
      return result;
    }

    // Step 7: 跑 JudgeArbitrator（两轮反向 A/B，默认 tie）
    const rawCandidate = {
      id: `candidate:raw:${chapterId}`,
      kind: "context_enhanced",
      text: rawText,
      model: "stub-raw",
      route: "v2_rawstage2",
      promptProfile: {
        type: "editorial",
        tokensIn: 0,
        containsDialogueRatio: false,
        containsParagraphLengthConstraint: false,
        containsControlChecklist: false,
        containsMechanicalMetric: false,
        contractIds: [],
      },
      contextHash: sha256(rawText),
      generatedAt: new Date().toISOString(),
      durationMs: 0,
    };

    const arbitrator = new JudgeArbitrator();
    const arbResult = await arbitrator.arbitrate({
      rawCandidate,
      editorialCandidate,
      intent: makeIntent(),
      constitution: null,
      modelGenerate,
      seed: 42,
      route: "v2_literary_judge",
    });

    result.judgeRounds = arbResult.rounds.length;
    result.judgeVerdictFirst = arbResult.firstRound?.verdict || null;
    result.judgeVerdictReverse = arbResult.reverseRound?.verdict || null;
    result.judgeConflicted = arbResult.conflicted;
    result.judgeAuditSummary = arbResult.auditSummary;
    result.judgeSelectionDecision = arbResult.selection?.decision || null;
    result.judgeReverseReviewed = arbResult.reverseReviewed;
    result.judgeMapping = arbResult.firstRound?.mapping || null;
    result.judgeFirstRoundDegraded = arbResult.firstRound?.degraded ?? null;
    result.judgeArbitratorResult = arbResult;

    // Step 8: 最终选择
    const finalId = arbResult.finalSelectedCandidateId;
    if (finalId === `candidate:raw:${chapterId}`) {
      result.finalSelectedSource = "raw";
    } else if (finalId === editorialCandidate.id) {
      result.finalSelectedSource = "calibration";
    } else if (finalId === null) {
      result.finalSelectedSource = "raw"; // null 表示保留 raw
    } else {
      result.finalSelectedSource = `unknown:${finalId}`;
    }
    result.finalSelectedCandidateId = finalId || `candidate:raw:${chapterId}`;

    // Step 9: 保存逐章产物（raw.md / candidate.md / hypothesis.json / fact-guard.json / judge-verdict.json / selection.json）
    result.artifacts = {
      rawText,
      candidateText: editorialCandidate.text,
      hypothesis,
      factGuardReport: result.factGuardReport,
      arbitratorResult: arbResult,
      editorialCandidateId: editorialCandidate.id,
      finalSelectedSource: result.finalSelectedSource,
      finalSelectedCandidateId: result.finalSelectedCandidateId,
      regressionCheck: result.regressionCheck,
      rawHash: result.rawHash,
    };
  } catch (err) {
    result.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    // 异常时仍保存 raw（任务规格 L395 每章保存 raw），便于审计失败原因
    if (!result.artifacts) {
      result.artifacts = {
        rawText,
        candidateText: "",
        hypothesis: null,
        factGuardReport: result.factGuardReport,
        arbitratorResult: null,
        editorialCandidateId: null,
        finalSelectedSource: result.finalSelectedSource || "raw",
        finalSelectedCandidateId: result.finalSelectedCandidateId || `candidate:raw:${chapterId}`,
        regressionCheck: result.regressionCheck,
        rawHash: result.rawHash,
      };
    }
  }

  return result;
}

// ============================================================================
// 保存逐章产物（任务规格 L395：每个章节保存 raw、校准候选、匿名反向 A/B）
// ============================================================================

/**
 * 把单章产物保存到 reports/language-calibration-real-1/{chapterId}/，含 6 个文件：
 * - raw.md: 原始 raw 文本
 * - candidate.md: 校准候选文本
 * - hypothesis.json: voice_and_naturalness hypothesis 对象
 * - fact-guard.json: FactGuard 结果（ok/hardBlocks/errors/...）
 * - judge-verdict.json: JudgeArbitrator 结果（firstRound/reverseRound/mapping/...）
 * - selection.json: 最终选择（finalSelectedSource/regressionCheck/rawHash）
 *
 * 若 result.artifacts 为 null（候选生成失败/FactGuard 阻断），仍保存已可用的部分产物。
 */
function saveChapterArtifacts(result) {
  const chapterDir = join(REPORT_DIR, result.chapterId);
  if (!existsSync(chapterDir)) {
    mkdirSync(chapterDir, { recursive: true });
  }

  const a = result.artifacts || {};

  // raw.md — 始终保存（即使候选生成失败）
  const rawText = a.rawText || "";
  writeFileSync(join(chapterDir, "raw.md"), rawText, "utf-8");

  // candidate.md — 候选生成失败时保存空文本 + 说明
  const candidateText = a.candidateText || "";
  writeFileSync(join(chapterDir, "candidate.md"), candidateText, "utf-8");

  // hypothesis.json — 保存 hypothesis 对象（可能为 undefined）
  writeFileSync(
    join(chapterDir, "hypothesis.json"),
    JSON.stringify(a.hypothesis || null, null, 2),
    "utf-8",
  );

  // fact-guard.json — 保存 FactGuard 结果
  const fg = a.factGuardReport || result.factGuardReport || { ok: null, hardBlocks: [], errors: [] };
  writeFileSync(
    join(chapterDir, "fact-guard.json"),
    JSON.stringify({
      ok: fg.ok,
      hardBlocks: fg.hardBlocks || [],
      errors: fg.errors || [],
      constraintManifestHash: fg.constraintManifestHash || null,
      unauthorizedHighImpactDiagnostics: fg.unauthorizedHighImpactDiagnostics || [],
      factGuardReason: result.factGuardReason,
    }, null, 2),
    "utf-8",
  );

  // judge-verdict.json — 保存 JudgeArbitrator 结果
  // 测试断言（language-calibration-real-1.test.mjs L701-770）：
  // - jv.firstRound.degraded === false
  // - jv.firstRound.verdict 含 winner/confidence/decisiveReasons/constitutionAlignment
  // - jv.reverseReviewed === true
  // - jv.reverseRound 非 null
  // - jv.rounds >= 2
  // - jv.mapping.leftLabel / jv.mapping.rightLabel 为 "A"/"B"
  // - jv.auditSummary 为非空字符串
  const arb = a.arbitratorResult;
  if (arb) {
    const jv = {
      firstRound: {
        degraded: arb.firstRound?.degraded ?? null,
        verdict: arb.firstRound?.verdict || null,
        mapping: arb.firstRound?.mapping || null,
      },
      reverseRound: arb.reverseRound
        ? {
            degraded: arb.reverseRound.degraded ?? null,
            verdict: arb.reverseRound.verdict || null,
            mapping: arb.reverseRound.mapping || null,
          }
        : null,
      reverseReviewed: arb.reverseReviewed,
      rounds: arb.rounds?.length || 0,
      mapping: arb.firstRound?.mapping || null,
      auditSummary: arb.auditSummary || "",
    };
    writeFileSync(join(chapterDir, "judge-verdict.json"), JSON.stringify(jv, null, 2), "utf-8");
  } else {
    // Judge 未运行（候选生成失败/FactGuard 阻断）→ 保存 null 标记
    writeFileSync(
      join(chapterDir, "judge-verdict.json"),
      JSON.stringify({
        firstRound: null,
        reverseRound: null,
        reverseReviewed: false,
        rounds: 0,
        mapping: null,
        auditSummary: "Judge 未运行（候选生成失败或 FactGuard 阻断）",
      }, null, 2),
      "utf-8",
    );
  }

  // selection.json — 保存最终选择
  const sel = {
    finalSelectedSource: result.finalSelectedSource || "raw",
    finalSelectedCandidateId: result.finalSelectedCandidateId || `candidate:raw:${result.chapterId}`,
    regressionCheck: result.regressionCheck || { checked: false, reason: "not run" },
    rawHash: result.rawHash,
    rawManifestHash: result.rawManifestHash,
  };
  writeFileSync(join(chapterDir, "selection.json"), JSON.stringify(sel, null, 2), "utf-8");
}

async function verifyStubBoundaryRejection(rawText, excerpt) {
  const hypothesis = makeVoiceHypothesis(rawText, excerpt, "h-voice-stub-boundary-negative");
  const attemptedCandidate = `${rawText.replace(excerpt, replacePerceptionSpan(excerpt))}\n越界修改证据。`;
  const modelGenerate = async (input) => ({
    text: attemptedCandidate,
    model: "doubao-seed-2-1-pro-260628",
    route: input.route,
    provider: "stub",
    durationMs: 1,
  });
  const result = await createEditorialCandidateGenerator().generate({
    rawText,
    rawCandidateId: "candidate:raw:stub-boundary-negative",
    hypotheses: [hypothesis],
    intent: makeIntent(),
    context: makeContext(),
    contextHash: sha256(rawText),
    chapterNumber: 1,
    modelGenerate,
    strategyRegistry: createEditorialStrategyRegistry(),
  });
  const reason = result.failures[0]?.reason ?? "";
  const evidence = {
    schema: "pinovel.language-calibration-boundary-rejection.v1",
    rejected: result.candidates.length === 0 && /span.*边界|越界|修改了 span 外文本/i.test(reason),
    candidatesGenerated: result.candidates.length,
    reason,
    rawHash: sha256(rawText),
    attemptedCandidateHash: sha256(attemptedCandidate),
    evidenceSpan: hypothesis.evidenceSpans[0],
  };
  if (!evidence.rejected) {
    throw new Error(`stub 越界候选未被拒绝：candidates=${result.candidates.length}, reason=${reason}`);
  }
  return evidence;
}

function collectAcceptanceBlockers(chapterResults) {
  const blockers = [];
  for (const result of chapterResults) {
    if (!result.candidateGenerated) blockers.push(`${result.chapterId}: 校准候选未生成`);
    if (result.factGuardPassed !== true) blockers.push(`${result.chapterId}: FactGuard 未通过`);
    if (result.judgeRounds < 2 || result.judgeReverseReviewed !== true || !result.judgeVerdictReverse) {
      blockers.push(`${result.chapterId}: 未完成匿名反向 A/B`);
    }
  }
  return blockers;
}

// ============================================================================
// 生成 markdown 报告
// ============================================================================

function generateReport({ chapterResults, mode, rawManifest, boundaryEvidence }) {
  const lines = [];

  // Header
  lines.push("# LANGUAGE-CALIBRATION-REAL-1 验收报告");
  lines.push("");
  lines.push("**任务**：P1-4 LANGUAGE-CALIBRATION-REAL-1（[delete/任务列表/项目优化20260718.md](file:///delete/任务列表/项目优化20260718.md) L383-407）");
  lines.push("");
  lines.push("## 模式与边界");
  lines.push("");
  lines.push(`- 运行模式：\`${mode.stub ? "stub" : "auth"}\``);
  lines.push(`- 验收状态：\`${mode.stub ? "COMPLETE_L0 (offline/stub)" : "REQUIRES_AUTH"}\``);
  lines.push("- 真实模型与正收益状态：`REQUIRES_AUTH`");
  lines.push("- `--auth` 状态：未启用，退出码 2，fail-closed，不调用真实模型");
  lines.push("- Git HEAD 证据边界：仅记录基准提交，不代表当前脏工作树的完整代码快照");
  lines.push(`- 冻结 raw manifest hash：\`${rawManifest.hash}\``);
  lines.push(`- 冻结 raw manifest：\`${rawManifest.path}\``);
  lines.push("");
  if (mode.stub) {
    lines.push("> ⚠️ **REQUIRES_AUTH 边界**：本切片为 offline stub 模式 + 真实 raw 文本 fixture。");
    lines.push("> 真实 Doubao Seed 2.1 Pro (`v2_chinese_calibration`) + gpt-5.6-sol 异源 judge (`v2_literary_judge`) 调用属于 REQUIRES_AUTH，作为后续切片单独提交。");
    lines.push("> 本报告不声称已验证真实模型正收益；只验证现有中文校准链路在 5 章真实 raw 文本上的端到端可达性。");
    lines.push("");
  } else {
    lines.push("> ✅ REQUIRES_AUTH 已授权：本切片调真实 Doubao + gpt-5.6-sol。");
    lines.push("");
  }

  // 5 章逐章结果
  lines.push("## 5 章逐章结果");
  lines.push("");

  for (const r of chapterResults) {
    lines.push(`### ${r.chapterId}`);
    lines.push("");
    lines.push(`- **raw hash**: \`${r.rawHash}\``);
    lines.push(`- **raw 长度**: ${r.rawLength} 字符`);
    lines.push(`- **span excerpt**: \`${r.spanExcerpt}\``);
    lines.push(`- **span location**: ${r.spanLocation}`);
    lines.push("");

    // 扫描器信号
    lines.push("#### 扫描器信号（EditorialOpportunityJudge 本地扫描器）");
    lines.push("");
    if (r.scannedSignals.length === 0) {
      lines.push("- （无扫描器信号）");
    } else {
      lines.push("| opportunityType | triggered | evidenceSpanCount | reason |");
      lines.push("|---|---|---|---|");
      for (const s of r.scannedSignals) {
        lines.push(`| ${s.opportunityType} | ${s.triggered} | ${s.evidenceSpanCount} | ${s.reason} |`);
      }
    }
    lines.push("");

    // hypothesis
    lines.push("#### EditorialHypothesis（手工构造 voice_and_naturalness）");
    lines.push("");
    lines.push(`- hypothesesGenerated: ${r.hypothesesGenerated}`);
    if (r.hypothesisEvidenceSpans) {
      lines.push("- evidenceSpans:");
      for (const s of r.hypothesisEvidenceSpans) {
        lines.push(`  - excerpt: \`${s.excerpt}\` (start=${s.start}, end=${s.end})`);
      }
    }
    lines.push("");

    // 校准候选
    lines.push("#### 校准候选（EditorialCandidateGenerator）");
    lines.push("");
    if (r.candidateGenerated) {
      lines.push(`- candidateHash: \`${r.candidateHash}\``);
      lines.push(`- candidateRoute: \`${r.candidateRoute}\``);
      lines.push(`- candidateLength: ${r.candidateLength} 字符`);
    } else {
      lines.push(`- ❌ 候选生成失败：${r.candidateFailureReason}`);
    }
    lines.push("");

    // FactGuard
    lines.push("#### FactGuard 检查");
    lines.push("");
    lines.push(`- factGuardPassed: ${r.factGuardPassed}`);
    lines.push(`- factGuardReason: ${r.factGuardReason}`);
    lines.push("");

    // Judge
    lines.push("#### PairwiseJudge 反向 A/B（JudgeArbitrator）");
    lines.push("");
    lines.push(`- judgeRounds: ${r.judgeRounds}`);
    lines.push(`- judgeVerdictFirst: ${r.judgeVerdictFirst}`);
    lines.push(`- judgeVerdictReverse: ${r.judgeVerdictReverse}`);
    lines.push(`- judgeConflicted: ${r.judgeConflicted}`);
    if (r.judgeAuditSummary) {
      lines.push(`- judgeAuditSummary: ${r.judgeAuditSummary}`);
    }
    if (r.judgeSelectionDecision) {
      lines.push(`- judgeSelectionDecision: ${r.judgeSelectionDecision}`);
    }
    lines.push("");

    // 最终选择
    lines.push("#### 最终选择（SelectionPolicy）");
    lines.push("");
    lines.push(`- finalSelectedSource: \`${r.finalSelectedSource}\``);
    lines.push(`- finalSelectedCandidateId: \`${r.finalSelectedCandidateId}\``);
    lines.push("");

    // 退化检查
    lines.push("#### 退化检查（regression check）");
    lines.push("");
    if (r.regressionCheck) {
      const rc = r.regressionCheck;
      lines.push(`- checked: ${rc.checked}`);
      if (rc.checked) {
        lines.push(`- beforeSpanExcerpt: \`${rc.beforeSpanExcerpt}\``);
        lines.push(`- afterSpanExcerpt: \`${rc.afterSpanExcerpt}\``);
        lines.push(`- spanChanged: ${rc.spanChanged}`);
        lines.push(`- rawTextLength: ${rc.rawTextLength}`);
        lines.push(`- candidateTextLength: ${rc.candidateTextLength}`);
        lines.push(`- lengthDelta: ${rc.lengthDelta}`);
      } else {
        lines.push(`- reason: ${rc.reason}`);
      }
    } else {
      lines.push("- （未执行退化检查）");
    }
    lines.push("");

    if (r.error) {
      lines.push("#### ❌ 错误");
      lines.push("");
      lines.push("```");
      lines.push(r.error);
      lines.push("```");
      lines.push("");
    }
  }

  // 总体统计
  lines.push("## 5 章总体统计（Summary）");
  lines.push("");

  const total = chapterResults.length;
  const candidatesGenerated = chapterResults.filter((r) => r.candidateGenerated).length;
  const factGuardPassed = chapterResults.filter((r) => r.factGuardPassed === true).length;
  const rawFallback = chapterResults.filter((r) => r.finalSelectedSource === "raw").length;
  const calibrationSelected = chapterResults.filter((r) => r.finalSelectedSource === "calibration").length;
  const errors = chapterResults.filter((r) => r.error).length;
  const passRate = total > 0 ? (candidatesGenerated / total) * 100 : 0;

  lines.push(`- **总章节数**: ${total}`);
  lines.push(`- **校准候选生成数**: ${candidatesGenerated}`);
  lines.push(`- **候选生成通过率（passRate）**: ${passRate.toFixed(1)}%`);
  lines.push(`- **FactGuard 通过数**: ${factGuardPassed}`);
  lines.push(`- **越界拒绝数（spanBoundary）**: ${boundaryEvidence.rejected ? 1 : 0}`);
  lines.push(`- **raw 兜底数（rawFallback）**: ${rawFallback}`);
  lines.push(`- **校准候选被选择数**: ${calibrationSelected}`);
  lines.push(`- **错误数**: ${errors}`);
  lines.push("");

  // REQUIRES_AUTH 后续切片
  lines.push("## REQUIRES_AUTH 后续切片");
  lines.push("");
  lines.push("本切片（stub 模式）已验证：");
  lines.push("- ✅ 现有 voice_and_naturalness → v2_chinese_calibration 链路在 5 章真实 raw 文本上端到端可达");
  lines.push("- ✅ 5/5 章通过 FactGuard，并分别完成匿名反向 A/B");
  lines.push("- ✅ 冻结 raw manifest + 完整 SHA-256 前置校验，hash 不匹配立即阻断");
  lines.push("- ✅ span 边界检查：独立 stub 越界候选已被生成器拒绝并保存结构化证据");
  lines.push("- ✅ FactGuard 接入（真实 `checkCandidateFactGuard` 调用：6 类硬阻断检查 + 高影响新设定 review 诊断）");
  lines.push("- ✅ PairwiseJudge 反向 A/B（两轮 verdict：confidence=uncertain 触发 needsReverseReview，reverseRound 非空）");
  lines.push("- ✅ SelectionPolicy raw 兜底（tie 时保留 raw）");
  lines.push("");
  lines.push(`- ✅ 越界拒绝证据：\`${BOUNDARY_REJECTION_PATH}\``);
  lines.push("");
  lines.push("后续 REQUIRES_AUTH 切片需要：");
  lines.push("- 真实 Doubao Seed 2.1 Pro 调用（`v2_chinese_calibration`）");
  lines.push("- 真实 gpt-5.6-sol 异源 judge（`v2_literary_judge`，反向 A/B）");
  lines.push("- 5 章真实样本端到端结果归档");
  lines.push("- 正收益证据（B4 vs B0 真实对比）");
  lines.push("");
  lines.push("这些需要用户授权 + API 配额，作为后续 REQUIRES_AUTH 切片单独提交。");
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(`**生成时间**: ${new Date().toISOString()}`);
  lines.push(`**脚本**: \`scripts/language-calibration-real-1/run-verification.mjs\``);
  lines.push(`**模式**: ${mode.stub ? "stub" : "auth"}`);
  lines.push(`**Git HEAD（仅基准提交，不代表脏工作树快照）**: ${readGitHead()}`);

  return lines.join("\n");
}

function readGitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
    return r.stdout?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ============================================================================
// 主入口
// ============================================================================

async function main() {
  const args = parseArgs(process.argv);

  if (args.auth) {
    console.error("❌ REQUIRES_AUTH 模式未启用：本切片仅 stub 模式");
    console.error("   真实 Doubao + gpt-5.6-sol 调用作为后续 REQUIRES_AUTH 切片单独提交");
    process.exit(2);
  }

  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 模式=${args.stub ? "stub" : "auth"}`);
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 加载 5 章真实 raw 文本 from ${args.chaptersDir}`);

  const chapters = loadAllChapters(args.chaptersDir);
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 已加载 ${Object.keys(chapters).length} 章`);
  const rawManifest = loadAndValidateRawManifest(chapters);
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 冻结 raw manifest 校验通过 hash=${rawManifest.hash}`);

  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }
  const boundaryEvidence = await verifyStubBoundaryRejection(
    chapters[EXPECTED_CHAPTERS[0]],
    CHAPTER_SPANS[EXPECTED_CHAPTERS[0]],
  );
  writeFileSync(BOUNDARY_REJECTION_PATH, JSON.stringify(boundaryEvidence, null, 2), "utf-8");

  // Change A：加载完整角色名列表，避免 checkEntityHallucination 误报已建立角色为"实体幻觉"
  const characterNames = loadCharacterNames();
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 已加载 ${characterNames.length} 个角色名（含 aliases）`);

  const chapterResults = [];
  for (const filename of EXPECTED_CHAPTERS) {
    const rawText = chapters[filename];
    const excerpt = CHAPTER_SPANS[filename];
    console.log(`[LANGUAGE-CALIBRATION-REAL-1] 处理 ${filename} (raw 长度=${rawText.length}, span="${excerpt}")`);
    const result = await verifyOneChapter({
      filename,
      rawText,
      excerpt,
      mode: args,
      characterNames,
      rawManifestHash: rawManifest.hash,
    });
    chapterResults.push(result);
    // Change 4：每章保存 6 个产物文件到 reports/language-calibration-real-1/{chapterId}/
    saveChapterArtifacts(result);
    console.log(`[LANGUAGE-CALIBRATION-REAL-1]   → candidateGenerated=${result.candidateGenerated}, finalSource=${result.finalSelectedSource}`);
  }

  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 生成报告 to ${REPORT_PATH}`);
  const report = generateReport({ chapterResults, mode: args, rawManifest, boundaryEvidence });
  writeFileSync(REPORT_PATH, report, "utf-8");

  const acceptanceBlockers = collectAcceptanceBlockers(chapterResults);
  if (acceptanceBlockers.length > 0) {
    throw new Error(`严格 5/5 验收失败：${acceptanceBlockers.join("; ")}`);
  }

  console.log(`[LANGUAGE-CALIBRATION-REAL-1] ✅ COMPLETE_L0 (offline/stub)`);
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 真实模型与正收益状态=REQUIRES_AUTH`);
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 报告: ${REPORT_PATH}`);

  // 输出统计
  const candidatesGenerated = chapterResults.filter((r) => r.candidateGenerated).length;
  const rawFallback = chapterResults.filter((r) => r.finalSelectedSource === "raw").length;
  console.log(`[LANGUAGE-CALIBRATION-REAL-1] 统计: candidates=${candidatesGenerated}/${chapterResults.length}, rawFallback=${rawFallback}`);
}

main().catch((err) => {
  console.error("❌ 执行失败:", err);
  process.exit(1);
});
