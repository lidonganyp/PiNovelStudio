/**
 * P1-PRODUCTION-REPLAY — 真实生产 replay：验证 PatternMemory 经 advisory 专用召回
 * 通道进入生产 workingSet（P1 是否彻底解决）。
 *
 * 与 scripts/memory-long-form-replay.mjs（确定性模拟，走 dist-test 纯函数）不同：
 * 本脚本构造一个含 20 章已提交长期状态的**真实 workspace**，然后调用生产闭包
 * dist/v2/core/context-compiler.js 的 ContextCompiler.compile() 编译第 21 章，
 * 走真实生产检索路径（context-compiler → deriveLongTermState → retrieveNarrativeContext）。
 *
 * 断言口径（P1）：
 * - PatternMemory 条目的 memory 信封 authorityClass=system_derived / epistemicStatus=derived，
 *   使 score 恒 <10（无法经常规 passingScore 进入工作集）。
 * - 断言这些 PatternMemory 仍经 advisoryInjected 通道进入 `longTermState.pattern`。
 * - 断言正式事实（canon/character）不受影响，仍进入工作集。
 *
 * 用法：
 *   node scripts/p1-production-replay.mjs
 *
 * 输出：
 *   reports/p1-production/p1-production-replay.json
 *   reports/p1-production/p1-production-replay.md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "p1-production");

// ============================================================================
// 20 章剧情脚本（驱动长期状态构造）
// ============================================================================
const GENRE = "仙侠世界";
const CHARACTERS = ["叶尘", "林婉儿", "苏影"];

function sha12(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function iso() {
  return new Date().toISOString();
}

/** 构造某章最终正文（供 sourceRef 可回源 + backfill 扫描） */
function chapterText(n) {
  const lines = [`第${n}章 正文`];
  if (n === 1) {
    lines.push(`这个世界的背景是${GENRE}。`);
    for (const c of CHARACTERS) lines.push(`${c} 是主角团成员。`);
  }
  if (n >= 5) lines.push("叶尘拥有碎星剑。");
  if (n >= 8) lines.push("叶尘与林婉儿是道侣。");
  if (n >= 10) {
    const realm = n >= 18 ? "筑基期" : n >= 14 ? "练气巅峰" : "练气中期";
    lines.push(`叶尘的修为已到${realm}。`);
  }
  if (n === 15) lines.push("叶尘承诺练成尘心诀后为林婉儿复仇，这个承诺尚未兑现。");
  return lines.join("\n");
}

/** 构造正式事实记忆信封（final_text_explicit + confirmed，score 高，常规通道进入） */
function formalMemory(kind, id, value, category, chapter, hash) {
  return {
    memoryId: id,
    memoryType: kind,
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: chapter,
    sourceRef: [`ch${chapter}#finalText:${hash}`],
    textHash: [hash],
    sourceRunId: `run-ch${chapter}`,
    sourceFinalTextHash: hash,
    createdAt: iso(),
    updatedAt: iso(),
    expiresAt: null,
    confidence: 0.9,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: {
      memoryType: kind,
      data: { key: id, value, category },
    },
  };
}

/** 构造 PatternMemory 信封（system_derived + derived，score 恒 <10，必须走 advisory 通道） */
function advisoryPatternMemory(id, patternType, description, occurrenceCount, chapter, hash) {
  return {
    memoryId: id,
    memoryType: "pattern",
    authorityClass: "system_derived",
    epistemicStatus: "derived",
    lifecycleStatus: "active",
    sourceChapter: chapter,
    sourceRef: [`ch${chapter}#finalText:${hash}`],
    textHash: [hash],
    sourceRunId: `run-ch${chapter}`,
    sourceFinalTextHash: hash,
    createdAt: iso(),
    updatedAt: iso(),
    expiresAt: null,
    confidence: 0.8,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: {
      memoryType: "pattern",
      data: { patternType, description, occurrenceCount },
    },
  };
}

