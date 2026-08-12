/**
 * MODEL-PROMPT-EVOLUTION-1（t3）— 安全/实验分层契约（eval-only）
 *
 * 把「不可变安全契约」与「可实验 Prompt 空间」明确分离，并防止模型专属
 * Prompt 越过系统边界（见 docs/model-version-isolation-prompt-evolution-development-plan.md §5）。
 *
 * 核心：
 * - IMMUTABLE_RULES：跨模型必须保持不变的系统安全 / 作者内容契约（§5.1）。
 * - PROTECTED_SURFACES：系统边界表面。实验候选不得修改这些表面，否则视为
 *   越过系统边界 → 契约违反 → 不得进入 Eval。
 * - EXPERIMENTAL_SURFACES：允许按模型实验的 Prompt 表面（§5.2）。
 *   实验只能改变模型「如何更稳定地完成契约」，不得削弱 IMMUTABLE_RULES。
 * - validateCandidateSurfaces()：给定候选变更的表面集合，返回所有契约违反。
 *   用于候选差异（t4）在进入 Eval 前做门禁，fail-closed。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

// ============================================================================
// 表面（surface）
// ============================================================================

/**
 * Prompt 表面：候选变更的最小定位单位。
 *
 * 两类：
 * - 系统边界表面（PROTECTED_SURFACES）：承载系统安全 / 作者内容契约，禁止实验；
 * - 实验表面（EXPERIMENTAL_SURFACES）：允许按模型调整，且不得削弱不可变契约。
 */
export type PromptSurface =
  // ── 系统边界表面（protected）──
  | "system_prompt"            // 系统 Prompt 的不可变核心（安全/边界指令）
  | "chapter_contract_renderer"// ChapterContract 渲染（作者内容契约）
  | "tool_schema"              // 授权工具集合与 schema
  | "tool_protocol"            // <tool_call> 注入协议
  | "context_compiler"         // 上下文编译器（事实/状态来源）
  | "output_parser"            // 输出解析器
  | "termination_protocol"     // <done> 终止协议
  | "provider_capability"      // provider 能力声明
  | "budget"                   // 检索/生成预算与超时
  // ── 实验表面（experimental）──
  | "user_prompt_renderer"     // 用户 Prompt 拼装（Agentic 意图/上下文组装）— 实验主载体
  | "instruction_order"        // 指令排列顺序
  | "context_layering"         // 上下文分层与压缩方式
  | "tag_style"                // XML / Markdown / 中文标签表达
  | "tool_selection_wording"   // 工具选择提示的表达方式
  | "example_count_selection_position" // 示例数量、选择、位置
  | "goal_abstraction"         // 创作目标的抽象程度
  | "autonomy_space"           // 模型自主判断空间大小
  | "style_guidance_density"   // 风格指导密度
  | "evidence_summary_presentation" // 检索证据摘要呈现方式
  | "stop_search_timing";      // 何时提示模型停止检索并开始写作

/** 系统边界表面（禁止实验修改） */
export const PROTECTED_SURFACES: readonly PromptSurface[] = [
  "system_prompt",
  "chapter_contract_renderer",
  "tool_schema",
  "tool_protocol",
  "context_compiler",
  "output_parser",
  "termination_protocol",
  "provider_capability",
  "budget",
];

/** 实验表面（允许按模型调整） */
export const EXPERIMENTAL_SURFACES: readonly PromptSurface[] = [
  "user_prompt_renderer",
  "instruction_order",
  "context_layering",
  "tag_style",
  "tool_selection_wording",
  "example_count_selection_position",
  "goal_abstraction",
  "autonomy_space",
  "style_guidance_density",
  "evidence_summary_presentation",
  "stop_search_timing",
];

/** 判断一个表面是否属于实验空间 */
export function isExperimentalSurface(surface: PromptSurface): boolean {
  return EXPERIMENTAL_SURFACES.includes(surface);
}

/** 判断一个表面是否属于系统边界（protected） */
export function isProtectedSurface(surface: PromptSurface): boolean {
  return PROTECTED_SURFACES.includes(surface);
}

// ============================================================================
// 不可变安全契约（§5.1）
// ============================================================================

/** 契约规则类别 */
export type ContractCategory =
  | "fact"       // 事实安全
  | "boundary"   // 系统边界 / 授权
  | "delivery"   // 交付边界
  | "state"      // 状态提交
  | "trace";     // trace 留存 / 失败分类

/** 不可变安全契约规则 */
export interface SecurityContractRule {
  id: string;
  category: ContractCategory;
  description: string;
  /** 该规则约束的系统边界表面（修改这些表面时不得削弱本规则） */
  boundSurfaces: readonly PromptSurface[];
}

