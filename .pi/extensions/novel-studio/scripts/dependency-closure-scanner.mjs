#!/usr/bin/env node
/**
 * PiNovelStudio — 依赖闭包扫描器 (Dependency Closure Scanner)
 *
 * LEGACY-CLOSURE-SCANNER-1：修正并固化依赖闭包扫描器。
 *
 * 背景：先前手动分析曾出现"0 import"误判——原因是 ESM 源文件用 `.js` 扩展名
 * 书写 import 路径（如 `import type { X } from "./types.js"`），未解析到 `.ts`
 * 源文件，导致看不见真实依赖。本扫描器修正该缺陷并固化闭包计算。
 *
 * 能力：
 *   1. 正确解析 ESM `.js` 导入路径 → TypeScript `.ts`/`.tsx` 源文件
 *   2. 识别全部 import 形式：
 *        - `import ... from "..."`        (value import)
 *        - `import type ... from "..."`   (type-only import，仍计入闭包：TS 编译需解析)
 *        - `export ... from "..."`        (re-export)
 *        - `export type ... from "..."`   (type-only re-export)
 *        - `export * from "..."`          (star re-export)
 *        - `import "..."`                 (副作用 import)
 *        - `import("...")`                (动态 import)
 *   3. 递归构建每个入口的传递闭包（DFS + visited，处理循环依赖）
 *   4. 标记 forbidden 依赖：legacy-index / agents/ / workflow/ / lab/
 *   5. 输出机器可读 owner 清单（reports/dependency-closure.json）
 *      —— 每个"被谁消费 (reachedFrom)"的反向映射，为后续 legacy 模块删除提供依据
 *
 * 入口类型：
 *   - `.ts` 源文件：解析相对 `.js` import → `.ts`
 *   - `.mjs` 测试文件：解析 `../dist/`、`../dist-eval/`、`../dist-test/` 路径，
 *     剥离编译目录前缀后回溯到 `.ts` 源
 *
 * 用法：
 *   node scripts/dependency-closure-scanner.mjs                         # 默认入口 test/test-modules.ts
 *   node scripts/dependency-closure-scanner.mjs craft/contract/parser.ts dag/validator.ts
 *   node scripts/dependency-closure-scanner.mjs --all-tests             # 扫描全部 tests/*.test.mjs + barrel
 *   node scripts/dependency-closure-scanner.mjs --check-forbidden       # 发现 forbidden 依赖时 exit 1
 *   node scripts/dependency-closure-scanner.mjs --json-out <path>       # 自定义 JSON 输出路径
 *
 * 约束：本脚本仅 import node 内建模块，不依赖任何项目源码或 forbidden 模块。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const { join: posixJoin, dirname: posixDirname, normalize: posixNormalize } = posix;
const OS_SEP = path.sep;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPTS_DIR_OS = __dirname.endsWith(OS_SEP) ? __dirname.slice(0, -1) : __dirname;
const EXT_ROOT_OS = path.dirname(SCRIPTS_DIR_OS); // .pi/extensions/novel-studio (OS 路径)
const EXT_ROOT = EXT_ROOT_OS.split(OS_SEP).join("/"); // posix 风格，用于闭包路径表示

// ============================================================================
// forbidden 标记规则
// ============================================================================
const FORBIDDEN_RULES = [
  { type: "legacy-index", test: (p) => /(^|\/)legacy-index\.(ts|js)$/.test(p) },
  { type: "agents", test: (p) => p.startsWith("agents/") },
  { type: "workflow", test: (p) => p.startsWith("workflow/") },
  { type: "lab", test: (p) => p.startsWith("lab/") },
];

function classifyForbidden(relPosixPath) {
  for (const rule of FORBIDDEN_RULES) {
    if (rule.test(relPosixPath)) return rule.type;
  }
  return null;
}

// ============================================================================
// import 路径解析（.js → .ts，剥离 dist/dist-eval/dist-test 前缀）
// ============================================================================
const COMPILATION_DIR_PREFIX = /^(dist-eval|dist-test|dist)\//;

function resolveImport(fromRelPosix, spec) {
  // spec 必须是相对路径（./ 或 ../）；外部包跳过
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;

  const fromDir = posixDirname(fromRelPosix);
  let resolved = posixNormalize(posixJoin(fromDir, spec));

  // 剥离编译目录前缀 → 回到源码空间（测试文件回溯场景）
  resolved = resolved.replace(COMPILATION_DIR_PREFIX, "");

  // 去掉 .js 扩展名（ESM 约定书写 .js，源文件实为 .ts）
  if (resolved.endsWith(".js")) {
    resolved = resolved.slice(0, -3);
  }

  // 尝试 .ts → .tsx → index.ts
  const candidates = [resolved + ".ts", resolved + ".tsx", posixJoin(resolved, "index.ts")];
  for (const c of candidates) {
    if (existsSync(toOsPath(c))) return c;
  }
  return null; // 无法解析（可能指向不存在或外部）
}

// 将相对 posix 路径转换为当前 OS 绝对路径用于 fs 调用
function toOsPath(relPosix) {
  return path.join(EXT_ROOT_OS, ...relPosix.split("/"));
}

// ============================================================================
// import 形式识别
// ============================================================================
// 三类正则，覆盖全部 ESM import/export 形式
const IMPORT_PATTERNS = [
  // from "..."：覆盖 import/import type/export/export type/export * 的 from 子句
  { kind: "from", re: /\bfrom\s*["']([^"']+)["']/g },
  // 副作用 import "..."（无 from，import 后紧跟引号）
  { kind: "side-effect", re: /\bimport\s*["']([^"']+)["']/g },
  // 动态 import("...")
  { kind: "dynamic", re: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g },
];

function parseImports(source) {
  const specToKinds = new Map();
  for (const { kind, re } of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // 跳过外部包
      if (!specToKinds.has(spec)) specToKinds.set(spec, new Set());
      specToKinds.get(spec).add(kind);
    }
  }
  return [...specToKinds.entries()].map(([spec, kinds]) => ({ spec, kinds: [...kinds] }));
}

// ============================================================================
// 单模块解析缓存：relPath → { directImports, importKinds, forbidden, forbiddenType, exists }
// ============================================================================
const moduleCache = new Map();

function loadModule(relPosixPath) {
  if (moduleCache.has(relPosixPath)) return moduleCache.get(relPosixPath);

  const osPath = toOsPath(relPosixPath);
  const exists = existsSync(osPath);
  const forbiddenType = classifyForbidden(relPosixPath);

  let directImports = [];
  const importKinds = {};
  if (exists) {
    const src = readFileSync(osPath, "utf-8");
    const parsed = parseImports(src);
    directImports = parsed
      .map(({ spec, kinds }) => {
        const resolved = resolveImport(relPosixPath, spec);
        if (!resolved) return null;
        importKinds[resolved] = kinds;
        return resolved;
      })
      .filter((p) => p !== null);
  }

  const info = {
    path: relPosixPath,
    exists,
    forbidden: forbiddenType !== null,
    forbiddenType,
    directImports,
    importKinds,
  };
  moduleCache.set(relPosixPath, info);
  return info;
}

// ============================================================================
// 传递闭包（DFS + visited；记录 forbidden 命中路径用于归因）
// ============================================================================
function computeClosure(entryRelPosix) {
  const closure = new Set();
  const forbiddenHits = []; // { module, via } via = 引入它的上游模块
  const stack = [{ current: entryRelPosix, via: null }];

  while (stack.length > 0) {
    const { current, via } = stack.pop();
    if (closure.has(current)) continue;
    closure.add(current);

    const info = loadModule(current);
    if (info.forbidden) {
      forbiddenHits.push({ module: current, forbiddenType: info.forbiddenType, via });
    }
    for (const dep of info.directImports) {
      if (!closure.has(dep)) {
        stack.push({ current: dep, via: current });
      }
    }
  }

  return {
    entry: entryRelPosix,
    closure: [...closure].sort(),
    closureSize: closure.size,
    forbiddenHits,
    forbiddenCount: forbiddenHits.length,
  };
}

// ============================================================================
// CLI
// ============================================================================
function parseArgs(argv) {
  const entries = [];
  let checkForbidden = false;
  let allTests = false;
  let jsonOut = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check-forbidden") checkForbidden = true;
    else if (a === "--all-tests") allTests = true;
    else if (a === "--json-out") {
      jsonOut = argv[++i];
      if (!jsonOut) throw new Error("--json-out 需要路径参数");
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else entries.push(a);
  }
  return { entries, checkForbidden, allTests, jsonOut };
}

function printHelp() {
  console.log(`PiNovelStudio 依赖闭包扫描器 (LEGACY-CLOSURE-SCANNER-1)

用法:
  node scripts/dependency-closure-scanner.mjs [entries...] [options]

选项:
  --all-tests         扫描全部 tests/*.test.mjs + test/test-modules.ts
  --check-forbidden   发现 forbidden 依赖时 exit 1（CI/门禁用）
  --json-out <path>   自定义 JSON 输出路径（默认 reports/dependency-closure.json）
  -h, --help          显示帮助

入口:
  - .ts 源文件（如 craft/contract/parser.ts）：解析相对 .js import
  - .mjs 测试文件（如 tests/foo.test.mjs）：解析 dist/dist-eval/dist-test 路径回溯到 .ts
  - 默认入口：test/test-modules.ts（dist-test barrel）
`);
}

function resolveEntry(arg) {
  // 接受绝对路径或相对 EXT_ROOT 的路径
  if (existsSync(arg)) return toRelPosix(arg);
  const candidate = toRelPosix(arg); // 相对路径直接转 posix
  if (existsSync(toOsPath(candidate))) return candidate;
  return candidate; // 返回相对路径，loadModule 会标记 exists=false
}

function toRelPosix(absOrRel) {
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(EXT_ROOT_OS, absOrRel);
  let rel = abs;
  if (rel.startsWith(EXT_ROOT_OS)) {
    rel = rel.slice(EXT_ROOT_OS.length);
    if (rel.startsWith(OS_SEP)) rel = rel.slice(1);
  }
  return rel.split(OS_SEP).join("/");
}

function collectAllTestEntries() {
  const testsDir = toOsPath("tests");
  const entries = ["test/test-modules.ts"];
  if (existsSync(testsDir)) {
    for (const name of readdirSync(testsDir)) {
      if (name.endsWith(".test.mjs")) entries.push("tests/" + name);
    }
  }
  return entries;
}

// ============================================================================
// 主流程
// ============================================================================
function main() {
  const { entries: rawEntries, checkForbidden, allTests, jsonOut } = parseArgs(process.argv.slice(2));

  let entries;
  if (allTests) {
    entries = collectAllTestEntries();
  } else if (rawEntries.length > 0) {
    entries = rawEntries.map(resolveEntry);
  } else {
    entries = ["test/test-modules.ts"];
  }

  const entryResults = entries.map(computeClosure);

  // 聚合：模块级 owner 清单（reachedFrom 反向映射）
  const modules = {};
  const reachedFromMap = new Map(); // modulePath -> Set<entry>
  for (const r of entryResults) {
    for (const mod of r.closure) {
      if (!reachedFromMap.has(mod)) reachedFromMap.set(mod, new Set());
      reachedFromMap.get(mod).add(r.entry);
      if (!modules[mod]) {
        const info = loadModule(mod);
        modules[mod] = {
          path: mod,
          exists: info.exists,
          forbidden: info.forbidden,
          forbiddenType: info.forbiddenType,
          directImports: info.directImports,
          importKinds: info.importKinds,
          reachedFrom: [], // 填充于下方
        };
      }
    }
  }
  for (const [mod, reached] of reachedFromMap) {
    modules[mod].reachedFrom = [...reached].sort();
  }

  // forbidden 汇总
  const forbiddenByType = { "legacy-index": 0, agents: 0, workflow: 0, lab: 0 };
  const violationsByEntry = {};
  let totalForbiddenModules = 0;
  for (const mod of Object.keys(modules)) {
    if (modules[mod].forbidden) {
      totalForbiddenModules++;
      forbiddenByType[modules[mod].forbiddenType]++;
    }
  }
  for (const r of entryResults) {
    if (r.forbiddenCount > 0) {
      violationsByEntry[r.entry] = r.forbiddenHits.map((h) => ({
        module: h.module,
        forbiddenType: h.forbiddenType,
        via: h.via,
      }));
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    extRoot: EXT_ROOT,
    scanner: "dependency-closure-scanner.mjs (LEGACY-CLOSURE-SCANNER-1)",
    entries: entryResults.map((r) => ({
      entry: r.entry,
      closureSize: r.closureSize,
      forbiddenCount: r.forbiddenCount,
      forbiddenHits: r.forbiddenHits,
      closure: r.closure,
    })),
    modules,
    forbiddenSummary: {
      totalForbiddenModules,
      byType: forbiddenByType,
      violationsByEntry,
    },
  };

  // 写 JSON
  const outPath = jsonOut
    ? (path.isAbsolute(jsonOut) ? jsonOut : path.join(EXT_ROOT_OS, jsonOut))
    : path.join(EXT_ROOT_OS, "reports", "dependency-closure.json");
  ensureDir(path.dirname(outPath));
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  // 人类可读摘要
  console.log("[closure-scanner] 入口数:", entries.length);
  for (const r of entryResults) {
    console.log(`  - ${r.entry}: 闭包 ${r.closureSize} 模块, forbidden ${r.forbiddenCount}`);
  }
  console.log("[closure-scanner] 唯一模块总数:", Object.keys(modules).length);
  console.log("[closure-scanner] forbidden 模块总数:", totalForbiddenModules);
  if (totalForbiddenModules > 0) {
    console.log("[closure-scanner] forbidden 按类型:", JSON.stringify(forbiddenByType));
    for (const [entry, hits] of Object.entries(violationsByEntry)) {
      console.log(`  [violation] ${entry}:`);
      for (const h of hits) {
        console.log(`      ${h.module} (${h.forbiddenType}) via ${h.via}`);
      }
    }
  }
  console.log("[closure-scanner] JSON 报告:", outPath);

  if (checkForbidden && totalForbiddenModules > 0) {
    console.error("[closure-scanner] --check-forbidden: 发现 forbidden 依赖，exit 1");
    process.exit(1);
  }
}

function ensureDir(osDir) {
  if (!osDir || existsSync(osDir)) return;
  mkdirSync(osDir, { recursive: true });
}

main();
