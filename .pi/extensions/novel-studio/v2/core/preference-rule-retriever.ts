/**
 * USER-PREFERENCE-CONSUMPTION-1: 用户偏好规则按需检索 + raw/editorial 边界
 *
 * 任务规格：delete/任务列表/项目优化20260718.md P1-3 L349-376
 *
 * 设计原则（任务规格）：
 * - 不要把现有 50 条规则全部塞入 prompt
 * - 按场景、角色、问题类型检索相关规则
 * - 每次最多注入 3–5 条（默认 5）
 * - 区分 3 类：用户硬偏好 / 已接受修订规律 / 尚未验证的工艺建议
 * - trace 记录 loaded、selected、consumed、dropped
 * - 未验证建议（unverified_craft）只能用于 editorial diagnosis，不能硬控 raw
 *
 * 闭包自包含：仅依赖 node 内建，可安全纳入 dist-test barrel。
 * 接入位置（后续切片）：
 * - ContextCompiler 调用 retrievePreferenceRules 得到 selection
 * - buildRawPrompt 调用 consumeForRaw 只注入 hard_preference + accepted_revision
 * - buildEditorialPrompt 调用 consumeForEditorial 注入全部 3 类
 * - quality-trace-recorder 持久化 selection.loaded/selected/consumed/dropped
 */

// ============================================================================
// 类型定义
// ============================================================================

export type PreferenceRuleType =
  | "hard_preference"
  | "accepted_revision"
  | "unverified_craft";

export interface PreferenceRule {
  id: string;
  type: PreferenceRuleType;
  content: string;
  /** 该规则适用的场景类型（如 combat/dialogue/transition）；空数组或 undefined 表示不限 */
  sceneTypes?: string[];
  /** 该规则适用的角色名；空数组或 undefined 表示不限 */
  characters?: string[];
  /** 该规则适用的问题类型（如 dialogue_ratio/translation_tone）；空数组或 undefined 表示不限 */
  problemTypes?: string[];
  /** 规则来源路径（用于 trace 审计） */
  sourcePath?: string;
}

export interface RetrievePreferenceRulesInput {
  /** 全部加载的规则（loaded） */
  rules: PreferenceRule[];
  /** 本章场景类型 */
  sceneTypes: string[];
  /** 本章焦点角色名 */
  characters: string[];
  /** 本章诊断出的问题类型 */
  problemTypes: string[];
  /** 每次最多注入的规则数（默认 5，任务规格要求 3-5 条） */
  maxCount?: number;
}

export interface PreferenceRuleSelection {
  /** 全部加载的规则（loaded） */
  loaded: PreferenceRule[];
  /** 检索匹配的规则（按相关性排序，最多 maxCount 条） */
  selected: PreferenceRule[];
  /** loaded 中未匹配或被 maxCount 截断的规则 */
  dropped: PreferenceRule[];
  /** selected 按 type 分组（便于 trace 审计） */
  byType: Record<PreferenceRuleType, PreferenceRule[]>;
  /** 检索条件（用于 trace 审计） */
  retrievalCriteria: {
    sceneTypes: string[];
    characters: string[];
    problemTypes: string[];
    maxCount: number;
  };
}

export interface ConsumedRules {
  /** 被当前 consumer 消费的规则（注入到 prompt） */
  consumed: PreferenceRule[];
  /** 被 consumer 拒绝的规则（不注入到该 prompt） */
  dropped: PreferenceRule[];
}

// ============================================================================
// 默认值与常量
// ============================================================================

const DEFAULT_MAX_COUNT = 5;

/**
 * type 优先级排序（数字越小优先级越高）。
 *
 * 设计原则：
 * - hard_preference 最优先（用户硬偏好必须遵守）
 * - accepted_revision 次之（已接受修订规律有证据支持）
 * - unverified_craft 最后（未验证建议只能用于 editorial diagnosis）
 */
const TYPE_PRIORITY: Record<PreferenceRuleType, number> = {
  hard_preference: 0,
  accepted_revision: 1,
  unverified_craft: 2,
};

// ============================================================================
// 1. retrievePreferenceRules — 按场景/角色/问题类型检索
// ============================================================================

/**
 * 按场景、角色、问题类型检索相关规则，返回 selection（含 loaded/selected/dropped/byType）。
 *
 * 匹配规则（"或"匹配，任一字段命中即匹配）：
 * - sceneTypes 命中（input.sceneTypes 与 rule.sceneTypes 都非空且有交集）→ 匹配，score += 3
 * - characters 命中 → 匹配，score += 2
 * - problemTypes 命中 → 匹配，score += 2
 * - 通用规则（rule 所有字段都为空/undefined）→ 默认匹配，score = 0
 * - 有限定的规则但无任何字段命中 → 不匹配（dropped）
 *
 * input 字段为空时，不参与匹配判定（视为"未指定检索条件"）；
 * rule 字段为空时，视为"不限"（与任何 input 兼容）。
 *
 * 排序：先按 type 优先级（hard_preference > accepted_revision > unverified_craft），
 * 再按 score 降序，最后按 id 字典序稳定排序。
 *
 * 截断：取前 maxCount 条作为 selected，其余进入 dropped。
 *
 * @param input 检索输入（rules + sceneTypes + characters + problemTypes + maxCount?）
 * @returns selection（含 trace 字段）
 */
