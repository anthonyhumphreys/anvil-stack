import {
  FACTORY_TERMINAL_STAGES,
  type FactoryDefinitionInput,
  type FactoryRun,
  type FactoryRunStage,
} from '../../../shared/factories';

/*
 * The Line: every factory run travels the same eight stations, from issue intake
 * to a verified merge. Stages map onto stations; off-line states (blocked, paused,
 * picked up) keep the station where the run stopped so the board never lies about
 * where work is.
 */

export type FactoryStationId =
  'intake' | 'build' | 'verify' | 'publish' | 'checks' | 'merge' | 'confirm' | 'done';

export interface FactoryStation {
  id: FactoryStationId;
  label: string;
  /** What happens at this station, in the user's terms. */
  description: string;
}

export const FACTORY_STATIONS: FactoryStation[] = [
  {
    id: 'intake',
    label: 'Intake',
    description: 'Claim the issue and prepare an isolated checkout',
  },
  { id: 'build', label: 'Build', description: 'Run the pinned workflow graph' },
  { id: 'verify', label: 'Verify', description: 'Prove each acceptance criterion' },
  { id: 'publish', label: 'PR', description: 'Publish the branch and pull request' },
  { id: 'checks', label: 'Checks', description: 'Wait for CI and review' },
  { id: 'merge', label: 'Merge', description: 'Approve and request the merge' },
  { id: 'confirm', label: 'Confirm', description: 'Observe the merge and run post-merge checks' },
  { id: 'done', label: 'Done', description: 'Merged and verified' },
];

const STAGE_STATION: Partial<Record<FactoryRunStage, FactoryStationId>> = {
  received: 'intake',
  implementing: 'build',
  repairing: 'build',
  validating: 'verify',
  publishing: 'publish',
  'waiting-checks': 'checks',
  'awaiting-merge-approval': 'merge',
  merging: 'merge',
  'verifying-merge': 'confirm',
  completed: 'done',
};

export const STAGE_LABELS: Record<FactoryRunStage, string> = {
  received: 'Received',
  implementing: 'Implementing',
  validating: 'Validating',
  publishing: 'Publishing',
  'waiting-checks': 'Waiting for checks',
  repairing: 'Repairing',
  'awaiting-merge-approval': 'Awaiting merge approval',
  merging: 'Merging',
  'verifying-merge': 'Verifying merge',
  cancelling: 'Cancellation pending',
  completed: 'Completed',
  blocked: 'Blocked',
  paused: 'Paused',
  cancelled: 'Cancelled',
  'taken-over': 'Picked up',
};

/**
 * - `live`: the factory is doing work right now
 * - `waiting`: waiting on GitHub (CI, reviews, a queued merge) or an auto-merge gate
 * - `needs-you`: a person must approve the current head
 * - `blocked`: stopped with an error; retry after reconciling
 */
export type FactoryRunState =
  | 'live'
  | 'waiting'
  | 'needs-you'
  | 'blocked'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'cancelled'
  | 'handed-off';

export interface FactoryRunPosition {
  station: FactoryStationId;
  stationIndex: number;
  state: FactoryRunState;
}

export function stationIndex(station: FactoryStationId): number {
  return FACTORY_STATIONS.findIndex((item) => item.id === station);
}

export function stationOf(id: FactoryStationId): FactoryStation {
  return FACTORY_STATIONS[stationIndex(id)];
}

/** Where a run stopped when its stage no longer says (older records lack resumeStage). */
function inferredStation(run: FactoryRun): FactoryStationId {
  if (run.resumeStage && STAGE_STATION[run.resumeStage]) return STAGE_STATION[run.resumeStage]!;
  if (run.mergeReceipt) return 'merge';
  if (run.pullRequest) return 'checks';
  if (run.evidence) return 'verify';
  if (run.checkout) return 'build';
  return 'intake';
}

export function runPosition(run: FactoryRun): FactoryRunPosition {
  const autoMerge = run.snapshot.definition.merge.mode === 'auto-merge';
  const station = STAGE_STATION[run.stage] ?? inferredStation(run);
  const state: FactoryRunState =
    run.stage === 'completed'
      ? 'done'
      : run.stage === 'cancelled'
        ? 'cancelled'
        : run.stage === 'taken-over'
          ? 'handed-off'
          : run.stage === 'blocked'
            ? 'blocked'
            : run.stage === 'paused'
              ? 'paused'
              : run.stage === 'cancelling' || run.pendingControl === 'cancel'
                ? 'cancelling'
                : run.stage === 'awaiting-merge-approval'
                  ? autoMerge
                    ? 'waiting'
                    : 'needs-you'
                  : run.stage === 'waiting-checks' ||
                      (run.stage === 'merging' && run.mergeReceipt?.state === 'queued')
                    ? 'waiting'
                    : 'live';
  return { station, stationIndex: stationIndex(station), state };
}

