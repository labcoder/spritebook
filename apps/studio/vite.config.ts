import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The studio frontend. The Tauri shell loads this from the dev server (dev)
// or from dist/ (packaged); a plain browser gets the demo-data bridge, which
// is what CI and the in-session preview verify chrome and tokens against.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  preview: { port: 4175, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
  clearScreen: false,
});
