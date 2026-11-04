// E2E fixture server (tests only): same App and CSS, synthetic records, no backend.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('./e2e-fixtures', import.meta.url)),
  plugins: [react()],
  appType: 'spa',
  server: { host: '127.0.0.1', port: 4318, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
});
