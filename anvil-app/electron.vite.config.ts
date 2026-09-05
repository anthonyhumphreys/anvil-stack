import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const buildBrand = process.env.ANVIL_BRAND ?? process.env.npm_config_brand ?? '';
const updateOrigin = process.env.ANVIL_UPDATE_ORIGIN ?? '';
const define = {
  'process.env.ANVIL_BUILD_BRAND': JSON.stringify(buildBrand),
  'process.env.ANVIL_UPDATE_ORIGIN': JSON.stringify(updateOrigin),
};

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: {
          index: 'src/main/index.ts',
          'repository-map.worker': 'src/main/workers/repository-map.worker.ts',
        },
      },
    },
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: 'src/preload/index.ts',
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    define,
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      manifest: true,
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
  },
});
