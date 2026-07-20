/**
 * FactGuard regression for quoted UI text recalled later in the same chapter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";

const BASE_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
  constitution: null,
  longTermState: null,
};

function runDuplicateScan(text) {
  const report = createFactContinuityGuard().check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames: ["林觉"],
    identityContract: null,
    ontologyContract: null,
  });
  return {
    diagnostics: report.allDiagnostics.filter((diagnostic) => diagnostic.source === "duplicate_scan"),
    exemptions: report.quoteExemptions ?? [],
  };
}

test("quoted permission dialog recalled after reviewing desk evidence is not duplicate pollution", () => {
  const text = [
    "验证失败。红色弹窗跳出来，字体比正常提示大了两号：**\"权限不足。该档案需L级及以上账户访问。\"**",
    "林觉关掉弹窗，继续调查系统日志。中间发生了很长一段调查、对话和行动。",
    "他低头看着桌上的东西：尸检报告、草稿纸、折叠纸条，以及工作站屏幕上那条刺眼的红色弹窗——**\"权限不足。该档案需L级及以上账户访问。\"**",
    "他关掉弹窗，重新打开系统日志。",
  ].join("\n\n");

  const { diagnostics, exemptions } = runDuplicateScan(text);

  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  assert.ok(exemptions.length >= 1, "expected an audited quoted-note recall exemption");
  assert.ok(exemptions.every((exemption) => exemption.quoteBlockKind === "quoted_note"));
});

test("independent identical quoted lines without recall context remain blocked", () => {
  const repeated = "权限不足。该档案需L级及以上账户访问。";
  const text = `系统甲显示：\"${repeated}\"。\n\n系统乙显示：\"${repeated}\"。`;

  const { diagnostics } = runDuplicateScan(text);

  assert.ok(diagnostics.length >= 1, "unrelated duplicate quoted UI text must remain blocked");
  assert.equal(diagnostics[0].severity, "hard");
});
