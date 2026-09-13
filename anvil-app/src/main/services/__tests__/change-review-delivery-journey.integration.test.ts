import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../../db/schema.js';
import {
  isFindingAccepted,
  type ChangeReview,
  type ReviewScenario,
} from '../../../shared/change-review-types.js';
import { reviewGit } from '../review-snapshot.service.js';

const environment = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => environment.userData,
    getAppPath: () => process.cwd(),
    getVersion: () => 'integration-fixture',
  },
  shell: {},
  dialog: {},
  BrowserWindow: {},
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
// This is a deterministic provider fixture, not a live Linear account or external dogfood run.
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: (connectionId: string) =>
    connectionId === 'fixture-linear'
      ? {
          getItem: async (id: string) => ({
            id,
            provider: 'linear',
            title: 'Fixture: preserve mobile retry',
            acceptanceCriteria: '- Retry remains visible on mobile after invalid input.',
          }),
        }
      : undefined,
}));
import {
  annotateChangeReview,
  cleanupChangeReviews,
  configureChangeReview,
  createChangeReview,
  decideChangeReview,
  exportChangeReview,
  getChangeReview,
  linkReviewEvidence,
  repairReviewFinding,
  resolveReviewFinding,
  resolveReviewRepairPaths,
  runChangeReview,
} from '../change-review.service.js';

