import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 渲染层打包进 Electron 的静态目录，由内核的本机服务提供；apps/desktop/static 里的图标原样复制
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  publicDir: '../desktop/static',
  build: {
    outDir: '../desktop/dist/static',
    emptyOutDir: true,
    assetsDir: 'assets',
    // 本机加载，不走网络，单个大包没有下载成本
    chunkSizeWarningLimit: 2000,
  },
});
