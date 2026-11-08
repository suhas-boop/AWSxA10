import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const backend = 'http://127.0.0.1:8080';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: { '/api': backend, '/ws': { target: backend, ws: true }, '/ping': backend },
  },
});
