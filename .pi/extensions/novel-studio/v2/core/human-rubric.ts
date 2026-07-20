/**
 * HumanRubric - 匿名 A/B 人工评价契约。
 *
 * 只保存分维证据与人工结论，不计算总分，不自动决定 winner。
 */

export const HUMAN_RUBRIC_DIMENSIONS = [
  { id: "native_chinese", label: "中文原生语感" },
  { id: "character_credibility", label: "人物声音与行为可信度" },
  { id: "goal_obstacle_choice_result", label: "目标-阻力-选择-结果" },
  { id: "emotional_progression", label: "情绪推进与兑现" },
  { id: "information_release", label: "信息释放" },
  { id: "scene_immersion", label: "场景细节与沉浸" },
  { id: "causal_end_pressure", label: "章末因果压力" },
  { id: "world_continuity", label: "世界观和连续性" },
  { id: "anti_template_ai_trace", label: "模板化与 AI 痕迹" },
  { id: "worth_replacing_raw", label: "是否值得替换 raw" },
] as const;

export type HumanRubricDimensionId = typeof HUMAN_RUBRIC_DIMENSIONS[number]["id"];
export type HumanRubricPreference = "A" | "B" | "tie" | "uncertain";
export type HumanRubricConfidence = "clear" | "slight" | "uncertain";
export type HumanRubricReviewerType =
  | "model"
  | "validated_human_proxy"
  | "human"
  | "user_final";

export interface AnonymousRubricCandidate {
  textHash: string;
  textLength: number;
}

export interface HumanRubricEvidenceSpan {
  candidate: "A" | "B";
  start: number;
  end: number;
  excerpt: string;
}

export interface HumanRubricDimensionReview {
  dimensionId: HumanRubricDimensionId;
  preference: HumanRubricPreference;
  evidenceSpans: HumanRubricEvidenceSpan[];
  rationale: string;
}

export interface HumanRubricReview {
  schemaId?: "pinovel.human-rubric";
  schemaVersion?: 1;
  reviewId: string;
  workspaceId: string;
  chapterId: string;
  reviewerType: HumanRubricReviewerType;
  reviewerId: string;
  anonymousCandidates: {
    A: AnonymousRubricCandidate;
    B: AnonymousRubricCandidate;
  };
  dimensions: HumanRubricDimensionReview[];
  overallPreference: HumanRubricPreference;
  confidence: HumanRubricConfidence;
  rationale: string;
  createdAt: string;
}

export interface HumanRubricValidationResult {
  ok: boolean;
  errors: string[];
}

const DIMENSION_IDS = new Set<string>(
  HUMAN_RUBRIC_DIMENSIONS.map((dimension) => dimension.id),
);
const PREFERENCES = new Set<HumanRubricPreference>(["A", "B", "tie", "uncertain"]);
const CONFIDENCES = new Set<HumanRubricConfidence>(["clear", "slight", "uncertain"]);
const REVIEWER_TYPES = new Set<HumanRubricReviewerType>([
  "model",
  "validated_human_proxy",
  "human",
  "user_final",
]);

export class HumanRubric {
  validate(review: HumanRubricReview): HumanRubricValidationResult {
    const errors: string[] = [];
    this.validateIdentity(review, errors);
    this.validateCandidates(review, errors);
    this.validateDimensions(review, errors);
    if (!PREFERENCES.has(review.overallPreference)) {
      errors.push("overallPreference 非法");
    }
    if (!CONFIDENCES.has(review.confidence)) {
      errors.push("confidence 非法");
    }
    if (!review.rationale?.trim()) {
      errors.push("overall rationale 不能为空");
    }
    return { ok: errors.length === 0, errors };
  }

  create(review: HumanRubricReview): HumanRubricReview & {
    schemaId: "pinovel.human-rubric";
    schemaVersion: 1;
  } {
    const validation = this.validate(review);
    if (!validation.ok) {
      throw new Error(`HumanRubric 校验失败：${validation.errors.join("; ")}`);
    }
    return {
      ...review,
      schemaId: "pinovel.human-rubric",
      schemaVersion: 1,
      anonymousCandidates: {
        A: { ...review.anonymousCandidates.A },
        B: { ...review.anonymousCandidates.B },
      },
      dimensions: review.dimensions.map((dimension) => ({
        ...dimension,
        evidenceSpans: dimension.evidenceSpans.map((span) => ({ ...span })),
      })),
    };
  }

