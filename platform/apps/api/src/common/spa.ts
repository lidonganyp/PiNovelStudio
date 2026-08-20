/**
 * 生产静态站点：API 托管 platform-web dist（§12.1 默认 api 托管）。
 * 仅 NODE_ENV=production 或显式 WEB_DIST_DIR 时启用，避免测试误把 SPA 当 404。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveWebDist(
  nodeEnv: string,
  webDistDir: string,
  cwd: string = process.cwd(),
): string | null {
  const explicit = webDistDir.trim();
  if (explicit) {
    return existsSync(resolve(explicit, 'index.html')) ? resolve(explicit) : null;
  }
  if (nodeEnv !== 'production') {
    return null;
  }
  const candidates = [resolve(cwd, 'web'), resolve(cwd, '../web/dist')];
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html'))) ?? null;
}
