/**
 * PiNovelStudio — Workspace 生成前预检器
 *
 * 治理方案 Phase 2：novel_preflight_workspace
 *
 * 在调用模型生成前执行预检，把"前置条件缺失"从"模型随机失败"中分离出来。
 *
 * 检查项：
 *  1. config.json 存在且包含 genre / subGenres / characters
 *  2. 角色档案目录存在且非空
 *  3. 第 2 章及以后存在前章 skeleton.json
 *  4. ChapterSeed 可生长性（worldConstraint / characterState / previousContinuation / currentPressure / candidateAnchors）
 *  5. 显式章纲 ch{N}-outline-explicit.md 解析（P26新增：事件数/事件ID/感知锚点/参与角色/必须包含）
 *  6. style fingerprint / fewshot / runtime manifest 可读
 *  7. 模型 timeout / env 配置
 *  8. 章节字数预算合理性
 *
 * 严禁：
 *  - 缺 series/outline.md 不得阻断（P22）
 *  - 缺 ch{N}-outline-explicit.md 不得阻断（走默认 ChapterSeed 链路）
 *  - 显式章纲存在但解析失败 / 字段缺失 → 必须阻断（P26 fail-closed）
 *  - Seed 不足时提示补种子源，不提示补章纲
 *  - 预检失败不得进入模型生成
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "node:crypto";
import { buildChapterSeed } from "./chapter-seed-builder.js";
import { createSeedReadinessChecker } from "./seed-readiness-checker.js";
import { getModelRequestTimeoutMs } from "../api/request-timeout.js";
// P26新增：统一显式章纲解析器，Stage 0/Preflight 提前校验显式章纲
// P27新增：hasVerifiableMandatoryElements 用于 mandatoryElements 可验证性校验
import { parseExplicitOutline, hasVerifiableMandatoryElements } from "./explicit-outline-parser.js";

export interface PreflightBlockingItem {
  /** 检查项标识，如 "config_missing" / "characters_missing" / "seed_readiness" */
  check: string;
  /** 人类可读的阻断原因 */
  reason: string;
  /** 修复指令 */
  fixInstruction: string;
  /** 相关证据 */
  evidence?: unknown;
}

export interface PreflightWorkspaceReport {
  /** 是否通过预检（无 blockingItems 即通过） */
  passed: boolean;
  /** 阻断项（必须修复才能生成） */
  blockingItems: PreflightBlockingItem[];
  /** 警告项（不阻断，但建议修复） */
  warnings: string[];
  /** 修复指令汇总（blockingItems 的 fixInstruction 去重） */
  fixInstructions: string[];
  /** 各检查项的详细结果 */
  checks: Record<string, { passed: boolean; detail?: unknown }>;
  /** 预检耗时（ms） */
  durationMs: number;
}

export interface PreflightWorkspaceOptions {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /** 项目根目录（用于检查 data/runtime 等共享资源），默认从 workspacePath 推导 */
  projectRoot?: string;
  /** 是否跳过 ChapterSeed 构建（第1章且无前章上下文时可选） */
  skipSeedReadiness?: boolean;
}

// ============================================================================
// PREFLIGHT-STATE-STORE-CONTINUITY-1
//
// 统一主链路下，前章连续性真相源从 legacy series/skeleton.json 迁移到
// workspaces/{id}/narrative-state-store.json（由 FinalStateCommit 写入）。
// legacy state-observer 不再被统一主链路调用，skeleton.json 不再可靠。
//
// 校验逻辑（chapterNumber > 1 时）：
//  1. state store 文件存在 → 它是权威连续性证据：
//     - workspaceId 必须匹配
//     - 必须有 sourceChapter=ch{N-1} 的 entry（否则陈旧 → 阻断）
//     - 至少一个 entry 的 sourceRef 必须锚定 finalText（ch{N-1}#finalText:{hash}），
//       而非 candidate:*（staged 未提交 → 阻断）
//     - sourceRef 中的 hash 必须与 chapters/{N-1}.md 实际 SHA-256 前 12 位匹配
//     - chapters/{N-1}.md 必须存在（state 声称 committed 但文件缺失 → 阻断）
//  2. state store 文件不存在 → 回退 legacy skeleton.json 检查（向后兼容旧 workspace）
//  3. 两者都缺失 → 阻断 previous_skeleton_missing
//
// 严禁：不自动生成或伪造 skeleton.json。
// ============================================================================

