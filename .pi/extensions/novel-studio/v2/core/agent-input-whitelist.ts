/**
 * AGENT-INPUT-WHITELIST — 按角色的最小输入字段白名单（MA-3.1 先冻结）
 *
 * 工作包创建时默认使用本表白名单；额外字段不得自动注入代理。
 */

import type { AgentRole } from "./agent-roles.js";

export const AGENT_INPUT_FIELD_WHITELISTS: Readonly<
  Record<AgentRole, readonly string[]>
> = {
  preflight: [
    "workspaceId",
    "chapterId",
    "chapterNumber",
    "styleProfilePresent",
    "modelBudget",
    "configSummary",
  ],
  context_compiler: [
    "workspaceId",
    "chapterId",
    "chapterNumber",
    "chapterSeed",
    "priorStateRefs",
    "factSourceRefs",
    "allowedResourceRoots",
  ],
  chapter_intent: [
    "workspaceId",
    "chapterId",
    "chapterNumber",
    "authorChapterCard",
    "openPromises",
    "priorStateSummary",
    "inviolableFacts",
  ],
  novelos_agentic: [
    "workspaceId",
    "chapterId",
    "chapterNumber",
    "chapterIntent",
    "seedContext",
    "context",
    "knownCharacterNames",
    "inviolableFacts",
    "evidencePlan",
    "targetWordCount",
    "recoveryDirective",
    "toolMode",
    "evalPrefix",
    "retrievalPromptOverride",
  ],
  fact_guard: [
    "workspaceId",
    "chapterId",
    "candidateId",
    "text",
    "context",
    "knownCharacterNames",
    "constraintManifest",
    "identityContract",
    "ontologyContract",
    "baselineText",
  ],
  author_style: [
    "workspaceId",
    "chapterId",
    "chapterNumber",
    "sourceCandidate",
    "intent",
    "context",
    "constitution",
    "styleGuidance",
    "strategyParams",
    "targetWordCount",
    "reducedGuidanceRatio",
    "driftFeedback",
    "recoveryFeedback",
    "writerPromptProfile",
  ],
  story_preservation: [
    "workspaceId",
    "chapterId",
    "rawText",
    "editorialText",
    "knownEntities",
    "entityCoverage",
    "aliasToCanonical",
    "sourceCandidateId",
    "optimizedCandidateId",
    "mode",
  ],
  final_fact_recheck: [
    "workspaceId",
    "chapterId",
    "candidateId",
    "finalText",
    "context",
    "knownCharacterNames",
    "inviolableFacts",
    "constraintManifest",
  ],
  final_state_commit: [
    "workspaceId",
    "chapterId",
    "finalText",
    "selectedCandidateId",
    "artifactHash",
    "revision",
    "approvalId",
    "stagedStateUpdate",
    "authorizationEvidence",
  ],
  audit: [
    "workspaceId",
    "chapterId",
    "orchestratorRunId",
    "stageResults",
    "failureEnvelope",
    "lineageIndex",
    "controlDecisions",
  ],
};

export function getInputFieldWhitelist(role: AgentRole): readonly string[] {
  return AGENT_INPUT_FIELD_WHITELISTS[role];
}

/**
 * 默认 allowedResources 模板（相对 workspace 根）。
 * 正式 chapters/ 与 narrative-state-store 不对创作代理开放写入；
 * 读取通过白名单资源前缀控制。
 */
export function getDefaultAllowedResources(
  role: AgentRole,
  sessionId: string,
): string[] {
  const sessionRoot = `novelos-sessions/${sessionId}`;
  switch (role) {
    case "novelos_agentic":
    case "author_style":
      return [
        "config.json",
        "styles/",
        "characters/",
        "series/",
        "CORE-WRITING-PRINCIPLES.md",
        "WORLDBUILDING-CANON.md",
        sessionRoot,
      ];
    case "final_state_commit":
      return [
        "chapters/",
        "narrative-state-store.json",
        "traces/",
        sessionRoot,
      ];
    case "audit":
      return ["traces/", sessionRoot, "novelos-sessions/"];
    default:
      return [
        "config.json",
        "styles/",
        "characters/",
        "series/",
        "CORE-WRITING-PRINCIPLES.md",
        "WORLDBUILDING-CANON.md",
        sessionRoot,
      ];
  }
}

export function getDefaultForbiddenResources(role: AgentRole): string[] {
  if (role === "final_state_commit" || role === "audit") {
    return [];
  }
  // 代理阶段禁止写正式章节与状态；读取也尽量通过编译上下文，不直接扫全量 chapters
  return [
    "chapters/",
    "narrative-state-store.json",
    "strategy-policy.json",
    ".env",
    "node_modules/",
  ];
}
