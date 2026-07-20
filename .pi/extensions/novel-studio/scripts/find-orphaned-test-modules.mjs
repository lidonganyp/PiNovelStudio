/**
 * 扫描所有测试文件的 import，找出不在 dist/、dist-eval/ 也不在 dist-test/ 的孤儿模块。
 * 这些模块需要加入对应编译 barrel（test/test-modules.ts 或 tsconfig.eval.json）
 * 才能被测试加载。
 *
 * LEGACY-LAB-BUILD-DELETE-1 (#10) 后：原 dist-lab/ 已删除，拆分为
 *   - dist-test/（测试专用 craft/agents/v2/utils/tools/dag/workflow，barrel: test/test-modules.ts）
 *   - dist-eval/（NovelBench + eval，tsconfig.eval.json）
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EXT_ROOT = join(__dirname, "..");
const DIST_DIR = join(EXT_ROOT, "dist");
const DIST_EVAL_DIR = join(EXT_ROOT, "dist-eval");
const DIST_TEST_DIR = join(EXT_ROOT, "dist-test");
const TESTS_DIR = join(EXT_ROOT, "tests");

function collectJsFiles(dir) {
  if (!existsSync(dir)) return new Set();
  const result = new Set();
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const rel = relative(EXT_ROOT, full).split(sep).join("/");
        result.add(rel);
      }
    }
  }
  walk(dir);
  return result;
}

const distFiles = collectJsFiles(DIST_DIR);
const distEvalFiles = collectJsFiles(DIST_EVAL_DIR);
const distTestFiles = collectJsFiles(DIST_TEST_DIR);
const distRel = new Set([...distFiles].map((p) => p.replace(/^dist\//, "")));
const distEvalRel = new Set([...distEvalFiles].map((p) => p.replace(/^dist-eval\//, "")));
const distTestRel = new Set([...distTestFiles].map((p) => p.replace(/^dist-test\//, "")));

// 收集所有测试文件中引用的 dist/ / dist-eval/ / dist-test/ 模块路径
const referencedModules = new Map(); // path -> [files]

for (const entry of readdirSync(TESTS_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
  const file = join(TESTS_DIR, entry.name);
  const src = readFileSync(file, "utf-8");

  // Pattern 1: 静态 import from "../dist/X.js" / "../dist-eval/X.js" / "../dist-test/X.js"
  // Pattern 2: 字符串字面量 "dist/X.js" / "dist-eval/X.js" / "dist-test/X.js"（动态 import）
  const patterns = [
    /(?:from\s*["']|\(["'])\.\.\/dist\/([^"']+\.js)["']/g,
    /(?:from\s*["']|\(["'])\.\.\/dist-eval\/([^"']+\.js)["']/g,
    /(?:from\s*["']|\(["'])\.\.\/dist-test\/([^"']+\.js)["']/g,
    /["']dist\/([^"']+\.js)["']/g,
    /["']dist-eval\/([^"']+\.js)["']/g,
    /["']dist-test\/([^"']+\.js)["']/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const modPath = m[1];
      if (!referencedModules.has(modPath)) {
        referencedModules.set(modPath, []);
      }
      referencedModules.get(modPath).push(entry.name);
    }
  }
}

// 找出引用了但既不在 dist 也不在 dist-eval / dist-test 的模块
const orphaned = [];
for (const [modPath, files] of referencedModules) {
  if (!distRel.has(modPath) && !distEvalRel.has(modPath) && !distTestRel.has(modPath)) {
    orphaned.push({ modPath, files });
  }
}

orphaned.sort((a, b) => a.modPath.localeCompare(b.modPath));

console.log(`[find-orphaned] 测试引用模块总数: ${referencedModules.size}`);
console.log(`[find-orphaned] dist/ .js 数: ${distFiles.size}`);
console.log(`[find-orphaned] dist-eval/ .js 数: ${distEvalFiles.size}`);
console.log(`[find-orphaned] dist-test/ .js 数: ${distTestFiles.size}`);
console.log(`[find-orphaned] 孤儿模块（不在 dist / dist-eval / dist-test）: ${orphaned.length}`);
console.log("");
console.log("孤儿模块清单（.ts 源路径 + 引用测试文件）：");
for (const o of orphaned) {
  const tsPath = o.modPath.replace(/\.js$/, ".ts");
  const srcExists = existsSync(join(EXT_ROOT, tsPath));
  console.log(`  ${srcExists ? "✓" : "✗"} ${tsPath}  ← ${o.files.join(", ")}`);
}
