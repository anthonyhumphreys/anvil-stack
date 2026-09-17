// Bundles the headless daemon (src/daemon/main.ts) for plain Node.
// The `electron` module is aliased to a stub — the daemon has no Electron
// runtime dependency. Native modules stay external; the host needs
// `better-sqlite3` installed (or a checkout with pnpm install run).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/daemon/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(root, 'dist-daemon/anvil-daemon.mjs'),
  alias: { electron: join(root, 'src/daemon/electron-stub.ts') },
  external: ['better-sqlite3', 'node-pty'],
  banner: {
    js: "import { createRequire as __daemonCreateRequire } from 'node:module'; const require = __daemonCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('daemon bundle: dist-daemon/anvil-daemon.mjs');
