/**
 * 评审智能体三轮闭环（REVIEW-LOOP-1）：
 * 生成 → 评审（gpt-6.1-sol，NOVELOS_JUDGE_* 独立通道）→ 修改（主写作通道）
 * → 再评审，最多 3 轮；通过（无 must_fix）提前终止；
 * 三轮不通过交付 V3 + 未解决清单。
 *
 * 设计要点：
 * - 评审者独立于生成者：物理通道隔离（judge 通道 vs gemini31 主通道），
 *   评审者只看成品 + 章卡 + 世界设定，不看生成过程。
 * - 评审只评审不改写；修改由修改智能体（主通道）执行。
 * - 评审维度：故事结构 / 人物 / 文字风格 / 设定一致性。
 * - 通过标准：无 severity=must_fix 项。
 * - 评审/修改失败不阻断交付（质量增强，非硬门）：保留当前文本继续。
 * - 产物全量落盘：workspaces/{id}/traces/{chapterId}-review-loop.json；
 *   每轮评审意见与修改说明经 onUpdate 推送到前端任务卡片。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callOpenAIChatCompletions } from "../governance/chapter-proxy-approval-caller.js";
import type { ModelGenerateFn } from "../adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CompiledContext } from "./types.js";

export const REVIEW_LOOP_MAX_ROUNDS = 3;
export const REVIEW_LOOP_SCHEMA_ID = "pinovel.review-loop" as const;
export const REVIEW_LOOP_SCHEMA_VERSION = "v1" as const;

const REVIEW_TIMEOUT_MS = 180_000;
const REVISION_TIMEOUT_MS = 300_000;
const PROGRESS_MESSAGE_MAX_LENGTH = 2000;

export type ReviewSeverity = "must_fix" | "should_fix" | "suggestion";
export type ReviewDimension = "story_structure" | "character" | "prose_style" | "consistency";

export interface ReviewIssue {
  severity: ReviewSeverity;
  dimension: ReviewDimension;
  location: string;
  problem: string;
  direction: string;
}

export interface ReviewRound {
  round: number;
  summary: string;
  issues: ReviewIssue[];
  passed: boolean;
  revisedText: string | null;
  revisionNotes: string | null;
  reviewModel: string | null;
  revisionModel: string | null;
  durationMs: number;
  error: string | null;
}

export interface ReviewLoopResult {
  executed: boolean;
  passed: boolean;
  invalidReview: boolean;
  rounds: ReviewRound[];
  finalText: string;
  unresolvedIssues: ReviewIssue[];
  tracePath: string | null;
}

export interface ReviewLoopProgressEvent {
  stage: string;
  status: "start" | "done";
  message: string;
  timestamp: string;
}

export interface ReviewLoopInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  projectRoot: string;
  text: string;
  intent: ChapterIntent;
  context: CompiledContext;
  /** 修改智能体模型通道（主写作通道，编排器传入已包装的 modelGenerate）。 */
  modelGenerate: ModelGenerateFn;
  onUpdate?: (event: ReviewLoopProgressEvent) => void;
  fullPipelinePreview?: boolean;
}

function emit(
  input: ReviewLoopInput,
  stage: string,
  status: "start" | "done",
  message: string,
): void {
  if (!input.onUpdate) return;
  try {
    input.onUpdate({
      stage,
      status,
      message: message.length > PROGRESS_MESSAGE_MAX_LENGTH
        ? `${message.slice(0, PROGRESS_MESSAGE_MAX_LENGTH)}…（截断）`
        : message,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* 进度推送失败不影响评审循环 */
  }
}

function safeDigest(value: unknown, limit = 1500): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "（空）";
    return text.length > limit ? `${text.slice(0, limit)}…（截断）` : text;
  } catch {
    return "（序列化失败）";
  }
}

