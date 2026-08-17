/**
 * CEG-7.1 — 20/50/100 章确定性长篇 fixture。
 * 只写隔离目录，不碰真实 workspace。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CegLongformFixtureSpec {
  projectRoot: string;
  workspaceId: string;
  chapters: 20 | 50 | 100;
}

export interface CegLongformFixtureResult {
  workspaceId: string;
  workspacePath: string;
  chapters: number;
  farFact: string;
  currentFact: string;
}

export function materializeCegLongformFixture(
  spec: CegLongformFixtureSpec,
): CegLongformFixtureResult {
  const workspacePath = join(spec.projectRoot, "workspaces", spec.workspaceId);
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "styles"), { recursive: true });

  const farFact = "远章锚点-封印核心在第1章被埋入青石底";
  const currentFact = `近章锚点-第${spec.chapters}章主角仍受封印反噬`;
  const canon = [
    {
      id: "canon:far:ch1:superseded",
      kind: "canon",
      fact: "已废止：封印核心在第1章被埋入红砂",
      category: "entity",
      sourceChapter: "ch1",
      sourceRef: "ch1#canon:far:old",
      confidence: 0.4,
      lastUpdated: "2026-08-15T00:00:00.000Z",
      memory: { lifecycleStatus: "superseded", epistemicStatus: "superseded" },
    },
    {
      id: "canon:far:ch1",
      kind: "canon",
      fact: farFact,
      category: "entity",
      sourceChapter: "ch1",
      sourceRef: "ch1#canon:far:ch1",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
    {
      id: `canon:near:ch${spec.chapters}`,
      kind: "canon",
      fact: currentFact,
      category: "entity",
      sourceChapter: `ch${spec.chapters}`,
      sourceRef: `ch${spec.chapters}#canon:near`,
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
  ];
  const character = [
    {
      id: "char:yechen:alive",
      kind: "character",
      characterId: "叶尘",
      field: "存活",
      value: "存活",
      sourceChapter: "ch1",
      sourceRef: "ch1#char:yechen",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
    {
      id: "char:yechen:knowledge",
      kind: "character",
      characterId: "叶尘",
      field: "knowledgeBoundary",
      value: "不知道封印核心真正主人",
      sourceChapter: "ch1",
      sourceRef: "ch1#char:yechen:knowledge",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
  ];
  const promise = [
    {
      id: "promise:seal",
      kind: "promise",
      promiseId: "seal",
      description: "第1章埋下的封印必须在终局兑现",
      currentHeat: 0.8,
      status: "open",
      sourceChapter: "ch1",
      sourceRef: "ch1#promise:seal",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
  ];
  const pattern = [
    {
      id: "pattern:ending-pressure",
      kind: "pattern",
      patternType: "hook_type",
      description: "章末停在未完成动作上",
      occurrenceCount: spec.chapters,
      sourceChapter: `ch${spec.chapters}`,
      sourceRef: `ch${spec.chapters}#pattern`,
      confidence: 0.6,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
  ];

  writeFileSync(
    join(workspacePath, "config.json"),
    JSON.stringify({
      novelName: `CEG longform ${spec.chapters}`,
      genre: "xianxia",
      characters: [{ id: "yechen", name: "叶尘", role: "protagonist" }],
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(workspacePath, "styles", "profile.json"),
    JSON.stringify({
      id: "ceg-longform",
      kind: "fingerprint",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["压力用动作呈现"],
    }, null, 2),
    "utf8",
  );
  writeFileSync(join(workspacePath, "characters", "yechen.md"), "叶尘，主角。\n", "utf8");
  writeFileSync(
    join(workspacePath, "narrative-state-store.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: spec.workspaceId,
      canon,
      character,
      promise,
      pattern,
      lastCommittedChapter: `ch${spec.chapters}`,
      updatedAt: "2026-08-15T00:00:00.000Z",
    }, null, 2),
    "utf8",
  );

  for (let n = 1; n <= spec.chapters; n += 1) {
    const dir = join(workspacePath, "chapters", `chapter-${n}`);
    mkdirSync(dir, { recursive: true });
    const body =
      n === 1
        ? `第1章。${farFact}。叶尘把远章锚点-封印核心封进青石。`
        : `第${n}章。叶尘继续前行。${n === spec.chapters ? currentFact : "路未尽。"}`;
    writeFileSync(join(dir, "final.md"), body, "utf8");
  }

  return {
    workspaceId: spec.workspaceId,
    workspacePath,
    chapters: spec.chapters,
    farFact,
    currentFact,
  };
}
