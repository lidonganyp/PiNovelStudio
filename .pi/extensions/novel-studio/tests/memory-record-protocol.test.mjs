/**
 * MEMORY-2 统一记忆协议与权威体系测试
 *
 * 验收口径（任务文档 §五/§七/§十二）：
 * - 非法枚举被拒绝
 * - 缺少来源的正式记忆写入被拒绝
 * - 结构化事实不能只保存自由文本摘要
 * - model_planned 永远不能自动转为 confirmed
 * - diagnostic_hypothesis / model_planned 不得作为正式事实证据
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateMemoryRecord,
  canPromoteEpistemicStatus,
  isFormalFactEvidence,
} from "../dist-test/v2/core/memory/memory-record.js";

/**
 * 测试用 MemoryRecord 结构（.mjs 无类型系统，仅作形状参考）。
 * 生产类型定义见 v2/core/memory/memory-record.ts。
 */
function makeRecord(overrides = {}) {
  return {
    memoryId: "canon:world:genre",
    memoryType: "canon",
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: 3,
    sourceRef: ["ch3#finalText:abc123def456:10-20"],
    textHash: ["abc123def456"],
    sourceRunId: "run-ch3",
    sourceFinalTextHash: "abc123def456",
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    confidence: 0.8,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: {
      memoryType: "canon",
      data: { value: "仙侠世界", category: "genre", key: "canon:world:genre" },
    },
    ...overrides,
  };
}

test("MEMORY-2: 合法正式记忆通过校验", () => {
  const r = validateMemoryRecord(makeRecord());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("MEMORY-2: 非法 authorityClass 枚举被拒绝", () => {
  const r = validateMemoryRecord(makeRecord({ authorityClass: "invalid_auth" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("authorityClass 非法")));
});

test("MEMORY-2: 非法 epistemicStatus 枚举被拒绝", () => {
  const r = validateMemoryRecord(makeRecord({ epistemicStatus: "invalid" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("epistemicStatus 非法")));
});

test("MEMORY-2: 正式记忆缺少 sourceChapter 被拒绝", () => {
  const r = validateMemoryRecord(makeRecord({ sourceChapter: null }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("必须有 sourceChapter")));
});

test("MEMORY-2: 正式记忆缺少 sourceRef 被拒绝", () => {
  const r = validateMemoryRecord(makeRecord({ sourceRef: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("必须有 sourceRef")));
});

test("MEMORY-2: 正式记忆缺少 textHash 被拒绝", () => {
  const r = validateMemoryRecord(
    makeRecord({ sourceFinalTextHash: null, textHash: [] })
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("必须绑定最终正文 textHash")));
});

test("MEMORY-2: 正式记忆使用 model_planned 权威被拒绝", () => {
  const r = validateMemoryRecord(makeRecord({ authorityClass: "model_planned" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("正式事实只允许")));
});

test("MEMORY-2: 结构化事实不能只保存自由文本摘要（缺 category/key）", () => {
  const r = validateMemoryRecord(
    makeRecord({
      payload: {
        memoryType: "canon",
        data: { value: "自由文本", category: "", key: "" },
      },
    })
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("不能只保存自由文本摘要")));
});

test("MEMORY-2: diagnostic 必须带 TTL", () => {
  const r = validateMemoryRecord(
    makeRecord({
      memoryType: "diagnostic",
      authorityClass: "diagnostic_hypothesis",
      epistemicStatus: "hypothesis",
      payload: {
        memoryType: "diagnostic",
        data: { kind: "risk", detail: "x", ttlSeconds: 0 },
      },
    })
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("正的 ttlSeconds")));
});

test("MEMORY-2: model_planned 永远不能自动转为 confirmed", () => {
  const r = canPromoteEpistemicStatus("planned", "model_planned", "confirmed");
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("model_planned"));
});

test("MEMORY-2: diagnostic_hypothesis 不得进入正式事实", () => {
  const r = canPromoteEpistemicStatus("hypothesis", "diagnostic_hypothesis", "confirmed");
  assert.equal(r.allowed, false);
});

test("MEMORY-2: system_derived 无证据不能晋升为 confirmed", () => {
  const r = canPromoteEpistemicStatus("derived", "system_derived", "confirmed");
  assert.equal(r.allowed, false);
});

test("MEMORY-2: final_text_explicit + confirmed 可晋升", () => {
  const r = canPromoteEpistemicStatus("derived", "final_text_explicit", "confirmed");
  assert.equal(r.allowed, true);
});

test("MEMORY-2: planned/hypothesis 默认不可作为事实证据", () => {
  assert.equal(isFormalFactEvidence(makeRecord({ epistemicStatus: "planned" })).usable, false);
  assert.equal(isFormalFactEvidence(makeRecord({ epistemicStatus: "hypothesis" })).usable, false);
  assert.equal(isFormalFactEvidence(makeRecord({ authorityClass: "model_planned" })).usable, false);
});

test("MEMORY-2: plan/diagnostic 类型不可作为正式事实", () => {
  assert.equal(
    isFormalFactEvidence(makeRecord({ memoryType: "plan", authorityClass: "model_planned" })).usable,
    false
  );
});

test("MEMORY-2: 已过期记忆不作为事实证据", () => {
  assert.equal(
    isFormalFactEvidence(makeRecord({ lifecycleStatus: "expired" })).usable,
    false
  );
});

test("MEMORY-2: 正式事实可被检索", () => {
  assert.equal(isFormalFactEvidence(makeRecord()).usable, true);
});
