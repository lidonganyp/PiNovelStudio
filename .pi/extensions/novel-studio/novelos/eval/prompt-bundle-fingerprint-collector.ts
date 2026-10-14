/**
 * MODEL-PROMPT-EVOLUTION-1（t2）— Bundle 指纹采集器（eval-only）
 *
 * 从生产真相源采集 PromptBundleManifest 的每一份 content：
 * - 常量类（systemPrompt / toolSchema / contextCompiler / budget）直接导入生产常量；
 * - 代码类（userPromptRenderer / chapterContractRenderer / toolProtocol /
 *   outputParser / terminationProtocol）读取实现文件**源码内容**哈希，
 *   保证实现文件任何变化都会改变指纹（全自动敏感，无手写"未变化"字段绕过）；
 * - providerCapability 使用 fail-closed 能力声明（见 prompt-bundle-manifest.ts §6）。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";
import { DEFAULT_BUDGET_CONFIG } from "../runtime/budget-policy.js";
import {
  CONTEXT_COMPILER_NAMES,
  ORCHESTRATOR_BUDGET_A,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
  type PromptSlot,
} from "./prompt-registry.js";
import { resolveWriterPromptProfile } from "../../v2/core/model-prompt-adapter.js";
import {
  createProviderCapability,
  type ProviderCapability,
  type BundleFingerprintContent,
} from "./prompt-bundle-manifest.js";

// ============================================================================
// 常量：生产实现文件路径（相对扩展 workspace 根）
// ============================================================================

/**
 * 按 slot 采集的指纹文件集（REGISTRY-DRIFT-IDENTITY-1）。
 *
 * 每个 slot 采集该阶段实际使用的系统提示与实现文件：
 * - novelos_agentic：Agentic ReAct 循环（prompt 拼装 + 工具协议 + 解析 + 终止协议）
 * - style_optimizer：作者风格整章优化（v2/core/author-style-optimizer.ts）
 * - writer_adapter：writer prompt 适配层（v2/core/model-prompt-adapter.ts）
 * - retrieval_eval：隔离评测检索基线（novelos/eval/tool-ab-real-runner.ts）
 */
interface SlotFingerprintFiles {
  userPromptRenderer: string[];
  chapterContractRenderer: string[];
  toolProtocol: string[];
  outputParser: string[];
  terminationProtocol: string[];
}

const SLOT_FINGERPRINT_FILES: Record<PromptSlot, SlotFingerprintFiles> = {
  novelos_agentic: {
    userPromptRenderer: [
      "novelos/agent/agentic-raw-candidate-source.ts",
      "novelos/agent/narrative-agent-loop.ts",
    ],
    chapterContractRenderer: [
      "v2/core/model-prompt-adapter.ts",
    ],
    toolProtocol: [
      "novelos/adapters/tool-schema-injector.ts",
      "novelos/adapters/react-tool-call-parser.ts",
    ],
    outputParser: [
      "novelos/adapters/react-tool-call-parser.ts",
    ],
    terminationProtocol: [
      "novelos/agent/narrative-agent-loop.ts",
      "novelos/adapters/tool-schema-injector.ts",
    ],
  },
  style_optimizer: {
    userPromptRenderer: ["v2/core/author-style-optimizer.ts"],
    chapterContractRenderer: ["v2/core/model-prompt-adapter.ts"],
    toolProtocol: ["v2/core/author-style-optimizer.ts"],
    outputParser: ["v2/core/author-style-optimizer.ts"],
    terminationProtocol: ["v2/core/author-style-optimizer.ts"],
  },
  writer_adapter: {
    userPromptRenderer: ["v2/core/model-prompt-adapter.ts"],
    chapterContractRenderer: ["v2/core/model-prompt-adapter.ts"],
    toolProtocol: ["v2/core/model-prompt-adapter.ts"],
    outputParser: ["v2/core/model-prompt-adapter.ts"],
    terminationProtocol: ["v2/core/model-prompt-adapter.ts"],
  },
  retrieval_eval: {
    userPromptRenderer: ["novelos/eval/tool-ab-real-runner.ts"],
    chapterContractRenderer: ["novelos/eval/tool-ab-real-runner.ts"],
    toolProtocol: ["novelos/eval/tool-ab-real-runner.ts"],
    outputParser: ["novelos/eval/tool-ab-real-runner.ts"],
    terminationProtocol: ["novelos/eval/tool-ab-real-runner.ts"],
  },
};

/** 各 slot 的生产系统提示（与 prompt-registry 的 SLOT_PROMPTS 同源） */
const SLOT_SYSTEM_PROMPTS: Record<PromptSlot, string> = {
  novelos_agentic: PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: PRODUCTION_STYLE_PROMPT,
  writer_adapter: PRODUCTION_WRITER_PROMPT,
  retrieval_eval: EVAL_BASELINE_RETRIEVAL_PROMPT,
};

// ============================================================================
// Provider capability 声明（fail-closed）
// ============================================================================

