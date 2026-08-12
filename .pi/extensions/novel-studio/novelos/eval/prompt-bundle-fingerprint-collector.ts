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

import { NOVELOS_SYSTEM_PROMPT } from "../agent/agentic-raw-candidate-source.js";
import { NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";
import { DEFAULT_BUDGET_CONFIG } from "../runtime/budget-policy.js";
import {
  CONTEXT_COMPILER_NAMES,
  ORCHESTRATOR_BUDGET_A,
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

/** user prompt renderer 实现文件（Agentic 的 intent/context 拼装 + loop 的 prompt 组装） */
const USER_PROMPT_RENDERER_FILES = [
  "novelos/agent/agentic-raw-candidate-source.ts",
  "novelos/agent/narrative-agent-loop.ts",
];

/** ChapterContract renderer 实现文件（renderContract / renderLayeredContract） */
const CHAPTER_CONTRACT_RENDERER_FILES = [
  "v2/core/model-prompt-adapter.ts",
];

/** 工具协议实现文件（<tool_call> 注入约定 + parser） */
const TOOL_PROTOCOL_FILES = [
  "novelos/adapters/tool-schema-injector.ts",
  "novelos/adapters/react-tool-call-parser.ts",
];

/** 输出解析器实现文件（tool-call 指令解析 + draft 提取） */
const OUTPUT_PARSER_FILES = [
  "novelos/adapters/react-tool-call-parser.ts",
];

/** 终止协议实现文件（<done> 标记 + stopReason 逻辑 + 调用约定尾部） */
const TERMINATION_PROTOCOL_FILES = [
  "novelos/agent/narrative-agent-loop.ts",
  "novelos/adapters/tool-schema-injector.ts",
];

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

/** 未声明 provider 一律空声明（fail-closed：全部能力 false） */
export function getProviderCapability(provider: string): ProviderCapability {
  return createProviderCapability(PROVIDER_CAPABILITY_DECLARATIONS[provider] ?? {});
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
 * 采集生产 Bundle 指纹输入。
 *
 * @param opts
 *   - workspaceRoot：扩展 workspace 根（.pi/extensions/novel-studio），用于读取源码
 *   - identity：模型身份与请求参数（modelVersion / provider / route / temperature / maxTokens）
 *   - profileId：可选的 profile 覆盖；缺省用 resolveWriterPromptProfile 从 route/provider 解析
 */
export function collectProductionBundleFingerprint(opts: {
  workspaceRoot: string;
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
    systemPrompt: NOVELOS_SYSTEM_PROMPT,
    userPromptRenderer: readSourceFiles(workspaceRoot, USER_PROMPT_RENDERER_FILES),
    chapterContractRenderer: readSourceFiles(workspaceRoot, CHAPTER_CONTRACT_RENDERER_FILES),
    toolSchema,
    toolProtocol: readSourceFiles(workspaceRoot, TOOL_PROTOCOL_FILES),
    contextCompiler,
    outputParser: readSourceFiles(workspaceRoot, OUTPUT_PARSER_FILES),
    terminationProtocol: readSourceFiles(workspaceRoot, TERMINATION_PROTOCOL_FILES),
    providerCapability: getProviderCapability(identity.provider),
    budget,
    temperature: identity.temperature,
    maxTokens: identity.maxTokens,
  };
}
