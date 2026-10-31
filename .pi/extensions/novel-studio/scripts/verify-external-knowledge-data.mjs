/**
 * R06：外挂蒸馏知识库真实数据离线验收（显式命令，不属于默认测试）。
 *
 * 默认测试只用临时目录里的自包含 fixture，不读取本机私有三库。
 * 本命令用于在确实提供了真实数据的机器上核对输入：
 * - 输入来源：`data/external-distilled/slices.json`、`excerpts-good.json`、`excerpts-bad.json`；
 *   这些文件被根目录 `.gitignore` 忽略，不纳入版本控制。
 * - 输出：每份文件的相对路径、字节数、sha256（内容版本指纹）与结构摘要。
 * - 缺失或结构无效时明确标注，且本次结果不得作为小说质量提升证据。
 * - 退出码：0 = 全部可用；2 = 存在缺失或结构无效。
 *
 * 用法：
 *   node scripts/verify-external-knowledge-data.mjs [--project-root <path>] [--json]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIR, "../../../..");

const DATA_FILES = [
  {
    key: "slices",
    relativePath: "data/external-distilled/slices.json",
    role: "生产候选通道（场景判断文本，无原文摘录）",
  },
  {
    key: "excerpts_good",
    relativePath: "data/external-distilled/excerpts-good.json",
    role: "隔离评测对照臂（生产永不读取）",
  },
  {
    key: "excerpts_bad",
    relativePath: "data/external-distilled/excerpts-bad.json",
    role: "隔离评测对照臂（生产永不读取）",
  },
];

function parseArgs(argv) {
  const options = { projectRoot: DEFAULT_PROJECT_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--project-root" && argv[index + 1]) {
      options.projectRoot = resolve(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function describeJsonShape(raw) {
  try {
    const parsed = JSON.parse(raw.content);
    if (Array.isArray(parsed)) {
      return { kind: "array", entryCount: parsed.length };
    }
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed);
      const arrays = keys.filter((key) => Array.isArray(parsed[key]));
      return {
        kind: "object",
        keys: keys.slice(0, 8),
        arrayFields: arrays.map((key) => ({ key, entryCount: parsed[key].length })),
      };
    }
    return { kind: typeof parsed, entryCount: 0 };
  } catch (error) {
    return { kind: "invalid_json", error: String(error).slice(0, 160) };
  }
}

async function describeSlicesWithLoader(projectRoot) {
  try {
    const module = await import("../dist/v2/core/external-knowledge-base.js");
    const result = module.loadExternalDistilledSlices(projectRoot);
    return {
      ok: result.ok === true,
      loader: "dist/v2/core/external-knowledge-base.js:loadExternalDistilledSlices",
      sliceCount: result.slices.length,
      error: result.error,
    };
  } catch (error) {
    return {
      ok: false,
      loader: "dist/v2/core/external-knowledge-base.js",
      sliceCount: 0,
      error: `loader_unavailable（先运行 npm run build:prod）：${String(error).slice(0, 120)}`,
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const entries = [];
  let missing = 0;
  let invalid = 0;

  for (const file of DATA_FILES) {
    const absolutePath = join(options.projectRoot, file.relativePath);
    if (!existsSync(absolutePath)) {
      missing += 1;
      entries.push({
        ...file,
        status: "missing",
        bytes: 0,
        sha256: null,
        note: "缺失：本次验收不得作为小说质量提升证据",
      });
      continue;
    }
    const buffer = readFileSync(absolutePath);
    const content = buffer.toString("utf8");
    const shape = describeJsonShape({ content });
    if (shape.kind === "invalid_json") invalid += 1;
    entries.push({
      ...file,
      status: shape.kind === "invalid_json" ? "invalid" : "ok",
      bytes: buffer.length,
      sha256: sha256(buffer),
      shape,
    });
  }

  const slices = entries.find((entry) => entry.key === "slices");
  const loaderProbe = slices.status === "ok"
    ? await describeSlicesWithLoader(options.projectRoot)
    : { ok: false, loader: "skipped", sliceCount: 0, error: "slices_missing" };

  const payload = {
    projectRoot: options.projectRoot,
    inputSource: "data/external-distilled/（根目录 .gitignore 忽略，不入库）",
    defaultTestDependency: false,
    defaultTests: "tests/external-knowledge-base.test.mjs 使用临时目录自包含 fixture",
    qualityEvidence: missing === 0 && invalid === 0 && loaderProbe.ok,
    missing,
    invalid,
    entries,
    loaderProbe,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`[external-kb] projectRoot=${payload.projectRoot}`);
    console.log(`[external-kb] 输入来源：${payload.inputSource}`);
    console.log("[external-kb] 默认测试不依赖本机数据（临时 fixture），本命令为显式离线验收");
    for (const entry of payload.entries) {
      const hash = entry.sha256 ? entry.sha256.slice(0, 16) : "-";
      const shape = entry.shape
        ? `shape=${entry.shape.kind}${entry.shape.entryCount !== undefined ? ` entries=${entry.shape.entryCount}` : ""}`
        : "";
      console.log(
        `[external-kb] ${entry.status.padEnd(7)} ${entry.relativePath} bytes=${entry.bytes} sha256=${hash} ${shape}${entry.note ? ` ${entry.note}` : ""}`,
      );
    }
    console.log(
      `[external-kb] loader=${loaderProbe.loader} ok=${loaderProbe.ok} slices=${loaderProbe.sliceCount}${loaderProbe.error ? ` error=${loaderProbe.error}` : ""}`,
    );
    if (!payload.qualityEvidence) {
      console.log(
        "[external-kb] 结论：缺少或被忽略的真实数据不可用；本次结果不得作为小说质量提升证据。",
      );
    } else {
      console.log("[external-kb] 结论：真实数据可读且切片结构有效；仍需真实章节 replay 与用户评价才算质量证据。");
    }
  }

  process.exitCode = missing === 0 && invalid === 0 && loaderProbe.ok ? 0 : 2;
}

main();
