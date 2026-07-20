/**
 * P3 SceneContractPlanner 测试
 *
 * 验收口径（计划 Task 4）：
 * - ch17 水下救援契约不含"对白比例"
 * - 群像场景能生成群像质量杠杆
 * - 契约能引用 CraftJudgmentLibrary 的 judgment id
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextCompiler } from "../dist/v2/core/context-compiler.js";
import {
  CraftJudgmentLibrary,
} from "../dist/v2/core/craft-judgment-library.js";
import {
  SceneContractPlanner,
  sceneContractContainsMechanicalMetric,
} from "../dist/v2/core/scene-contract-planner.js";

const PROJECT_ROOT = "D:/CODE/PiNovelStudio";

function compileCh17() {
  const cc = new ContextCompiler();
  return cc.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
}

test("P3: ch17 能生成至少 1 个 SceneContract", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });
  assert.ok(plan.contracts.length >= 1, `应 >= 1 个契约，实际 ${plan.contracts.length}`);
});

test("P3: ch17 水下救援契约不含'对白比例'或机械指标", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  // 找到 rescue 类型契约（ch17 必有水下救援）
  const rescueContracts = plan.contracts.filter((c) => c.sceneType === "rescue");
  assert.ok(rescueContracts.length >= 1, `ch17 应有 rescue 契约，实际 ${rescueContracts.length}`);

  for (const contract of rescueContracts) {
    const allText = [
      ...contract.readerPayoff,
      ...contract.mustPreserve,
      ...contract.mustAvoid,
      ...contract.qualityLevers,
    ].join("\n");
    assert.ok(
      !allText.includes("对白比例"),
      `rescue 契约 ${contract.sceneId} 不含"对白比例"`
    );
    assert.ok(
      !allText.includes("对话比例"),
      `rescue 契约 ${contract.sceneId} 不含"对话比例"`
    );
    assert.ok(
      !sceneContractContainsMechanicalMetric(allText),
      `rescue 契约 ${contract.sceneId} 不含机械指标`
    );
  }
});

test("P3: 所有契约字段都不含机械指标（对白比例/比例必须 XX%）", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    const allText = [
      ...contract.readerPayoff,
      ...contract.mustPreserve,
      ...contract.mustAvoid,
      ...contract.qualityLevers,
    ].join("\n");
    assert.ok(
      !sceneContractContainsMechanicalMetric(allText),
      `${contract.sceneId} 不应含机械指标：${allText}`
    );
  }
});

test("P3: 契约能引用 CraftJudgmentLibrary 的 judgment id", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    assert.ok(
      contract.relevantJudgments.length >= 1,
      `${contract.sceneId} 应引用至少 1 个 judgment id`
    );
    // 每个 relevantJudgment 都能在 library 中查到
    for (const jid of contract.relevantJudgments) {
      assert.ok(lib.getById(jid), `judgment ${jid} 应存在于 library`);
    }
  }
});

test("P3: rescue 契约引用 judgment:scene_continuity（hard_block）和 judgment:character_agency", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  const rescue = plan.contracts.find((c) => c.sceneType === "rescue");
  assert.ok(rescue, "ch17 应有 rescue 契约");
  assert.ok(rescue.relevantJudgments.includes("judgment:scene_continuity"));
  assert.ok(rescue.relevantJudgments.includes("judgment:character_agency"));
});

test("P3: 群像场景能生成群像质量杠杆（ensemble 契约的 qualityLevers 含角色功能分化）", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  // ch17 EA5 描述战狼领队/小妖/赵明远等群像，应推断出 ensemble 契约
  const ensemble = plan.contracts.find((c) => c.sceneType === "ensemble");
  if (ensemble) {
    const leversText = ensemble.qualityLevers.join("\n");
    // 群像质量杠杆应涉及角色功能分化或群体压力
    const hasEnsembleLever =
      leversText.includes("功能分化") ||
      leversText.includes("群体压力") ||
      leversText.includes("反应层次") ||
      leversText.includes("身份锚点");
    assert.ok(hasEnsembleLever, `ensemble qualityLevers 应含群像杠杆：${leversText}`);
    assert.ok(ensemble.relevantJudgments.includes("judgment:ensemble"));
  }
});

test("P3: SceneContract 字段完整（sceneId/sceneType/readerPayoff/mustPreserve/mustAvoid/qualityLevers/relevantJudgments）", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    assert.ok(typeof contract.sceneId === "string" && contract.sceneId.length > 0);
    assert.ok([
      "rescue", "combat", "dialogue", "revelation",
      "emotion", "transition", "ensemble", "cliffhanger",
    ].includes(contract.sceneType));
    assert.ok(Array.isArray(contract.readerPayoff) && contract.readerPayoff.length > 0);
    assert.ok(Array.isArray(contract.mustPreserve));
    assert.ok(Array.isArray(contract.mustAvoid) && contract.mustAvoid.length > 0);
    assert.ok(Array.isArray(contract.qualityLevers));
    assert.ok(Array.isArray(contract.relevantJudgments) && contract.relevantJudgments.length > 0);
  }
});

test("P3: rescue 契约 readerPayoff 强调空间清楚/动作连续/风险递增/角色选择", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  const rescue = plan.contracts.find((c) => c.sceneType === "rescue");
  assert.ok(rescue, "ch17 应有 rescue 契约");
  const payoffText = rescue.readerPayoff.join("\n");
  // 至少命中 2 个关键词
  const keywords = ["空间", "动作连续", "风险递增", "选择", "代价"];
  const hitCount = keywords.filter((k) => payoffText.includes(k)).length;
  assert.ok(hitCount >= 2, `rescue readerPayoff 应强调空间/动作/风险/选择，命中 ${hitCount}：${payoffText}`);
});

test("P3: containsMechanicalMetric 正则检测机械指标", () => {
  assert.ok(sceneContractContainsMechanicalMetric("对白比例必须 34%"));
  assert.ok(sceneContractContainsMechanicalMetric("对话比例 30%"));
  assert.ok(sceneContractContainsMechanicalMetric("每段 200 字"));
  assert.ok(sceneContractContainsMechanicalMetric("段落长度必须"));
  assert.ok(!sceneContractContainsMechanicalMetric("动作连续，风险递增"));
  assert.ok(!sceneContractContainsMechanicalMetric("角色功能分化，群体压力推动主角选择"));
});

// Phase D 续修复（2026-07-09 第五轮）：prompt audit 分层
// 根因：原 MECHANICAL_METRIC_PATTERN 含 `必须.*?\d+\s*%` 宽泛分支，会从
// "【硬约束·必须遵守】...至少保留 80%" 匹配成功，误杀 scene_contract 行动保真约束，
// 导致 quick-verify 4/4 样本 scene_contract 候选被拦截，comparator 不执行。
// 修复：去掉宽泛百分比分支，只 hard block 明确机械指标（对白比例/段落长度/字数）。
test("Phase D 续: containsMechanicalMetric 不误杀行动保真约束", () => {
  // 行动保真约束（不应命中）
  assert.ok(!sceneContractContainsMechanicalMetric("保留 rawStage2 已有的主角行动词（至少保留 80%）：推开、冲进"));
  assert.ok(!sceneContractContainsMechanicalMetric("【硬约束·必须遵守】保留 rawStage2 已有的主角行动词（至少保留 80%）"));
  assert.ok(!sceneContractContainsMechanicalMetric("违反硬约束的候选将被废弃重写"));
  assert.ok(!sceneContractContainsMechanicalMetric("主角行动词命中数不得少于 rawStage2 基线（3 个）"));
  assert.ok(!sceneContractContainsMechanicalMetric("感知词命中数不得多于 rawStage2 基线（2 个）"));

  // 保护性：明确机械指标仍应命中（hard block 不变）
  assert.ok(sceneContractContainsMechanicalMetric("对白比例必须 34%"), "对白比例仍应 hard block");
  assert.ok(sceneContractContainsMechanicalMetric("对话比例 30%"), "对话比例仍应 hard block");
  assert.ok(sceneContractContainsMechanicalMetric("每段 200 字"), "每段字数仍应 hard block");
  assert.ok(sceneContractContainsMechanicalMetric("段落长度必须 300 字"), "段落长度仍应 hard block");
  assert.ok(sceneContractContainsMechanicalMetric("字数必须 3000"), "字数要求仍应 hard block");
});

test("P3: 无 seed 时从 context.facts 反解 anchors 仍能生成契约", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    // 不传 seed，走 facts 反解
  });
  assert.ok(plan.contracts.length >= 1, "无 seed 时仍应生成契约");
  // 反解的契约也应引用 judgment id
  for (const contract of plan.contracts) {
    assert.ok(contract.relevantJudgments.length >= 1);
  }
});

test("P3: 每个 sceneType 的契约 qualityLevers 不为空", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    assert.ok(
      contract.qualityLevers.length >= 1,
      `${contract.sceneId} qualityLevers 不应为空`
    );
  }
});

// ============================================================================
// P5 新增：SceneContract 改进断言（continuityAnchors + perceptionErosion + 场景专属 lever）
// ============================================================================

test("P5: 每个 contract 有 continuityAnchors 字段（数组，可为空但字段存在）", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    assert.ok(
      Array.isArray(contract.continuityAnchors),
      `${contract.sceneId} 应有 continuityAnchors 数组字段`
    );
  }
});

test("P5: rescue/combat 场景 mustPreserve 含行动词或空间相关保真项", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  const actionScenes = plan.contracts.filter(
    (c) => c.sceneType === "rescue" || c.sceneType === "combat"
  );
  assert.ok(actionScenes.length >= 1, "ch17 应有 rescue 或 combat 契约");

  for (const contract of actionScenes) {
    const preserveText = contract.mustPreserve.join("\n");
    const hasActionOrSpace =
      preserveText.includes("行动词") ||
      preserveText.includes("空间") ||
      preserveText.includes("出手") ||
      preserveText.includes("位置");
    assert.ok(
      hasActionOrSpace,
      `${contract.sceneId}（${contract.sceneType}）mustPreserve 应含行动词/空间保真项：${preserveText}`
    );
  }
});

test("P5: 所有场景 mustAvoid 含 perceptionErosion 禁令（感知词/觉得/意识到）", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    const avoidText = contract.mustAvoid.join("\n");
    const hasPerceptionErosionBan =
      avoidText.includes("感知词") ||
      avoidText.includes("觉得") ||
      avoidText.includes("意识到");
    assert.ok(
      hasPerceptionErosionBan,
      `${contract.sceneId} mustAvoid 应含 perceptionErosion 禁令：${avoidText}`
    );
  }
});

test("P5: qualityLevers 不为空且不含机械指标", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    assert.ok(
      contract.qualityLevers.length >= 1,
      `${contract.sceneId} qualityLevers 不应为空`
    );
    const leversText = contract.qualityLevers.join("\n");
    assert.ok(
      !sceneContractContainsMechanicalMetric(leversText),
      `${contract.sceneId} qualityLevers 不应含机械指标：${leversText}`
    );
  }
});

test("P5: ensemble 场景 qualityLevers 含角色功能分化或群体反应层次", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  const ensemble = plan.contracts.find((c) => c.sceneType === "ensemble");
  if (ensemble) {
    const leversText = ensemble.qualityLevers.join("\n");
    const hasEnsembleLever =
      leversText.includes("功能分化") ||
      leversText.includes("反应有层次") ||
      leversText.includes("背景板");
    assert.ok(
      hasEnsembleLever,
      `ensemble qualityLevers 应含角色功能分化/群体反应层次：${leversText}`
    );
  }
});

test("P5: cliffhanger 场景 qualityLevers 含信息增量或情绪余韵", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  const cliffhanger = plan.contracts.find((c) => c.sceneType === "cliffhanger");
  if (cliffhanger) {
    const leversText = cliffhanger.qualityLevers.join("\n");
    const hasCliffhangerLever =
      leversText.includes("信息增量") ||
      leversText.includes("情绪余韵") ||
      leversText.includes("信息悬念");
    assert.ok(
      hasCliffhangerLever,
      `cliffhanger qualityLevers 应含信息增量/情绪余韵：${leversText}`
    );
  }
});

test("P5: 所有场景 mustAvoid 含'为钩子牺牲主事件细节'禁令", () => {
  const result = compileCh17();
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: result.context,
    library: lib,
    seed: result.sourceSeed,
  });

  for (const contract of plan.contracts) {
    const avoidText = contract.mustAvoid.join("\n");
    assert.ok(
      avoidText.includes("为钩子牺牲"),
      `${contract.sceneId} mustAvoid 应含'为钩子牺牲主事件细节'禁令：${avoidText}`
    );
  }
});