/** 构造 20 章 narrative-state-store（含 PatternMemory 与正式事实） */
function buildStore() {
  const canon = [];
  const character = [];
  const promise = [];
  const pattern = [];

  // 世界观 canon（ch1，零漂移）
  const worldHash = sha12(chapterText(1));
  canon.push({
    kind: "canon",
    id: "canon:world:genre",
    sourceChapter: "ch1",
    sourceRef: `ch1#finalText:${worldHash}`,
    confidence: 0.95,
    lastUpdated: iso(),
    fact: GENRE,
    category: "timeline",
    memory: formalMemory("canon", "canon:world:genre", GENRE, "genre", 1, worldHash),
  });

  // 20 章逐章正式事实（canon + character realm 递进）
  let lastRealm = "练气中期";
  for (let n = 1; n <= 20; n++) {
    const text = chapterText(n);
    const hash = sha12(text);
    const ch = `ch${n}`;

    // 每章一条 canon 事实（碎星剑 / 道侣 / 境界）
    if (n === 5) {
      canon.push({
        kind: "canon",
        id: "canon:item:碎星剑",
        sourceChapter: ch,
        sourceRef: `ch${n}#finalText:${hash}`,
        confidence: 0.9,
        lastUpdated: iso(),
        fact: "叶尘拥有碎星剑",
        category: "entity",
        memory: formalMemory("canon", "canon:item:碎星剑", "叶尘拥有碎星剑", "item", n, hash),
      });
    }
    if (n === 8) {
      canon.push({
        kind: "canon",
        id: "canon:relation:叶尘-林婉儿",
        sourceChapter: ch,
        sourceRef: `ch${n}#finalText:${hash}`,
        confidence: 0.9,
        lastUpdated: iso(),
        fact: "叶尘与林婉儿是道侣",
        category: "entity",
        memory: formalMemory("canon", "canon:relation:叶尘-林婉儿", "叶尘与林婉儿是道侣", "relation", n, hash),
      });
    }

    // 角色境界递进（合法状态变化）
    const realm = n >= 18 ? "筑基期" : n >= 14 ? "练气巅峰" : n >= 10 ? "练气中期" : null;
    if (realm && realm !== lastRealm) {
      lastRealm = realm;
      character.push({
        kind: "character",
        id: `character:叶尘:realm-v${n}`,
        sourceChapter: ch,
        sourceRef: `ch${n}#finalText:${hash}`,
        confidence: 0.85,
        lastUpdated: iso(),
        characterId: "叶尘",
        field: "realm",
        value: realm,
        memory: formalMemory("character", `character:叶尘:realm-v${n}`, realm, "realm", n, hash),
      });
    }
  }

  // Promise（ch15 埋入，未兑现）
  const p15 = sha12(chapterText(15));
  promise.push({
    kind: "promise",
    id: "promise:尘心诀",
    sourceChapter: "ch15",
    sourceRef: `ch15#finalText:${p15}`,
    confidence: 0.9,
    lastUpdated: iso(),
    promiseId: "promise:尘心诀",
    description: "叶尘承诺练成尘心诀后为林婉儿复仇",
    status: "open",
    currentHeat: 3,
    memory: {
      memoryId: "promise:尘心诀",
      memoryType: "promise",
      authorityClass: "final_text_explicit",
      epistemicStatus: "confirmed",
      lifecycleStatus: "active",
      sourceChapter: 15,
      sourceRef: [`ch15#finalText:${p15}`],
      textHash: [p15],
      sourceRunId: "run-ch15",
      sourceFinalTextHash: p15,
      createdAt: iso(),
      updatedAt: iso(),
      expiresAt: null,
      confidence: 0.9,
      derivedFromMemoryIds: [],
      supersedesMemoryIds: [],
      payload: {
        memoryType: "promise",
        data: { promiseId: "promise:尘心诀", description: "叶尘承诺练成尘心诀后为林婉儿复仇", status: "open", currentHeat: 3 },
      },
    },
  });

  // PatternMemory（P1 核心：system_derived + derived，score 恒 <10）
  const patternSeeds = [
    { chapter: 6, type: "imagery", desc: "剑光意象堆积，几乎每段都有'剑光如'", count: 4 },
    { chapter: 9, type: "sentence_risk", desc: "AI 腔风险：'缓缓/轻轻'高频堆积", count: 3 },
    { chapter: 12, type: "trope", desc: "打脸套路重复：每章都先抑后扬", count: 5 },
    { chapter: 14, type: "hook_type", desc: "章末疑问悬置连用三章", count: 3 },
    { chapter: 17, type: "conflict_resolution", desc: "冲突化解过于依赖天降机缘", count: 2 },
    { chapter: 19, type: "sentence_risk", desc: "对白占比偏高，叙述段落偏少", count: 2 },
  ];
  for (const seed of patternSeeds) {
    const hash = sha12(chapterText(seed.chapter));
    pattern.push({
      kind: "pattern",
      id: `pattern:${seed.chapter}:${seed.type}`,
      sourceChapter: `ch${seed.chapter}`,
      sourceRef: `ch${seed.chapter}#finalText:${hash}`,
      confidence: 0.8,
      lastUpdated: iso(),
      patternType: seed.type,
      description: seed.desc,
      occurrenceCount: seed.count,
      memory: advisoryPatternMemory(
        `pattern:${seed.chapter}:${seed.type}`,
        seed.type,
        seed.desc,
        seed.count,
        seed.chapter,
        hash,
      ),
    });
  }

  return {
    schemaVersion: 1,
    workspaceId: "p1-replay",
    canon,
    character,
    promise,
    pattern,
    expectation: [],
    eventLog: [...canon, ...character, ...promise, ...pattern],
    quarantine: [],
    planned: [],
    lastCommittedChapter: "ch20",
    updatedAt: iso(),
  };
}

