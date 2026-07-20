/**
 * Replay benchmark and author-learning regression tests.
 *
 * These checks keep external blind evaluation and validated craft-rule
 * admission wired into the existing PiNovelStudio chapter pipeline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(extensionRoot, "../../..");

function makeTempRoot(prefix) {
  const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function runPython(scriptPath, args, cwd = projectRoot) {
  const result = spawnSync("python", [scriptPath, ...args], {
    cwd,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, `${scriptPath} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function runPythonRaw(scriptPath, args, cwd = projectRoot) {
  return spawnSync("python", [scriptPath, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

describe("replay benchmark and learning pipeline", () => {
  it("rejects replay candidates without novel_generate_chapter proof", () => {
    const root = makeTempRoot("pns-replay-unproven");
    const referencePath = join(root, "reference.txt");
    const candidatePath = join(root, "candidate.txt");
    const metadataPath = join(root, "metadata.json");
    const outputPath = join(root, "bench", "unproven.json");

    writeFileSync(referencePath, "The ledger stayed locked in the rain.", "utf-8");
    writeFileSync(candidatePath, "The ledger opened and changed the debtor's choice.", "utf-8");
    writeJson(metadataPath, {
      chapterId: "manual-candidate",
      candidateRules: [
        {
          id: "manual-rule",
          sceneType: "daily",
          craftMove: "Use a concrete object to force a visible choice.",
        },
      ],
    });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    const result = runPythonRaw(replayScript, [
      "--reference", referencePath,
      "--candidate", candidatePath,
      "--metadata", metadataPath,
      "--output", outputPath,
    ]);

    assert.notEqual(result.status, 0, "replay should fail without orchestrator proof");
    assert.match(`${result.stdout}\n${result.stderr}`, /novel_generate_chapter/);
    assert.equal(existsSync(outputPath), false);
  });

  it("rejects replay candidates whose referenced generation result is not successful", () => {
    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");

    for (const fieldPlacement of ["candidate", "metadata"]) {
      const root = makeTempRoot(`pns-replay-failed-generation-${fieldPlacement}`);
      const referencePath = join(root, "reference.txt");
      const candidatePath = join(root, "candidate.txt");
      const resultPath = join(root, "workspace", "chapters", "chapter-1", "generate-result.json");
      const metadataPath = join(root, "metadata.json");
      const outputPath = join(root, "bench", `${fieldPlacement}-failed-generation.json`);

      writeFileSync(referencePath, "The ledger stayed locked in the rain.", "utf-8");
      writeFileSync(candidatePath, "The ledger opened and changed the debtor's choice.", "utf-8");
      writeJson(resultPath, {
        status: "error",
        stage: "2-narrator",
        message: "Stage 2 gate blocked the event.",
      });
      writeJson(metadataPath, {
        chapterId: `${fieldPlacement}-failed-generation`,
        generatedBy: "novel_generate_chapter",
        ...(fieldPlacement === "candidate"
          ? { candidate: { resultPath } }
          : { resultPath }),
      });

      const result = runPythonRaw(replayScript, [
        "--reference", referencePath,
        "--candidate", candidatePath,
        "--metadata", metadataPath,
        "--output", outputPath,
      ]);

      assert.notEqual(result.status, 0, `replay should fail for ${fieldPlacement} failed generation result`);
      assert.match(`${result.stdout}\n${result.stderr}`, /successful/);
      assert.equal(existsSync(outputPath), false);
    }
  });

  it("rejects replay candidates whose referenced quality trace is incomplete", () => {
    const root = makeTempRoot("pns-replay-incomplete-trace");
    const referencePath = join(root, "reference.txt");
    const candidatePath = join(root, "candidate.txt");
    const tracePath = join(root, "workspace", "traces", "chapter-1-quality-trace.json");
    const metadataPath = join(root, "metadata.json");
    const outputPath = join(root, "bench", "incomplete-trace.json");

    writeFileSync(referencePath, "The ledger stayed locked in the rain.", "utf-8");
    writeFileSync(candidatePath, "The ledger opened and changed the debtor's choice.", "utf-8");
    writeJson(tracePath, {
      schemaVersion: 1,
      workspaceId: "demo",
      chapterId: "chapter-1",
      events: [],
      patches: [],
      gates: [],
    });
    writeJson(metadataPath, {
      chapterId: "incomplete-trace",
      generatedBy: "novel_generate_chapter",
      candidate: {
        tracePath,
      },
    });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    const result = runPythonRaw(replayScript, [
      "--reference", referencePath,
      "--candidate", candidatePath,
      "--metadata", metadataPath,
      "--output", outputPath,
    ]);

    assert.notEqual(result.status, 0, "replay should fail when explicit quality trace proof is incomplete");
    assert.match(`${result.stdout}\n${result.stderr}`, /quality trace|trace/i);
    assert.equal(existsSync(outputPath), false);
  });

  it("refuses to promote benchmark files without novel_generate_chapter proof", () => {
    const root = makeTempRoot("pns-promote-unproven");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");

    writeJson(join(benchmarkDir, "manual.json"), {
      schemaVersion: 1,
      benchmarkId: "manual",
      candidateWins: true,
      scores: {
        reference: 42,
        candidate: 58,
        delta: 16,
      },
      metadata: {
        chapterId: "manual",
      },
      candidateRules: [
        {
          id: "manual-rule",
          sceneType: "daily",
          craftMove: "Use a concrete object to force a visible choice.",
        },
      ],
    });

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    const result = runPythonRaw(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
    ]);

    assert.notEqual(result.status, 0, "promotion should fail without orchestrator proof");
    assert.match(`${result.stdout}\n${result.stderr}`, /novel_generate_chapter/);
    assert.equal(existsSync(join(runtimeDir, "candidate-rules.json")), false);
    assert.equal(existsSync(join(runtimeDir, "validated-craft-rules.json")), false);
  });

  it("refuses to promote replay benchmarks whose referenced generation result failed", () => {
    const root = makeTempRoot("pns-promote-failed-generation");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const resultPath = join(root, "workspace", "chapters", "chapter-1", "generate-result.json");

    writeJson(resultPath, {
      status: "error",
      stage: "2-narrator",
      message: "Segment craft gate blocked the chapter.",
    });
    writeJson(join(benchmarkDir, "failed-generation.json"), {
      schemaVersion: 1,
      benchmarkId: "failed-generation",
      candidateWins: true,
      scores: {
        reference: 42,
        candidate: 58,
        delta: 16,
      },
      metadata: {
        chapterId: "failed-generation",
        generatedBy: "novel_generate_chapter",
        candidate: {
          resultPath,
        },
      },
      candidateRules: [
        {
          id: "failed-generation-rule",
          sceneType: "daily",
          craftMove: "Use a concrete object to force a visible choice.",
        },
      ],
    });

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    const result = runPythonRaw(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
    ]);

    assert.notEqual(result.status, 0, "promotion should fail when generation result failed");
    assert.match(`${result.stdout}\n${result.stderr}`, /successful/);
    assert.equal(existsSync(join(runtimeDir, "candidate-rules.json")), false);
    assert.equal(existsSync(join(runtimeDir, "validated-craft-rules.json")), false);
  });

  it("refuses failed generation proof even when resultPath is relative to the benchmark file", () => {
    const root = makeTempRoot("pns-promote-relative-failed-generation");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const relativeResultPath = "../workspace/chapters/chapter-1/generate-result.json";

    writeJson(join(root, "workspace", "chapters", "chapter-1", "generate-result.json"), {
      status: "blocked",
      stage: "8-scene-continuity",
      message: "location_jump_without_transition",
    });
    writeJson(join(benchmarkDir, "relative-failed-generation.json"), {
      schemaVersion: 1,
      benchmarkId: "relative-failed-generation",
      candidateWins: true,
      scores: {
        reference: 42,
        candidate: 58,
        delta: 16,
      },
      metadata: {
        chapterId: "relative-failed-generation",
        generatedBy: "novel_generate_chapter",
        candidate: {
          resultPath: relativeResultPath,
        },
      },
      candidateRules: [
        {
          id: "relative-failed-generation-rule",
          sceneType: "daily",
          craftMove: "Use a concrete object to force a visible choice.",
        },
      ],
    });

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    const result = runPythonRaw(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
    ]);

    assert.notEqual(result.status, 0, "promotion should fail when relative generation result failed");
    assert.match(`${result.stdout}\n${result.stderr}`, /successful/);
    assert.equal(existsSync(join(runtimeDir, "candidate-rules.json")), false);
    assert.equal(existsSync(join(runtimeDir, "validated-craft-rules.json")), false);
  });

  it("fails closed without replay benchmark evidence and preserves existing runtime rules", () => {
    const root = makeTempRoot("pns-promote-no-benchmark-evidence");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const candidateRulesPath = join(runtimeDir, "candidate-rules.json");
    const validatedRulesPath = join(runtimeDir, "validated-craft-rules.json");
    const existingCandidateRules = {
      schemaVersion: 1,
      generatedAt: "existing-candidate",
      entries: [
        {
          id: "keep-candidate-rule",
          sceneType: "horror",
          craftMove: "Keep this unpromoted candidate evidence intact.",
          mustDo: ["Do not overwrite candidate evidence without replay benchmarks."],
          avoid: [],
          evidence: {
            source: "replay_benchmark",
            sampleSize: 2,
            wins: 1,
            losses: 1,
            winRate: 0.5,
            benchmarkIds: ["old-1", "old-2"],
          },
        },
      ],
    };
    const existingValidatedRules = {
      schemaVersion: 1,
      generatedAt: "existing-validated",
      entries: [
        {
          id: "keep-validated-rule",
          sceneType: "horror",
          craftMove: "Keep this validated evidence intact.",
          mustDo: ["Do not clear validated rules without usable replay evidence."],
          avoid: [],
          evidence: {
            source: "replay_benchmark",
            sampleSize: 3,
            wins: 2,
            losses: 1,
            winRate: 0.6667,
            validatedWinRate: 0.6667,
            benchmarkIds: ["old-1", "old-2", "old-3"],
          },
        },
      ],
    };

    writeJson(candidateRulesPath, existingCandidateRules);
    writeJson(validatedRulesPath, existingValidatedRules);
    writeJson(join(benchmarkDir, "ch001-quality-report.skipped.json"), {
      schemaVersion: 1,
      status: "skipped",
      reason: "candidate text missing from novel_generate_chapter result",
      metadata: {
        generatedBy: "novel_generate_chapter",
      },
    });
    writeJson(join(benchmarkDir, "quality-evolution-audit.json"), {
      schemaVersion: 1,
      verdict: "fail",
      summary: {
        benchmarkFiles: 0,
      },
      checks: [],
    });

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    const result = runPythonRaw(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "3",
      "--min-win-rate", "0.55",
    ]);

    assert.notEqual(result.status, 0, "promotion should fail without replay benchmark-shaped evidence");
    assert.match(`${result.stdout}\n${result.stderr}`, /No replay benchmark/i);
    assert.deepEqual(JSON.parse(readFileSync(candidateRulesPath, "utf-8")), existingCandidateRules);
    assert.deepEqual(JSON.parse(readFileSync(validatedRulesPath, "utf-8")), existingValidatedRules);
  });

  it("ignores audit reports and unreadable JSON while promoting replay benchmarks", () => {
    const root = makeTempRoot("pns-promote-mixed-bench-dir");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");

    writeJson(join(benchmarkDir, "valid-replay.json"), {
      schemaVersion: 1,
      benchmarkId: "valid-replay",
      candidateWins: true,
      scores: {
        reference: 40,
        candidate: 70,
        delta: 30,
      },
      metadata: {
        chapterId: "chapter-1",
        generatedBy: "novel_generate_chapter",
      },
      candidateRules: [
        {
          id: "concrete-object-choice",
          sceneType: "daily",
          craftMove: "Force the choice through one concrete object.",
          mustDo: ["Tie the object to the changed decision."],
          avoid: ["Explain the decision in abstract emotion."],
        },
      ],
    });
    writeJson(join(benchmarkDir, "quality-evolution-audit.json"), {
      schemaVersion: 1,
      verdict: "fail",
      summary: {
        benchmarkFiles: 1,
      },
      checks: [],
    });
    writeFileSync(join(benchmarkDir, "bad-encoding.json"), Buffer.from([0xff, 0xfe, 0x7b, 0x00]));

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    runPython(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
    ]);

    const candidateRules = JSON.parse(readFileSync(join(runtimeDir, "candidate-rules.json"), "utf-8"));
    const validatedRules = JSON.parse(readFileSync(join(runtimeDir, "validated-craft-rules.json"), "utf-8"));
    assert.equal(candidateRules.entries.length, 1);
    assert.equal(validatedRules.entries.length, 1);
    assert.equal(candidateRules.entries[0].id, "concrete-object-choice");
    assert.equal(candidateRules.entries[0].evidence.sampleSize, 1);
  });

  it("deduplicates promoted rule evidence by benchmarkId before sample and win-rate accounting", () => {
    const root = makeTempRoot("pns-promote-duplicate-benchmark");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const duplicateRule = {
      id: "horror-visible-progression",
      sceneType: "horror",
      craftMove: "Force the scene to create a visible state delta.",
      mustDo: ["End the beat with a changed fact, risk, or choice."],
      avoid: ["Counting repeated atmosphere as progression."],
    };

    mkdirSync(benchmarkDir, { recursive: true });
    for (const filename of ["chapter-1-raw.json", "chapter-1-distilled.json"]) {
      writeJson(join(benchmarkDir, filename), {
        schemaVersion: 1,
        benchmarkId: "same-chapter-1",
        candidateWins: true,
        scores: {
          reference: 40,
          candidate: 70,
          delta: 30,
        },
        metadata: {
          chapterId: "same-chapter-1",
          generatedBy: "novel_generate_chapter",
        },
        candidateRules: [duplicateRule],
      });
    }

    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");
    runPython(learningScript, [
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--min-samples", "2",
      "--min-win-rate", "0.55",
    ]);

    const candidateRules = JSON.parse(readFileSync(join(runtimeDir, "candidate-rules.json"), "utf-8"));
    const validatedRules = JSON.parse(readFileSync(join(runtimeDir, "validated-craft-rules.json"), "utf-8"));
    assert.equal(candidateRules.entries.length, 1);
    assert.equal(candidateRules.entries[0].evidence.sampleSize, 1);
    assert.deepEqual(candidateRules.entries[0].evidence.benchmarkIds, ["same-chapter-1"]);
    assert.equal(validatedRules.entries.length, 0);
  });

  it("turns Chinese replay wins into selectable validated runtime rules", () => {
    const root = makeTempRoot("pns-replay-learning");
    const referencePath = join(root, "reference.txt");
    const candidateWinOnePath = join(root, "candidate-win-1.txt");
    const candidateWinTwoPath = join(root, "candidate-win-2.txt");
    const candidateLossPath = join(root, "candidate-loss.txt");
    const winOneMetadataPath = join(root, "metadata-win-1.json");
    const winTwoMetadataPath = join(root, "metadata-win-2.json");
    const lossMetadataPath = join(root, "metadata-loss.json");
    const winOneOut = join(root, "bench", "win-1.json");
    const winTwoOut = join(root, "bench", "win-2.json");
    const lossOut = join(root, "bench", "loss.json");
    const runtimeDir = join(root, "data", "runtime");

    writeFileSync(
      referencePath,
      [
        "雨夜旧巷里，沈岚和债主发生了争执。",
        "债主发现账册后，她感到非常紧张，因为这个情况十分危险。",
        "她必须想办法解决这个问题，让对方做出让步。",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidateWinOnePath,
      [
        "雨水从旧巷檐角砸下来，沈岚把账册压进袖口，纸页边缘蹭过腕骨。",
        "“你只还本金？”债主按住伞柄，伞尖抵住砖缝里的泥水，“那这一页是谁的名字？”",
        "沈岚没有退。她翻到账册折角，露出被雨泡软的红印：“你可以拿走原件，但明早之前，诊所门口会多一份副本。”",
        "债主的笑停住，手指从她腕骨上松开半寸：“本金减半，利息翻倍。”",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidateWinTwoPath,
      [
        "灯从旧巷尽头晃过来，账册的封皮被雨水泡出一道皱痕。",
        "沈岚把伞柄往债主手腕上一压：“副本在诊所门口，天亮前谁拿到，谁就能翻倍收利息。”",
        "债主盯着红印，指尖停在账册边缘，终于松开：“本金减半，今晚的事算我让一步。”",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidateLossPath,
      "沈岚感到非常紧张，因为债主十分危险。就在这时，气氛变得压抑起来。她必须想办法解决这个问题。",
      "utf-8"
    );
    const metadataBase = {
      generatedBy: "novel_generate_chapter",
      events: [
        {
          id: "E1",
          sceneType: "daily",
          contentPoints: ["雨夜旧巷", "账册", "债主让步", "副本"],
        },
      ],
      candidateRules: [
        {
          id: "daily-object-choice-cn",
          sceneType: "daily",
          appliesWhen: ["雨夜旧巷", "账册", "债主让步"],
          craftMove: "让日常道具逼出可见选择，不用抽象心理解释替代行动。",
          mustDo: ["把道具、对白和让步结果绑在同一处动作里"],
          avoid: ["先解释情绪，再概括局势"],
          microExample: "债主盯着红印，指尖从账册边缘松开。",
        },
      ],
    };
    writeJson(winOneMetadataPath, { ...metadataBase, chapterId: "chapter-cn-win-1" });
    writeJson(winTwoMetadataPath, { ...metadataBase, chapterId: "chapter-cn-win-2" });
    writeJson(lossMetadataPath, { ...metadataBase, chapterId: "chapter-cn-loss" });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    const learningScript = join(projectRoot, "scripts", "learning", "promote_validated_rules.py");

    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidateWinOnePath,
      "--metadata", winOneMetadataPath,
      "--output", winOneOut,
      "--min-delta", "0.01",
    ]);
    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidateWinTwoPath,
      "--metadata", winTwoMetadataPath,
      "--output", winTwoOut,
      "--min-delta", "0.01",
    ]);
    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidateLossPath,
      "--metadata", lossMetadataPath,
      "--output", lossOut,
      "--min-delta", "0.01",
    ]);

    const winJson = JSON.parse(readFileSync(winOneOut, "utf-8"));
    const winTwoJson = JSON.parse(readFileSync(winTwoOut, "utf-8"));
    const lossJson = JSON.parse(readFileSync(lossOut, "utf-8"));
    assert.equal(winJson.candidateWins, true);
    assert.equal(winTwoJson.candidateWins, true);
    assert.equal(lossJson.candidateWins, false);
    assert.ok(winJson.candidateRules.length > 0);

    runPython(learningScript, [
      "--benchmark-dir", join(root, "bench"),
      "--runtime-dir", runtimeDir,
      "--min-samples", "3",
      "--min-win-rate", "0.55",
    ]);

    const candidateRulesPath = join(runtimeDir, "candidate-rules.json");
    const validatedRulesPath = join(runtimeDir, "validated-craft-rules.json");
    assert.equal(existsSync(candidateRulesPath), true);
    assert.equal(existsSync(validatedRulesPath), true);

    const candidateRules = JSON.parse(readFileSync(candidateRulesPath, "utf-8"));
    const validatedRules = JSON.parse(readFileSync(validatedRulesPath, "utf-8"));

    assert.equal(candidateRules.entries.length, 1);
    assert.equal(candidateRules.entries[0].evidence.sampleSize, 3);
    assert.equal(candidateRules.entries[0].evidence.winRate, 0.6667);
    assert.equal(validatedRules.entries.length, 1);
    assert.equal(validatedRules.entries[0].evidence.validatedWinRate, 0.6667);
    assert.equal(validatedRules.entries[0].sceneType, "daily_life");
  });

  it("scores replay-sensitive deltas beyond old coverage and style metrics", () => {
    const root = makeTempRoot("pns-replay-sensitive-metrics");
    const referencePath = join(root, "reference.txt");
    const candidatePath = join(root, "candidate.txt");
    const metadataPath = join(root, "metadata.json");
    const outputPath = join(root, "bench", "replay-sensitive.json");

    writeFileSync(
      referencePath,
      [
        "The corridor felt oppressive and everyone was nervous.",
        "The danger seemed close, but nothing changed before the scene ended.",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidatePath,
      [
        "The nurse stopped at the locked cabinet, compared the tag number with last night's receipt, and marked the mismatch in red.",
        "\"If this number is real, we leave now,\" Lin said, choosing the back stairs instead of the lobby.",
        "The knocking moved from the far ward to the door beside them, and the final tag carried Lin's own phone number.",
      ].join("\n"),
      "utf-8"
    );
    writeJson(metadataPath, {
      chapterId: "replay-sensitive",
      generatedBy: "novel_generate_chapter",
      events: [
        {
          id: "E1",
          sceneType: "horror",
          contentPoints: ["locked cabinet", "tag number", "back stairs", "phone number"],
        },
      ],
      candidateRules: [
        {
          id: "horror-evidence-choice-hook",
          sceneType: "horror",
          craftMove: "Turn atmosphere into evidence, choice, risk proximity, and a causal hook.",
        },
      ],
    });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidatePath,
      "--metadata", metadataPath,
      "--output", outputPath,
      "--min-delta", "0.01",
    ]);

    const result = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(result.candidateWins, true);
    for (const key of [
      "progression",
      "evidenceDelta",
      "choiceDelta",
      "riskDelta",
      "hookMovement",
      "readerNeedToContinue",
    ]) {
      assert.equal(typeof result.candidateMetrics[key], "number", `${key} missing from candidate metrics`);
      assert.equal(typeof result.referenceMetrics[key], "number", `${key} missing from reference metrics`);
    }
    assert.ok(result.candidateMetrics.evidenceDelta > result.referenceMetrics.evidenceDelta);
    assert.ok(result.candidateMetrics.choiceDelta > result.referenceMetrics.choiceDelta);
    assert.ok(result.candidateMetrics.riskDelta > result.referenceMetrics.riskDelta);
    assert.ok(result.candidateMetrics.hookMovement > result.referenceMetrics.hookMovement);
    assert.ok(result.candidateMetrics.readerNeedToContinue > result.referenceMetrics.readerNeedToContinue);
  });

  it("does not let keyword-stuffed prose fake replay progression", () => {
    const root = makeTempRoot("pns-replay-keyword-stuffed-progression");
    const referencePath = join(root, "reference.txt");
    const candidatePath = join(root, "candidate.txt");
    const metadataPath = join(root, "metadata.json");
    const outputPath = join(root, "bench", "keyword-stuffed-progression.json");

    writeFileSync(
      referencePath,
      [
        "The nurse stopped at the locked cabinet, compared the tag number with last night's receipt, and marked the mismatch in red.",
        "\"If this number is real, we leave now,\" Lin said, choosing the back stairs instead of the lobby.",
        "The knocking moved from the far ward to the door beside them, and the final tag carried Lin's own phone number.",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidatePath,
      [
        "The choice was important, the back way mattered, the drawer stayed locked, and everything changed.",
        "He thought about the choice and the danger, then thought about going back because the lock had changed.",
        "The scene ended by saying the choice changed the situation, but no receipt, tag, number, or moving threat appeared.",
      ].join("\n"),
      "utf-8"
    );
    writeJson(metadataPath, {
      chapterId: "keyword-stuffed-progression",
      generatedBy: "novel_generate_chapter",
      events: [
        {
          id: "E1",
          sceneType: "horror",
          contentPoints: ["locked cabinet", "tag number", "back stairs", "phone number"],
        },
      ],
      candidateRules: [
        {
          id: "horror-keyword-stuffing",
          sceneType: "horror",
          craftMove: "Reject keyword-only progression without evidence-choice-risk-hook movement.",
        },
      ],
    });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidatePath,
      "--metadata", metadataPath,
      "--output", outputPath,
      "--min-delta", "0.01",
    ]);

    const result = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.ok(
      result.candidateMetrics.progression < 0.35,
      `keyword stuffing should not produce replay progression: ${result.candidateMetrics.progression}`
    );
    assert.equal(result.candidateWins, false);
  });

  it("caps replay progression when anchors lack causal evidence spans", () => {
    const root = makeTempRoot("pns-replay-anchor-only-progression");
    const referencePath = join(root, "reference.txt");
    const candidatePath = join(root, "candidate.txt");
    const metadataPath = join(root, "metadata.json");
    const outputPath = join(root, "bench", "anchor-only-progression.json");

    writeFileSync(
      referencePath,
      [
        "The nurse compared the receipt with the tag number and marked the mismatch in red.",
        "Lin chose the back stairs instead of the lobby, so the locked exit no longer trapped them in the same corridor.",
        "The knocking moved from the far ward to the door beside him, and the final tag carried Lin's own phone number.",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      candidatePath,
      [
        "He compared evidence and proof, then chose to turn back because the risk felt closer.",
        "The threat moved closer near the door, and a final number appeared like a message.",
        "Evidence, choice, risk, hook, final number, proof, door, clue, and message were all mentioned again.",
      ].join("\n"),
      "utf-8"
    );
    writeJson(metadataPath, {
      chapterId: "anchor-only-progression",
      generatedBy: "novel_generate_chapter",
      events: [
        {
          id: "E1",
          sceneType: "horror",
          contentPoints: ["receipt", "tag number", "back stairs", "own phone number"],
        },
      ],
      candidateRules: [
        {
          id: "horror-causal-span-progression",
          sceneType: "horror",
          craftMove: "Require progression anchors to carry evidence, consequence, proximity, and hook spans.",
        },
      ],
    });

    const replayScript = join(projectRoot, "scripts", "replay-benchmark", "run_replay_benchmark.py");
    runPython(replayScript, [
      "--reference", referencePath,
      "--candidate", candidatePath,
      "--metadata", metadataPath,
      "--output", outputPath,
      "--min-delta", "0.01",
    ]);

    const result = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.ok(
      result.candidateMetrics.progression < 0.35,
      `anchor-only progression should stay below the gate-aligned floor: ${result.candidateMetrics.progression}`
    );
    assert.equal(result.candidateWins, false);
  });

  it("distills replay metric deficits into candidate rules without copying reference prose", () => {
    const root = makeTempRoot("pns-author-rule-distill");
    const benchmarkDir = join(root, "benchmarks");
    const outputDir = join(root, "distilled");
    mkdirSync(benchmarkDir, { recursive: true });

    writeJson(join(benchmarkDir, "chapter-1.json"), {
      schemaVersion: 1,
      benchmarkId: "chapter-1",
      candidateWins: false,
      scores: {
        reference: 72,
        candidate: 45,
        delta: -27,
      },
      referenceMetrics: {
        progression: 0.8,
        evidenceDelta: 0.75,
        choiceDelta: 0.4,
        riskDelta: 0.7,
        hookMovement: 0.65,
        readerNeedToContinue: 0.72,
      },
      candidateMetrics: {
        progression: 0,
        evidenceDelta: 0.1,
        choiceDelta: 0.05,
        riskDelta: 0.15,
        hookMovement: 0.05,
        readerNeedToContinue: 0.1,
      },
      metadata: {
        chapterId: "chapter-1",
        generatedBy: "novel_generate_chapter",
        sourceBook: "shenmi-fusu",
        events: [
          {
            id: "E1",
            sceneType: "horror",
            narrativeBeat: "revelation",
            contentPoints: ["The exact reference sentence should not leak into a rule."],
          },
        ],
      },
      candidateRules: [],
    });

    const distillScript = join(projectRoot, "scripts", "learning", "distill_author_rules.py");
    runPython(distillScript, [
      "--benchmark-dir", benchmarkDir,
      "--output-dir", outputDir,
      "--min-gap", "0.2",
    ]);

    const enriched = JSON.parse(readFileSync(join(outputDir, "chapter-1.json"), "utf-8"));
    const summary = JSON.parse(readFileSync(join(outputDir, "distilled-author-rules.json"), "utf-8"));
    const ruleIds = enriched.candidateRules.map((rule) => rule.id);

    assert.ok(ruleIds.includes("replay-horror-progression"));
    assert.ok(ruleIds.includes("replay-horror-evidence-delta"));
    assert.ok(ruleIds.includes("replay-horror-hook-movement"));
    assert.equal(summary.totalBenchmarks, 1);
    assert.equal(summary.totalRules, enriched.candidateRules.length);
    assert.ok(enriched.candidateRules.every((rule) => rule.validationStatus === "candidate"));
    assert.ok(enriched.candidateRules.every((rule) => rule.sourceBook === "shenmi-fusu"));
    assert.match(enriched.candidateRules[0].mustDo.join(" "), /visible state change|verifiable information gain|ending hook/i);
    assert.doesNotMatch(
      JSON.stringify(enriched.candidateRules),
      /The exact reference sentence should not leak/
    );
  });

  it("distills GetDraft archive evidence into replay-gated candidate rules only", () => {
    const root = makeTempRoot("pns-getdraft-distill");
    const sourceDir = join(root, "docs", "archive", "getdraft");
    const runtimeDir = join(root, "data", "runtime");
    const outputPath = join(runtimeDir, "getdraft-candidate-rules.json");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, "GetDraft-dialogue.md"),
      [
        "# GetDraft dialogue notes",
        "Dialogue craft: each turn should change information, risk, decision, or relationship.",
        "DO_NOT_COPY_GETDRAFT_SOURCE_PHRASE",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(sourceDir, "GetDraft-hooks.md"),
      [
        "# GetDraft hook notes",
        "Ending hooks should be causal to chapter evidence, a visible choice, or a changed risk.",
      ].join("\n"),
      "utf-8"
    );
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const distillScript = join(projectRoot, "scripts", "learning", "distill_getdraft_candidates.py");
    runPython(distillScript, [
      "--source-dir", sourceDir,
      "--output", outputPath,
      "--axis", "dialogue_propulsion",
      "--axis", "hook_causality",
    ]);

    const distilled = JSON.parse(readFileSync(outputPath, "utf-8"));
    const validated = JSON.parse(readFileSync(join(runtimeDir, "validated-craft-rules.json"), "utf-8"));
    const ruleIds = distilled.entries.map((rule) => rule.id);
    const dialogueRule = distilled.entries.find((rule) => rule.id === "getdraft-dialogue-propulsion");

    assert.deepEqual(ruleIds, ["getdraft-dialogue-propulsion", "getdraft-hook-causality"]);
    assert.ok(distilled.entries.every((rule) => rule.validationStatus === "candidate"));
    assert.ok(distilled.entries.every((rule) => rule.distilledFrom.source === "getdraft_archive"));
    assert.ok(distilled.entries.every((rule) => rule.distilledFrom.requiresReplayPromotion === true));
    assert.ok(dialogueRule.appliesWhen.includes("axis:dialogue_propulsion"));
    assert.ok(dialogueRule.distilledFrom.documents.some((documentPath) => documentPath.endsWith("GetDraft-dialogue.md")));
    assert.equal(JSON.stringify(distilled).includes("validatedWinRate"), false);
    assert.doesNotMatch(JSON.stringify(distilled.entries), /DO_NOT_COPY_GETDRAFT_SOURCE_PHRASE/);
    assert.deepEqual(validated, {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
  });

  it("materializes GetDraft dialogue distillation as candidate-only rules and trace specs", () => {
    const root = makeTempRoot("pns-getdraft-dialogue-materialize");
    const inputDir = join(root, "dialogue-input");
    const runtimeDir = join(root, "data", "runtime");
    const outputDir = join(runtimeDir, "getdraft-dialogue");
    const rulesInput = join(inputDir, "candidate-rules.jsonl");
    const traceInput = join(inputDir, "trace-fields.jsonl");
    const validatedPath = join(runtimeDir, "validated-craft-rules.json");
    const expectedRuleIds = ["DP-001", "DP-002", "LC-001", "LC-002", "HC-001", "HC-002", "AA-001", "AA-002"];
    const traceRulesByField = new Map([
      ["transition_evidence", ["LC-001"]],
      ["entry_evidence", ["LC-002"]],
      ["hook_evidence_chain", ["HC-001"]],
      ["hook_movement", ["HC-002"]],
      ["span_problem_list", ["AA-001", "AA-002"]],
      ["information_core", ["AA-002"]],
      ["patch_accepted_rate", ["AA-001", "AA-002"]],
      ["rollback_count", ["AA-001", "AA-002"]],
    ]);
    const axesByPrefix = {
      DP: "dialogue_propulsion",
      LC: "location_continuity",
      HC: "hook_causality",
      AA: "anti_ai_span_repair",
    };

    mkdirSync(inputDir, { recursive: true });
    writeFileSync(
      rulesInput,
      [
        "Aqiang:",
        ...expectedRuleIds.map((id) => {
          const prefix = id.slice(0, 2);
          return JSON.stringify({
            id,
            axis: axesByPrefix[prefix],
            priority: id.endsWith("001") ? "P0" : "P1",
            validation_status: "candidate",
            source: "getdraft_dialogue",
            observation_mode: prefix === "AA",
            patch_unit: prefix === "HC" ? "chapter_end" : prefix === "DP" ? "event" : "span",
            trigger_predicate: `${id} predicate`,
            required_trace_fields: ["causal_chain", "style_match_score"],
            suggested_new_trace_fields: [],
            repair_actions: ["repair only the failing local unit"],
            acceptance_criteria: { must_improve: ["target metric improves"], must_not_regress: ["style_match_score"] },
            rollback_criteria: ["regression detected"],
            replay_metrics: ["style_match_score"],
            fixture_coverage: ["sample A", "sample B", "sample C"],
            promotion_gate: {
              sample_size_at_least: 3,
              validated_win_rate_at_least: 0.55,
              requires_replay_promotion: true,
            },
            non_promotion_reasons: ["sample_size < 3"],
            runtime_default_enabled: false,
          });
        }),
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      traceInput,
      Array.from(traceRulesByField.entries())
        .map(([fieldName, appliesToRules]) =>
          JSON.stringify({
            field_name: fieldName,
            applies_to_rules: appliesToRules,
            detection_scope: "event_boundary",
            value_type: fieldName.endsWith("_count") ? "integer" : fieldName.endsWith("_rate") ? "float" : "boolean",
            observation_metric: ["patch_accepted_rate", "rollback_count"].includes(fieldName),
            positive_condition: "positive condition",
            negative_condition: "negative condition",
            extraction_inputs: ["trace"],
            false_positive_risks: ["false positive"],
            false_negative_risks: ["false negative"],
            replay_fixture_minimum: ["positive examples", "negative examples"],
            should_block_runtime_if_missing: false,
            should_block_patch_if_missing: ["hook_evidence_chain", "span_problem_list"].includes(fieldName),
            fallback_when_missing: "completed_with_review",
          })
            .replaceAll('"', "“")
            .replaceAll(":", "：")
            .replaceAll(",", "，")
        )
        .join("\n"),
      "utf-8"
    );
    writeJson(validatedPath, {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const materializeScript = join(projectRoot, "scripts", "learning", "materialize_getdraft_dialogue_candidates.py");
    runPython(materializeScript, [
      "--rules-input", rulesInput,
      "--trace-fields-input", traceInput,
      "--output-dir", outputDir,
    ]);

    const rules = JSON.parse(readFileSync(join(outputDir, "getdraft-dialogue-candidate-rules.json"), "utf-8"));
    const traceFields = JSON.parse(readFileSync(join(outputDir, "getdraft-dialogue-trace-fields.json"), "utf-8"));
    const validated = JSON.parse(readFileSync(validatedPath, "utf-8"));

    assert.deepEqual(rules.entries.map((rule) => rule.id), expectedRuleIds);
    assert.equal(rules.source, "getdraft_dialogue");
    assert.equal(rules.validationStatus, "candidate");
    assert.equal(rules.runtimeDefaultEnabled, false);
    assert.ok(rules.entries.every((rule) => rule.validation_status === "candidate"));
    assert.ok(rules.entries.every((rule) => rule.source === "getdraft_dialogue"));
    assert.ok(rules.entries.every((rule) => rule.runtime_default_enabled === false));
    assert.ok(rules.entries.every((rule) => rule.promotion_gate.sample_size_at_least >= 3));
    assert.ok(rules.entries.every((rule) => rule.promotion_gate.validated_win_rate_at_least >= 0.55));
    assert.ok(rules.entries.every((rule) => rule.promotion_gate.requires_replay_promotion === true));
    assert.deepEqual(rules.entries.filter((rule) => rule.observation_mode).map((rule) => rule.id), ["AA-001", "AA-002"]);

    assert.deepEqual(traceFields.fields.map((field) => field.field_name), Array.from(traceRulesByField.keys()));
    assert.deepEqual(
      traceFields.fields.filter((field) => field.observation_metric).map((field) => field.field_name),
      ["patch_accepted_rate", "rollback_count"]
    );
    assert.deepEqual(
      traceFields.fields.filter((field) => field.should_block_patch_if_missing).map((field) => field.field_name),
      ["hook_evidence_chain", "span_problem_list"]
    );
    assert.deepEqual(validated, {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
  });

  it("audits GetDraft dialogue real replay traces as evidence-only until trace fields and rule samples exist", () => {
    const root = makeTempRoot("pns-getdraft-dialogue-trace-audit");
    const benchmarkDir = join(root, "docs", "evals", "quality-replay", "getdraft-dialogue-real");
    const rulesPath = join(root, "data", "runtime", "getdraft-dialogue", "getdraft-dialogue-candidate-rules.json");
    const outputPath = join(benchmarkDir, "getdraft-dialogue-trace-coverage.json");
    const requiredTraceFields = [
      "event_type",
      "dialogue_propulsion_score",
      "state_delta",
      "choice_delta",
      "risk_delta",
      "causal_chain",
      "contract_coverage",
      "style_match_score",
    ];

    writeJson(rulesPath, {
      schemaVersion: 1,
      source: "getdraft_dialogue",
      validationStatus: "candidate",
      entries: [
        {
          id: "DP-001",
          axis: "dialogue_propulsion",
          priority: "P0",
          patch_unit: "event",
          required_trace_fields: requiredTraceFields,
        },
        {
          id: "DP-002",
          axis: "dialogue_propulsion",
          priority: "P1",
          patch_unit: "event",
          required_trace_fields: [
            "event_type",
            "narrative_beat",
            "protagonist_active",
            "causal_chain",
            "style_match_score",
            "dialogue_propulsion_score",
            "contract_coverage",
          ],
        },
      ],
    });

    mkdirSync(benchmarkDir, { recursive: true });
    for (const chapter of [1, 2, 3]) {
      const tracePath = join(root, "workspaces", "demo", "traces", `ch${chapter.toString().padStart(3, "0")}-quality-trace.json`);
      writeJson(tracePath, {
        schemaVersion: 1,
        workspaceId: "demo",
        chapterId: `ch${chapter.toString().padStart(3, "0")}`,
        chapterContract: {
          dialoguePlan: {
            dialogueBearingEventIds: ["E1"],
          },
        },
        events: [
          {
            eventId: "E1",
            eventName: "dialogue decision beat",
            sceneType: "horror",
            craftGate: {
              issueTypes: ["dialogue_propulsion"],
              metrics: {
                dialoguePropulsion: chapter === 2 ? 84 : 62,
                contractCoverage: 0.82,
                dialogueRatio: 0.44,
              },
            },
            progression: {
              evidence: {
                metrics: {
                  state_delta: { passed: false },
                  causal_chain: { passed: true },
                  protagonist_active: { passed: chapter === 3 },
                },
                riskDelta: { score: chapter === 2 ? 1 : 0 },
                informationDelta: { score: chapter },
              },
            },
            getdraftDialogueTrace: {
              event_type: "dialogue",
              narrative_beat: chapter === 1 ? "revelation" : chapter === 2 ? "decision" : "confrontation",
              dialogue_propulsion_score: chapter === 2 ? 84 : 62,
              state_delta: false,
              risk_delta: chapter === 2 ? 1 : 0,
              causal_chain: true,
              protagonist_active: chapter === 3,
              contract_coverage: 0.82,
            },
          },
        ],
        gates: [
          {
            stage: "stage8.scene_continuity",
            status: "pass",
          },
        ],
        patches: [],
      });

      writeJson(join(benchmarkDir, `ch${chapter.toString().padStart(3, "0")}-benchmark.json`), {
        schemaVersion: 1,
        benchmarkId: String(chapter),
        candidateWins: chapter === 2,
        scores: {
          reference: 60,
          candidate: chapter === 2 ? 64 : 58,
          delta: chapter === 2 ? 4 : -2,
        },
        candidateMetrics: {
          choiceDelta: 0,
          riskDelta: chapter === 2 ? 1 : 0,
        },
        metadata: {
          chapterId: String(chapter),
          generatedBy: "novel_generate_chapter",
          candidate: {
            tracePath,
          },
        },
        candidateRules: [
          ...(chapter === 2 ? [] : [{
            id: "DP-001",
            axis: "dialogue_propulsion",
            source: "getdraft_dialogue",
            validationStatus: "candidate",
            runtimeDefaultEnabled: false,
            requiresReplayPromotion: true,
            patchUnit: "event",
            triggeredEventIds: ["E1"],
          }]),
          ...(chapter === 3 ? [] : [{
            id: "DP-002",
            axis: "dialogue_propulsion",
            source: "getdraft_dialogue",
            validationStatus: "candidate",
            runtimeDefaultEnabled: false,
            requiresReplayPromotion: true,
            patchUnit: "event",
            triggeredEventIds: ["E1"],
          }]),
        ],
      });
    }

    const auditScript = join(projectRoot, "scripts", "learning", "audit_getdraft_dialogue_trace_coverage.py");
    runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--rules", rulesPath,
      "--output", outputPath,
    ]);

    const report = JSON.parse(readFileSync(outputPath, "utf-8"));
    const dp001 = report.rules.find((rule) => rule.id === "DP-001");
    const dp002 = report.rules.find((rule) => rule.id === "DP-002");

    assert.equal(report.verdict, "insufficient_trace_evidence");
    assert.equal(report.summary.benchmarkFiles, 3);
    assert.equal(report.summary.orchestratorGeneratedBenchmarks, 3);
    assert.equal(report.summary.candidateRuleSamples, 4);
    assert.equal(report.summary.traceFiles, 3);
    assert.equal(report.summary.traceEventsWithSelectedRules, 0);
    assert.deepEqual(report.summary.blockedRuleIds, ["DP-001", "DP-002"]);
    assert.ok(dp001.directFields.includes("event_type"));
    assert.ok(dp001.directFields.includes("risk_delta"));
    assert.ok(dp001.benchmarkMetricOnlyFields.includes("choice_delta"));
    assert.ok(dp001.missingFields.includes("style_match_score"));
    assert.ok(dp001.triggerCandidateCount > 0);
    assert.ok(dp002.directFields.includes("narrative_beat"));
    assert.ok(dp002.directFields.includes("protagonist_active"));
    assert.ok(dp002.missingFields.includes("style_match_score"));
    assert.equal(report.conclusion.canPromoteGetDraftDialogueRules, false);
    assert.match(report.conclusion.reason, /candidate rule samples exist/i);
  });

  it("audits replay-runner quality report files for GetDraft dialogue trace coverage", () => {
    const root = makeTempRoot("pns-getdraft-quality-report-audit");
    const benchmarkDir = join(root, "replay-run", "reports");
    const rulesPath = join(root, "data", "runtime", "getdraft-dialogue", "getdraft-dialogue-candidate-rules.json");
    const outputPath = join(benchmarkDir, "getdraft-dialogue-trace-coverage.json");
    const tracePath = join(root, "replay-run", "traces", "ch001-quality-trace.json");

    writeJson(rulesPath, {
      schemaVersion: 1,
      source: "getdraft_dialogue",
      validationStatus: "candidate",
      entries: [
        {
          id: "DP-001",
          axis: "dialogue_propulsion",
          priority: "P0",
          patch_unit: "event",
          required_trace_fields: ["event_type", "dialogue_propulsion_score", "state_delta", "causal_chain"],
        },
      ],
    });
    writeJson(tracePath, {
      schemaVersion: 1,
      workspaceId: "demo",
      chapterId: "ch001",
      chapterContract: {
        dialoguePlan: {
          dialogueBearingEventIds: ["E1"],
        },
      },
      events: [
        {
          eventId: "E1",
          sceneType: "horror",
          craftGate: {
            issueTypes: ["dialogue_propulsion"],
            metrics: {
              dialoguePropulsion: 62,
              dialogueRatio: 0.45,
            },
          },
          progression: {
            evidence: {
              metrics: {
                state_delta: { passed: false },
                causal_chain: { passed: true },
              },
            },
          },
          getdraftDialogueTrace: {
            event_type: "dialogue",
            dialogue_propulsion_score: 62,
            state_delta: false,
            causal_chain: true,
          },
        },
      ],
      gates: [],
      patches: [],
    });
    writeJson(join(benchmarkDir, "ch001-quality-report.json"), {
      schemaVersion: 1,
      benchmarkId: "ch001",
      candidateWins: false,
      scores: {
        reference: 60,
        candidate: 58,
        delta: -2,
      },
      metadata: {
        chapterId: "ch001",
        generatedBy: "novel_generate_chapter",
        candidate: {
          generationTool: "novel_generate_chapter",
          tracePath,
        },
      },
      candidateRules: [
        {
          id: "DP-001",
          axis: "dialogue_propulsion",
          source: "getdraft_dialogue",
          validationStatus: "candidate",
          runtimeDefaultEnabled: false,
          requiresReplayPromotion: true,
          patchUnit: "event",
          triggeredEventIds: ["E1"],
        },
      ],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_getdraft_dialogue_trace_coverage.py");
    runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--rules", rulesPath,
      "--output", outputPath,
    ]);

    const report = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(report.summary.benchmarkFiles, 1);
    assert.equal(report.summary.traceFiles, 1);
    assert.equal(report.summary.candidateRuleSamples, 1);
    assert.equal(report.benchmarks[0].file, "ch001-quality-report.json");
    assert.equal(report.benchmarks[0].generatedByOrchestrator, true);
  });
});

describe("quality evolution acceptance audit", () => {
  it("fails closed when runtime learning evidence is still empty", () => {
    const root = makeTempRoot("pns-quality-audit-empty");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    mkdirSync(benchmarkDir, { recursive: true });
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPythonRaw(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "3",
      "--min-win-rate", "0.55",
    ]);

    assert.equal(result.status, 1, `audit should fail closed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "fail");
    assert.ok(report.checks.some((check) => check.id === "replay_benchmarks" && check.status === "fail"));
    assert.ok(report.checks.some((check) => check.id === "active_validated_rules" && check.status === "fail"));
  });

  it("counts only replay benchmark shaped JSON files in mixed audit directories", () => {
    const root = makeTempRoot("pns-quality-audit-mixed-dir");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    mkdirSync(benchmarkDir, { recursive: true });

    writeJson(join(benchmarkDir, "chapter-1.json"), {
      schemaVersion: 1,
      benchmarkId: "chapter-1",
      candidateWins: true,
      scores: {
        reference: 40,
        candidate: 70,
        delta: 30,
      },
      metadata: {
        chapterId: "chapter-1",
        generatedBy: "novel_generate_chapter",
      },
      candidateRules: [
        {
          id: "concrete-object-choice",
          sceneType: "daily",
          craftMove: "Force the choice through one concrete object.",
        },
      ],
    });
    writeJson(join(benchmarkDir, "quality-evolution-audit.json"), {
      schemaVersion: 1,
      verdict: "fail",
      summary: {
        benchmarkFiles: 1,
      },
      checks: [],
    });
    writeFileSync(join(benchmarkDir, "bad-encoding.json"), Buffer.from([0xff, 0xfe, 0x7b, 0x00]));
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
      "--allow-incomplete",
    ]);

    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.benchmarkFiles, 1);
    assert.equal(report.summary.benchmarkFilesWithRules, 1);
    assert.equal(report.summary.orchestratorGeneratedBenchmarks, 1);
    assert.equal(report.verdict, "fail");
  });

  it("writes the audit report to an explicit output path without changing the verdict", () => {
    const root = makeTempRoot("pns-quality-audit-output");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const outputPath = join(root, "reports", "quality-evolution-audit.json");
    mkdirSync(benchmarkDir, { recursive: true });
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--output", outputPath,
      "--allow-incomplete",
    ]);

    assert.equal(existsSync(outputPath), true);
    const stdoutReport = JSON.parse(result.stdout);
    const fileReport = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(stdoutReport.verdict, "fail");
    assert.deepEqual(fileReport, stdoutReport);
  });

  it("deduplicates replay benchmark samples by benchmarkId before acceptance checks", () => {
    const root = makeTempRoot("pns-quality-audit-duplicate-benchmark");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const duplicateRule = {
      id: "replay-scene-progression",
      sceneType: "horror",
      craftMove: "Force each scene to create a visible state delta.",
    };

    mkdirSync(benchmarkDir, { recursive: true });
    for (const filename of ["chapter-1-raw.json", "chapter-1-distilled.json"]) {
      writeJson(join(benchmarkDir, filename), {
        schemaVersion: 1,
        benchmarkId: "same-chapter-1",
        candidateWins: false,
        scores: { reference: 60, candidate: 42, delta: -18 },
        metadata: {
          chapterId: "same-chapter-1",
          generatedBy: "novel_generate_chapter",
        },
        candidateRules: [duplicateRule],
      });
    }
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "2",
      "--min-win-rate", "0.55",
      "--allow-incomplete",
    ]);

    const report = JSON.parse(result.stdout);
    const replayCheck = report.checks.find((check) => check.id === "replay_benchmarks");
    assert.equal(report.summary.benchmarkFiles, 1);
    assert.equal(report.summary.benchmarkFilesWithRules, 1);
    assert.equal(report.summary.benchmarkRuleSamples, 1);
    assert.equal(report.summary.orchestratorGeneratedBenchmarks, 1);
    assert.equal(replayCheck?.status, "fail");
  });

  it("does not count failed generation results as usable orchestrator proof", () => {
    const root = makeTempRoot("pns-quality-audit-failed-generation");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const resultPath = join(root, "workspace", "chapters", "chapter-1", "generate-result.json");

    mkdirSync(benchmarkDir, { recursive: true });
    writeJson(resultPath, {
      status: "blocked",
      stage: "8-scene-continuity",
      message: "location_jump_without_transition",
    });
    writeJson(join(benchmarkDir, "chapter-1.json"), {
      schemaVersion: 1,
      benchmarkId: "chapter-1",
      candidateWins: true,
      scores: {
        reference: 40,
        candidate: 70,
        delta: 30,
      },
      metadata: {
        chapterId: "chapter-1",
        generatedBy: "novel_generate_chapter",
        candidate: {
          resultPath,
        },
      },
      candidateRules: [
        {
          id: "concrete-object-choice",
          sceneType: "daily",
          craftMove: "Force the choice through one concrete object.",
        },
      ],
    });
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
      "--allow-incomplete",
    ]);

    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.benchmarkFiles, 1);
    assert.equal(report.summary.orchestratorGeneratedBenchmarks, 0);
    assert.equal(report.summary.failedGenerationProofBenchmarks, 1);
    assert.ok(report.checks.some((check) => check.id === "orchestrator_generation_proof" && check.status === "fail"));
  });

  it("does not count completed_with_review generation results as usable orchestrator proof", () => {
    const root = makeTempRoot("pns-quality-audit-completed-with-review");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const resultPath = join(root, "workspace", "chapters", "chapter-1", "generate-result.json");

    mkdirSync(benchmarkDir, { recursive: true });
    writeJson(resultPath, {
      status: "completed_with_review",
      stage: "8-anti-ai",
      message: "candidate text and trace were produced with review notes",
    });
    writeJson(join(benchmarkDir, "chapter-1.json"), {
      schemaVersion: 1,
      benchmarkId: "chapter-1",
      candidateWins: true,
      scores: {
        reference: 40,
        candidate: 70,
        delta: 30,
      },
      metadata: {
        chapterId: "chapter-1",
        generatedBy: "novel_generate_chapter",
        candidate: {
          resultPath,
        },
      },
      candidateRules: [
        {
          id: "concrete-object-choice",
          sceneType: "daily",
          craftMove: "Force the choice through one concrete object.",
        },
      ],
    });
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: null,
      entries: [],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPython(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "1",
      "--min-win-rate", "0.55",
      "--allow-incomplete",
    ]);

    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.benchmarkFiles, 1);
    // P0: completed_with_review 不再视为成功
    assert.equal(report.summary.orchestratorGeneratedBenchmarks, 0);
    assert.equal(report.summary.failedGenerationProofBenchmarks, 1);
    assert.ok(report.checks.some((check) => check.id === "orchestrator_generation_proof" && check.status === "fail"));
  });

  it("passes only when replay, validated runtime rules, and trace evidence are all present", () => {
    const root = makeTempRoot("pns-quality-audit-ready");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const rule = {
      id: "daily-object-choice-cn",
      sceneType: "daily_life",
      appliesWhen: ["雨夜旧巷", "账册", "债主让步"],
      craftMove: "让日常道具逼出可见选择，不用抽象心理解释替代行动。",
      mustDo: ["把道具、对白和让步结果绑在同一处动作里"],
      avoid: ["先解释情绪，再概括局势"],
      evidence: {
        source: "replay_benchmark",
        sampleSize: 3,
        wins: 2,
        losses: 1,
        winRate: 0.6667,
        validatedWinRate: 0.6667,
      },
    };

    mkdirSync(benchmarkDir, { recursive: true });
    for (const index of [1, 2, 3]) {
      writeJson(join(benchmarkDir, `chapter-cn-${index}.json`), {
        schemaVersion: 1,
        benchmarkId: `chapter-cn-${index}`,
        candidateWins: index !== 3,
        scores: { reference: 52, candidate: index !== 3 ? 71 : 49, delta: index !== 3 ? 19 : -3 },
        metadata: {
          chapterId: `chapter-cn-${index}`,
          generatedBy: "novel_generate_chapter",
        },
        candidateRules: [rule],
      });
    }
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: "2026-06-07T00:00:00Z",
      entries: [rule],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: "2026-06-07T00:00:00Z",
      entries: [rule],
    });
    writeJson(join(traceDir, "demo", "traces", "chapter-cn-4-quality-trace.json"), {
      schemaVersion: 1,
      workspaceId: "demo",
      chapterId: "chapter-cn-4",
      events: [
        {
          eventId: "E1",
          eventName: "雨夜摊牌",
          sceneType: "daily_life",
          selectedRuleIds: ["daily-object-choice-cn"],
          selectedFewshotIds: [],
          contractSummary: "让日常道具逼出可见选择",
          evaluation: { score: 82, passed: true, issueTypes: [] },
          attempts: 1,
          model: "test/model",
        },
      ],
      patches: [
        {
          stage: "stage5.style.loop1",
          accepted: false,
          beforeScore: 80,
          afterScore: 61,
          scoreDelta: -19,
          reason: "patch rejected",
        },
      ],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPythonRaw(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "3",
      "--min-win-rate", "0.55",
    ]);

    assert.equal(result.status, 0, `audit should pass\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "pass");
    assert.equal(report.summary.benchmarkFiles, 3);
    assert.equal(report.summary.activeValidatedRules, 1);
    assert.equal(report.summary.traceEventsWithRules, 1);
    assert.equal(report.summary.traceEventsWithActiveValidatedRules, 1);
  });

  it("fails when traces select rules that are not active validated runtime rules", () => {
    const root = makeTempRoot("pns-quality-audit-wrong-trace-rule");
    const benchmarkDir = join(root, "bench");
    const runtimeDir = join(root, "data", "runtime");
    const traceDir = join(root, "workspaces");
    const rule = {
      id: "daily-object-choice-cn",
      sceneType: "daily_life",
      appliesWhen: ["雨夜旧巷", "账册", "债主让步"],
      craftMove: "让日常道具逼出可见选择，不用抽象心理解释替代行动。",
      mustDo: ["把道具、对白和让步结果绑在同一处动作里"],
      avoid: ["先解释情绪，再概括局势"],
      evidence: {
        source: "replay_benchmark",
        sampleSize: 3,
        wins: 2,
        losses: 1,
        winRate: 0.6667,
        validatedWinRate: 0.6667,
      },
    };

    mkdirSync(benchmarkDir, { recursive: true });
    for (const index of [1, 2, 3]) {
      writeJson(join(benchmarkDir, `chapter-cn-${index}.json`), {
        schemaVersion: 1,
        benchmarkId: `chapter-cn-${index}`,
        candidateWins: index !== 3,
        scores: { reference: 52, candidate: index !== 3 ? 71 : 49, delta: index !== 3 ? 19 : -3 },
        metadata: {
          chapterId: `chapter-cn-${index}`,
          generatedBy: "novel_generate_chapter",
        },
        candidateRules: [rule],
      });
    }
    writeJson(join(runtimeDir, "candidate-rules.json"), {
      schemaVersion: 1,
      generatedAt: "2026-06-07T00:00:00Z",
      entries: [rule],
    });
    writeJson(join(runtimeDir, "validated-craft-rules.json"), {
      schemaVersion: 1,
      generatedAt: "2026-06-07T00:00:00Z",
      entries: [rule],
    });
    writeJson(join(traceDir, "demo", "traces", "chapter-cn-4-quality-trace.json"), {
      schemaVersion: 1,
      workspaceId: "demo",
      chapterId: "chapter-cn-4",
      events: [
        {
          eventId: "E1",
          eventName: "雨夜摊牌",
          sceneType: "daily_life",
          selectedRuleIds: ["confidence-only-old-rule"],
          selectedFewshotIds: [],
          contractSummary: "选中了未验证旧规则",
          evaluation: { score: 82, passed: true, issueTypes: [] },
          attempts: 1,
          model: "test/model",
        },
      ],
      patches: [
        {
          stage: "stage5.style.loop1",
          accepted: true,
          beforeScore: 70,
          afterScore: 76,
          scoreDelta: 6,
          reason: "patch accepted",
        },
      ],
    });

    const auditScript = join(projectRoot, "scripts", "learning", "audit_quality_evolution.py");
    const result = runPythonRaw(auditScript, [
      "--project-root", root,
      "--benchmark-dir", benchmarkDir,
      "--runtime-dir", runtimeDir,
      "--trace-dir", traceDir,
      "--min-samples", "3",
      "--min-win-rate", "0.55",
    ]);

    assert.equal(result.status, 1, `audit should reject trace rule mismatch\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "fail");
    assert.ok(report.checks.some((check) => check.id === "quality_trace" && check.status === "fail"));
  });
});