export function isTerminal(run: FactoryRun): boolean {
  return FACTORY_TERMINAL_STAGES.includes(run.stage);
}

export function needsAttention(run: FactoryRun): boolean {
  const { state } = runPosition(run);
  return state === 'needs-you' || state === 'blocked';
}

export type RunGroup = 'attention' | 'active' | 'finished';

export function runGroup(run: FactoryRun): RunGroup {
  if (needsAttention(run)) return 'attention';
  return isTerminal(run) ? 'finished' : 'active';
}

export function groupRuns(runs: FactoryRun[]): Record<RunGroup, FactoryRun[]> {
  const groups: Record<RunGroup, FactoryRun[]> = { attention: [], active: [], finished: [] };
  for (const run of runs) groups[runGroup(run)].push(run);
  const recent = (a: FactoryRun, b: FactoryRun) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  groups.attention.sort(recent);
  groups.active.sort(
    (a, b) => runPosition(b).stationIndex - runPosition(a).stationIndex || recent(a, b),
  );
  groups.finished.sort(recent);
  return groups;
}

export interface StationLoad {
  station: FactoryStationId;
  total: number;
  live: number;
  waiting: number;
  needsYou: number;
  blocked: number;
  paused: number;
}

/** Runs currently at each station. Done counts completed runs; other terminal runs are off the line. */
export function stationLoads(runs: FactoryRun[]): StationLoad[] {
  const loads = FACTORY_STATIONS.map<StationLoad>((station) => ({
    station: station.id,
    total: 0,
    live: 0,
    waiting: 0,
    needsYou: 0,
    blocked: 0,
    paused: 0,
  }));
  for (const run of runs) {
    const { state, stationIndex: index } = runPosition(run);
    if (state === 'cancelled' || state === 'handed-off') continue;
    const load = loads[index];
    load.total += 1;
    if (state === 'live') load.live += 1;
    else if (state === 'waiting' || state === 'cancelling') load.waiting += 1;
    else if (state === 'needs-you') load.needsYou += 1;
    else if (state === 'blocked') load.blocked += 1;
    else if (state === 'paused') load.paused += 1;
  }
  return loads;
}

export interface FactoryRunSummary {
  active: number;
  attention: number;
  live: number;
}

