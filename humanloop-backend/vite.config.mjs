import { defineConfig } from 'vite';
export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true, proxy: { '/ws': { target: 'ws://127.0.0.1:8080', ws: true }, '/api': 'http://127.0.0.1:8080' } },
  build: { target: 'es2022' },
});
