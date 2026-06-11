import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const buildBrand = process.env.ANVIL_BRAND ?? process.env.npm_config_brand ?? '';
const define = {
  'process.env.ANVIL_BUILD_BRAND': JSON.stringify(buildBrand),
};

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: 'src/main/index.ts',
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
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
  },
});
