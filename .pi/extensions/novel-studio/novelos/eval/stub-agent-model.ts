/**
 * NovelOS M1 评测 — Stub Agent Model（Task C.1）+ P1-1 真实模型通道
 *
 * 为 eval harness 提供能模拟 ReAct 工具调用 + 正文生成的 stub ModelGenerateFn。
 *
 * 设计：
 * - `createStubAgentModelGenerate(fixture, mode)` 返回 ModelGenerateFn
 * - 三个 mode 对应三条 baseline：
 *   - "b1"：不调工具，直接返回 candidateWithErrors（模拟 one_shot_raw 无检索 → 有事实遗漏）
 *   - "b2"：先发 `<tool_call>` 指令，收到证据后返回 healthyCandidate（模拟 agentic 检索后生成）
 *   - "b3"：同 b2 生成路径，verifier 清零由 loop 内置 verifyAndPatch 完成
 * - 内部用 userPrompt 内容判断当前阶段：
 *   - 含"修复范围与方向" → patch 阶段，返回原 draft（模拟 patch 成功）
 *   - 含"已检索到的证据" → 第 2 轮，生成正文
 *   - 否则 → 第 1 轮，发 tool_call 指令（或无检索查询时直接生成正文）
 *
 * 确定性、零真实模型调用，保证 eval 可复现。
 *
 * P1-1 新增 `createRealModelGenerate`：包装 legacy fallback-manager 真实 API 调用，
 * 用于质量评测（runQualityEval）。B1/B2/B3 共用同一 modelGenerate（相同模型/采样/预算），
 * 差异只由 AgenticRawSourceCapabilities 控制。
 */

import type { EvalFixture } from "./eval-types.js";
import type { ModelGenerateFn } from "../../v2/adapters/legacy-model-route-adapter.js";

// ============================================================================
// 类型
// ============================================================================

export type StubMode = "b1" | "b2" | "b3";

// ============================================================================
// createStubAgentModelGenerate
// ============================================================================

/**
 * 创建 stub ModelGenerateFn。
 *
 * 根据 mode 和 userPrompt 内容决定返回：
 * - patch 阶段（userPrompt 含"修复范围与方向"）→ 返回原 draft
 * - b1 mode → 直接返回 candidateWithErrors
 * - b2/b3 mode + 有证据 → 返回 healthyCandidate
 * - b2/b3 mode + 无证据 + 有检索查询 → 发 tool_call 指令
 * - b2/b3 mode + 无证据 + 无检索查询 → 直接返回 healthyCandidate
 *
 * @param fixture 评测 fixture（提供 candidateWithErrors / healthyCandidate / retrievalQueries）
 * @param mode baseline 模式
 */
export function createStubAgentModelGenerate(
  fixture: EvalFixture,
  mode: StubMode,
): ModelGenerateFn {
  return async (input) => {
    const userPrompt = input.userPrompt;

    // patch 阶段：userPrompt 含"修复范围与方向" → 返回 healthyCandidate（模拟 patch 实际修复）
    // M1.1：B3 patch 应实际修复错误，返回 healthyCandidate 而非 originalDraft
    if (userPrompt.includes("修复范围与方向")) {
      return {
        text: fixture.expected.healthyCandidate ?? "",
        model: "stub-patch",
        route: input.route,
        durationMs: 1,
      };
    }

    // B1：不调工具，直接返回有错误的候选
    if (mode === "b1") {
      return {
        text: fixture.expected.candidateWithErrors ?? "",
        model: "stub-b1",
        route: input.route,
        durationMs: 1,
      };
    }

    // B2/B3：检查是否已有证据（第 2 轮）
    if (userPrompt.includes("已检索到的证据")) {
      // 有证据 → 生成正文
      // M1.1：B2/B3 第 2 轮都返回 candidateWithErrors，让 verifier 能发现真实错误
      // B2 不启用 verification → 最终文本有错误（反映 one-shot 无验证的缺陷）
      // B3 启用 verification → verifier 发现错误后触发 patch，patch 阶段返回 healthyCandidate
      return {
        text: fixture.expected.candidateWithErrors ?? "",
        model: "stub-b2b3",
        route: input.route,
        durationMs: 2,
      };
    }

    // 第 1 轮：无证据
    const queries = fixture.chapterIntent.retrievalQueries;
    if (queries.length === 0) {
      // 无需检索 → 直接生成正文（负控 fixture）
      return {
        text: fixture.expected.healthyCandidate ?? "",
        model: "stub-b2b3",
        route: input.route,
        durationMs: 2,
      };
    }

    // 发 tool_call 指令（最多 2 次，模拟 ReAct 工具调用阶段）
    // P0-1：改用 search_narrative_evidence（跨源结构化检索），使 B2 trajectory
    // 含 ranked_evidence 条目，证明模型通过工具协议看到排序证据
    const toolCallDirectives = queries
      .slice(0, 2)
      .map(
        (q) =>
          `<tool_call>{"name":"search_narrative_evidence","arguments":{"query":"${q}","maxResults":10}}</tool_call>`,
      )
      .join("\n");
    return {
      text: toolCallDirectives,
      model: "stub-b2b3",
      route: input.route,
      durationMs: 1,
    };
  };
}

// ============================================================================
// 内部工具
// ============================================================================

/**
 * 从 patch prompt 提取"原始正文："和"修复范围与方向："之间的内容。
 *
 * patch prompt 格式（见 narrative-agent-loop.ts generatePatchedText）：
 * ```
 * 以下正文存在若干硬伤...
 *
 * 原始正文：
 * {originalDraft}
 *
 * 修复范围与方向：
 * {patchInstructions}
 * ```
 */
function extractOriginalDraft(userPrompt: string): string {
  const startMarker = "原始正文：";
  const endMarker = "修复范围与方向：";
  const start = userPrompt.indexOf(startMarker);
  const end = userPrompt.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) return "";
  return userPrompt.slice(start + startMarker.length, end).trim();
}

// ============================================================================
// P1-1：真实模型 ModelGenerateFn（用于质量评测）
// ============================================================================

/**
 * 创建真实模型 ModelGenerateFn（用于质量评测）。
 *
 * 包装 legacy fallback-manager 的真实 API 调用。B1/B2/B3 共用同一 modelGenerate
 * （相同模型/采样/预算），差异只由 AgenticRawSourceCapabilities 控制
 * （enableRetrieval/enableVerification）。
 *
 * 与 `createStubAgentModelGenerate` 的区别：
 * - stub：确定性、零 API 调用，验证 loop 控制流
 * - real：真实模型调用，测量检索对生成质量的实际影响
 *
 * @param route 模型路由名（如 narrator_primary）
 * @returns ModelGenerateFn，调用时经 fallback-manager 真实调用 API
 */
export async function createRealModelGenerate(route: string): Promise<ModelGenerateFn> {
  // 动态 import legacy fallback-manager（与 createLegacyModelGenerateFn 一致）
  const { createLegacyModelGenerateFn } = await import(
    "../../v2/adapters/legacy-model-route-adapter.js"
  );
  const legacyGenerate = createLegacyModelGenerateFn();

  return async (input) => {
    // 强制使用传入的 route（保证 B1/B2/B3 共用同一路由）
    return legacyGenerate({
      ...input,
      route: input.route ?? route,
    });
  };
}
