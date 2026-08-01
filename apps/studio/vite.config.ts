import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The studio frontend. The Tauri shell loads this from the dev server (dev)
// or from dist/ (packaged); a plain browser gets the demo-data bridge, which
// is what CI and the in-session preview verify chrome and tokens against.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  preview: { port: 4175, strictPort: true },
  // three/webgpu has a TOP-LEVEL AWAIT that es2022 cannot express; the
  // viewport skill names this exact trap. Both the build and the dep
  // pre-bundle need esnext or the entry fails to transform.
  build: { outDir: 'dist', target: 'esnext' },
  clearScreen: false,
  optimizeDeps: {
    // NO lazy discovery: the rolldown scanner wedges the whole dev server
    // for minutes crawling Deno's junction-heavy .deno store on Windows —
    // the first request after any lockfile change answered NOTHING (not
    // even index.html) while `[optimizer] scanning dependencies...` hung,
    // which is exactly the white first-run window the maintainer reported
    // (a rerun "worked" only by hitting the orphaned, finally-warm vite).
    // Every dependency the app imports is listed EXPLICITLY instead; add
    // new ones here or they load unbundled (slower, still correct).
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
