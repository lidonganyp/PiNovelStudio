/**
 * 模块说明：最小 .env 文件加载器（无外部依赖，副作用模块）。
 * 从 process.cwd() 向上最多 3 级查找 .env（覆盖 apps/api、platform、容器 /app 三种运行位置），
 * 仅设置 process.env 中尚不存在的键；真实环境变量优先。
 * 注意：必须在 import ./config/env 之前加载（本文件为副作用模块，放 import 首行）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function loadEnvFile(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 3; depth++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      applyEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function applyEnvFile(envPath: string): void {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();
