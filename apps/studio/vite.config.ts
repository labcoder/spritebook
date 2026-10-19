import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The studio frontend. The Tauri shell loads this from the dev server (dev)
// or from dist/ (packaged); a plain browser gets the demo-data bridge, which
// is what CI and the in-session preview verify chrome and tokens against.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/.build/**'] } },
  preview: { port: 4175, strictPort: true },
  // three/webgpu has a TOP-LEVEL AWAIT that es2022 cannot express; the
  // viewport skill names this exact trap. Both the build and the dep
  // pre-bundle need esnext or the entry fails to transform.
  build: { outDir: 'dist', target: 'esnext' },
  clearScreen: false,
  optimizeDeps: {
    // Keep first-start optimization bounded; Rust outputs are excluded from the watcher above.
    noDiscovery: true,
    esbuildOptions: { target: 'esnext' },
    include: [
      'three',
      'three/webgpu',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/controls/TransformControls.js',
      'camera-controls',
      'react',
      'react/jsx-runtime',
      'react-dom/client',
      '@base-ui/react/menu',
      '@lingui/core',
      '@lingui/react',
    ],
  },
});
