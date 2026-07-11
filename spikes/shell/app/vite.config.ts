import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // shells load the app from a dev server (dev) or built dist (packaged)
  server: { port: 5173, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
  clearScreen: false,
});
