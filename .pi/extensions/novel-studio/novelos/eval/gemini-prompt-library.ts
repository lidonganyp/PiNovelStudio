/**
 * Phase 8 Stage P — Gemini 专属 Prompt 库（eval-only）
 *
 * 集中定义 Gemini 专属系统提示词，供 Stage P Prompt-A/B 评测使用。
 * 设计目标（见 docs/phase8-gemini-prompt-native-design.md §4）：
 * 在固定 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（fallback=[]）前提下，
 * 显式利用 Gemini 的长上下文、原生工具调用与结构化输出约束，与通用 Prompt 正交比较。
 *
 * 铁律：
 * - 本模块为 eval-only，只注册在 tsconfig.eval.json，不进入 tsconfig.prod.json（生产构建）。
 * - 不包含任何生产硬编码；生产路径不 import 本模块，systemPrompt 覆盖仅经 eval runner 注入。
 * - 两臂（P-A 通用 / P-B Gemini 专属）在其他维度上完全一致，只变化 systemPrompt。
 *
 * 两个 Prompt 面：
 * - GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE：检索决策面（Stage P 两臂 runner 用，
 *   经 runRealToolAbScenario 的 systemPromptBase 注入，再经 injectToolSchemas 拼接工具 schema）。
 * - GEMINI_SYSTEM_PROMPT：完整 NovelOS Agentic 生成面（经 agentic-raw-candidate-source.ts 的
 *   systemPromptOverride 注入，仅当 permitSystemPromptOverride=true）。
 */

/**
 * 检索决策面：Gemini 专属 system prompt 基座（Stage P P-B 臂）。
 *
 * 对比通用 REAL_SYSTEM_PROMPT_BASE（tool-ab-real-runner.ts）：
 * - 显式要求结构化 JSON 工具调用字面量（<tool_call>{...}</tool_call>），降低 malformed 指令。
 * - 强调按证据强度收敛：证据充分即输出终止标记，避免冗余调用压降 token。
 * - 强调 sourceRef 纪律：证据需带有效章节引用，提升 sourceRef 完整率。
 * - 明确长上下文下"直接基于既有证据形成结论，非必要不检索"。
 *
 * 评测边界与通用版一致：不生成章节正文，只返回终止标记。
 */
export const GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE =
  "你是用于网文叙事证据检索的高精度决策代理。你擅长结构化工具调用与长上下文综合。" +
  "请严格遵循以下约束完成任务：\n" +
  "1) 依据检索计划与可见工具，自主决定调用哪个工具收集证据；每次工具调用必须输出" +
  "严格合法的 JSON 工具指令字面量（<tool_call>{\"name\":\"工具名\",\"arguments\":{...}}</tool_call>），" +
  "参数名与类型必须与工具 schema 完全一致，禁止输出多余字段或损坏 JSON。\n" +
  "2) 优先复用已在上下文中确认的既有证据；仅当现状不足以保证事实、人物状态或因果关系正确时再检索，避免冗余调用。\n" +
  "3) 证据收集过程中，凡检索命中必须携带有效章节引用（sourceRef），保证引用完整可溯源。\n" +
  "4) 证据充分后，只需输出终止标记 <done>，禁止生成或输出任何章节正文。";

/**
 * 完整生成面：Gemini 专属 NovelOS Agentic 系统提示词（agentic-raw-candidate-source 注入）。
 *
 * 对比通用 NOVELOS_SYSTEM_PROMPT（agentic-raw-candidate-source.ts）：
 * - 显式利用 Gemini 长上下文与结构化输出：分节指示（意图→上下文→证据→正文）。
 * - 强化"仅当上下文不足才检索"的长上下文综合语义，降低非必要检索。
 * - 强调中文自然度与连续性，避免 AI 腔。
 *
 * 仅经 agentic-raw-candidate-source 的 systemPromptOverride 注入（permitSystemPromptOverride=true），
 * 生产路径不激活。
 */
export const GEMINI_SYSTEM_PROMPT =
  "你是顶尖网文作家，擅长利用长上下文进行连贯的多段落创作。\n" +
  "你将基于「本章意图 → 种子上下文 → 叙事证据」三部分信息生成章节正文：\n" +
  "1) 先综合意图与上下文，明确本章要推进的情节、人物状态与信息释放；\n" +
  "2) 仅当现有上下文不足以保证事实、人物状态或因果关系正确时，才调用叙事证据工具查证，" +
  "证据已充分则直接落笔，避免冗余检索；\n" +
  "3) 正文需中文自然流畅、段落节奏得当、避免翻译腔与 AI 腔，保持人物群像与伏笔连续性。\n" +
  "只输出正文，不要写大纲、注释或分析。";