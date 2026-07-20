/**
 * USER-PREFERENCE-CONSUMPTION-1 测试（RED）
 *
 * 验收口径（来自任务清单 D:\CODE\PiNovelStudio\delete\任务列表\项目优化20260718.md P1-3）：
 *
 * 不要把现有 50 条规则全部塞入 prompt。
 *
 * 实现要求：
 * - 按场景、角色、问题类型检索相关规则。
 * - 每次最多注入 3–5 条。
 * - 区分：用户硬偏好 / 已接受修订规律 / 尚未验证的工艺建议
 * - trace 记录 loaded、selected、consumed、dropped。
 * - 未验证建议只能用于 editorial diagnosis，不能硬控 raw。
 *
 * 本测试验证：
 * 1. retrievePreferenceRules 按 sceneType/character/problemType 检索
 * 2. 最多返回 maxCount 条（默认 5）
 * 3. 区分 3 类 type（hard_preference / accepted_revision / unverified_craft）
 * 4. consumeForRaw 不返回 unverified_craft（未验证建议不硬控 raw）
 * 5. consumeForEditorial 返回全部 3 类
 * 6. PreferenceRuleSelection 含 loaded/selected/consumed/dropped 完整 trace 字段
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  retrievePreferenceRules,
  consumeForRaw,
  consumeForEditorial,
} from "../dist-test/v2/core/preference-rule-retriever.js";

// ── 测试用规则集（模拟 50 条规则的子集）──────────────────────────────────

function buildSampleRules() {
  return [
    // 用户硬偏好（hard_preference）
    {
      id: "pref-1",
      type: "hard_preference",
      content: "对白占比不超过 40%",
      sceneTypes: ["dialogue"],
      characters: [],
      problemTypes: ["dialogue_ratio"],
    },
    {
      id: "pref-2",
      type: "hard_preference",
      content: "禁止使用'不仅...而且...'翻译腔句式",
      sceneTypes: [],
      characters: [],
      problemTypes: ["translation_tone"],
    },
    // 已接受修订规律（accepted_revision）
    {
      id: "rev-1",
      type: "accepted_revision",
      content: "林轩战斗场景应突出剑势细节",
      sceneTypes: ["combat"],
      characters: ["林轩"],
      problemTypes: [],
    },
    {
      id: "rev-2",
      type: "accepted_revision",
      content: "黑衣人对话应保持神秘感",
      sceneTypes: ["dialogue"],
      characters: ["黑衣人"],
      problemTypes: [],
    },
    // 尚未验证的工艺建议（unverified_craft）
    {
      id: "craft-1",
      type: "unverified_craft",
      content: "尝试用短句叠加构建紧张感",
      sceneTypes: ["combat", "tension"],
      characters: [],
      problemTypes: ["pacing"],
    },
    {
      id: "craft-2",
      type: "unverified_craft",
      content: "环境描写可参考电影镜头切换",
      sceneTypes: ["transition"],
      characters: [],
      problemTypes: ["imagery"],
    },
  ];
}

// ============================================================================
// 1. retrievePreferenceRules — 按场景/角色/问题类型检索
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · 按 sceneType 检索相关规则", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat"],
    characters: [],
    problemTypes: [],
    maxCount: 5,
  });
  // 应选中 combat 场景相关规则：rev-1（sceneTypes 含 combat）+ craft-1（sceneTypes 含 combat）
  const ids = selection.selected.map((r) => r.id);
  assert.ok(
    ids.includes("rev-1") && ids.includes("craft-1"),
    `combat 检索应含 rev-1 + craft-1，实际: ${JSON.stringify(ids)}`,
  );
});

test("USER-PREFERENCE-CONSUMPTION-1 · 按 character 检索相关规则", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: [],
    characters: ["林轩"],
    problemTypes: [],
    maxCount: 5,
  });
  const ids = selection.selected.map((r) => r.id);
  assert.ok(
    ids.includes("rev-1"),
    `林轩检索应含 rev-1，实际: ${JSON.stringify(ids)}`,
  );
});

test("USER-PREFERENCE-CONSUMPTION-1 · 按 problemType 检索相关规则", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: [],
    characters: [],
    problemTypes: ["dialogue_ratio"],
    maxCount: 5,
  });
  const ids = selection.selected.map((r) => r.id);
  assert.ok(
    ids.includes("pref-1"),
    `dialogue_ratio 检索应含 pref-1，实际: ${JSON.stringify(ids)}`,
  );
});

// ============================================================================
// 2. 最多返回 maxCount 条
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · 最多返回 maxCount 条（默认 5）", () => {
  const rules = buildSampleRules();
  // 全匹配：sceneTypes/characters/problemTypes 都为空 → 应返回全部，但被 maxCount 截断
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: [],
    characters: [],
    problemTypes: [],
    maxCount: 3,
  });
  assert.ok(
    selection.selected.length <= 3,
    `selected 长度应 <= maxCount=3，实际: ${selection.selected.length}`,
  );
});

test("USER-PREFERENCE-CONSUMPTION-1 · 默认 maxCount=5", () => {
  const rules = buildSampleRules();
  // 不传 maxCount，默认 5
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: [],
    characters: [],
    problemTypes: [],
  });
  assert.ok(
    selection.selected.length <= 5,
    `默认 maxCount=5，selected 长度应 <= 5，实际: ${selection.selected.length}`,
  );
});

// ============================================================================
// 3. 区分 3 类 type
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · 区分 3 类 type（hard_preference/accepted_revision/unverified_craft）", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat", "dialogue", "transition", "tension"],
    characters: ["林轩", "黑衣人"],
    problemTypes: ["dialogue_ratio", "translation_tone", "pacing", "imagery"],
    maxCount: 5,
  });
  const types = new Set(selection.selected.map((r) => r.type));
  assert.ok(
    types.has("hard_preference"),
    `应含 hard_preference，实际: ${[...types].join(", ")}`,
  );
  assert.ok(
    types.has("accepted_revision"),
    `应含 accepted_revision，实际: ${[...types].join(", ")}`,
  );
  assert.ok(
    types.has("unverified_craft"),
    `应含 unverified_craft，实际: ${[...types].join(", ")}`,
  );
});

// ============================================================================
// 4. consumeForRaw — 不返回 unverified_craft
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · consumeForRaw 不返回 unverified_craft（未验证建议不硬控 raw）", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat", "dialogue"],
    characters: ["林轩"],
    problemTypes: [],
    maxCount: 5,
  });
  const rawConsumed = consumeForRaw(selection);
  // raw 只应含 hard_preference + accepted_revision
  const types = new Set(rawConsumed.consumed.map((r) => r.type));
  assert.ok(
    !types.has("unverified_craft"),
    `raw 不应含 unverified_craft，实际: ${[...types].join(", ")}`,
  );
  assert.ok(
    types.has("hard_preference") || types.has("accepted_revision"),
    `raw 应至少含 hard_preference 或 accepted_revision 之一，实际: ${[...types].join(", ")}`,
  );
});

// ============================================================================
// 5. consumeForEditorial — 返回全部 3 类
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · consumeForEditorial 返回全部 3 类（含 unverified_craft 用于 diagnosis）", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat", "dialogue", "transition"],
    characters: ["林轩", "黑衣人"],
    problemTypes: ["dialogue_ratio", "pacing", "imagery"],
    maxCount: 5,
  });
  const editorialConsumed = consumeForEditorial(selection);
  const types = new Set(editorialConsumed.consumed.map((r) => r.type));
  // editorial 应可含全部 3 类（如果 selection 含）
  assert.ok(
    types.has("unverified_craft"),
    `editorial 应可含 unverified_craft（diagnosis 用），实际: ${[...types].join(", ")}`,
  );
});

// ============================================================================
// 6. PreferenceRuleSelection — trace 字段 loaded/selected/consumed/dropped
// ============================================================================

test("USER-PREFERENCE-CONSUMPTION-1 · selection 含 loaded/selected/dropped trace 字段", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat"],
    characters: [],
    problemTypes: [],
    maxCount: 5,
  });
  assert.ok(
    Array.isArray(selection.loaded) && selection.loaded.length === rules.length,
    `loaded 应含全部 ${rules.length} 条规则，实际: ${JSON.stringify(selection.loaded?.length)}`,
  );
  assert.ok(
    Array.isArray(selection.selected) && selection.selected.length > 0,
    `selected 应为非空数组，实际: ${JSON.stringify(selection.selected?.length)}`,
  );
  assert.ok(
    Array.isArray(selection.dropped),
    `dropped 应为数组，实际: ${JSON.stringify(selection.dropped)}`,
  );
  // dropped + selected = loaded
  assert.ok(
    selection.dropped.length + selection.selected.length === selection.loaded.length,
    `dropped(${selection.dropped.length}) + selected(${selection.selected.length}) 应等于 loaded(${selection.loaded.length})`,
  );
});

test("USER-PREFERENCE-CONSUMPTION-1 · consumeForRaw 返回 consumed + dropped（被 raw 拒绝的规则）", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat"],
    characters: [],
    problemTypes: [],
    maxCount: 5,
  });
  const rawResult = consumeForRaw(selection);
  assert.ok(
    Array.isArray(rawResult.consumed),
    `consumed 应为数组，实际: ${JSON.stringify(rawResult.consumed)}`,
  );
  assert.ok(
    Array.isArray(rawResult.dropped),
    `dropped 应为数组（含被 raw 拒绝的 unverified_craft），实际: ${JSON.stringify(rawResult.dropped)}`,
  );
  // dropped 中应含 unverified_craft（如果有）
  const droppedTypes = new Set(rawResult.dropped.map((r) => r.type));
  assert.ok(
    droppedTypes.has("unverified_craft"),
    `raw dropped 应含 unverified_craft，实际: ${[...droppedTypes].join(", ")}`,
  );
});

test("USER-PREFERENCE-CONSUMPTION-1 · consumeForEditorial 返回 consumed + dropped（被 editorial 拒绝的规则）", () => {
  const rules = buildSampleRules();
  const selection = retrievePreferenceRules({
    rules,
    sceneTypes: ["combat"],
    characters: [],
    problemTypes: [],
    maxCount: 5,
  });
  const editorialResult = consumeForEditorial(selection);
  assert.ok(
    Array.isArray(editorialResult.consumed),
    `consumed 应为数组，实际: ${JSON.stringify(editorialResult.consumed)}`,
  );
  assert.ok(
    Array.isArray(editorialResult.dropped),
    `dropped 应为数组，实际: ${JSON.stringify(editorialResult.dropped)}`,
  );
  // editorial 接受全部 3 类，dropped 应为空（或仅含超出 maxCount 的）
  // 但 selection.selected 可能被 maxCount 截断，超出部分在 selection.dropped
  // editorial consumed 应等于 selection.selected
  assert.ok(
    editorialResult.consumed.length === selection.selected.length,
    `editorial consumed(${editorialResult.consumed.length}) 应等于 selection.selected(${selection.selected.length})`,
  );
});
