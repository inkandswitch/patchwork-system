import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import path from 'path';

import patchworkExternals from '@inkandswitch/patchwork-bootloader/externals';

const external = [...patchworkExternals];

export default defineConfig({
  base: './',
  plugins: [
    topLevelAwait(),
    wasm(),
    react(),
    cssInjectedByJsPlugin({ relativeCSSInjection: true }),
  ],

  build: {
    sourcemap: true,
    cssCodeSplit: true,
    rollupOptions: {
      external,
      input: './src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
      preserveEntrySignatures: 'strict',
    },
  },

  worker: {
    format: 'es',
    rollupOptions: {
      external,
      output: {
        format: 'es',
      },
    },
    plugins: () => [wasm(), topLevelAwait()],
  },

  resolve: {
    alias: {
      // Direct file system path bypasses the 'exports' check
      'es-module-shims-worker': path.resolve(
        __dirname,
        'node_modules/es-module-shims/dist/es-module-shims.wasm.js',
      ),
    },
  },

  optimizeDeps: {
    // Prevent Vite from pre-bundling the shim (which causes the 'window' error)
    exclude: ['es-module-shims'],
  },
});
