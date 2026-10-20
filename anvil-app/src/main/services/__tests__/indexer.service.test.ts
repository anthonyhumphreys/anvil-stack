import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyseRepo } from '../indexer.service.js';

let repoDir = '';

function write(rel: string, content = 'export const x = 1;\n'): void {
  const full = path.join(repoDir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), 'anvil-indexer-'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('identifyModules (via analyseRepo)', () => {
  it('groups a balanced repo by top-level directory', async () => {
    write('package.json', '{}');
    write('src/index.ts');
    write('src/app.ts');
    write('lib/util.ts');
    write('docs/guide.md', '# guide\n');

    const result = await analyseRepo(repoDir);
    const paths = result.modules.map((m) => m.path).sort();
    expect(paths).toEqual(['.', 'docs', 'lib', 'src']);
  });

  it('descends one level when one top-level dir dominates (>60% of files)', async () => {
    // 7 files under src/, 3 elsewhere → src/ is 70% and must split.
    write('package.json', '{}');
    write('docs/guide.md', '# guide\n');
    write('tools/build.sh', '#!/bin/sh\n');
    write('src/server/index.ts');
    write('src/server/routes.ts');
    write('src/client/app.ts');
    write('src/client/view.ts');
    write('src/shared/types.ts');
    write('src/shared/util.ts');
    write('src/shared/constants.ts');

    const result = await analyseRepo(repoDir);
    const paths = result.modules.map((m) => m.path).sort();
    expect(paths).toContain('src/server');
    expect(paths).toContain('src/client');
    expect(paths).toContain('src/shared');
    expect(paths).toContain('docs');
    expect(paths).toContain('tools');
    expect(paths).not.toContain('src');
  });

  it('honours pnpm-workspace.yaml member dirs over top-level grouping', async () => {
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    write('package.json', '{}');
    write('packages/api/package.json', '{}');
    write('packages/api/src/index.ts');
    write('packages/web/package.json', '{}');
    write('packages/web/src/main.ts');
    write('scripts/dev.sh', '#!/bin/sh\n');

    const result = await analyseRepo(repoDir);
    const paths = result.modules.map((m) => m.path);
    expect(paths).toContain('packages/api');
    expect(paths).toContain('packages/web');
    // 'packages' itself must not appear as a single giant module.
    expect(paths).not.toContain('packages');
  });

  it('honours package.json workspaces', async () => {
    write('package.json', JSON.stringify({ workspaces: ['apps/*'] }));
    write('apps/mobile/index.ts');
    write('apps/desktop/index.ts');
    write('README.md', '# hi\n');

    const result = await analyseRepo(repoDir);
    const paths = result.modules.map((m) => m.path);
    expect(paths).toContain('apps/mobile');
    expect(paths).toContain('apps/desktop');
    expect(paths).not.toContain('apps');
  });

  it('honours Cargo.toml [workspace] members', async () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    write('crates/core/src/lib.rs', 'pub fn a() {}\n');
    write('crates/cli/src/main.rs', 'fn main() {}\n');

    const result = await analyseRepo(repoDir);
    const paths = result.modules.map((m) => m.path);
    expect(paths).toContain('crates/core');
    expect(paths).toContain('crates/cli');
    expect(paths).not.toContain('crates');
  });
});
