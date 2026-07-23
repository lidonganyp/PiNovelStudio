/**
 * staged-state-builder - 从 ChapterSeed 派生 StagedStateUpdate
 *
 * 从 unified-entry.ts 抽出的纯函数模块（P2 H1 修复，2026-07-23）。
 *
 * 抽取动机（H1 audit gap 修复）：
 *   chapter-proxy-approval-finalization-entry.ts 的 runFinalization 在
 *   orchestratorInput.stagedStateUpdate 和 pendingDraft.stagedStateUpdate 均缺失时
 *   需要从 ChapterSeed 重生成 staged state，避免只提交 PatternMemory（丢失
 *   Canon/Character/Promise/Expectation）。但 unified-entry.ts 不在 dist-test
 *   编译范围（test/test-modules.ts 不引用它），无法直接 import。
 *
 *   将 buildStagedStateUpdate 抽到此独立模块后，可同时被以下路径消费：
 *   - unified-entry.ts（生产入口 runUnifiedPipeline，dist/）
 *   - chapter-proxy-approval-finalization-entry.ts（G7 定稿路径，dist/ + dist-test/）
 *
 * 行为保持：与原 unified-entry.ts:491-657 buildStagedStateUpdate 一致，
 * 未来此处为唯一真相源，unified-entry.ts 通过 re-export 复用。
 *
 * 真相源：docs/top-tier-chinese-novel-system-development-plan.md §4.2 FinalStateCommit
 *         docs/long-form-stability-gaps-fix-plan-v2.md §P2
 */

import { compileOntologyContract } from "./ontology-contract-compiler.js";
import type {
  NarrativeStateEntry,
  StagedStateUpdate,
} from "./final-state-commit.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";

// ============================================================================
// buildStagedStateUpdate
// ============================================================================

/**
 * 从 ChapterSeed 派生本章的 StagedStateUpdate（候选生成期间缓冲，最终正文选定后 commit）。
 *
 * 派生五类长期状态：
 * - promise：seed.currentPressure.pendingForeshadowing → "advancing"
 * - canon：seed.worldConstraint.immutableFacts + seed.highLevelDirection.immutableFacts
 * - character：seed.characters → "participation"，并从 expectedIrreversibleChange
 *   提取显式境界迁移（仅注册过 ontology levels 的境界术语）
 * - pattern：不在此处生成（需要正文文本分析，由 commitAndSave 从 finalText 扫描追加）
 * - expectation：当 chapterFunction=setup 或 intent.primary=foreshadow 时创建 1 条
 *
 * sourceRef 初始为 seed:*，由 reanchorStagedStateToFinalText 在最终正文选定后
 * 重锚定为 finalText span/hash，确保状态可追溯到真实正文。
 */
