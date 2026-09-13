import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureReviewSnapshot, reviewGit } from '../review-snapshot.service.js';
import type { ReviewScenario } from '../../../shared/change-review-types.js';
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => tmpdir() } }));
import { runReviewSide } from '../change-review-runner.service.js';
const moduleRoot = process.env.ANVIL_REVIEW_PLAYWRIGHT_ROOT;
const root = mkdtempSync(join(tmpdir(), 'anvil-review-integration-'));
afterAll(() => {
  try {
    if (process.env.ANVIL_REVIEW_QA_OUTPUT) {
      for (const name of ['first', 'replay']) {
        if (existsSync(join(root, name)))
          cpSync(join(root, name), join(process.env.ANVIL_REVIEW_QA_OUTPUT, name), {
            recursive: true,
          });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
describe.skipIf(!moduleRoot)('real browser review journey', () => {
  it('finds a seeded mobile regression, then passes the same scenario after a fix', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"review-fixture","type":"module"}');
    symlinkSync(join(moduleRoot!, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(
      join(repo, 'server.mjs'),
      `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(readFileSync('index.html'));}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    const html =
      '<!doctype html><html><head><style>body{font:16px system-ui;padding:32px}button,input{font:inherit;padding:10px;margin:8px}BAD_STYLE</style></head><body><main><h1>Settings</h1><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#error\').textContent=\'Please use a valid name\'">Save</button><p id="error"></p><button id="retry">Retry</button></main></body></html>';
    writeFileSync(join(repo, 'index.html'), html.replace('BAD_STYLE', ''));
    reviewGit(repo, ['init']);
    reviewGit(repo, ['config', 'user.name', 'Review fixture']);
    reviewGit(repo, ['config', 'user.email', 'fixture@localhost']);
    reviewGit(repo, ['add', '.']);
    reviewGit(repo, ['commit', '-m', 'test: seed settings journey']);
    const base = reviewGit(repo, ['rev-parse', 'HEAD']);
    const scenario: ReviewScenario = {
      name: 'Invalid settings',
      fixtureVersion: 'static-v1',
      resetCommand: 'node -e "process.exit(0)"',
      startCommand: 'node server.mjs',
      readyPath: '/',
      viewports: [
        { name: 'Desktop', width: 1280, height: 800 },
        { name: 'Mobile', width: 390, height: 844 },
      ],
      steps: [
        { action: 'goto', value: '/' },
        { action: 'fill', locator: '#name', value: 'invalid' },
        { action: 'click', locator: '#save' },
        { action: 'text', locator: '#error', value: 'Please use a valid name' },
        { action: 'visible', locator: '#retry' },
      ],
    };
    const runDir = join(root, 'first');
    mkdirSync(runDir);
    const log: string[] = [];
    const input = {
      repoPath: repo,
      commit: base,
      scenario,
      runDir,
      signal: new AbortController().signal,
      log: (text: string) => log.push(text),
    };
    const baseline = await runReviewSide({ ...input, side: 'base' });
    expect(baseline.map((c) => c.outcome)).toEqual(['passed', 'passed']);
    writeFileSync(
      join(repo, 'index.html'),
      html.replace('BAD_STYLE', '@media(max-width:600px){#retry{display:none}}'),
    );
    const brokenSnapshot = captureReviewSnapshot(repo);
    const broken = await runReviewSide({ ...input, side: 'candidate', snapshot: brokenSnapshot });
    expect(broken.map((c) => c.outcome)).toEqual(['passed', 'failed']);
    expect(broken[1].steps.at(-1)?.outcome).toBe('failed');
    expect(existsSync(join(runDir, broken[1].image))).toBe(true);
    expect(existsSync(join(runDir, broken[1].trace))).toBe(true);
    writeFileSync(join(repo, 'index.html'), html.replace('BAD_STYLE', ''));
    const fixed = await runReviewSide({
      ...input,
      runDir: join(root, 'replay'),
      side: 'candidate',
      snapshot: captureReviewSnapshot(repo),
    });
    expect(fixed.map((c) => c.outcome)).toEqual(['passed', 'passed']);
    expect(reviewGit(repo, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(
      1,
    );
    expect(reviewGit(repo, ['rev-parse', 'HEAD'])).toBe(base);
  }, 90_000);
});
