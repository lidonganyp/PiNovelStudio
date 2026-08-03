/**
 * Agentic Few-shot prompt 构建（P1 修复，从 agentic-raw-candidate-source.ts 抽取）
 *
 * 把 few-shot 黄金示例编译为 prompt 注入块，作为写作参考（非机械配额）。
 * 独立模块以便 agentic-raw-candidate-source.ts 保持在 simplicity-gate 800 行以内。
 *
 * 设计原则：
 * - manifestApproved=false 或 examples 为空时不注入
 * - 最多 3 个示例（与 FewshotSelector 全局预算一致）
 * - 每个示例最多 520 字符（超长截断 + "…"）
 * - 元数据（场景/节拍/情绪）以括号注释附在示例前
 */

// ============================================================================
// 类型
// ============================================================================

/**
 * Agentic 消费的 Few-shot 选择结果（orchestrator-types.ts fewshotSelection 的子集）。
 *
 * 独立定义避免 v2/core → novelos/agent 的类型耦合。
 */
export interface AgenticFewshotSelection {
  /** FewshotSelector 选中的示例 */
  examples: ReadonlyArray<{
    id: string;
    sceneType?: string;
    text: string;
    qualityScore: number;
    source: string;
    narrativeBeat?: string;
    conflictLevel?: number;
    emotionTarget?: string;
  }>;
  /** FewshotSelector 报告的通道 */
  channel: "runtime" | "flat" | "mixed" | "empty";
  /** manifest 准入状态（false 时强制返回 empty） */
  manifestApproved: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** 最多注入的示例数（与 FewshotSelector 全局预算一致） */
const MAX_FEWSHOT_EXAMPLES = 3;

/** 单个示例最大字符数（超长截断 + "…"） */
const MAX_EXAMPLE_CHARS = 520;

// ============================================================================
// Prompt 构建
// ============================================================================

/**
 * 把 few-shot 选择结果编译为 prompt 注入块。
 *
 * @param fewshotSelection few-shot 选择结果（undefined 或未准入时返回空字符串）
 * @returns prompt 注入块（空字符串表示不注入）
 */
export function buildFewshotPromptBlock(
  fewshotSelection?: AgenticFewshotSelection,
): string {
  if (!fewshotSelection?.manifestApproved || fewshotSelection.examples.length === 0) {
    return "";
  }

  const examples = fewshotSelection.examples.slice(0, MAX_FEWSHOT_EXAMPLES);
  const fewshotParts = examples.map((ex, i) => {
    const meta: string[] = [];
    if (ex.sceneType) meta.push(`场景:${ex.sceneType}`);
    if (ex.narrativeBeat) meta.push(`节拍:${ex.narrativeBeat}`);
    if (ex.emotionTarget) meta.push(`情绪:${ex.emotionTarget}`);
    const metaStr = meta.length > 0 ? `（${meta.join("，")}）` : "";
    const truncatedText =
      ex.text.length > MAX_EXAMPLE_CHARS
        ? ex.text.slice(0, MAX_EXAMPLE_CHARS) + "…"
        : ex.text;
    return `  ${i + 1}.${metaStr}\n  ${truncatedText}`;
  });
  return `【Few-shot 写作参考】（共 ${examples.length} 个示例，通道：${fewshotSelection.channel}）\n${fewshotParts.join("\n")}`;
}
