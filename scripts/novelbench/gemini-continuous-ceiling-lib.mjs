/** Pure helpers for the Gemini continuous ceiling experiment. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function parseContinuousCeilingArgs(args) {
  const value = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const sourceWorkspaceId = value("source", "xinmo");
  const throughChapter = Number(value("through", "17"));
  const chapterCount = Number(value("chapters", "3"));
  const runId = value("run-id", `gemini-continuous-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const resume = args.includes("--resume");
  if (!/^[A-Za-z0-9_-]+$/.test(sourceWorkspaceId)) throw new Error("source workspace id is invalid");
  if (!Number.isInteger(throughChapter) || throughChapter < 1) throw new Error("through must be a positive integer");
  if (!Number.isInteger(chapterCount) || chapterCount < 3 || chapterCount > 5) {
    throw new Error("chapters must be an integer between 3 and 5");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("run-id is invalid");
  return { sourceWorkspaceId, throughChapter, chapterCount, runId, resume };
}

export function parseSeedPlannerResponse(raw, { startChapter, chapterCount }) {
  const parsed = JSON.parse(stripFence(raw));
  const rootArrays = Object.values(parsed).filter(Array.isArray);
  const chapters = parsed.chapters ?? parsed.chapterSeeds ?? parsed["章节列表"]
    ?? (rootArrays.length === 1 ? rootArrays[0] : null);
  if (!Array.isArray(chapters) || chapters.length !== chapterCount) {
    throw new Error(`seed planner must return exactly ${chapterCount} chapters`);
  }
  return chapters.map((seed, index) => {
    const expectedChapter = startChapter + index;
    const values = seed && typeof seed === "object" ? Object.values(seed) : [];
    const chapterNumberValue = seed?.chapterNumber ?? seed?.["章节号"];
    const chapterNumber = chapterNumberValue === undefined ? expectedChapter : Number(chapterNumberValue);
    if (chapterNumber !== expectedChapter) {
      throw new Error(`seed planner chapter sequence mismatch: expected ${expectedChapter}`);
    }
    const shapedChoiceArrays = values.filter((value) => Array.isArray(value)
      && value.length > 0
      && value.every((item) => item && typeof item === "object" && !Array.isArray(item)));
    const rawChoices = seed.choicesAndCosts ?? seed["选择与代价"]
      ?? (shapedChoiceArrays.length === 1 ? shapedChoiceArrays[0] : null);
    const choicesAndCosts = Array.isArray(rawChoices) ? rawChoices : [];
    const shapedStringArrays = values.filter((value) => Array.isArray(value)
      && value.length > 0
      && value.every((item) => typeof item === "string" && item.trim()));
    const expectedIrreversibleChange = stringArray(
      seed.expectedIrreversibleChange ?? seed["不可逆变化"]
        ?? shapedStringArrays.at(-2),
    );
    const causalEndPressure = stringArray(
      seed.causalEndPressure ?? seed["章末因果压力"]
        ?? shapedStringArrays.at(-1),
    );
    if (choicesAndCosts.length === 0 || choicesAndCosts.some((item) =>
      !item || normalizeChoice(item).choice === null || normalizeChoice(item).cost === null)) {
      throw new Error(`chapter ${expectedChapter} choicesAndCosts must contain a concrete choice and cost`);
    }
    if (expectedIrreversibleChange.length === 0) {
      throw new Error(`chapter ${expectedChapter} expectedIrreversibleChange is required`);
    }
    if (causalEndPressure.length === 0) {
      throw new Error(`chapter ${expectedChapter} causalEndPressure is required`);
    }
    return {
      chapterNumber: expectedChapter,
      choicesAndCosts: choicesAndCosts.map((item) => ({
        choice: normalizeChoice(item).choice,
        cost: normalizeChoice(item).cost,
      })),
      expectedIrreversibleChange,
      causalEndPressure,
    };
  });
}

export function installSharedChapterSeeds(configPaths, seeds) {
  for (const configPath of configPaths) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const chapterSeeds = { ...(config.chapterSeeds ?? {}) };
    for (const seed of seeds) {
      chapterSeeds[String(seed.chapterNumber)] = {
        choicesAndCosts: seed.choicesAndCosts,
        expectedIrreversibleChange: seed.expectedIrreversibleChange,
        causalEndPressure: seed.causalEndPressure,
        candidateAnchors: buildSharedSeedCandidateAnchors(seed),
      };
    }
    writeJsonAtomic(configPath, { ...config, chapterSeeds });
  }
}

export function buildSharedSeedCandidateAnchors(seed) {
  const anchors = seed.choicesAndCosts.map((entry, index) => ({
    id: `shared-choice-${seed.chapterNumber}-${index + 1}`,
    description: `主动选择：${entry.choice}；代价验证：${entry.cost}`,
    channel: index % 2 === 0 ? "cognitive" : "emotional",
    weight: Math.max(0.7, 0.9 - index * 0.05),
  }));
  for (const change of seed.expectedIrreversibleChange) {
    if (anchors.length >= 2) break;
    anchors.push({
      id: `shared-change-${seed.chapterNumber}-${anchors.length + 1}`,
      description: `主动选择：推动不可逆状态变化；代价验证：${change}`,
      channel: "emotional",
      weight: 0.8,
    });
  }
  for (const pressure of seed.causalEndPressure) {
    if (anchors.length >= 2) break;
    anchors.push({
      id: `shared-pressure-${seed.chapterNumber}-${anchors.length + 1}`,
      description: `主动选择：验证当前因果压力；代价验证：${pressure}`,
      channel: "cognitive",
      weight: 0.75,
    });
  }
  return anchors.slice(0, 3);
}

export function buildAnonymousSequenceMapping(runId) {
  const rawFirst = Number.parseInt(sha256(runId).slice(0, 2), 16) % 2 === 0;
  const publicToPrivate = rawFirst
    ? { "序列甲": "raw", "序列乙": "scene_solution" }
    : { "序列甲": "scene_solution", "序列乙": "raw" };
  return {
    publicToPrivate,
    publicReviewLabels: { "序列甲": "候选序列甲", "序列乙": "候选序列乙" },
  };
}

export function buildHumanReviewTemplate(runId, chapters) {
  const dimensions = [
    "主角主动性", "规则信息增量", "场景状态变化", "恐怖递进",
    "对白功能", "信息差", "章末因果压力", "中文原生感",
  ];
  return {
    schemaVersion: 2,
    runId,
    scoringScale: {
      minimum: 1,
      maximum: 5,
      anchors: {
        1: "明显失败，需要重写",
        3: "基本可读，但需要中度修改",
        5: "达到成熟商业连载可发布线",
      },
    },
    dimensions,
    sequences: ["序列甲", "序列乙"].map((sequence) => ({
      sequence,
      chapterScores: chapters.map((chapterNumber) => ({
        chapterNumber,
        scores: Object.fromEntries(dimensions.map((dimension) => [dimension, null])),
        publishable: null,
        accepted: null,
        estimatedRevisionRatio: null,
        hookOrTemplateRepetition: null,
        aiVoiceSeverity: null,
        notes: "",
      })),
      overallPreference: null,
      matureCommercialLine: null,
      continuity: {
        stateDrift: null,
        hookOrTemplateRepetition: null,
        causalContinuity: null,
        characterContinuity: null,
        notes: "",
      },
    })),
    decision: {
      overallWinner: null,
      positiveGain: null,
      productionAdmission: null,
      rationale: "",
    },
  };
}

export function resolveCanonicalChapterPath(workspacePath, chapterNumber) {
  for (const name of [`${chapterNumber}.md`, `chapter-${chapterNumber}.md`]) {
    const path = join(workspacePath, "chapters", name);
    if (existsSync(path)) return path;
  }
  throw new Error(`canonical chapter file missing for chapter ${chapterNumber}`);
}

export function shouldRecoverBlockedRaw(chapterCheckpoint) {
  return chapterCheckpoint?.accepted === false
    && chapterCheckpoint?.failureEnvelope?.stage === "raw_fact_guard";
}

export function normalizeSceneSolutionStateAliases(payload) {
  const normalized = structuredClone(payload);
  const cards = normalized?.["方案列表"] ?? normalized?.solutions ?? normalized?.cards;
  if (!Array.isArray(cards)) throw new Error("scene solution payload is missing the card list");
  for (const card of cards) {
    const key = Object.hasOwn(card, "状态类型") ? "状态类型" : "stateKind";
    const raw = nonEmpty(card[key]);
    if (raw === null) throw new Error("unsupported scene state kind: missing");
    if (["位置", "关系", "资源", "认知", "危险", "承诺", "能力边界"].includes(raw)
      || ["position", "relationship", "resource", "knowledge", "danger", "promise", "ability_boundary"].includes(raw)) {
      continue;
    }
    const aliases = [
      { pattern: /潜行|威胁|风险|危机|高压|压力/, value: "危险" },
      { pattern: /调查|信息|认知|悬疑|线索|情报/, value: "认知" },
      { pattern: /空间|地点|位置/, value: "位置" },
      { pattern: /关系|同盟|信任|情感|羁绊/, value: "关系" },
      { pattern: /资源|物资|道具/, value: "资源" },
      { pattern: /承诺|伏笔|约定|契约/, value: "承诺" },
      { pattern: /能力|战力|战术|底牌|规则.*边界|边界/, value: "能力边界" },
    ];
    const match = aliases.find((alias) => alias.pattern.test(raw));
    if (!match) throw new Error(`unsupported scene state kind: ${raw}`);
    card[key] = match.value;
  }
  return normalized;
}

export function writeJsonAtomic(path, value) {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, path);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripFence(value) {
  const trimmed = String(value ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(nonEmpty).filter(Boolean) : [];
}

function normalizeChoice(item) {
  const namedChoice = nonEmpty(item?.choice ?? item?.["选择"]);
  const namedCost = nonEmpty(item?.cost ?? item?.["代价"]);
  if (namedChoice !== null || namedCost !== null) return { choice: namedChoice, cost: namedCost };
  const values = Object.values(item ?? {}).map(nonEmpty).filter(Boolean);
  return values.length === 2 ? { choice: values[0], cost: values[1] } : { choice: null, cost: null };
}