// ============================================================================
// 构造真实 workspace
// ============================================================================
function buildWorkspace() {
  const replayDir = mkdtempSync(join(tmpdir(), "p1-production-"));
  const wsId = "p1-replay";
  const wsDir = join(replayDir, "workspaces", wsId);
  for (const sub of ["characters", "styles", "series", "chapters", "worldbuilding"]) {
    mkdirSync(join(wsDir, sub), { recursive: true });
  }

  // config.json
  writeFileSync(
    join(wsDir, "config.json"),
    JSON.stringify(
      {
        genre: GENRE,
        subGenres: ["东方玄幻"],
        styleProfile: "仙侠叙事",
        immutableFacts: ["这个世界是仙侠世界", "叶尘是主角"],
        worldKeyTerms: ["灵气", "尘心诀", "碎星剑", "筑基期"],
        characters: CHARACTERS.map((name) => ({ name, role: name === "叶尘" ? "protagonist" : "supporting" })),
        chapterProgress: { completed: 20 },
        targetWordCount: { perChapter: { min: 2000, max: 3000 } },
      },
      null,
      2
    ),
    "utf8"
  );

  // 角色档案
  for (const name of CHARACTERS) {
    const role = name === "叶尘" ? "protagonist" : "supporting";
    writeFileSync(
      join(wsDir, "characters", `${name}.md`),
      `# ${name}\n\n角色：${name}\n\n## 性格\n沉着冷静。\n\n## 决策逻辑\n以家族和道侣安危为先。\n`,
      "utf8"
    );
  }

  // 风格指纹（preflight 要求 kind=fingerprint）
  writeFileSync(
    join(wsDir, "styles", "profile.json"),
    JSON.stringify({ id: "xianxia-voice", kind: "fingerprint", content: "克制陈述、留白、少修饰" }, null, 2),
    "utf8"
  );

  // 世界观 power-system
  writeFileSync(join(wsDir, "worldbuilding", "power-system.md"), "练气 → 筑基 → 金丹\n", "utf8");

  // 章节正文 1-20（供 continuity + backfill）
  for (let n = 1; n <= 20; n++) {
    writeFileSync(join(wsDir, "chapters", `${n}.md`), chapterText(n), "utf8");
  }

  // 长期状态（含 PatternMemory）
  writeFileSync(
    join(wsDir, "narrative-state-store.json"),
    JSON.stringify(buildStore(), null, 2),
    "utf8"
  );

  return { replayDir, wsId };
}

