/**
 * RECOVERY-STATE-MACHINE tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRecoveryStateMachine,
  assertTransition,
} from "../dist/v2/core/recovery-state-machine.js";
import { canTransition as canT } from "../dist/v2/core/recovery-types.js";

test("合法转换：running -> retryable_failure -> retrying -> running", () => {
  const sm = createRecoveryStateMachine("running");
  assert.equal(sm.transition("retryable_failure").ok, true);
  assert.equal(sm.transition("retrying").ok, true);
  assert.equal(sm.transition("running").ok, true);
});

test("非法转换：checkpoint 不得直接 committed", () => {
  const sm = createRecoveryStateMachine("checkpoint");
  const r = sm.transition("committed");
  assert.equal(r.ok, false);
  assert.equal(sm.state, "checkpoint");
});

test("非法转换：blocked 是终端", () => {
  const sm = createRecoveryStateMachine("blocked");
  assert.equal(sm.transition("running").ok, false);
  assert.equal(sm.transition("committed").ok, false);
});

test("resume 仅允许从 checkpoint", () => {
  const sm = createRecoveryStateMachine("running");
  assert.equal(sm.resume().ok, false);
  sm.transition("retryable_failure");
  sm.transition("checkpoint");
  assert.equal(sm.resume("explicit").ok, true);
  assert.equal(sm.state, "running");
});

test("interrupted -> checkpoint 合法", () => {
  const sm = createRecoveryStateMachine("running");
  assert.equal(sm.transition("interrupted").ok, true);
  assert.equal(sm.transition("checkpoint").ok, true);
});

test("assertTransition 非法抛错", () => {
  assert.throws(() => assertTransition("committed", "running"));
});

test("canTransition 表一致性", () => {
  assert.equal(canT("commit_pending", "committed"), true);
  assert.equal(canT("commit_pending", "blocked"), true);
  assert.equal(canT("running", "committed"), false);
});