/**
 * 各 provider 的能力声明（只声明已验证为 true 的能力）。
 *
 * 计划 §6：Gemini 代理的 reasoning 参数已证明不可控，故 thinkingConfig /
 * reasoningEffort / reasoningTokenControl 一律不声明为 true。
 * 本项目生产链路为 text-only ReAct（模型输出 <tool_call> 指令由 parser 解析），
 * 因此 nativeFunctionCalling / responseSchema / structuredToolCallParser 均 false。
 * 未来切换 provider / endpoint 必须重新执行能力探测（重新声明）。
 */
const PROVIDER_CAPABILITY_DECLARATIONS: Record<string, Partial<ProviderCapability>> = {
  gemini: {
    nativeSystemInstruction: true,
  },
  claude: {
    nativeSystemInstruction: true,
  },
  gpt: {
    nativeSystemInstruction: true,
  },
  doubao: {
    nativeSystemInstruction: true,
  },
  glm: {
    nativeSystemInstruction: true,
  },
  ernie: {
    nativeSystemInstruction: true,
  },
  qwen: {
    nativeSystemInstruction: true,
  },
};

/**
 * provider 键别名规范化（model-routing 的 provider 键 → 能力声明键）。
 * gemini31 是 Gemini 渠道族的路由键（兼容 trace 的历史命名），能力等价于 gemini。
 */
const PROVIDER_KEY_ALIASES: Record<string, string> = {
  gemini31: "gemini",
};

/** 未声明 provider 一律空声明（fail-closed：全部能力 false） */
export function getProviderCapability(provider: string): ProviderCapability {
  const normalized = PROVIDER_KEY_ALIASES[provider] ?? provider;
  return createProviderCapability(PROVIDER_CAPABILITY_DECLARATIONS[normalized] ?? {});
}

// ============================================================================
// 源码读取辅助
// ============================================================================

/** 读取一组源码文件并按固定顺序拼接（读取失败抛错，fail-closed） */
function readSourceFiles(rootDir: string, relativePaths: string[]): string {
  return relativePaths
    .map((rel) => {
      const abs = join(rootDir, rel);
      return readFileSync(abs, "utf-8");
    })
    .join("\n===== FILE BOUNDARY =====\n");
}

// ============================================================================
// 采集
// ============================================================================

/**
 * 采集生产 Bundle 指纹输入（按 slot，REGISTRY-DRIFT-IDENTITY-1）。
 *
 * systemPrompt 与 renderer/parser/协议实现文件按 slot 采集该阶段实际使用的
 * 系统提示与实现；不再对全部 slot 统一使用 NovelOS Agentic 的提示与文件。
 *
 * @param opts
 *   - workspaceRoot：扩展 workspace 根（.pi/extensions/novel-studio），用于读取源码
 *   - slot：采集的 prompt slot（决定 systemPrompt 与实现文件集）
 *   - identity：模型身份与请求参数（modelVersion / provider / route / temperature / maxTokens）
 *   - profileId：可选的 profile 覆盖；缺省用 resolveWriterPromptProfile 从 route/provider 解析
 */
export function collectProductionBundleFingerprint(opts: {
  workspaceRoot: string;
  slot: PromptSlot;
  identity: {
    modelVersion: string;
    provider: string;
    route: string;
    temperature: number | null;
    maxTokens: number | null;
  };
  profileId?: string;
}): BundleFingerprintContent {
  const { workspaceRoot, identity } = opts;
  const profileId = opts.profileId ?? resolveWriterPromptProfile({
    provider: identity.provider,
    model: identity.modelVersion,
    route: identity.route,
  });
  const files = SLOT_FINGERPRINT_FILES[opts.slot];

  const toolSchema = Array.from(NARRATIVE_TOOL_NAMES).sort().join(",");
  const contextCompiler = Array.from(CONTEXT_COMPILER_NAMES).sort().join(",");
  const budget = JSON.stringify({
    maxTurns: DEFAULT_BUDGET_CONFIG.maxTurns,
    maxToolCalls: DEFAULT_BUDGET_CONFIG.maxToolCalls,
    maxLatencyMs: DEFAULT_BUDGET_CONFIG.maxLatencyMs,
    orchestratorSoft: ORCHESTRATOR_BUDGET_A.soft,
    orchestratorHard: ORCHESTRATOR_BUDGET_A.hard,
  });

  return {
    modelVersion: identity.modelVersion,
    provider: identity.provider,
    route: identity.route,
    profileId,
    systemPrompt: SLOT_SYSTEM_PROMPTS[opts.slot],
    userPromptRenderer: readSourceFiles(workspaceRoot, files.userPromptRenderer),
    chapterContractRenderer: readSourceFiles(workspaceRoot, files.chapterContractRenderer),
    toolSchema,
    toolProtocol: readSourceFiles(workspaceRoot, files.toolProtocol),
    contextCompiler,
    outputParser: readSourceFiles(workspaceRoot, files.outputParser),
    terminationProtocol: readSourceFiles(workspaceRoot, files.terminationProtocol),
    providerCapability: getProviderCapability(identity.provider),
    budget,
    temperature: identity.temperature,
    maxTokens: identity.maxTokens,
  };
}
