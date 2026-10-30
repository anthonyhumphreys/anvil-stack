import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const previewRoot = fileURLToPath(
  new URL('../src/renderer/components/chat/replay/dev-preview', import.meta.url),
);

export default defineConfig({
  root: previewRoot,
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4179,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
});
