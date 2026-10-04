import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 600 },
});