const moduleRoot = process.env.ANVIL_REVIEW_PLAYWRIGHT_ROOT;
const root = mkdtempSync(join(tmpdir(), 'anvil-delivery-journey-'));
environment.userData = join(root, 'user-data');
const databasePath = join(root, 'journey.sqlite');
let db = new Database(databasePath);
db.exec(SCHEMA_SQL);
afterAll(() => {
  cleanupChangeReviews();
  db.close();
  try {
    if (process.env.ANVIL_REVIEW_QA_OUTPUT && existsSync(environment.userData)) {
      const output = join(process.env.ANVIL_REVIEW_QA_OUTPUT, 'connected-delivery-journey');
      mkdirSync(output, { recursive: true });
      cpSync(environment.userData, join(output, 'user-data'), { recursive: true });
      cpSync(databasePath, join(output, 'journey.sqlite'));
      if (existsSync(join(root, 'evidence.json')))
        cpSync(join(root, 'evidence.json'), join(output, 'evidence.json'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
async function completed(id: string): Promise<ChangeReview> {
  await vi.waitFor(() => expect(getChangeReview(id).runs.at(-1)?.outcome).not.toBe('running'), {
    timeout: 70_000,
    interval: 200,
  });
  return getChangeReview(id);
}

describe.skipIf(!moduleRoot)(
  'persisted delivery journey with a real browser and fixture Work Item',
  () => {
    it('connects retained execution, PR evidence, a seeded failure, repair, replay and human acceptance', async () => {
      const repo = join(root, 'repo');
      const retained = join(root, 'retained-candidate');
      mkdirSync(repo);
      writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
      writeFileSync(
        join(repo, 'package.json'),
        '{"name":"connected-review-fixture","type":"module"}',
      );
      writeFileSync(
        join(repo, 'server.mjs'),
        "import {createServer} from 'node:http';import {readFileSync} from 'node:fs';createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(readFileSync('index.html'));}).listen(Number(process.env.PORT),'127.0.0.1');",
      );
      const html =
        '<!doctype html><html><head><style>body{font:16px system-ui;padding:24px}button,input{font:inherit;padding:10px}SEED</style></head><body><main><h1>Settings</h1><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#error\').textContent=\'Please use a valid name\'">Save</button><p id="error"></p><button id="retry">Retry</button></main></body></html>';
      writeFileSync(join(repo, 'index.html'), html.replace('SEED', ''));
      reviewGit(repo, ['init', '-b', 'main']);
      reviewGit(repo, ['config', 'user.name', 'Delivery fixture']);
      reviewGit(repo, ['config', 'user.email', 'fixture@localhost']);
      reviewGit(repo, ['add', '.']);
      reviewGit(repo, ['commit', '-m', 'test: establish fixture baseline']);
      const head = reviewGit(repo, ['rev-parse', 'HEAD']);
      reviewGit(repo, ['worktree', 'add', '-b', 'candidate', retained]);
      symlinkSync(join(moduleRoot!, 'node_modules'), join(retained, 'node_modules'), 'dir');
      writeFileSync(
        join(retained, 'index.html'),
        html.replace('SEED', '@media(max-width:600px){#retry{display:none}}'),
      );
      db.prepare(
        "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES ('ws','Fixture workspace','now','now')",
      ).run();
      db.prepare("INSERT INTO repos(id,name,path) VALUES ('repo','Fixture repository',?)").run(
        repo,
      );
      db.prepare(
        "INSERT INTO workspace_repos(workspace_id,repo_id,added_at) VALUES ('ws','repo','now')",
      ).run();
      for (const id of ['supervisor', 'repair-thread'])
        db.prepare(
          "INSERT INTO chat_threads(id,workspace_id,persona_id,title,repo_ids_json) VALUES (?,'ws','coder','Fixture delivery','[\"repo\"]')",
        ).run(id);
      const workItemRef = { connectionId: 'fixture-linear', provider: 'linear', id: 'FIXTURE-7' };
      db.prepare(
        "INSERT INTO workflow_runs(id,template_id,template_name,workspace_id,graph_json,kickoff,status,supervisor_thread_id,node_runs_json,created_at) VALUES ('workflow','delivery','Delivery','ws',?,'Fixture work','completed','supervisor','[]','now')",
      ).run(JSON.stringify({ executionPaths: [{ id: 'repo', path: retained }], workItemRef }));
      let review = await createChangeReview({
        workspaceId: 'ws',
        repoId: 'repo',
        baseRef: 'main',
        origin: {
          workflowRunId: 'workflow',
          pullRequest: { id: '7', number: 7, provider: 'github', headSha: head },
        },
      });
      expect(review.workItemRef).toEqual(workItemRef);
      expect(review.origin?.executionPath).toBe(realpathSync(retained));
      const scenario: ReviewScenario = {
        name: 'Invalid settings recovery',
        fixtureVersion: 'connected-fixture-v1',
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
      review = configureChangeReview(review.id, scenario);
      const scenarioVersion = review.scenarioVersion;
      db.prepare(
        "INSERT INTO pull_request_visualisations(id,repo_id,provider,pull_request_id,head_sha,status,pull_request_json,data_json,created_at) VALUES ('vis','repo','github','7',?,'ready','{}',?,?)",
      ).run(
        head,
        JSON.stringify({
          chapters: [{ id: 'recovery', title: 'Recovery' }],
          risks: [{ id: 'mobile-risk', title: 'Mobile recovery' }],
        }),
        new Date().toISOString(),
      );
      const source = {
        visualisationId: 'vis',
        headSha: head,
        kind: 'chapter' as const,
        id: 'recovery',
      };
      review = linkReviewEvidence(review.id, {
        source,
        criterionId: review.criteria[0].items[0].id,
        scenarioVersion,
      });
      expect(review.decisions).toHaveLength(0);
      await runChangeReview(review.id);
      review = await completed(review.id);
      const failed = review.runs[0];
      expect(failed.base.map((capture) => capture.outcome)).toEqual(['passed', 'passed']);
      expect(failed.candidateCaptures.map((capture) => capture.outcome)).toEqual([
        'passed',
        'failed',
      ]);
      expect(failed.evidenceAvailable).toBe(true);
      const mobile = failed.candidateCaptures[1];
      review = annotateChangeReview(review.id, {
        runId: failed.id,
        captureId: mobile.id,
        note: 'Seeded regression: mobile Retry is hidden.',
        locator: '#retry',
      });
      const finding = review.findings[0];
      review = linkReviewEvidence(review.id, {
        source: { ...source, kind: 'risk', id: 'mobile-risk' },
        findingId: finding.id,
      });
      review = repairReviewFinding(review.id, finding.id, { threadId: 'repair-thread' });
      expect(resolveReviewRepairPaths('repair-thread', ['repo'])).toEqual([realpathSync(retained)]);
      resolveReviewFinding(review.id, finding.id, 'ready_for_recheck', failed.id);
      expect(() => resolveReviewFinding(review.id, finding.id, 'accepted', failed.id)).toThrow(
        'subsequent passing replay',
      );
      // Reopen the actual SQLite database to prove handoff/evidence survives process persistence.
      db.close();
      db = new Database(databasePath);
      expect(getChangeReview(review.id).findings[0].repair?.threadId).toBe('repair-thread');
      expect(resolveReviewRepairPaths('repair-thread', ['repo'])).toEqual([realpathSync(retained)]);
      writeFileSync(join(retained, 'index.html'), html.replace('SEED', ''));
      expect(getChangeReview(review.id).freshness).toBe('stale');
      await runChangeReview(review.id);
      review = await completed(review.id);
      const replay = review.runs[1];
      expect(replay.outcome).toBe('passed');
      expect(replay.scenarioVersion).toBe(scenarioVersion);
      expect(replay.criteriaVersion).toBe(failed.criteriaVersion);
      expect(replay.candidate.tree).not.toBe(failed.candidate.tree);
      expect(review.evidenceLinks?.every((link) => link.freshness === 'stale')).toBe(true);
      review = resolveReviewFinding(review.id, finding.id, 'accepted', replay.id);
      expect(review.findings[0].repair?.replayRunId).toBe(replay.id);
      review = linkReviewEvidence(review.id, {
        source,
        criterionId: review.criteria[0].items[0].id,
        scenarioVersion,
        runId: replay.id,
        captureId: replay.candidateCaptures[1].id,
      });
      review = await decideChangeReview(review.id, {
        runId: replay.id,
        outcome: 'accepted',
        note: 'Integration fixture decision: inspected replay capture and observed mobile Retry assertion.',
        criterionDecisions: review.criteria[0].items.map((criterion) => ({
          criterionId: criterion.id,
          outcome: 'accepted',
          note: 'Fixture human-decision input after passing mobile replay.',
        })),
      });
      expect(isFindingAccepted(getChangeReview(review.id), review.findings[0])).toBe(true);
      expect(review.decisions[0].snapshot).toBe(replay.candidate.tree);
      expect(review.evidenceLinks?.at(-1)?.freshness).toBe('current');
      expect(readFileSync(join(repo, 'index.html'), 'utf8')).toBe(html.replace('SEED', ''));
      expect(reviewGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(
        reviewGit(repo, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1,
      ).toBe(2);
      const exported = exportChangeReview(review.id, 'json');
      writeFileSync(join(root, 'evidence.json'), exported);
      expect(JSON.parse(exported).findings[0].acceptanceCurrent).toBe(true);
      db.close();
      db = new Database(databasePath);
      expect(getChangeReview(review.id).decisions).toHaveLength(1);
    }, 150_000);
  },
);