function buildIntentDigest(intent: ChapterIntent): string {
  const lines: string[] = [];
  if (intent.chapterFunction) lines.push(`本章功能：${intent.chapterFunction}`);
  if (intent.overallPlotDirection?.length) lines.push(`情节方向：${intent.overallPlotDirection.join("；")}`);
  if (intent.concreteDelivery?.length) lines.push(`必须交付：${intent.concreteDelivery.join("；")}`);
  if (intent.readerExperience?.length) lines.push(`读者体验目标：${intent.readerExperience.join("；")}`);
  if (intent.focusCharacterGoals?.length) {
    lines.push(`焦点角色目标：${intent.focusCharacterGoals.map((g) => `${g.character}：${g.goal}`).join("；")}`);
  }
  if (intent.causalEndPressure?.length) lines.push(`章末压力：${intent.causalEndPressure.join("；")}`);
  if (intent.inviolableFacts?.length) lines.push(`不可违背事实：${intent.inviolableFacts.join("；")}`);
  return lines.length > 0 ? lines.join("\n") : "（章卡为空）";
}

function buildContextDigest(context: CompiledContext): string {
  const lines: string[] = [];
  if (context.worldRules?.length) lines.push(`世界规则：${safeDigest(context.worldRules)}`);
  if (context.characterStates?.length) lines.push(`人物状态：${safeDigest(context.characterStates)}`);
  if (context.facts?.length) lines.push(`既有事实：${safeDigest(context.facts)}`);
  return lines.length > 0 ? lines.join("\n") : "（无世界设定上下文）";
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型输出中未找到 JSON 对象");
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) throw new Error("模型输出不是 JSON 对象");
  return parsed as Record<string, unknown>;
}

const REVIEW_SEVERITIES: ReviewSeverity[] = ["must_fix", "should_fix", "suggestion"];
const REVIEW_DIMENSIONS: ReviewDimension[] = ["story_structure", "character", "prose_style", "consistency"];

function normalizeSeverity(value: unknown): ReviewSeverity {
  return typeof value === "string" && (REVIEW_SEVERITIES as string[]).includes(value)
    ? (value as ReviewSeverity)
    : "suggestion";
}

function normalizeDimension(value: unknown): ReviewDimension {
  return typeof value === "string" && (REVIEW_DIMENSIONS as string[]).includes(value)
    ? (value as ReviewDimension)
    : "story_structure";
}

function normalizeIssues(value: unknown): ReviewIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ReviewIssue[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const problem = typeof record.problem === "string" ? record.problem.trim() : "";
    if (!problem) continue;
    issues.push({
      severity: normalizeSeverity(record.severity),
      dimension: normalizeDimension(record.dimension),
      location: typeof record.location === "string" ? record.location : "（未定位）",
      problem,
      direction: typeof record.direction === "string" ? record.direction : "（未给出方向）",
    });
  }
  return issues;
}