export function retrievePreferenceRules(input: RetrievePreferenceRulesInput): PreferenceRuleSelection {
  const maxCount = input.maxCount ?? DEFAULT_MAX_COUNT;
  const loaded = [...input.rules];

  // 计算每条规则的匹配分数与是否匹配
  const scored = loaded.map((rule) => {
    let score = 0;
    let anyFieldMatched = false;
    let anyFieldRestricted = false;

    // sceneTypes 字段匹配
    if (rule.sceneTypes && rule.sceneTypes.length > 0) {
      anyFieldRestricted = true;
      if (
        input.sceneTypes.length > 0 &&
        rule.sceneTypes.some((s) => input.sceneTypes.includes(s))
      ) {
        score += 3;
        anyFieldMatched = true;
      }
    }

    // characters 字段匹配
    if (rule.characters && rule.characters.length > 0) {
      anyFieldRestricted = true;
      if (
        input.characters.length > 0 &&
        rule.characters.some((c) => input.characters.includes(c))
      ) {
        score += 2;
        anyFieldMatched = true;
      }
    }

    // problemTypes 字段匹配
    if (rule.problemTypes && rule.problemTypes.length > 0) {
      anyFieldRestricted = true;
      if (
        input.problemTypes.length > 0 &&
        rule.problemTypes.some((p) => input.problemTypes.includes(p))
      ) {
        score += 2;
        anyFieldMatched = true;
      }
    }

    // 通用规则（无任何限定）：默认匹配（score=0）
    // 有限定的规则：至少一个字段命中才匹配
    const matched = anyFieldRestricted ? anyFieldMatched : true;

    return { rule, score, matched };
  });

  // 过滤掉不匹配的
  const matchedRules = scored.filter((s) => s.matched);

  // 排序：先按 type 优先级，再按 score 降序，最后按 id 字典序
  matchedRules.sort((a, b) => {
    const typeDiff = TYPE_PRIORITY[a.rule.type] - TYPE_PRIORITY[b.rule.type];
    if (typeDiff !== 0) return typeDiff;
    if (b.score !== a.score) return b.score - a.score;
    return a.rule.id.localeCompare(b.rule.id);
  });

  // 取前 maxCount 条作为 selected
  const selected = matchedRules.slice(0, maxCount).map((s) => s.rule);
  const selectedIds = new Set(selected.map((r) => r.id));

  // dropped = loaded 中不在 selected 中的（含不匹配 + 被 maxCount 截断）
  const dropped = loaded.filter((r) => !selectedIds.has(r.id));

  // 按 type 分组（在 selected 中）
  const byType: Record<PreferenceRuleType, PreferenceRule[]> = {
    hard_preference: selected.filter((r) => r.type === "hard_preference"),
    accepted_revision: selected.filter((r) => r.type === "accepted_revision"),
    unverified_craft: selected.filter((r) => r.type === "unverified_craft"),
  };

  return {
    loaded,
    selected,
    dropped,
    byType,
    retrievalCriteria: {
      sceneTypes: [...input.sceneTypes],
      characters: [...input.characters],
      problemTypes: [...input.problemTypes],
      maxCount,
    },
  };
}

// ============================================================================
// 2. consumeForRaw — raw consumer（不返回 unverified_craft）
// ============================================================================

/**
 * raw prompt consumer：只接受 hard_preference + accepted_revision。
 *
 * 任务规格硬约束："未验证建议只能用于 editorial diagnosis，不能硬控 raw"
 * → unverified_craft 不进入 raw prompt（被 dropped）。
 *
 * @param selection 检索结果
 * @returns consumed（hard_preference + accepted_revision）+ dropped（unverified_craft）
 */
export function consumeForRaw(selection: PreferenceRuleSelection): ConsumedRules {
  const consumed = selection.selected.filter(
    (r) => r.type === "hard_preference" || r.type === "accepted_revision",
  );
  const dropped = selection.selected.filter((r) => r.type === "unverified_craft");
  return { consumed, dropped };
}

// ============================================================================
// 3. consumeForEditorial — editorial consumer（接受全部 3 类）
// ============================================================================

/**
 * editorial prompt consumer：接受全部 3 类规则（含 unverified_craft 用于 diagnosis）。
 *
 * 任务规格："未验证建议只能用于 editorial diagnosis" → editorial 可消费 unverified_craft。
 *
 * @param selection 检索结果
 * @returns consumed（= selection.selected）+ dropped（空，selected 全部被消费）
 */
export function consumeForEditorial(selection: PreferenceRuleSelection): ConsumedRules {
  return {
    consumed: [...selection.selected],
    dropped: [],
  };
}
