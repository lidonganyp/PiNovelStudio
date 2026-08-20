// platform 工作区 ESLint 根配置（flat config）
// Phase 1 范围：仅 TypeScript 源码；Vue SFC lint 在 Phase 5 前端阶段补充。
// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/*.config.*',
      '**/*.js',
      'apps/web/**/*.vue',
      'apps/web/e2e/**',
      // novel-runtime 抽取属 Phase 3，本阶段不纳入 lint 范围
      'services/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
