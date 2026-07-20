/** Default test scripts must avoid shared dist directory races. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("default full-suite scripts run Node tests serially", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf-8"),
  );
  for (const scriptName of ["test", "test:fresh", "test:eval"]) {
    assert.match(
      packageJson.scripts[scriptName],
      /--test-concurrency=1/,
      `${scriptName} must serialize tests that share dist artifacts`,
    );
  }
});

test("build and test scripts share a cross-process artifact lock", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf-8"),
  );
  for (const scriptName of [
    "clean",
    "build",
    "build:prod",
    "build:eval",
    "build:test",
    "test",
    "test:fresh",
    "test:eval",
    "smoke",
    "simplicity-gate",
    "verify:real-quality",
  ]) {
    assert.match(
      packageJson.scripts[scriptName],
      /artifact-operation-lock\.mjs/,
      `${scriptName} must coordinate access to shared dist artifacts`,
    );
  }
});

test("artifact operation lock serializes independent processes", async () => {
  const extensionRoot = resolve(import.meta.dirname, "..");
  const lockScript = join(extensionRoot, "scripts", "artifact-operation-lock.mjs");
  const probeScript = join(import.meta.dirname, "fixtures", "artifact-lock-probe.mjs");
  const tempRoot = mkdtempSync(join(tmpdir(), "pinovel-artifact-lock-test-"));
  const eventPath = join(tempRoot, "events.txt");

  const runProbe = (id) => new Promise((resolvePromise, rejectPromise) => {
    const independentEnv = { ...process.env };
    delete independentEnv.PINOVEL_ARTIFACT_LOCK_TOKEN;
    const child = spawn(process.execPath, [
      lockScript,
      "--",
      process.execPath,
      probeScript,
      eventPath,
      id,
      "150",
    ], { cwd: tempRoot, env: independentEnv, stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`lock probe ${id} exited with ${code}`)));
  });

  try {
    await Promise.all([runProbe("a"), runProbe("b")]);
    const events = readFileSync(eventPath, "utf8").trim().split(/\r?\n/);
    assert.ok(
      JSON.stringify(events) === JSON.stringify(["a:start", "a:end", "b:start", "b:end"])
        || JSON.stringify(events) === JSON.stringify(["b:start", "b:end", "a:start", "a:end"]),
      `critical sections overlapped: ${events.join(", ")}`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
