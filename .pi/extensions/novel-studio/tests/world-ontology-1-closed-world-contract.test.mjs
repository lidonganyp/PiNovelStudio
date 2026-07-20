/**
 * WORLD-ONTOLOGY-1 - ClosedWorldOntologyContract RED contract.
 *
 * 验收口径（对应任务卡 acceptance）：
 * 1. OntologyContract 从 config levels 编译，含 category/terms
 * 2. 未登记"筑体/铸骨"体系被阻断（hard block）
 * 3. 合法"锻骨/淬腑/易筋"通过
 * 4. 开放名词不进入 closed-world gate（不误报）
 * 5. 境界变化需要同章升级 span 或既有 state sourceRef
 * 6. prompt 与 FactGuard 消费同一 contract（id/hash 一致）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileOntologyContract } from "../dist/v2/core/ontology-contract-compiler.js";
import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// 使用仓库内 committed fixture，避免依赖未提交的 workspaces/xinmo/config.json
// （干净检出时该文件不存在，导致模块加载阶段 ENOENT）
const XINMO_CONFIG = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "xinmo-minimal-config.json"), "utf-8")
);
const XINMO_LEVELS = XINMO_CONFIG.worldKeyTerms?.levels ?? [];

// ── 单元测试 ─────────────────────────────────────────────────────────

test("WO1 unit: OntologyContract 从 config levels 编译含 category/terms", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  assert.ok(contract, "contract 应非 null");
  assert.equal(contract.schema, "pinovel.ontology-contract");
  assert.ok(contract.contractId, "应有 contractId");
  assert.ok(contract.contractHash, "应有 contractHash");
  assert.ok(contract.entries.length >= 1, "应有 ontology 条目");

  // 验证炼体境界
  const lianti = contract.entries.find((e) => e.category === "炼体");
  assert.ok(lianti, "应含炼体类别");
  assert.ok(lianti.terms.includes("锻骨"), "炼体 terms 应含锻骨");
  assert.ok(lianti.terms.includes("淬腑"), "炼体 terms 应含淬腑");
  assert.ok(lianti.terms.includes("金身"), "炼体 terms 应含金身");

  // 验证炼魂境界
  const lianhun = contract.entries.find((e) => e.category === "炼魂");
  assert.ok(lianhun, "应含炼魂类别");
  assert.ok(lianhun.terms.includes("灵觉"), "炼魂 terms 应含灵觉");
});

test("WO1 unit: 缺少可解析 levels 时 contract 标记 unavailable 而不伪造序列", () => {
  const contract = compileOntologyContract([]);
  assert.equal(contract.available, false);
  assert.equal(contract.entries.length, 0);
  assert.match(contract.emptyReason, /未提供|不可解析|缺少/);
});

test("WO1 unit: 未登记术语 筑体/铸骨 产生 review 诊断（FACTGUARD-DOWNGRADE-1）", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李一凡突破到了筑体境，骨骼发出脆响。他的铸骨境修炼已经初见成效。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.ok(ontologyDiags.length > 0, "未登记术语'筑体/铸骨'应有 ontology 违规诊断");
  assert.equal(ontologyDiags[0].severity, "review");
  assert.match(ontologyDiags[0].evidence, /筑体|铸骨|未登记/);
});

test("WO1 unit: 合法术语 锻骨/淬腑/易筋 通过", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李一凡的锻骨境修炼已入门槛，下一步是淬腑境。他感觉易筋境还很遥远。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(ontologyDiags.length, 0, "合法术语不应触发 ontology 违规");
});

test("WO1 unit: 开放名词不进入 closed-world gate", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  // "心境"、"意境"不是境界体系术语，是普通词
  const report = guard.check({
    text: "李一凡的心境平和，仿佛进入了某种意境。窗外下着雨。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(ontologyDiags.length, 0, "开放名词'心境/意境'不应触发 ontology 违规");
});

// ── ONTOLOGY-PUNCTUATION-REGRESSION-1 ────────────────────────────────
// c63530a7 修复：含标点/非中文字符的两字符候选不产生 ontology_violation。
// RQ4G 第二次尝试中 "遍，境" 被误报为未登记术语 "遍，"。

test("OPR1: 含标点的两字符候选不产生 ontology_violation", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  // "遍，境" — 逗号混入术语提取
  const textWithPunct = "李一凡跑了一遍，境界似乎有所提升。窗外下着雨。";
  const report = guard.check({
    text: textWithPunct,
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(ontologyDiags.length, 0, `含标点的候选不应触发 ontology 违规，实际：${JSON.stringify(ontologyDiags.map(d => d.evidence))}`);
});

test("OPR1: 含数字的两字符候选不产生 ontology_violation", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  // "3境" — 数字混入术语提取
  const textWithDigit = "李一凡完成了第3境的修炼，感觉力量有所增长。";
  const report = guard.check({
    text: textWithDigit,
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(ontologyDiags.length, 0, `含数字的候选不应触发 ontology 违规，实际：${JSON.stringify(ontologyDiags.map(d => d.evidence))}`);
});

test("OPR1: 纯中文未登记术语产生 review 诊断（FACTGUARD-DOWNGRADE-1）", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  const report = guard.check({
    text: "李一凡突破到了筑体境，随后铸骨境的修炼也初见成效。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.ok(ontologyDiags.length >= 2, "纯中文未登记术语'筑体'和'铸骨'应各自产生 ontology 违规");
  assert.equal(ontologyDiags[0].severity, "review");
});

test("OPR1: 已登记术语仍通过（回归不误杀）", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  const report = guard.check({
    text: "李一凡的锻骨境修炼已入门槛，淬腑境还很遥远。易筋境更是遥不可及。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(ontologyDiags.length, 0, "已登记术语不应触发 ontology 违规");
});

test("FGLB1: 普通险境/绝境不因前置上下文被识别为未登记境界", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  const report = guard.check({
    text: "他从九死险境里挣脱，又决定利用绝境反击。这里描述的是处境，不是力量等级。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(
    ontologyDiags.length,
    0,
    `普通险境/绝境不应触发 ontology 违规，实际：${JSON.stringify(ontologyDiags.map((d) => d.evidence))}`,
  );
});

test("OCL1: 已登记 ontology category label 炼魂境/炼体境 不视为未登记层级", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();

  const report = guard.check({
    text: "炼魂境强调精神层面的修炼，炼体境则侧重肉身，两者都是体系分类标签。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    ontologyContract: contract,
  });

  const ontologyDiags = report.allDiagnostics.filter((d) => d.source === "ontology_violation");
  assert.equal(
    ontologyDiags.length,
    0,
    `contract category label 不应触发 ontology 违规，实际：${JSON.stringify(ontologyDiags.map((d) => d.evidence))}`,
  );
});

test("OCL1: ontology category label 不参与角色有序境界 transition", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李一凡开始研究炼魂境体系，但他的当前炼体层级仍是锻骨境。",
    context: {
      facts: [],
      characterStates: [{
        characterId: "li-yifan",
        name: "李一凡",
        state: { realm: "锻骨" },
        sourceIds: ["state:ch18"],
      }],
      openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
      constitution: null, longTermState: null,
    },
    knownCharacterNames: ["李一凡"],
    ontologyContract: contract,
  });

  const transitionDiags = report.allDiagnostics.filter((d) => d.source === "ontology_transition");
  assert.equal(transitionDiags.length, 0, "category label 不应被解释为角色 level transition");
});

test("WO1 transition: 角色从既有锻骨状态无升级事件直接变成易筋时产生 review 诊断", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李一凡站在门口，易筋境的气息压得众人无法抬头。",
    context: {
      facts: [],
      characterStates: [{
        characterId: "li-yifan",
        name: "李一凡",
        state: { realm: "锻骨" },
        sourceIds: ["state:ch19"],
      }],
      openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
      constitution: null, longTermState: null,
    },
    knownCharacterNames: ["李一凡"],
    ontologyContract: contract,
  });

  const transitionDiags = report.allDiagnostics.filter((d) => d.source === "ontology_transition");
  assert.equal(transitionDiags.length, 1, "无升级 span 的境界变化应产生 review 诊断（FACTGUARD-DOWNGRADE-1：不 hard block）");
  assert.equal(transitionDiags[0].severity, "review");
  assert.match(transitionDiags[0].evidence, /锻骨|易筋|state:ch19/);
  assert.equal(report.hasHardBlock, false, "境界跃迁降为 review 后不得 hard block");
});

test("WO1 transition: 同章明确突破到下一境界时允许", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李一凡咬紧牙关冲破最后一道关隘，正式踏入淬腑境。",
    context: {
      facts: [],
      characterStates: [{
        characterId: "li-yifan",
        name: "李一凡",
        state: { realm: "锻骨" },
        sourceIds: ["state:ch19"],
      }],
      openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
      constitution: null, longTermState: null,
    },
    knownCharacterNames: ["李一凡"],
    ontologyContract: contract,
  });

  const transitionDiags = report.allDiagnostics.filter((d) => d.source === "ontology_transition");
  assert.equal(transitionDiags.length, 0, "同章有明确升级 span 时应允许境界变化");
});

test("WO1 transition: 历史提及其他境界不改写当前状态", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const report = createFactContinuityGuard().check({
    text: "李一凡想起自己当年刚踏入淬腑境时，连刀都握不稳。",
    context: {
      facts: [],
      characterStates: [{
        characterId: "li-yifan", name: "李一凡",
        state: { realm: "锻骨" }, sourceIds: ["state:ch19"],
      }],
      openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
      constitution: null, longTermState: null,
    },
    knownCharacterNames: ["李一凡"],
    ontologyContract: contract,
  });

  assert.equal(
    report.allDiagnostics.filter((d) => d.source === "ontology_transition").length,
    0,
    "明确历史语境不应覆盖当前境界",
  );
});

test("WO1 transition: 当前境界缺 sourceRef 时只产生 review", () => {
  const contract = compileOntologyContract(XINMO_LEVELS);
  const report = createFactContinuityGuard().check({
    text: "李一凡站在门口，易筋境的气息压得众人无法抬头。",
    context: {
      facts: [],
      characterStates: [{
        characterId: "li-yifan", name: "李一凡",
        state: { realm: "锻骨" }, sourceIds: [],
      }],
      openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
      constitution: null, longTermState: null,
    },
    knownCharacterNames: ["李一凡"],
    ontologyContract: contract,
  });

  const diagnostics = report.allDiagnostics.filter((d) => d.source === "ontology_transition");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "review");
  assert.equal(report.hasHardBlock, false, "来源不完整时不得伪造 hard fact");
});

test("WO1 integration: raw prompt 与 FactGuard 消费同一 ontology contract", async () => {
  const { createUnifiedOrchestrator } = await import("../dist/v2/core/unified-orchestrator.js");
  const projectRoot = mkdtempSync(join(tmpdir(), "wo1-integration-"));
  const wsDir = join(projectRoot, "workspaces", "wo1-test");
  mkdirSync(join(wsDir, "chapters"), { recursive: true });
  writeFileSync(join(wsDir, "config.json"), JSON.stringify({
    novelTitle: "测试",
    genre: "都市异能",
    worldKeyTerms: { levels: XINMO_LEVELS },
  }), "utf-8");

  let capturedRawPrompt = "";
  const rawText = [
    "李一凡推开密封室的门，锻骨境的力量沿着手臂收拢。",
    "他侧身避开落下的铁架，把受伤的队员拖到墙后。",
    "门外脚步忽然停住，有人在黑暗里叫出了他的名字。",
    "那声音不属于任何一个已登记的队员。来者到底是谁？",
  ].join("\n");
  const stubModel = async (input) => {
    if (input.kind === "raw_chapter") {
      capturedRawPrompt = input.userPrompt;
      return { text: rawText, model: "stub-raw", route: input.route, durationMs: 1 };
    }
    return {
      text: JSON.stringify({
        winner: "tie", confidence: "uncertain", decisiveReasons: [],
        factualRisks: [], regressionRisks: [], constitutionAlignment: "无",
      }),
      model: "stub-judge", route: input.route, durationMs: 1,
    };
  };

  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "wo1-test", chapterId: "ch1", chapterNumber: 1, projectRoot,
      intent: {
        chapterFunction: "测试", readerExperience: ["紧张"], currentPressure: ["压力"],
        meaningfulChoices: [], promisesToAdvance: [], possibleEndPressure: [],
        relevantCharacters: ["李一凡"], inviolableFacts: [], sourceRefs: ["test"],
        focusCharacterGoals: [{ character: "李一凡", goal: "救出队员" }],
        resistance: [], choicesAndCosts: [], expectedIrreversibleChange: [],
        selectedPromisesToAdvance: [], causalEndPressure: [],
        factAndCharacterKnowledgeForbiddenZones: [], fieldSourceRefs: {},
      },
      context: {
        facts: [], characterStates: [{
          characterId: "li-yifan", name: "李一凡",
          state: { role: "protagonist", realm: "锻骨" }, sourceIds: ["state:ch19"],
        }],
        openLoops: [], worldRules: [], styleReferences: [], sourceMap: [],
        constitution: null, longTermState: null,
      },
      constitution: null,
      characterNames: ["李一凡"],
      ontologyLevels: XINMO_LEVELS,
      modelGenerate: stubModel,
      generationModelGenerate: stubModel,
      judgeModelGenerate: stubModel,
      seed: 1,
    });

    const contract = result.stageResults?.ontologyContract;
    assert.ok(contract?.contractId, "stageResults 应保留 ontology contract");
    assert.ok(contract?.contractHash, "ontology contract 应有 hash");
    assert.ok(
      result.stageResults?.chapterIntent?.consumedFields?.includes("ontologyContract"),
      "raw prompt 应消费 ontologyContract",
    );
    assert.match(capturedRawPrompt, new RegExp(contract.contractId), "raw prompt 应写入 contract id");
    assert.equal(
      result.stageResults?.rawFactGuard?.report?.ontologyContractHash,
      contract.contractHash,
      "FactGuard 与 raw prompt 必须消费同一 contract hash",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
