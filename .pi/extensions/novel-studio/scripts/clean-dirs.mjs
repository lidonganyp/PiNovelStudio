/**
 * PiNovelStudio — 清理构建输出目录
 *
 * 构建前清理 dist/ 与 dist-eval/ 与 dist-test/，避免旧产物污染
 * （例如旧 monolithic 构建残留的 dist/lab/ 不应出现在生产 dist/ 中）。
 *
 * 用法：
 *   node scripts/clean-dirs.mjs                        # 清理 dist + dist-eval + dist-test
 *   node scripts/clean-dirs.mjs dist                   # 仅清理 dist
 *   node scripts/clean-dirs.mjs dist-eval              # 仅清理 dist-eval
 */
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, "..");

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["dist", "dist-eval", "dist-test"];
for (const dir of dirs) {
  const target = resolve(extRoot, dir);
  rmSync(target, { recursive: true, force: true });
}
