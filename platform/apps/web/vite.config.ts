/**
 * Vite 配置：开发端口 5173，/api 代理到本地 NestJS（3000）。
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        timeout: 310_000,
        proxyTimeout: 310_000,
      },
    },
  },
});