function formatIssues(issues: ReviewIssue[]): string {
  if (issues.length === 0) return "（无问题）";
  return issues
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.severity}/${issue.dimension}] ${issue.location}：${issue.problem}（修改方向：${issue.direction}）`,
    )
    .join("\n");
}

const REVIEW_SYSTEM_PROMPT = [
  "你是一名独立的资深小说评审编辑，与作者相互独立，只评审、不改写正文。",
  "从读者视角评审，维度：故事结构（story_structure）、人物（character）、文字风格（prose_style）、设定一致性（consistency）。",
  "severity 标准：must_fix=硬伤（情节矛盾、人设崩坏、设定冲突、严重逻辑漏洞）；should_fix=明显可改进；suggestion=锦上添花。",
  "location 给出可定位的章节位置或引文片段；direction 给出具体修改方向，不给出改写后的文字。",
  "输出 JSON：{\"summary\":\"总评（200字内）\",\"issues\":[{\"severity\":\"must_fix|should_fix|suggestion\",\"dimension\":\"story_structure|character|prose_style|consistency\",\"location\":\"...\",\"problem\":\"...\",\"direction\":\"...\"}]}",
  "没有需要指出的问题时 issues 为空数组。不要输出 JSON 以外的任何内容。",
].join("\n");

const REVISION_SYSTEM_PROMPT = [
  "你是小说修改作者，根据评审意见修改正文。",
  "要求：只针对评审指出的问题修改；未被点名的内容、情节走向、人物设定保持不变；保持原文风格与字数规模；不得引入新设定或新人物。",
  "输出 JSON：{\"revisedText\":\"修改后的完整正文\",\"revisionNotes\":\"修改说明，逐条对应评审意见说明改了什么\"}",
  "不要输出 JSON 以外的任何内容。",
].join("\n");

interface ReviewOnceResult {
  summary: string;
  issues: ReviewIssue[];
  model: string;
  durationMs: number;
}

async function runReviewOnce(
  input: ReviewLoopInput,
  text: string,
  previousIssues: ReviewIssue[] | null,
): Promise<ReviewOnceResult> {
  const userParts: string[] = [
    "【章卡（大纲与需求）】",
    buildIntentDigest(input.intent),
    "【世界设定与既有事实】",
    buildContextDigest(input.context),
  ];
  if (previousIssues && previousIssues.length > 0) {
    userParts.push(
      "【上一轮评审意见（请检查是否已解决，未解决的继续指出）】",
      formatIssues(previousIssues),
    );
  }
  userParts.push("【当前版正文】", text, "请输出 JSON 评审结果。json");
  const result = await callOpenAIChatCompletions(
    [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ],
    { timeoutMs: REVIEW_TIMEOUT_MS, responseFormat: "json_object" },
  );
  const parsed = extractJson(result.text);
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const issues = normalizeIssues(parsed.issues);
  // 空评审观测：评审通道返回可解析但内容为空的 JSON 时，记录原始应答供诊断（此前完全无日志）
  if (issues.length === 0 && !summary.trim()) {
    console.warn(
      `[ReviewEmpty] 评审通道返回空评审 model=${result.model} durationMs=${result.durationMs} rawHead=${JSON.stringify(result.text.slice(0, 300))}`,
    );
  }
  return { summary, issues, model: result.model, durationMs: result.durationMs };
}

interface RevisionOnceResult {
  text: string;
  notes: string;
  model: string;
}

async function runRevisionOnce(
  input: ReviewLoopInput,
  text: string,
  issues: ReviewIssue[],
): Promise<RevisionOnceResult> {
  const userPrompt = [
    "【评审意见】",
    formatIssues(issues),
    "【当前正文】",
    text,
    "请输出修改后的完整正文与修改说明。json",
  ].join("\n\n");
  const output = await input.modelGenerate({
    route: "v2_amplified_gemini31",
    systemPrompt: REVISION_SYSTEM_PROMPT,
    userPrompt,
    kind: "review_revision",
    timeoutMs: REVISION_TIMEOUT_MS,
  });
  const parsed = extractJson(output.text);
  const revisedText = typeof parsed.revisedText === "string" ? parsed.revisedText.trim() : "";
  if (!revisedText) throw new Error("修改输出缺少 revisedText");
  return {
    text: revisedText,
    notes: typeof parsed.revisionNotes === "string" ? parsed.revisionNotes : "",
    model: output.model ?? "",
  };
}

async function persistReviewLoopTrace(
  input: ReviewLoopInput,
  result: ReviewLoopResult,
): Promise<string | null> {
  if (input.fullPipelinePreview) return null;
  const tracesDir = join(input.projectRoot, "workspaces", input.workspaceId, "traces");
  await mkdir(tracesDir, { recursive: true });
  const tracePath = join(tracesDir, `${input.chapterId}-review-loop.json`);
  const artifact = {
    schemaId: REVIEW_LOOP_SCHEMA_ID,
    schemaVersion: REVIEW_LOOP_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    createdAt: new Date().toISOString(),
    passed: result.passed,
    rounds: result.rounds,
    unresolvedIssues: result.unresolvedIssues,
  };
  await writeFile(tracePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return tracePath;
}

export async function runReviewLoop(input: ReviewLoopInput): Promise<ReviewLoopResult> {
  const rounds: ReviewRound[] = [];
  let currentText = input.text;
  let passed = false;
  let invalidReview = false;
  let unresolvedIssues: ReviewIssue[] = [];
  let executed = false;

  for (let round = 1; round <= REVIEW_LOOP_MAX_ROUNDS; round++) {
    const roundStartedAt = Date.now();
    emit(input, `review_loop_round_${round}`, "start", `评审智能体第 ${round} 轮评审中`);
    try {
      const previousIssues = rounds.length > 0 ? rounds[rounds.length - 1].issues : null;
      const review = await runReviewOnce(input, currentText, previousIssues);
      executed = true;
      const mustFixCount = review.issues.filter((issue) => issue.severity === "must_fix").length;
      // fail-closed：空评审（无问题清单且无总评）视为无效评审，不得据此判通过
      const roundInvalid = review.issues.length === 0 && !review.summary.trim();
      const roundPassed = mustFixCount === 0 && !roundInvalid;
      let revisedText: string | null = null;
      let revisionNotes: string | null = null;
      let revisionModel: string | null = null;
      if (!roundInvalid && !roundPassed && round < REVIEW_LOOP_MAX_ROUNDS) {
        emit(input, `review_loop_revise_${round}`, "start", `根据第 ${round} 轮评审意见修改中`);
        try {
          const revision = await runRevisionOnce(input, currentText, review.issues);
          revisedText = revision.text;
          revisionNotes = revision.notes;
          revisionModel = revision.model;
          currentText = revision.text;
          emit(
            input,
            `review_loop_revise_${round}`,
            "done",
            `第 ${round} 轮修改完成。修改说明：\n${revision.notes || "（未提供）"}`,
          );
        } catch (revisionErr) {
          emit(
            input,
            `review_loop_revise_${round}`,
            "done",
            `第 ${round} 轮修改失败（保留当前文本继续）：${(revisionErr as Error).message}`,
          );
        }
      }
      rounds.push({
        round,
        summary: review.summary,
        issues: review.issues,
        passed: roundPassed,
        revisedText,
        revisionNotes,
        reviewModel: review.model,
        revisionModel,
        durationMs: Date.now() - roundStartedAt,
        error: null,
      });
      emit(
        input,
        `review_loop_round_${round}`,
        "done",
        [
          roundInvalid
            ? `第 ${round} 轮评审无效：评审通道（模型 ${review.model || "未知"}）返回空评审——无问题清单且无总评，耗时 ${review.durationMs}ms，原始应答已记入 runtime 日志；不判通过`
            : `第 ${round} 轮评审${roundPassed ? "通过" : "未通过"}（必须修改 ${mustFixCount} 项）`,
          `总评：${review.summary || "（未提供）"}`,
          `问题清单：\n${formatIssues(review.issues)}`,
        ].join("\n"),
      );
      if (roundPassed) {
        passed = true;
        invalidReview = false;
        unresolvedIssues = review.issues;
        break;
      }
      if (roundInvalid) {
        invalidReview = true;
        if (round < REVIEW_LOOP_MAX_ROUNDS) {
          // 无效评审：重试评审本身，不基于空意见进入修改
          continue;
        }
        // 末轮仍无效：整轮评审无效，不判通过
        unresolvedIssues = [];
        break;
      }
      if (round === REVIEW_LOOP_MAX_ROUNDS) {
        // 三轮不通过：交付 V3（当前文本）+ 未解决清单
        unresolvedIssues = review.issues;
      }
    } catch (reviewErr) {
      rounds.push({
        round,
        summary: "",
        issues: [],
        passed: false,
        revisedText: null,
        revisionNotes: null,
        reviewModel: null,
        revisionModel: null,
        durationMs: Date.now() - roundStartedAt,
        error: `第 ${round} 轮评审失败（评审无效，不判通过）：${(reviewErr as Error).message}`,
      });
      emit(
        input,
        `review_loop_round_${round}`,
        "done",
        `第 ${round} 轮评审失败（评审无效，不判通过）：${(reviewErr as Error).message}`,
      );
      // fail-closed：评审通道故障时评审无效，不得据此判通过
      invalidReview = true;
      passed = false;
      unresolvedIssues = [];
      break;
    }
  }

  const result: ReviewLoopResult = {
    executed,
    passed,
    invalidReview,
    rounds,
    finalText: currentText,
    unresolvedIssues,
    tracePath: null,
  };
  try {
    result.tracePath = await persistReviewLoopTrace(input, result);
  } catch {
    /* trace 落盘失败不影响交付 */
  }
  return result;
}
