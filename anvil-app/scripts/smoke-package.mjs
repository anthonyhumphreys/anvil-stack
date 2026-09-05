import { app } from 'electron';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Run with the matching development Electron runtime. Resolve dependencies inside the archive.
// Usage: pnpm exec electron scripts/smoke-package.mjs /path/Anvil.app
const bundle = resolve(process.argv[2]);
const archive = join(bundle, 'Contents/Resources/app.asar');
const profile = mkdtempSync(join(tmpdir(), 'anvil-package-smoke-'));
app.setPath('userData', profile);

void app.whenReady().then(async () => {
  try {
    const require = createRequire(join(archive, 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    assert.deepEqual(db.prepare('SELECT 42 AS answer').get(), { answer: 42 });
    db.close();
    const pty = require('node-pty');
    await new Promise((resolve, reject) => {
      const terminal = pty.spawn('/bin/echo', ['anvil-native-smoke'], {
        cwd: profile,
        env: process.env,
      });
      let output = '';
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error('PTY timed out'));
      }, 5000);
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(() => {
        clearTimeout(timeout);
        if (output.includes('anvil-native-smoke')) resolve();
        else reject(new Error('PTY did not produce expected output'));
      });
    });
    for (const name of ['globby', 'openai', 'qrcode', 'simple-git', 'typescript', 'yaml', 'yazl']) {
      await import(pathToFileURL(require.resolve(name)).href);
    }
    for (const name of ['@anvilstack/cloud-cli', '@anvilstack/registry-cli']) {
      const root = join(archive, 'node_modules', name);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      for (const bin of Object.values(typeof pkg.bin === 'string' ? { bin: pkg.bin } : pkg.bin)) {
        assert.ok(existsSync(join(root, bin)), `Missing ${name} executable`);
      }
    }
    const source = 'export const answer = 42;';
    writeFileSync(join(profile, 'fixture.ts'), source);
    await new Promise((resolve, reject) => {
      const worker = new Worker(join(archive, 'out/main/repository-map.worker.js'), {
        workerData: {
          repoId: 'fixture',
          repositoryName: 'Fixture',
          repoPath: profile,
          files: [{ relativePath: 'fixture.ts', extension: '.ts', sizeBytes: source.length }],
          modules: [],
        },
      });
      let graph;
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Worker timed out'));
      }, 10_000);
      worker.on('message', (result) => {
        graph = result;
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        clearTimeout(timeout);
        if (
          code === 0 &&
          graph?.repoId === 'fixture' &&
          graph.nodes.some((node) => node.name === 'answer')
        )
          resolve();
        else reject(new Error(`Packaged worker failed: ${code}`));
      });
    });
    assert.ok(existsSync(join(archive, 'scripts/chrome-mcp-server.mjs')));
    console.log(
      'Packaged SQLite, PTY, runtime imports, CLI files, MCP helper and repository-map worker passed.',
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
});
