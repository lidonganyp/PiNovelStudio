/**
 * Serialize commands that read or replace the shared dist artifact directories.
 * The lock lives in the OS temp directory so concurrent Codex sessions using the
 * same checkout cannot observe a half-cleaned build.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REENTRANT_TOKEN_ENV = "PINOVEL_ARTIFACT_LOCK_TOKEN";
const WAIT_TIMEOUT_ENV = "PINOVEL_ARTIFACT_LOCK_WAIT_MS";
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 100;
const OWNER_WRITE_GRACE_MS = 5_000;

function parseCommand(argv) {
  if (argv[0] === "--command" && argv[1]) return argv[1];
  const separator = argv.indexOf("--");
  const args = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (args.length === 0) {
    throw new Error("artifact-operation-lock requires --command <command> or -- <command>");
  }
  return args.map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value) {
  if (/^[A-Za-z0-9_./:\\=*@-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function getLockDirectory(cwd) {
  const canonical = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  const checkoutHash = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  return join(tmpdir(), `pinovel-artifacts-${checkoutHash}.lock`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function removeStaleLock(lockDirectory) {
  const owner = readOwner(lockDirectory);
  if (owner && isProcessAlive(owner.pid)) return false;
  if (!owner) {
    try {
      if (Date.now() - statSync(lockDirectory).mtimeMs < OWNER_WRITE_GRACE_MS) return false;
    } catch {
      return false;
    }
  }
  try {
    rmSync(lockDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockDirectory, token, waitTimeoutMs) {
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(lockDirectory);
      writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      }), "utf8");
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      removeStaleLock(lockDirectory);
      if (Date.now() - startedAt >= waitTimeoutMs) {
        const owner = readOwner(lockDirectory);
        throw new Error(`timed out waiting for artifact lock held by pid ${owner?.pid ?? "unknown"}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
    }
  }
}

function releaseOwnedLock(lockDirectory, token) {
  const owner = readOwner(lockDirectory);
  if (owner?.token === token) rmSync(lockDirectory, { recursive: true, force: true });
}

function runCommand(command, token) {
  const result = spawnSync(command, {
    cwd: process.cwd(),
    env: { ...process.env, [REENTRANT_TOKEN_ENV]: token },
    shell: true,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(`[artifact-lock] child terminated by ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const command = parseCommand(process.argv.slice(2));
const inheritedToken = process.env[REENTRANT_TOKEN_ENV];
if (inheritedToken) process.exit(runCommand(command, inheritedToken));

const token = randomUUID();
const lockDirectory = getLockDirectory(process.cwd());
const configuredWait = Number(process.env[WAIT_TIMEOUT_ENV] ?? DEFAULT_WAIT_TIMEOUT_MS);
const waitTimeoutMs = Number.isFinite(configuredWait) && configuredWait > 0
  ? configuredWait
  : DEFAULT_WAIT_TIMEOUT_MS;

await acquireLock(lockDirectory, token, waitTimeoutMs);
try {
  process.exitCode = runCommand(command, token);
} finally {
  if (existsSync(lockDirectory)) releaseOwnedLock(lockDirectory, token);
}