/** 跨模型必须保持不变的系统安全 / 作者内容契约（§5.1） */
export const IMMUTABLE_RULES: readonly SecurityContractRule[] = [
  {
    id: "inviolable_facts",
    category: "fact",
    description: "不得篡改已确认事实",
    boundSurfaces: ["context_compiler", "chapter_contract_renderer", "system_prompt"],
  },
  {
    id: "no_invented_setting",
    category: "fact",
    description: "不得凭空新增关键设定",
    boundSurfaces: ["context_compiler", "chapter_contract_renderer"],
  },
  {
    id: "must_verify_coverage",
    category: "boundary",
    description: "mustVerify 必须被覆盖",
    boundSurfaces: ["system_prompt", "tool_protocol"],
  },
  {
    id: "tool_whitelist",
    category: "boundary",
    description: "工具只能使用系统授权集合",
    boundSurfaces: ["tool_schema", "tool_protocol", "system_prompt"],
  },
  {
    id: "retrieval_budget",
    category: "boundary",
    description: "检索调用上限和总预算由系统强制",
    boundSurfaces: ["budget", "tool_protocol"],
  },
  {
    id: "fact_gates",
    category: "boundary",
    description: "FactGuard / StoryPreservation / FinalFactRecheck / Completeness 门禁",
    boundSurfaces: ["context_compiler", "system_prompt"],
  },
  {
    id: "agentic_not_delivered",
    category: "delivery",
    description: "Agentic 初稿不得直接交付",
    boundSurfaces: ["system_prompt", "termination_protocol"],
  },
  {
    id: "state_commit_after_final",
    category: "state",
    description: "状态只能在最终正文确认后提交",
    boundSurfaces: ["termination_protocol", "system_prompt"],
  },
  {
    id: "atomic_save",
    category: "delivery",
    description: "正文输出边界和原子保存事务",
    boundSurfaces: ["output_parser", "termination_protocol"],
  },
  {
    id: "trace_contract",
    category: "trace",
    description: "FailureEnvelope、trace 留存和失败分类契约",
    boundSurfaces: ["output_parser", "termination_protocol"],
  },
];

// ============================================================================
// 契约校验（fail-closed）
// ============================================================================

/** 契约违反记录 */
export interface ContractViolation {
  /** 规则 id（如 tool_whitelist） */
  ruleId: string;
  category: ContractCategory;
  /** 被修改且属于系统边界的表面 */
  surface: PromptSurface;
  description: string;
}

/**
 * 校验候选变更的表面集合是否违反不可变安全契约。
 *
 * 规则：
 * - 任何修改系统边界表面（PROTECTED_SURFACES）的候选 → 越过系统边界 → 违反，
 *   返回对应的 SecurityContractRule 绑定。
 * - 只修改实验表面（EXPERIMENTAL_SURFACES）→ 不违反（但仍需通过 Eval 门禁）。
 * - 空变更集 → 无违反（表示候选与基线完全一致，不产生进化）。
 *
 * fail-closed：未识别的表面按 protected 处理（不放过未知表面）。
 *
 * @param changedSurfaces 候选相对基线修改的表面集合
 */
export function validateCandidateSurfaces(
  changedSurfaces: readonly PromptSurface[],
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  for (const surface of changedSurfaces) {
    // 未知表面一律视为系统边界（fail-closed，不放过）
    if (!isExperimentalSurface(surface) && !isProtectedSurface(surface)) {
      violations.push({
        ruleId: "unknown_surface",
        category: "boundary",
        surface,
        description: `未知表面按系统边界处理（fail-closed）：${surface}`,
      });
      continue;
    }
    if (!isProtectedSurface(surface)) continue;

    // 找到绑定该 protected 表面的不可变规则
    const boundRules = IMMUTABLE_RULES.filter((r) => r.boundSurfaces.includes(surface));
    if (boundRules.length === 0) {
      violations.push({
        ruleId: "protected_surface",
        category: "boundary",
        surface,
        description: `修改系统边界表面，未绑定具体不可变规则：${surface}`,
      });
      continue;
    }
    for (const rule of boundRules) {
      violations.push({
        ruleId: rule.id,
        category: rule.category,
        surface,
        description: `${rule.description}（表面 ${surface} 属于系统边界，禁止实验修改）`,
      });
    }
  }

  return violations;
}

/**
 * 便捷判断：候选是否完全在实验空间内（无契约违反）。
 */
export function isCandidateWithinExperimentalSpace(
  changedSurfaces: readonly PromptSurface[],
): boolean {
  return validateCandidateSurfaces(changedSurfaces).length === 0;
}
