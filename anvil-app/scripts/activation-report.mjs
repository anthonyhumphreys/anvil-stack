#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

if (!process.versions.electron) {
  const electronPath = require('electron');
  const result = spawnSync(electronPath, [scriptPath, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} else {
  try {
    await runReport();
  } catch (error) {
    process.stderr.write(`activation-report: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function runReport() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const dbPath = path.resolve(options.db ?? defaultDatabasePath());
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (error) {
    throw new Error(`Could not load the Electron SQLite driver: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`Could not open ${dbPath}: ${errorMessage(error)}`, { cause: error });
  }

  try {
    const columns = db.prepare('PRAGMA table_info(activation_events)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    for (const required of ['event', 'payload', 'created_at', 'app_run_id', 'journey_id']) {
      if (!columnNames.has(required)) {
        throw new Error(
          `The selected database does not have the ${required} activation measurement column. Update Anvil to schema v112 first.`,
        );
      }
    }

    const rows = db
      .prepare(
        `SELECT id, event, app_run_id, journey_id, payload, created_at
         FROM activation_events ORDER BY id`,
      )
      .all();
    const reportModule = await loadMeasurementModule();
    const report = reportModule.buildActivationMeasurementReport(rows);
    const comparison = options.compare
      ? reportModule.compareActivationJourneys(report, options.compare[0], options.compare[1])
      : null;

    if (options.compare && !comparison) {
      throw new Error(
        `Could not find both journeys. Use the IDs printed by this report, then pass --compare <left-id> <right-id>.`,
      );
    }

    const output = options.compare ? comparison : report;
    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (options.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.resolve(options.out), json, { encoding: 'utf8', flag: 'wx' });
    }

    if (options.json) process.stdout.write(json);
    else process.stdout.write(formatReport(report, comparison, dbPath, options.out));
  } finally {
    db.close();
  }
}

async function loadMeasurementModule() {
  const { readFile } = await import('node:fs/promises');
  const ts = await import('typescript');
  const sourcePath = path.resolve(
    path.dirname(scriptPath),
    '../src/shared/activation-measurement.ts',
  );
  const source = await readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(output, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

function parseArguments(args) {
  const options = { json: false, help: false, compare: null };
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const argument = forwardedArgs[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--db') options.db = requiredValue(forwardedArgs, ++index, '--db');
    else if (argument === '--out') options.out = requiredValue(forwardedArgs, ++index, '--out');
    else if (argument === '--compare') {
      const left = requiredValue(forwardedArgs, ++index, '--compare');
      const right = requiredValue(forwardedArgs, ++index, '--compare');
      options.compare = [left, right];
    } else {
      throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
    }
  }
  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--'))
    throw new Error(`${option} requires a value.\n\n${usage()}`);
  return value;
}

function defaultDatabasePath() {
  const profile = process.env.ANVIL_DEV_USER_DATA_PATH?.trim();
  if (profile) return path.join(profile, 'anvil.db');

  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Anvil', 'anvil.db');
  }
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'Anvil', 'anvil.db');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(configHome, 'Anvil', 'anvil.db');
}

function formatReport(report, comparison, dbPath, outPath) {
  const lines = [
    'Local activation report',
    `Database: ${dbPath}`,
    `Started journeys: ${report.totals.startedJourneys}`,
    `Onboarding completion observed: ${report.totals.onboardingCompleted}/${report.totals.startedJourneys}`,
    `Possible onboarding drop-off: ${report.totals.possibleOnboardingDropoff} (app interruption is unknown)`,
    `Composer enabled: ${formatTiming(report.totals.composerEnabled)}`,
    `First change summary viewed: ${formatTiming(report.totals.firstChangeSummaryViewed)}`,
    `First kept change: ${formatTiming(report.totals.firstChangeApplied)}`,
    `Journeys with a blocked composer: ${report.totals.journeysWithBlockedComposer}`,
    `Index completion observations: ${report.totals.indexObservations}`,
    `Enrichment observations: ${report.totals.enrichmentObservations}`,
    `Confirmed pull requests: ${report.totals.pullRequestsOpened}`,
    `Legacy diff_proposed events (untrusted): ${report.totals.legacyDiffProposedEvents}`,
    `Events outside an onboarding journey: ${report.totals.eventsOutsideJourney}`,
    `Legacy events without IDs: ${report.totals.legacyUnscopedEvents}`,
    '',
    'Journeys',
  ];

  if (report.journeys.length === 0) lines.push('  No journey IDs are recorded yet.');
  for (const journey of report.journeys) {
    lines.push(
      `  ${journey.journeyId}`,
      `    started ${journey.startedAt}; app runs ${journey.appRunIds.length}; onboarding ${journey.onboarding.status}`,
      `    composer ${formatElapsed(journey.milestones.composerEnabledMs)}; first summary viewed ${formatElapsed(journey.milestones.firstChangeSummaryViewedMs)}; first kept change ${formatElapsed(journey.milestones.firstChangeAppliedMs)}`,
      `    blocked composer ${journey.blockedShownCount} times; confirmed PRs ${journey.pullRequestOpenedCount}`,
      `    indexing observations ${journey.indexObservations.length}; enrichment observations ${journey.enrichment.observations}`,
    );
  }

  if (comparison) {
    lines.push(
      '',
      `Paired comparison (right minus left): ${comparison.left.journeyId} -> ${comparison.right.journeyId}`,
      `  Composer enabled: ${formatDelta(comparison.timingDeltaMs.composerEnabled)}`,
      `  First change summary viewed: ${formatDelta(comparison.timingDeltaMs.firstChangeSummaryViewed)}`,
      `  First kept change: ${formatDelta(comparison.timingDeltaMs.firstChangeApplied)}`,
    );
  }

  lines.push(
    '',
    'Interpretation limits',
    '  Summary viewed means a completed turn summary was rendered; it does not prove a person read it or that a new change was generated.',
    '  Actual new-change generation is not instrumented. Legacy diff_proposed events are untrusted and excluded from timing.',
    '  Active human, active time, app interruption, model usage, and output quality are unknown or not recorded.',
    '  A pull request is counted only when a pull_request_opened event was recorded.',
  );
  if (outPath) lines.push('', `JSON exported to ${path.resolve(outPath)}`);
  return `${lines.join('\n')}\n`;
}

function formatTiming(summary) {
  return `${summary.observed} observed; median ${formatElapsed(summary.medianMs)}`;
}

function formatElapsed(value) {
  if (value === null) return 'not observed';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatDelta(value) {
  if (value === null) return 'not comparable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatElapsed(value)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return [
    'Usage: pnpm activation:report [--db <path>] [--json] [--out <path>] [--compare <left-id> <right-id>]',
    '',
    'Reads local activation_events from SQLite. It opens the database read-only.',
    'Use --json to print report JSON or --out to create a new JSON export file.',
    'Use --compare with two journey IDs from the report for a paired task comparison.',
  ].join('\n');
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`activation-report: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