// ============================================================================
// 运行生产 replay
// ============================================================================
async function main() {
  const { ContextCompiler, createContextCompiler } = await import(
    `file://${join(EXT_ROOT, "dist", "v2", "core", "context-compiler.js")}`
  );
  const { replayDir, wsId } = buildWorkspace();

  const chapterNumber = 21;
  const compiler = createContextCompiler();
  const result = compiler.compile({
    workspaceId: wsId,
    chapterId: String(chapterNumber),
    chapterNumber,
    projectRoot: replayDir,
  });

  const lts = result.context.longTermState;
  const report = lts?.retrievalReport ?? null;
  const patternIds = (lts?.pattern ?? []).map((e) => e.id);
  const advisoryInjected = report?.advisoryInjected ?? [];
  const forcedRecallAdded = report?.forcedRecallAdded ?? [];

  // P1 断言口径（P1-PRODUCTION-REPLAY-1 修正）：
  // advisory 通道是"少量低权重上下文"（advisoryFloor = max(1, floor(itemLimit/8))），
  // 不可能也不应该让全部 PatternMemory 进入。P1 的核心验收是：
  // (a) 至少一个正式 PatternMemory（system_derived/derived）经 advisory 通道进入工作集；
  // (b) advisory 名额**全部**分配给正式 PatternMemory，未被 backfill 的无信封派生
  //     pattern（accepted-ending）挤占（P1-REPLAY-1 暴露的缺陷）；
  // (c) 正式事实（canon/character）不受 advisory 挤占。
  const expectedPatternIds = [
    "pattern:6:imagery",
    "pattern:9:sentence_risk",
    "pattern:12:trope",
    "pattern:14:hook_type",
    "pattern:17:conflict_resolution",
    "pattern:19:sentence_risk",
  ];
  const injectedFormal = advisoryInjected.filter((id) => expectedPatternIds.includes(id));
  const patternPassed = injectedFormal.length >= 1; // 至少一个正式 PatternMemory 进入工作集
  // advisory 名额应全部为正式 PatternMemory；若出现 backfill 无信封 pattern 挤占则为失败
  const advisoryPassed = advisoryInjected.length > 0 && injectedFormal.length === advisoryInjected.length;

  // 正式事实不被 advisory 挤占
  const canonCount = (lts?.canon ?? []).length;
  const characterCount = (lts?.character ?? []).length;
  const formalPresent = canonCount >= 2 && characterCount >= 2
    && (lts?.canon ?? []).some((e) => e.id === "canon:world:genre")
    && (lts?.character ?? []).some((e) => e.characterId === "叶尘");

  const pass = patternPassed && advisoryPassed && formalPresent;

  const summary = {
    chapterCompiled: chapterNumber,
    workingSet: {
      canon: canonCount,
      character: characterCount,
      promise: (lts?.promise ?? []).length,
      pattern: (lts?.pattern ?? []).length,
    },
    expectedPatternIds,
    patternInWorkingSet: expectedPatternIds.filter((id) => patternIds.includes(id)),
    advisoryInjected,
    advisoryInjectedFormal: injectedFormal,
    forcedRecallAdded,
    patternPassed,
    advisoryPassed,
    formalPresent,
    pass,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "p1-production-replay.json"), JSON.stringify(summary, null, 2), "utf8");

  const md = [
    "# P1 Production Replay — PatternMemory 生产工作集验证",
    "",
    `- 编译章节：ch${chapterNumber}`,
    `- 生产管道：dist/v2/core/context-compiler.js → ContextCompiler.compile → deriveLongTermState → retrieveNarrativeContext`,
    `- 构造：20 章真实 workspace（临时目录，运行后请清理）`,
    "",
    "## PatternMemory（system_derived/derived，score<10）进入工作集",
    ...expectedPatternIds.map((id) => `- ${id}: ${patternIds.includes(id) ? "✅ 进入 workingSet" : "未进入（advisory 名额有限，仅保留最近 N 条）"} ${advisoryInjected.includes(id) ? "(经 advisoryInjected)" : ""}`),
    "",
    "## advisoryInjected",
    "- " + (advisoryInjected.join(", ") || "(无)"),
    `- 其中正式 PatternMemory：${injectedFormal.join(", ") || "(无)"}`,
    `- advisory 名额全部为正式 PatternMemory（未被 backfill 无信封 pattern 挤占）：${advisoryPassed ? "✅" : "❌"}`,
    "",
    "## 正式事实未被挤占",
    `- canon=${canonCount} (含 canon:world:genre=${(lts?.canon ?? []).some((e) => e.id === "canon:world:genre")})`,
    `- character=${characterCount} (含 叶尘=${(lts?.character ?? []).some((e) => e.characterId === "叶尘")})`,
    `- promise=${(lts?.promise ?? []).length}`,
    "",
    `## 结论：**${pass ? "P1 彻底解决 ✅（PatternMemory 经生产 advisory 通道进入工作集）" : "P1 未解决 ❌"}**`,
    "",
  ].join("\n");
  writeFileSync(join(REPORT_DIR, "p1-production-replay.md"), md, "utf8");

  console.log(md);

  rmSync(replayDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

// pre-declare to avoid TDZ in main
main().catch((err) => {
  console.error("P1 production replay failed:", err);
  process.exit(1);
});