export function summarizeRuns(runs: FactoryRun[]): FactoryRunSummary {
  let active = 0;
  let attention = 0;
  let live = 0;
  for (const run of runs) {
    if (isTerminal(run)) continue;
    active += 1;
    const { state } = runPosition(run);
    if (state === 'live') live += 1;
    if (state === 'needs-you' || state === 'blocked') attention += 1;
  }
  return { active, attention, live };
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export interface NextStep {
  title: string;
  detail: string;
}

function checkProgress(run: FactoryRun): string | null {
  const observation = run.observation;
  if (!observation) return null;
  const current = observation.checks.filter((check) => check.headSha === observation.headSha);
  const required = run.snapshot.definition.merge.requiredChecks;
  const relevant = required.length
    ? current.filter((check) => required.includes(check.name))
    : current;
  const total = required.length || relevant.length;
  if (!total) return null;
  const passed = relevant.filter((check) => check.status === 'passed').length;
  const failed = relevant.filter((check) => check.status === 'failed').length;
  return failed
    ? `${failed} of ${total} ${required.length ? 'required ' : ''}checks failed`
    : `${passed} of ${total} ${required.length ? 'required ' : ''}checks passed`;
}

function reviewProgress(run: FactoryRun): string | null {
  switch (run.observation?.review) {
    case 'approved':
      return 'review approved';
    case 'changes-requested':
      return 'changes requested';
    case 'pending':
      return run.snapshot.definition.merge.requireApproval ? 'review pending' : null;
    default:
      return null;
  }
}

/** One plain-language sentence pair: what is happening and what happens next. */
export function nextStep(run: FactoryRun): NextStep {
  const definition = run.snapshot.definition;
  const position = runPosition(run);
  const where = stationOf(position.station).label;
  const head = shortSha(run.observation?.headSha ?? run.pullRequest?.headSha);
  switch (run.stage) {
    case 'received':
      return {
        title: 'Claiming the issue',
        detail: 'Confirming it is still open and labelled, then preparing an isolated checkout.',
      };
    case 'implementing':
      return {
        title: 'Agent is implementing',
        detail: run.checkout
          ? `Running the pinned graph on ${run.checkout.branch}.`
          : 'Running the pinned workflow graph.',
      };
    case 'repairing':
      return {
        title: `Repair round ${run.repairRounds} of ${definition.limits.repairRounds}`,
        detail: 'Addressing failed checks or review feedback at the current head.',
      };
    case 'validating':
      return {
        title: 'Verifying acceptance criteria',
        detail: `Running ${definition.checks.length} bound ${definition.checks.length === 1 ? 'check' : 'checks'} against the produced commit.`,
      };
    case 'publishing':
      return {
        title: definition.publication.draft ? 'Opening a draft PR' : 'Opening a PR',
        detail: `Pushing the verified commit to ${definition.github.owner}/${definition.github.repo}.`,
      };
    case 'waiting-checks':
      return {
        title: 'Waiting for CI and review',
        detail:
          [checkProgress(run), reviewProgress(run)].filter(Boolean).join(', ') ||
          'Watching the pull request for check and review results.',
      };
    case 'awaiting-merge-approval':
      return definition.merge.mode === 'auto-merge'
        ? {
            title: 'Auto-merge is ready',
            detail: 'Every gate passed. The factory requests the merge on its next check.',
          }
        : {
            title: 'Needs your merge approval',
            detail: head
              ? `Every gate passed at ${head}. Approving merges exactly this head.`
              : 'Every gate passed. Approving merges exactly the observed head.',
          };
    case 'merging':
      return {
        title: run.mergeReceipt?.state === 'queued' ? 'Merge queued' : 'Merge requested',
        detail: 'GitHub accepted the request. The run completes only after the merge is observed.',
      };
    case 'verifying-merge':
      return {
        title: 'Running post-merge checks',
        detail: `Testing merge commit ${shortSha(run.observation?.mergeCommitSha)}.`,
      };
    case 'completed':
      return {
        title: 'Merged and verified',
        detail: run.pullRequest
          ? `PR #${run.pullRequest.number} merged and its post-merge checks passed.`
          : 'The merge was observed and post-merge checks passed.',
      };
    case 'blocked':
      return {
        title: `Blocked at ${where}`,
        detail: run.error ?? 'The run stopped. Reconcile the cause, then retry.',
      };
    case 'paused':
      return {
        title: `Paused at ${where}`,
        detail:
          run.pendingControl === 'pause'
            ? (run.error ?? 'Waiting for in-flight work to stop.')
            : run.error
              ? `${run.error} Resume to continue from ${where}.`
              : `Resume to continue from ${where}.`,
      };
    case 'cancelling':
      return {
        title: 'Cancellation pending',
        detail: 'Waiting for GitHub to confirm that queued or automatic merge work is clear.',
      };
    case 'cancelled':
      return { title: 'Cancelled', detail: `Stopped at ${where}. No further work will run.` };
    case 'taken-over':
      return {
        title: 'Picked up in chat',
        detail: 'A person is continuing this issue in a private conversation.',
      };
  }
}

export type BudgetTone = 'normal' | 'warning' | 'exhausted';

export interface RunBudget {
  id: 'commands' | 'repairs' | 'time';
  label: string;
  used: number;
  limit: number;
  /** Rendered value, e.g. "14 of 40". */
  value: string;
  ratio: number;
  tone: BudgetTone;
}

function tone(ratio: number): BudgetTone {
  return ratio >= 1 ? 'exhausted' : ratio >= 0.8 ? 'warning' : 'normal';
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Consumption against the run's own pinned limits; the clock stops when the run ends. */
export function runBudgets(run: FactoryRun, now: number): RunBudget[] {
  const limits = run.snapshot.definition.limits;
  const started = Date.parse(run.createdAt);
  const end = isTerminal(run) || run.stage === 'blocked' ? Date.parse(run.updatedAt) : now;
  const elapsed = Number.isFinite(started) ? Math.max(0, end - started) : 0;
  const minuteLimit = limits.maxRunMinutes * 60_000;
  const budgets: RunBudget[] = [
    {
      id: 'commands',
      label: 'Commands',
      used: run.commandsUsed,
      limit: limits.maxCommands,
      value: `${run.commandsUsed} of ${limits.maxCommands}`,
      ratio: limits.maxCommands ? run.commandsUsed / limits.maxCommands : 0,
      tone: 'normal',
    },
    {
      id: 'repairs',
      label: 'Repair rounds',
      used: run.repairRounds,
      limit: limits.repairRounds,
      value: `${run.repairRounds} of ${limits.repairRounds}`,
      ratio: limits.repairRounds
        ? run.repairRounds / limits.repairRounds
        : run.repairRounds
          ? 1
          : 0,
      tone: 'normal',
    },
    {
      id: 'time',
      label: 'Time',
      used: elapsed,
      limit: minuteLimit,
      value: `${formatDuration(elapsed)} of ${formatDuration(minuteLimit)}`,
      ratio: minuteLimit ? elapsed / minuteLimit : 0,
      tone: 'normal',
    },
  ];
  return budgets.map((budget) => ({ ...budget, tone: tone(budget.ratio) }));
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function absoluteTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/* Definition editing ------------------------------------------------------ */

/** Backend-enforced ranges (factory-definition.service). */
export const LIMIT_RANGES: Record<
  keyof FactoryDefinitionInput['limits'],
  { min: number; max: number; label: string; unit: string }
> = {
  repairRounds: { min: 0, max: 8, label: 'Repair rounds', unit: 'rounds' },
  maxRunMinutes: { min: 1, max: 1440, label: 'Time per issue', unit: 'minutes' },
  maxCommands: { min: 1, max: 1000, label: 'Command budget', unit: 'commands' },
  maxConcurrentRuns: { min: 1, max: 8, label: 'Issues at once', unit: 'issues' },
};

export interface DefinitionIssue {
  field:
    | 'name'
    | 'repo'
    | 'label'
    | 'baseBranch'
    | 'workflow'
    | 'criteria'
    | 'postMerge'
    | 'limits'
    | 'access'
    | 'merge';
  message: string;
}

/** Mirrors the backend's structural validation so problems surface while editing. */
export function definitionIssues(
  definition: FactoryDefinitionInput,
  workflowIssues: string[] = [],
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  if (!definition.name.trim()) issues.push({ field: 'name', message: 'Name the factory.' });
  if (!definition.repoId) issues.push({ field: 'repo', message: 'Choose a GitHub repository.' });
  if (!definition.github.label.trim())
    issues.push({ field: 'label', message: 'Choose the issue label that triggers a run.' });
  if (!definition.github.baseBranch.trim())
    issues.push({ field: 'baseBranch', message: 'Choose a base branch.' });
  if (!definition.workflowTemplateId)
    issues.push({
      field: 'workflow',
      message: 'Choose the workflow graph that builds each change.',
    });
  else if (workflowIssues.length) issues.push({ field: 'workflow', message: workflowIssues[0] });
  const pairs = definition.criteria.map((criterion, index) => [
    criterion,
    definition.checks[index],
  ]);
  if (!pairs.length)
    issues.push({ field: 'criteria', message: 'Add at least one acceptance criterion.' });
  else if (
    definition.criteria.length !== definition.checks.length ||
    pairs.some(([criterion, check]) => !criterion?.trim() || !check?.trim())
  )
    issues.push({ field: 'criteria', message: 'Every criterion needs its own check command.' });
  else if (new Set(definition.criteria.map((item) => item.trim())).size !== pairs.length)
    issues.push({ field: 'criteria', message: 'Each acceptance criterion must be unique.' });
  if (!definition.postMergeChecks.some((check) => check.trim()))
    issues.push({ field: 'postMerge', message: 'Add at least one post-merge check.' });
  const reserved = definition.checks.length + definition.postMergeChecks.length + 1;
  if (definition.limits.maxCommands < reserved)
    issues.push({
      field: 'limits',
      message: `The command budget needs at least ${reserved} to leave room for implementation and every check.`,
    });
  for (const [key, range] of Object.entries(LIMIT_RANGES) as Array<
    [keyof FactoryDefinitionInput['limits'], (typeof LIMIT_RANGES)[keyof typeof LIMIT_RANGES]]
  >) {
    const value = definition.limits[key];
    if (!Number.isInteger(value) || value < range.min || value > range.max)
      issues.push({
        field: 'limits',
        message: `${range.label} must be between ${range.min} and ${range.max}.`,
      });
  }
  if (definition.merge.mode === 'auto-merge' && !definition.publication.enabled)
    issues.push({ field: 'merge', message: 'Auto-merge needs permission to publish PRs.' });
  if (definition.access.kind === 'organization') {
    if (!definition.access.organizationId)
      issues.push({ field: 'access', message: 'Choose the organization to share with.' });
    else if (definition.access.visibility === 'team' && !definition.access.teamId?.trim())
      issues.push({ field: 'access', message: 'Choose a GitHub team for team visibility.' });
  }
  return issues;
}

/** Normalises editable rows before preview: trims and drops fully empty pairs and commands. */
export function normalizeDefinition(definition: FactoryDefinitionInput): FactoryDefinitionInput {
  const pairs = definition.criteria
    .map((criterion, index) => [criterion.trim(), (definition.checks[index] ?? '').trim()] as const)
    .filter(([criterion, check]) => criterion || check);
  return {
    ...definition,
    name: definition.name.trim(),
    github: {
      ...definition.github,
      label: definition.github.label.trim(),
      baseBranch: definition.github.baseBranch.trim(),
    },
    criteria: pairs.map(([criterion]) => criterion),
    checks: pairs.map(([, check]) => check),
    postMergeChecks: definition.postMergeChecks.map((check) => check.trim()).filter(Boolean),
    merge: {
      ...definition.merge,
      requiredChecks: definition.merge.requiredChecks.map((check) => check.trim()).filter(Boolean),
    },
  };
}