  private validateIdentity(review: HumanRubricReview, errors: string[]): void {
    if (!review.reviewId?.trim()) errors.push("reviewId 不能为空");
    if (!review.workspaceId?.trim()) errors.push("workspaceId 不能为空");
    if (!review.chapterId?.trim()) errors.push("chapterId 不能为空");
    if (!review.reviewerId?.trim()) errors.push("reviewerId 不能为空");
    if (!REVIEWER_TYPES.has(review.reviewerType)) errors.push("reviewerType 非法");
  }

  private validateCandidates(review: HumanRubricReview, errors: string[]): void {
    const labels = Object.keys(review.anonymousCandidates ?? {}).sort();
    if (labels.join(",") !== "A,B") {
      errors.push("anonymousCandidates 只能包含 A/B 标签");
      return;
    }
    for (const label of ["A", "B"] as const) {
      const candidate = review.anonymousCandidates[label];
      if (!/^[a-f0-9]{64}$/i.test(candidate.textHash)) {
        errors.push(`candidate ${label} textHash 必须是 SHA-256`);
      }
      if (!Number.isInteger(candidate.textLength) || candidate.textLength < 0) {
        errors.push(`candidate ${label} textLength 非法`);
      }
    }
  }

  private validateDimensions(review: HumanRubricReview, errors: string[]): void {
    if (!Array.isArray(review.dimensions) || review.dimensions.length !== HUMAN_RUBRIC_DIMENSIONS.length) {
      errors.push("dimensions 必须完整包含 10 个维度");
      return;
    }
    const seen = new Set<string>();
    for (const dimension of review.dimensions) {
      if (!DIMENSION_IDS.has(dimension.dimensionId)) {
        errors.push(`未知 dimensionId: ${dimension.dimensionId}`);
        continue;
      }
      if (seen.has(dimension.dimensionId)) {
        errors.push(`重复 dimensionId: ${dimension.dimensionId}`);
      }
      seen.add(dimension.dimensionId);
      if (!PREFERENCES.has(dimension.preference)) {
        errors.push(`${dimension.dimensionId} preference 非法`);
      }
      if (!dimension.rationale?.trim()) {
        errors.push(`${dimension.dimensionId} rationale 不能为空`);
      }
      if (
        (dimension.preference === "A" || dimension.preference === "B") &&
        dimension.evidenceSpans.length === 0
      ) {
        errors.push(`${dimension.dimensionId} 明确胜负时 evidenceSpans 不能为空`);
      }
      for (const span of dimension.evidenceSpans) {
        const candidate = review.anonymousCandidates[span.candidate];
        if (!candidate) {
          errors.push(`${dimension.dimensionId} span 候选标签非法`);
          continue;
        }
        if (
          !Number.isInteger(span.start) ||
          !Number.isInteger(span.end) ||
          span.start < 0 ||
          span.end <= span.start ||
          span.end > candidate.textLength
        ) {
          errors.push(`${dimension.dimensionId} evidence span 越界`);
        }
      }
    }
    if (seen.size !== HUMAN_RUBRIC_DIMENSIONS.length) {
      errors.push("dimensions 缺少必需维度");
    }
  }
}

const REVIEWER_PRIORITY: Record<HumanRubricReviewerType, number> = {
  model: 0,
  validated_human_proxy: 1,
  human: 2,
  user_final: 3,
};

export function chooseAuthoritativeHumanReview<T extends HumanRubricReview>(reviews: T[]): T {
  if (reviews.length === 0) {
    throw new Error("至少需要一份 HumanRubric review");
  }
  return reviews.reduce((best, current) =>
    REVIEWER_PRIORITY[current.reviewerType] > REVIEWER_PRIORITY[best.reviewerType]
      ? current
      : best,
  );
}

export function createHumanRubric(): HumanRubric {
  return new HumanRubric();
}

