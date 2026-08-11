/**
 * 临时门禁前置校验：运行 evaluateProductionReleaseGate 确认 devMode=false、
 * release gate 全通过（指纹匹配、审批 artifact 有效），并打印当前指纹。
 * 仅用于生产基线运行前的低成本预检，不调用模型、不写状态。
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");

// 加载 .env（与 index.ts 相同逻辑）
const envPath = join(PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

console.log(`PINOVEL_DEV_MODE = ${process.env.PINOVEL_DEV_MODE ?? "(unset)"}`);
console.log(`GEMINI_API_KEY set = ${Boolean(process.env.GEMINI_API_KEY)}`);
console.log(`GOOGLE_GEMINI_BASE_URL = ${process.env.GOOGLE_GEMINI_BASE_URL ?? "(unset)"}`);

// 加载 dist-test 编译产物（governance 模块在 test 构建中）
const gateModulePath = join(
  EXTENSION_ROOT,
  "dist-test",
  "v2",
  "governance",
  "production-release-gate.js",
);
if (!existsSync(gateModulePath)) {
  console.error(`❌ dist-test gate 不存在: ${gateModulePath}`);
  process.exit(1);
}
const gateModule = await import(pathToFileURL(gateModulePath).href);
const { evaluateProductionReleaseGate, captureDefaultEnvironmentFingerprint } = gateModule;

const currentHash = captureDefaultEnvironmentFingerprint(PROJECT_ROOT);
console.log(`\n当前环境指纹: ${currentHash}`);

const result = evaluateProductionReleaseGate({
  projectRoot: PROJECT_ROOT,
  currentFingerprintHash: currentHash,
});

if (result.ok) {
  console.log("\n✅ 生产门禁通过");
  console.log(`  devMode: ${result.devMode}`);
  console.log(`  releaseId: ${result.releaseId}`);
  console.log(`  environmentFingerprint: ${result.environmentFingerprint}`);
  console.log(`  approvalRef: ${result.approvalRef}`);
  console.log(`  canaryEvidenceRunId: ${result.canaryEvidenceRunId}`);
  process.exit(0);
} else {
  console.log("\n❌ 生产门禁阻断");
  console.log(`  devMode: ${result.devMode}`);
  const fe = result.failureEnvelope;
  console.log(`  stage: ${fe.stage}, severity: ${fe.severity}, degradedTo: ${fe.degradedTo}`);
  console.log(`  reason: ${fe.reason}`);
  process.exitCode = 1;
}