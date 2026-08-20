/**
 * vitest 全局 setup：最先加载 .env（副作用模块），
 * 保证 env.ts 的 zod 校验在任何测试模块 import 前拿到环境变量。
 */
import '../src/config/load-env-file';
