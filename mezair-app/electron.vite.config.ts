import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { meshBuildDefines } from './scripts/mesh-build-config.mjs';

const buildBrand = process.env.MEZAIR_BRAND ?? process.env.npm_config_brand ?? '';
const updateOrigin = process.env.MEZAIR_UPDATE_ORIGIN ?? '';
const rawDeploymentEnv = process.env.MEZAIR_DEPLOYMENT_ENV;
const deploymentEnv = (rawDeploymentEnv === undefined ? 'staging' : rawDeploymentEnv)
  .trim()
  .toLowerCase();
if (deploymentEnv !== 'staging' && deploymentEnv !== 'production') {
  throw new Error(
    `Invalid MEZAIR_DEPLOYMENT_ENV "${deploymentEnv}". Expected "staging" or "production".`,
  );
}

const selectedHostedBackendUrl =
  deploymentEnv === 'production'
    ? (process.env.MEZAIR_PRODUCTION_HOSTED_BACKEND_URL ?? '').trim()
    : process.env.MEZAIR_STAGING_HOSTED_BACKEND_URL?.trim() ||
      process.env.MEZAIR_HOSTED_BACKEND_URL?.trim() ||
      '';
const define = {
  'process.env.MEZAIR_PREVIEW_BUILD': JSON.stringify(process.env.MEZAIR_PREVIEW_BUILD ?? ''),
  'process.env.MEZAIR_BUILD_BRAND': JSON.stringify(buildBrand),
  'process.env.MEZAIR_UPDATE_ORIGIN': JSON.stringify(updateOrigin),
  'process.env.MEZAIR_DEPLOYMENT_ENV': JSON.stringify(deploymentEnv),
  'process.env.MEZAIR_STAGING_HOSTED_BACKEND_URL': JSON.stringify(
    deploymentEnv === 'staging' ? selectedHostedBackendUrl : '',
  ),
  'process.env.MEZAIR_PRODUCTION_HOSTED_BACKEND_URL': JSON.stringify(
    deploymentEnv === 'production' ? selectedHostedBackendUrl : '',
  ),
};
const mainDefine = {
  ...define,
  ...meshBuildDefines({
    machineEndpoints: process.env.MEZAIR_MESH_MACHINE_ENDPOINTS,
    managedEndpoints: process.env.MEZAIR_MESH_MANAGED_ENDPOINTS,
  }),
};

export default defineConfig({
  main: {
    define: mainDefine,
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