export function buildStagedStateUpdate(
  seed: ChapterSeed,
  chapterNumber: number,
  ontologyLevels: string[] = [],
): StagedStateUpdate {
  const sourceChapter = `ch${chapterNumber}`;
  const now = new Date().toISOString();
  const additions: NarrativeStateEntry[] = [];

  // 1. PromiseLedger：从 seed.currentPressure.pendingForeshadowing 派生 promise 状态更新
  const pendingForeshadowing = seed.currentPressure?.pendingForeshadowing ?? [];
  for (const f of pendingForeshadowing) {
    if (!f.id || !f.description) continue;
    additions.push({
      kind: "promise",
      id: f.id,
      sourceChapter,
      sourceRef: `seed:${f.id}`,
      confidence: 0.6, // intended engagement，非 confirmed resolution
      lastUpdated: now,
      promiseId: f.id,
      description: f.description,
      currentHeat: 1, // 本章正在参与
      status: "advancing",
    });
  }

  // 2. CanonState：从 seed.worldConstraint + highLevelDirection 派生不可破坏事实
  const immutableFacts = [
    ...(seed.worldConstraint?.immutableFacts ?? []),
    ...(seed.highLevelDirection?.immutableFacts ?? []),
  ];
  for (let i = 0; i < immutableFacts.length; i++) {
    const fact = immutableFacts[i];
    if (!fact || fact.trim().length < 2) continue;
    additions.push({
      kind: "canon",
      id: `canon:fact:${i}:ch${chapterNumber}`,
      sourceChapter,
      sourceRef: `seed:canon:${i}`,
      confidence: 0.6,
      lastUpdated: now,
      fact,
      category: "entity", // 默认分类，seed 不携带 category 信息
    });
  }

  // 3. CharacterState：从 seed.characters 派生角色参与记录
  const characters = seed.characters ?? [];
  for (const c of characters) {
    if (!c.name) continue;
    additions.push({
      kind: "character",
      id: `character:${c.name}:ch${chapterNumber}`,
      sourceChapter,
      sourceRef: `seed:character:${c.name}`,
      confidence: 0.6,
      lastUpdated: now,
      characterId: c.name, // 用角色名作为 characterId，便于 reanchor 时在正文中定位
      field: "participation",
      // participation 只记录本章是否实际出现；config.role 是静态元数据，
      // 不能仅因角色名命中就提交为本章关系/身份事实。
      value: "present",
    });
  }

  // 3.1 CharacterState：只从显式不可逆变化中派生已注册境界更新。
  const registeredRealms = compileOntologyContract(ontologyLevels).entries.flatMap((entry) => entry.terms);
  const transitionPattern = /迈入|突破|晋升|进阶|升至|升到|达到|到达|踏入|进入/;
  const stagedRealmCharacters = new Set<string>();
  for (const change of seed.intent?.expectedIrreversibleChange ?? []) {
    if (!transitionPattern.test(change)) continue;
    const character = [...characters]
      .sort((a, b) => b.name.length - a.name.length)
      .find((candidate) => change.includes(candidate.name)
        || (candidate.aliases ?? []).some((alias) => alias.length > 0 && change.includes(alias)));
    if (!character || stagedRealmCharacters.has(character.name)) continue;
    const realmTerm = registeredRealms
      .sort((a, b) => b.length - a.length)
      .find((term) => change.includes(term));
    if (!realmTerm) continue;
    const escapedRealm = realmTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const realmValue = change.match(new RegExp(`${escapedRealm}(?:境|期|阶|级)?(?:初期|中期|后期|巅峰)?`))?.[0];
    if (!realmValue) continue;
    stagedRealmCharacters.add(character.name);
    additions.push({
      kind: "character",
      id: `character:${character.name}:realm`,
      sourceChapter,
      sourceRef: `seed:character:${character.name}:realm`,
      confidence: 0.75,
      lastUpdated: now,
      characterId: character.name,
      field: "realm",
      value: realmValue,
    });
  }

  // 4. PatternMemory：由编排器在最终正文生成后从 LanguageRiskLibrary 扫描追加，
  //    此处不生成（pattern 需要正文文本分析，seed 不携带 pattern 信息）。

  // 5. ExpectationEntry（REM 扩展，2026-07-21）：
  //    从 seed.intent 派生本章"建立/激活的读者期待"。
  //    保守策略：仅当 chapterFunction==="setup" 且 intent.chapterTheme 非空，
  //    或 intent.primary==="foreshadow" 时创建 1 条 expectation entry。
  //    expectation 关注"读者体验目标"（与 promise 关注"伏笔兑现"区分）。
  //    sourceRef 初始为 seed:expectation:*，由 reanchorStagedStateToFinalText
  //    在最终正文选定后重锚定为 finalText span/hash。
  //
  //    P1-7 修复（REM-LIFECYCLE-FIX）：
  //    - 移除机械全关联：不再把本章全部开放弧线/角色/伏笔关联到单条 expectation。
  //      关联字段留空（undefined），由 FinalStateCommit.reanchor 或后续 LLM 诊断
  //      基于实际正文内容决定是否关联。机械全关联会污染后续 LLM 诊断（让 LLM 误以为
  //      所有开放弧线都与本期待相关）。
  //    - overdueWindow 只接受作者/章卡显式输入；缺省时不生成机械期限。
  //    - 明示 seed-only 生命周期边界：此处只创建 expectation（status=open），
  //      不处理 advanced/delayed/escalated/fulfilled 状态推进。
  //      状态推进由两个路径负责：
  //      (a) FinalStateCommit.reanchorStagedStateToFinalText：检查 expectation.description
  //          关键词是否在 finalText 命中，命中则 status 可推进（但 reanchor 保守，通常只
  //          提升 confidence，不自动改 status）。
  //      (b) 后续 LLM 诊断 / 手动 feedback：通过 novel_strategy_feedback 或
  //          novel_workspace_manager action=ingest_reader_feedback 提供证据，
  //          由人工/LLM 决定是否推进 status。
  //      本函数不替代这两个路径——它是 seed-only 的"建立"步骤。
  const chapterTheme = seed.intent?.chapterTheme?.trim();
  const intentPrimary = seed.intent?.primary?.trim();
  const targetEmotions = seed.intent?.targetEmotions ?? [];
  const shouldCreateExpectation =
    (seed.chapterFunction === "setup" && !!chapterTheme) ||
    intentPrimary === "foreshadow";

  if (shouldCreateExpectation && chapterTheme) {
    const expectationId = `expectation:ch${chapterNumber}:${intentPrimary || "setup"}`;
    // Only author/chapter-card supplied windows become REM deadlines.
    const overdueWindow = seed.intent?.expectationWindow;
    additions.push({
      kind: "expectation",
      id: `expectation:ch${chapterNumber}:${intentPrimary || "setup"}`,
      sourceChapter,
      sourceRef: `seed:expectation:${intentPrimary || "setup"}`,
      confidence: 0.6, // intended establishment，非 confirmed 兑现
      lastUpdated: now,
      expectationId,
      description: chapterTheme,
      expectationType: mapIntentPrimaryToExpectationType(intentPrimary),
      targetReaderExperience: targetEmotions.length > 0
        ? targetEmotions.join("、")
        : undefined,
      status: "open", // 本章建立，未兑现
      // REM 生命周期字段
      createdChapter: sourceChapter,
      lastAdvancedChapter: sourceChapter, // 建立即视为首次激活
      ...(overdueWindow ? { overdueWindow: { ...overdueWindow } } : {}),
      // P1-7: 关联字段留空（不机械全关联）
      // 由 FinalStateCommit.reanchor 或后续 LLM 诊断基于实际正文内容决定关联
      // relatedArcIds / relatedCharacterIds / relatedForeshadowIds 不在此处设置
    });
  }

  return {
    additions,
    invalidations: [],
    sourceChapter,
    // finalCandidateId 留空：编排器用 selectedCandidateId 校验
  };
}

// ============================================================================
// mapIntentPrimaryToExpectationType
// ============================================================================

/**
 * 把 ChapterSeed.intent.primary 映射为 expectationType（TYPE-1 ~ TYPE-8）。
 * 来源：legacy reader-expectation-manager 的 8 类期待。
 * 未识别的 primary 返回 undefined（advisory，不阻断）。
 */
function mapIntentPrimaryToExpectationType(
  primary: string | undefined
): string | undefined {
  if (!primary) return undefined;
  const map: Record<string, string> = {
    foreshadow: "TYPE-1-information",
    character: "TYPE-5-character",
    reversal: "TYPE-3-reversal",
    romance: "TYPE-6-romance",
    setting: "TYPE-2-worldbuilding",
    combat: "TYPE-7-tension",
    humor: "TYPE-8-justice",
    tension: "TYPE-7-tension",
  };
  return map[primary];
}