interface StateStoreContinuityResult {
  /** 连续性证据是否有效 */
  valid: boolean;
  /** 连续性来源（"state-store" / "skeleton-legacy" / "first-chapter"） */
  source?: string;
  /** 无效时的原因标识（state-store-absent 表示文件不存在，应回退 skeleton） */
  reason?: string;
}

function validateStateStoreContinuity(
  workspacePath: string,
  workspaceId: string,
  chapterNumber: number,
): StateStoreContinuityResult {
  if (chapterNumber <= 1) {
    return { valid: true, source: "first-chapter" };
  }
  const previousChapter = chapterNumber - 1;
  const previousChapterId = `ch${previousChapter}`;
  const stateStorePath = join(workspacePath, "narrative-state-store.json");

  if (!existsSync(stateStorePath)) {
    // state store 不存在 → 回退 legacy skeleton 检查（由调用方处理）
    return { valid: false, reason: "state-store-absent" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(stateStorePath, "utf-8"));
  } catch (e) {
    return { valid: false, reason: `state-store-parse-error: ${String(e)}` };
  }

  // workspaceId 必须匹配（防止从其他 workspace 复制 state store 误用）
  if (parsed.workspaceId !== workspaceId) {
    return {
      valid: false,
      reason: `state-store-workspace-mismatch: store=${parsed.workspaceId} expected=${workspaceId}`,
    };
  }

  // 收集所有 entry（四类长期叙事状态 + expectation）
  const allEntries: any[] = [
    ...(Array.isArray(parsed.canon) ? parsed.canon : []),
    ...(Array.isArray(parsed.character) ? parsed.character : []),
    ...(Array.isArray(parsed.promise) ? parsed.promise : []),
    ...(Array.isArray(parsed.pattern) ? parsed.pattern : []),
    ...(Array.isArray(parsed.expectation) ? parsed.expectation : []),
  ];

  // 找前章 committed entry
  const prevEntries = allEntries.filter(
    (e) => e && typeof e === "object" && e.sourceChapter === previousChapterId,
  );
  if (prevEntries.length === 0) {
    return {
      valid: false,
      reason: `state-store-stale: no entries with sourceChapter=${previousChapterId} (lastCommittedChapter=${parsed.lastCommittedChapter ?? "unknown"})`,
    };
  }

  // 验证至少一个 entry 的 sourceRef 锚定 finalText（非 candidate:*）
  const finalTextAnchored = prevEntries.find(
    (e) => typeof e.sourceRef === "string" && e.sourceRef.includes("#finalText:"),
  );
  if (!finalTextAnchored) {
    return {
      valid: false,
      reason: `state-store-candidate-only: ${previousChapterId} entries have no finalText-anchored sourceRef (all candidate/staged, never committed)`,
    };
  }

  // 提取 hash 并与实际章节文件比对
  const hashMatch = String(finalTextAnchored.sourceRef).match(/#finalText:([0-9a-fA-F]{12})/);
  if (!hashMatch) {
    return {
      valid: false,
      reason: `state-store-sourceRef-malformed: ${finalTextAnchored.sourceRef}`,
    };
  }
  const stateHash = hashMatch[1].toLowerCase();

  const prevChapterPath = join(workspacePath, "chapters", `${previousChapter}.md`);
  if (!existsSync(prevChapterPath)) {
    return {
      valid: false,
      reason: `state-store-chapter-file-missing: chapters/${previousChapter}.md not found but state claims ${previousChapterId} committed`,
    };
  }

  const prevChapterText = readFileSync(prevChapterPath, "utf-8");
  const actualHash = createHash("sha256")
    .update(prevChapterText, "utf8")
    .digest("hex")
    .slice(0, 12);

  if (stateHash !== actualHash) {
    return {
      valid: false,
      reason: `state-store-hash-mismatch: sourceRef=${stateHash} actual=${actualHash}`,
    };
  }

  return { valid: true, source: "state-store" };
}

/**
 * 执行 workspace 生成前预检。
 *
 * 不调用任何外部模型，纯本地文件 + 配置检查。
 */
export function preflightWorkspace(options: PreflightWorkspaceOptions): PreflightWorkspaceReport {
  const startedAt = Date.now();
  const { workspacePath, workspaceId, chapterId, chapterNumber } = options;
  const blockingItems: PreflightBlockingItem[] = [];
  const warnings: string[] = [];
  const checks: Record<string, { passed: boolean; detail?: unknown }> = {};

  // 项目根目录推导：workspacePath = projectRoot/workspaces/{id}
  const projectRoot = options.projectRoot || deriveProjectRoot(workspacePath);

  // ────────────────────────────────────────────────────────────────
  // 检查 1: config.json 存在 + genre / subGenres / characters
  // ────────────────────────────────────────────────────────────────
  const configPath = join(workspacePath, "config.json");
  let configData: any = null;
  if (!existsSync(configPath)) {
    blockingItems.push({
      check: "config_missing",
      reason: `workspace "${workspaceId}" 缺少 config.json`,
      fixInstruction: `在 workspaces/${workspaceId}/config.json 中配置世界观信息（genre/subGenres/characters）`,
    });
    checks.config = { passed: false };
  } else {
    try {
      configData = JSON.parse(readFileSync(configPath, "utf-8"));
      const missingFields: string[] = [];
      if (!configData.genre) missingFields.push("genre");
      if (configData.subGenres === undefined) missingFields.push("subGenres");
      if (!Array.isArray(configData.characters) || configData.characters.length === 0) {
        missingFields.push("characters");
      }
      if (missingFields.length > 0) {
        blockingItems.push({
          check: "config_fields_missing",
          reason: `config.json 缺少必要字段：${missingFields.join(", ")}`,
          fixInstruction: `在 workspaces/${workspaceId}/config.json 中补充 ${missingFields.join("、")} 字段`,
          evidence: { missingFields },
        });
        checks.config = { passed: false, detail: { missingFields } };
      } else {
        checks.config = { passed: true, detail: { genre: configData.genre, characterCount: configData.characters.length } };
      }
    } catch (e) {
      blockingItems.push({
        check: "config_parse_error",
        reason: `config.json 解析失败：${String(e)}`,
        fixInstruction: `修复 workspaces/${workspaceId}/config.json 的 JSON 格式`,
      });
      checks.config = { passed: false, detail: { error: String(e) } };
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 2: 角色档案目录
  // ────────────────────────────────────────────────────────────────
  const charsDir = join(workspacePath, "characters");
  if (!existsSync(charsDir)) {
    blockingItems.push({
      check: "characters_dir_missing",
      reason: `缺少角色档案目录 characters/`,
      fixInstruction: `在 workspaces/${workspaceId}/characters/ 下创建角色 .md 文件`,
    });
    checks.characters = { passed: false };
  } else {
    const mdFiles = readdirSync(charsDir).filter(f => f.endsWith(".md"));
    if (mdFiles.length === 0) {
      blockingItems.push({
        check: "characters_empty",
        reason: `角色档案目录 characters/ 为空`,
        fixInstruction: `在 workspaces/${workspaceId}/characters/ 下创建角色 .md 文件`,
      });
      checks.characters = { passed: false };
    } else {
      checks.characters = { passed: true, detail: { count: mdFiles.length, files: mdFiles } };
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 3: 前章连续性（第 2 章及以后）
  //
  // PREFLIGHT-STATE-STORE-CONTINUITY-1：真相源迁移
  //  - 优先校验 narrative-state-store.json（统一主链路 FinalStateCommit 写入）
  //  - state store 不存在时回退 legacy series/skeleton.json（向后兼容旧 workspace）
  //  - state store 存在但无效（陈旧/candidate-only/hash 不符/workspace 不匹配）→ 阻断，
  //    不回退 skeleton（state store 存在即权威，无效是真问题）
  //  - 严禁自动生成或伪造 skeleton.json
  // ────────────────────────────────────────────────────────────────
  if (chapterNumber > 1) {
    const continuity = validateStateStoreContinuity(workspacePath, workspaceId, chapterNumber);

    if (continuity.valid) {
      // state store 有效（或第1章）→ 连续性确认，skeleton 不再必需
      checks.previousSkeleton = {
        passed: true,
        detail: { source: continuity.source, skeletonOptional: true },
      };
    } else if (continuity.reason === "state-store-absent") {
      // state store 文件不存在 → 回退 legacy skeleton 检查
      const skeletonPath = join(workspacePath, "series", "skeleton.json");
      if (!existsSync(skeletonPath)) {
        blockingItems.push({
          check: "previous_skeleton_missing",
          reason: `前章连续性证据缺失（章节 ${chapterNumber - 1}）：narrative-state-store.json 不存在且 series/skeleton.json 不存在`,
          fixInstruction: `先生成章节 ${chapterNumber - 1}（统一主链路会自动提交 narrative-state-store.json，含 sourceChapter=ch${chapterNumber - 1} 与 finalText hash）；或从其他工作区复制 skeleton.json 到 series/skeleton.json`,
          evidence: {
            chapterNumber,
            missingStateStore: "narrative-state-store.json",
            missingSkeleton: "series/skeleton.json",
          },
        });
        checks.previousSkeleton = { passed: false };
      } else {
        try {
          const skeleton = JSON.parse(readFileSync(skeletonPath, "utf-8"));
          checks.previousSkeleton = {
            passed: true,
            detail: { source: "skeleton-legacy", hasChapters: Array.isArray(skeleton.chapters) },
          };
        } catch (e) {
          blockingItems.push({
            check: "previous_skeleton_parse_error",
            reason: `前章 skeleton.json 解析失败：${String(e)}`,
            fixInstruction: `修复 workspaces/${workspaceId}/series/skeleton.json 的 JSON 格式，或生成章节 ${chapterNumber - 1} 以提交 narrative-state-store.json`,
          });
          checks.previousSkeleton = { passed: false };
        }
      }
    } else {
      // state store 存在但无效（陈旧/candidate-only/hash 不符/workspace 不匹配/解析错误/章节文件缺失）
      // → 阻断，不回退 skeleton（state store 存在即权威，无效是真问题）
      blockingItems.push({
        check: "previous_state_store_invalid",
        reason: `前章 narrative-state-store 无效：${continuity.reason}`,
        fixInstruction: `检查 workspaces/${workspaceId}/narrative-state-store.json 是否有 ch${chapterNumber - 1} 的 committed finalText 状态（sourceChapter=ch${chapterNumber - 1}，sourceRef=ch${chapterNumber - 1}#finalText:{hash}，hash 须与 chapters/${chapterNumber - 1}.md 实际 SHA-256 前 12 位匹配）；或重新生成章节 ${chapterNumber - 1}`,
        evidence: { chapterNumber, reason: continuity.reason },
      });
      checks.previousSkeleton = {
        passed: false,
        detail: { source: "state-store-invalid", reason: continuity.reason },
      };
    }
  } else {
    checks.previousSkeleton = { passed: true, detail: { skipped: "chapter 1" } };
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 4: ChapterSeed 可生长性
  // ────────────────────────────────────────────────────────────────
  if (!options.skipSeedReadiness) {
    try {
      const seedResult = buildChapterSeed({
        workspacePath,
        workspaceId,
        chapterId,
        chapterNumber,
      });
      const readinessChecker = createSeedReadinessChecker();
      const readinessReport = readinessChecker.check(seedResult.seed);
      if (readinessReport.shouldBlockGeneration) {
        blockingItems.push({
          check: "seed_readiness",
          reason: `ChapterSeed 种子可生长性不足（score=${readinessReport.score}/100, status=${readinessReport.status}）`,
          fixInstruction: readinessReport.blockingReasons.length > 0
            ? readinessReport.blockingReasons.join("; ")
            : `补充种子源：角色状态 / 当前压力 / 未结账细节 / 世界约束 / 候选感知锚点（不要补章纲）`,
          evidence: {
            score: readinessReport.score,
            status: readinessReport.status,
            blockingReasons: readinessReport.blockingReasons,
            dimensions: readinessReport.dimensions.map(d => ({ dimension: d.dimension, sufficient: d.sufficient })),
          },
        });
        checks.seedReadiness = { passed: false, detail: { score: readinessReport.score, status: readinessReport.status } };
      } else {
        if (readinessReport.status === "warning") {
          warnings.push(`ChapterSeed 可生成性评分偏低（${readinessReport.score}/100），建议补充种子源`);
        }
        checks.seedReadiness = { passed: true, detail: { score: readinessReport.score, status: readinessReport.status } };
      }
    } catch (e) {
      blockingItems.push({
        check: "seed_build_error",
        reason: `ChapterSeed 构建失败：${String(e)}`,
        fixInstruction: `检查 config.json / 角色档案 / series/skeleton.json 是否完整可读`,
        evidence: { error: String(e) },
      });
      checks.seedReadiness = { passed: false, detail: { error: String(e) } };
    }
  } else {
    checks.seedReadiness = { passed: true, detail: { skipped: true } };
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 5: 显式章纲 ch{N}-outline-explicit.md（P26新增）
  //
  // 用户提供的 per-chapter 事件契约。存在时必须能解析出 ≥1 个事件，
  // 且每个事件必须包含：事件 ID、感知锚点、参与角色、必须包含字段。
  // 解析失败 → 阻断在模型前，不消耗生成。
  //
  // 严禁：
  //   - 章纲非空但 0 事件 → explicit_outline_parse_error 阻断
  //   - 事件缺感知锚点/参与角色/必须包含 → explicit_outline_field_missing 阻断
  //   - 不存在 ch{N}-outline-explicit.md → 跳过（不阻断，走默认 ChapterSeed 链路）
  // ────────────────────────────────────────────────────────────────
  const explicitOutlinePath = join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`);
  if (existsSync(explicitOutlinePath)) {
    try {
      const explicitContent = readFileSync(explicitOutlinePath, "utf-8");
      const parsed = parseExplicitOutline(explicitContent);

      // 5a: 章纲非空但解析出 0 事件 → fail-closed
      if (parsed.hasNonEmptyOutline && parsed.parseError) {
        blockingItems.push({
          check: "explicit_outline_parse_error",
          reason: `显式章纲 ch${chapterNumber}-outline-explicit.md 非空但未解析出任何事件头：${parsed.parseError.reason}`,
          fixInstruction: `检查 workspaces/${workspaceId}/series/ch${chapterNumber}-outline-explicit.md 的事件头格式（期望 \`##/###/#### 事件 N\` / \`事件 EN\`），preview: ${parsed.parseError.preview.slice(0, 80)}`,
          evidence: {
            outlineLength: parsed.parseError.outlineLength,
            preview: parsed.parseError.preview,
            outlinePath: `series/ch${chapterNumber}-outline-explicit.md`,
          },
        });
        checks.explicitOutline = { passed: false, detail: { parseError: parsed.parseError } };
      } else if (parsed.events.length > 0) {
        // 5b: 事件字段完整性检查（感知锚点 / 参与角色 / 必须包含）
        const missingFieldEvents: Array<{
          outlineEventId: string;
          title: string;
          missingFields: string[];
        }> = [];
        for (const ev of parsed.events) {
          const missingFields: string[] = [];
          if (ev.perceptualAnchors.length === 0) missingFields.push("感知锚点");
          if (ev.characters.length === 0) missingFields.push("参与角色");
          if (ev.mandatoryElements.length === 0) missingFields.push("必须包含");
          if (missingFields.length > 0) {
            missingFieldEvents.push({
              outlineEventId: ev.outlineEventId,
              title: ev.title,
              missingFields,
            });
          }
        }

        if (missingFieldEvents.length > 0) {
          blockingItems.push({
            check: "explicit_outline_field_missing",
            reason: `显式章纲事件缺少必须字段（感知锚点/参与角色/必须包含）：${missingFieldEvents.map(e => `${e.outlineEventId}(${e.missingFields.join("+")})`).join(", ")}`,
            fixInstruction: `在 workspaces/${workspaceId}/series/ch${chapterNumber}-outline-explicit.md 中为以下事件补全字段：${missingFieldEvents.map(e => `${e.outlineEventId} 缺 ${e.missingFields.join("、")}`).join("; ")}`,
            evidence: {
              outlineEventCount: parsed.events.length,
              missingFieldEvents,
              outlinePath: `series/ch${chapterNumber}-outline-explicit.md`,
            },
          });
          checks.explicitOutline = {
            passed: false,
            detail: { outlineEventCount: parsed.events.length, missingFieldEvents },
          };
        } else {
          // P27新增：5c mandatoryElements 可验证性检查
          // 字段齐全但 mandatoryElements 全是停用词/泛化术语（如"主角"、"场景"、"情绪"）
          // → 无法形成可验证事件契约 → 阻断，不允许进入模型生成。
          const unverifiableEvents: Array<{
            outlineEventId: string;
            title: string;
            mandatoryElements: string[];
          }> = [];
          for (const ev of parsed.events) {
            if (!hasVerifiableMandatoryElements(ev.mandatoryElements)) {
              unverifiableEvents.push({
                outlineEventId: ev.outlineEventId,
                title: ev.title,
                mandatoryElements: ev.mandatoryElements,
              });
            }
          }
          if (unverifiableEvents.length > 0) {
            blockingItems.push({
              check: "explicit_outline_contract_error",
              reason: `显式章纲事件 mandatoryElements 无法形成可验证项（全是停用词/泛化术语）：${unverifiableEvents.map(e => `${e.outlineEventId}(${e.mandatoryElements.length === 0 ? "空" : JSON.stringify(e.mandatoryElements)})`).join(", ")}`,
              fixInstruction: `在 workspaces/${workspaceId}/series/ch${chapterNumber}-outline-explicit.md 中为以下事件的 \`必须包含\` 字段补全可验证元素（动作/物件/台词/状态变化等具体名词，禁止只用"主角/场景/情绪/类型"等泛化词）：${unverifiableEvents.map(e => e.outlineEventId).join(", ")}`,
              evidence: {
                outlineEventCount: parsed.events.length,
                unverifiableEvents,
                outlinePath: `series/ch${chapterNumber}-outline-explicit.md`,
              },
            });
            checks.explicitOutline = {
              passed: false,
              detail: { outlineEventCount: parsed.events.length, unverifiableEvents },
            };
          } else {
            checks.explicitOutline = {
              passed: true,
              detail: {
                outlineEventCount: parsed.events.length,
                events: parsed.events.map(e => ({
                  outlineEventId: e.outlineEventId,
                  title: e.title,
                  sceneType: e.sceneType,
                  anchorCount: e.perceptualAnchors.length,
                  characterCount: e.characters.length,
                  mandatoryCount: e.mandatoryElements.length,
                })),
              },
            };
          }
        }
      } else {
        // 章纲为空文件（hasNonEmptyOutline=false）→ 视为无显式契约，不阻断
        checks.explicitOutline = { passed: true, detail: { skipped: "empty outline file" } };
      }
    } catch (e) {
      blockingItems.push({
        check: "explicit_outline_read_error",
        reason: `显式章纲 ch${chapterNumber}-outline-explicit.md 读取失败：${String(e)}`,
        fixInstruction: `检查 workspaces/${workspaceId}/series/ch${chapterNumber}-outline-explicit.md 文件权限与编码（UTF-8）`,
        evidence: { error: String(e) },
      });
      checks.explicitOutline = { passed: false, detail: { error: String(e) } };
    }
  } else {
    // 不存在 ch{N}-outline-explicit.md → 不阻断，走默认 ChapterSeed 链路
    checks.explicitOutline = { passed: true, detail: { skipped: "no explicit outline" } };
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 6: style fingerprint / fewshot / runtime manifest 可读性
  // ────────────────────────────────────────────────────────────────
  // P30 修复公共节点污染：三段式解析
  //   1. workspace-local 优先：workspaces/{workspaceId}/styles/profile.json（workspace 私有指纹）
  //   2. 公共 shared 次选：styles/profiles/{styleProfile}.json（公共作者风格指纹库）
  //   3. 两者皆无时不阻断，仅记录 missing=true，由运行时回退到代码内置默认
  const styleProfileName = configData?.styleProfile;
  if (styleProfileName && typeof styleProfileName === "string") {
    const workspaceLocalPath = join(projectRoot, "workspaces", workspaceId, "styles", "profile.json");
    const sharedPath = join(projectRoot, "styles", "profiles", `${styleProfileName}.json`);
    if (existsSync(workspaceLocalPath)) {
      checks.styleProfile = { passed: true, detail: { path: workspaceLocalPath, source: "workspace-local" } };
    } else if (existsSync(sharedPath)) {
      checks.styleProfile = { passed: true, detail: { path: sharedPath, source: "shared" } };
    } else {
      warnings.push(`风格指纹文件不存在：workspaces/${workspaceId}/styles/profile.json 与 styles/profiles/${styleProfileName}.json 均缺失（将使用代码内置默认风格）`);
      checks.styleProfile = { passed: true, detail: { missing: true, paths: [workspaceLocalPath, sharedPath] } };
    }
  } else {
    // 无 styleProfile 字段时，仅检查 workspace-local（如 story-outline-planner-test 不再配置 styleProfile）
    const workspaceLocalPath = join(projectRoot, "workspaces", workspaceId, "styles", "profile.json");
    if (existsSync(workspaceLocalPath)) {
      checks.styleProfile = { passed: true, detail: { path: workspaceLocalPath, source: "workspace-local" } };
    } else {
      checks.styleProfile = { passed: true, detail: { skipped: "no styleProfile configured, no workspace-local profile" } };
    }
  }

  // runtime manifest（可选，不阻断）
  const runtimeManifestPath = join(projectRoot, "data", "runtime", "manifest.json");
  if (existsSync(runtimeManifestPath)) {
    checks.runtimeManifest = { passed: true, detail: { path: runtimeManifestPath } };
  } else {
    warnings.push("data/runtime/manifest.json 不存在（运行时知识检索将跳过，不阻断生成）");
    checks.runtimeManifest = { passed: true, detail: { missing: true } };
  }

  // validated-craft-rules.json（可选，不阻断）
  const validatedRulesPath = join(projectRoot, "data", "runtime", "validated-craft-rules.json");
  if (existsSync(validatedRulesPath)) {
    checks.validatedRules = { passed: true, detail: { path: validatedRulesPath } };
  } else {
    warnings.push("data/runtime/validated-craft-rules.json 不存在（机制就绪但尚无经晋级的作者学习规则，不阻断生成）");
    checks.validatedRules = { passed: true, detail: { missing: true } };
  }

  // user-preference-rules.json（可选，不阻断）— USER-REVISION-LEARNINGS.md 编译产物。
  // 只 existsSync，不 JSON.parse（schema 错误由 narrator loader 通过 loadReport.schemaError
  // 上报 trace diagnostic，避免 preflight/narrator 双重解析不一致）。
  const userPrefRulesPath = join(workspacePath, "runtime", "user-preference-rules.json");
  if (existsSync(userPrefRulesPath)) {
    checks.userPreferenceRules = { passed: true, detail: { path: userPrefRulesPath } };
  } else {
    warnings.push(`workspaces/${workspaceId}/runtime/user-preference-rules.json 不存在（用户偏好规则未编译，不阻断生成；可运行 scripts/learning/compile_user_revision_preferences.py --workspace ${workspaceId} 编译）`);
    checks.userPreferenceRules = { passed: true, detail: { missing: true } };
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 6: 模型 timeout / env 配置
  // ────────────────────────────────────────────────────────────────
  const timeoutMs = getModelRequestTimeoutMs();
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    blockingItems.push({
      check: "model_timeout_invalid",
      reason: `模型请求超时配置无效：PINOVEL_MODEL_REQUEST_TIMEOUT_MS=${process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS}`,
      fixInstruction: `设置 PINOVEL_MODEL_REQUEST_TIMEOUT_MS 为正整数（默认 300000ms）`,
    });
    checks.modelTimeout = { passed: false };
  } else {
    checks.modelTimeout = { passed: true, detail: { timeoutMs } };
  }

  // ────────────────────────────────────────────────────────────────
  // 检查 7: 章节字数预算合理性
  // ────────────────────────────────────────────────────────────────
  if (configData) {
    const perChapter = configData.targetWordCount?.perChapter;
    if (perChapter) {
      const min = Number(perChapter.min);
      const max = Number(perChapter.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        if (min <= 0 || max <= 0) {
          blockingItems.push({
            check: "word_budget_invalid",
            reason: `字数预算配置无效：perChapter.min=${min}, perChapter.max=${max}`,
            fixInstruction: `在 config.json 中设置 targetWordCount.perChapter.min/max 为正整数`,
            evidence: { min, max },
          });
          checks.wordBudget = { passed: false };
        } else if (min > max) {
          blockingItems.push({
            check: "word_budget_inverted",
            reason: `字数预算 min > max：min=${min}, max=${max}`,
            fixInstruction: `修正 config.json 中 targetWordCount.perChapter.min/max（min 应 <= max）`,
            evidence: { min, max },
          });
          checks.wordBudget = { passed: false };
        } else if (max < 500) {
          warnings.push(`字数预算 max=${max} 过低，单章不足 500 字可能无法满足质量门禁`);
          checks.wordBudget = { passed: true, detail: { min, max, warning: "low_budget" } };
        } else {
          checks.wordBudget = { passed: true, detail: { min, max } };
        }
      } else {
        warnings.push("config.json 缺少 targetWordCount.perChapter.min/max，将使用默认字数预算");
        checks.wordBudget = { passed: true, detail: { missing: true } };
      }
    } else {
      warnings.push("config.json 缺少 targetWordCount.perChapter，将使用默认字数预算");
      checks.wordBudget = { passed: true, detail: { missing: true } };
    }
  } else {
    checks.wordBudget = { passed: true, detail: { skipped: "config missing" } };
  }

  // ────────────────────────────────────────────────────────────────
  // 汇总
  // ────────────────────────────────────────────────────────────────
  const fixInstructionsSet = new Set<string>();
  for (const item of blockingItems) {
    fixInstructionsSet.add(item.fixInstruction);
  }

  const durationMs = Date.now() - startedAt;

  return {
    passed: blockingItems.length === 0,
    blockingItems,
    warnings,
    fixInstructions: Array.from(fixInstructionsSet),
    checks,
    durationMs,
  };
}

/**
 * 从 workspacePath 推导 projectRoot。
 * workspacePath 形如 .../workspaces/{id}，projectRoot 为其上两级。
 */
function deriveProjectRoot(workspacePath: string): string {
  // workspacePath = <root>/workspaces/<id>
  const parent = join(workspacePath, ".."); // <root>/workspaces
  const grandparent = join(parent, ".."); // <root>
  try {
    const normalized = grandparent;
    if (existsSync(join(normalized, "workspaces"))) {
      return normalized;
    }
  } catch {
    // fallthrough
  }
  return grandparent;
}

/**
 * 格式化预检报告为可读消息（用于 return.message 或日志）。
 */
export function formatPreflightWorkspaceReport(report: PreflightWorkspaceReport): string {
  const lines: string[] = [];
  lines.push(`【生成前预检】${report.passed ? "✓ 通过" : "✗ 阻断"}（耗时 ${report.durationMs}ms）`);
  if (report.blockingItems.length > 0) {
    lines.push("");
    lines.push("阻断项：");
    for (const item of report.blockingItems) {
      lines.push(`  - [${item.check}] ${item.reason}`);
      lines.push(`    修复：${item.fixInstruction}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("警告：");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}
