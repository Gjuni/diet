import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 시 /api 는 백엔드(기본 http://localhost:4000)로 프록시 → 같은 출처라 SameSite=Strict 쿠키가 그대로 동작한다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
