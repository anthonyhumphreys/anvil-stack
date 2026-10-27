import {
  Ban,
  Check,
  CircleAlert,
  CircleCheckBig,
  CirclePause,
  Clock3,
  Hand,
  LoaderCircle,
  MessagesSquare,
  Pause,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { FactoryRun } from '../../../shared/factories';
import {
  FACTORY_STATIONS,
  runPosition,
  shortSha,
  type FactoryRunState,
  type FactoryStationId,
  type StationLoad,
} from './factory-line';

type Mark = 'idle' | 'passed' | 'live' | 'waiting' | 'attention' | 'blocked' | 'paused' | 'done';

const STATE_MARK: Record<FactoryRunState, Mark> = {
  live: 'live',
  waiting: 'waiting',
  cancelling: 'waiting',
  'needs-you': 'attention',
  blocked: 'blocked',
  paused: 'paused',
  done: 'done',
  cancelled: 'paused',
  'handed-off': 'paused',
};

export const RUN_STATE_META: Record<
  FactoryRunState,
  { label: string; className: string; icon: LucideIcon | 'live' }
> = {
  live: { label: 'Running', className: 'text-accent', icon: 'live' },
  waiting: { label: 'Waiting', className: 'text-info', icon: Clock3 },
  'needs-you': { label: 'Needs you', className: 'text-warning', icon: Hand },
  blocked: { label: 'Blocked', className: 'text-error', icon: CircleAlert },
  paused: { label: 'Paused', className: 'text-text-secondary', icon: CirclePause },
  cancelling: { label: 'Cancelling', className: 'text-warning', icon: LoaderCircle },
  done: { label: 'Merged', className: 'text-success', icon: CircleCheckBig },
  cancelled: { label: 'Cancelled', className: 'text-text-tertiary', icon: Ban },
  'handed-off': { label: 'Picked up', className: 'text-text-secondary', icon: MessagesSquare },
};

export function LiveGlyph({ small = false }: { small?: boolean }) {
  return (
    <span className={`live-glyph ${small ? 'live-glyph--sm' : ''}`} aria-hidden="true">
      <span className="live-glyph-ring" />
      <span className="live-glyph-dot" />
    </span>
  );
}

export function RunStateIcon({ state, size = 14 }: { state: FactoryRunState; size?: number }) {
  const meta = RUN_STATE_META[state];
  if (meta.icon === 'live') return <LiveGlyph small={size < 14} />;
  const Icon = meta.icon;
  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${meta.className}`} />;
}

function MarkIcon({ mark }: { mark: Mark }) {
  switch (mark) {
    case 'live':
      return <LiveGlyph />;
    case 'done':
      return <Check size={11} strokeWidth={3} aria-hidden="true" />;
    case 'blocked':
      return <X size={11} strokeWidth={3} aria-hidden="true" />;
    case 'attention':
      return <Hand size={10} strokeWidth={2.5} aria-hidden="true" />;
    case 'paused':
      return <Pause size={9} strokeWidth={3} aria-hidden="true" />;
    case 'waiting':
      return <Clock3 size={10} strokeWidth={2.5} aria-hidden="true" />;
    case 'passed':
      return <Check size={10} strokeWidth={3} aria-hidden="true" className="text-bg-primary" />;
    default:
      return null;
  }
}

function stationNote(run: FactoryRun, station: FactoryStationId): string | null {
  switch (station) {
    case 'build':
      return run.repairRounds
        ? `${run.repairRounds} ${run.repairRounds === 1 ? 'repair' : 'repairs'}`
        : null;
    case 'verify': {
      if (!run.evidence) return null;
      const failed = run.evidence.criteria.filter((item) => item.status !== 'passed').length;
      return failed
        ? `${failed} failed`
        : `${run.evidence.criteria.length}/${run.evidence.criteria.length}`;
    }
    case 'publish':
      return run.pullRequest ? `#${run.pullRequest.number}` : null;
    case 'checks': {
      const observation = run.observation;
      if (!observation) return null;
      const current = observation.checks.filter((check) => check.headSha === observation.headSha);
      if (!current.length) return null;
      return `${current.filter((check) => check.status === 'passed').length}/${current.length}`;
    }
    case 'merge':
      return run.mergeReceipt
        ? run.mergeReceipt.state
        : run.mergeApprovalHead
          ? shortSha(run.mergeApprovalHead)
          : null;
    case 'confirm':
      return run.postMergeEvidence ? (run.postMergeEvidence.passed ? 'passed' : 'failed') : null;
    default:
      return null;
  }
}

/** One run's journey along the line. */
export function RunJourney({ run }: { run: FactoryRun }) {
  const position = runPosition(run);
  const describedState = RUN_STATE_META[position.state].label;
  return (
    <ol className="factory-line" aria-label="Lifecycle">
      {FACTORY_STATIONS.map((station, index) => {
        const current = index === position.stationIndex;
        const passed = index < position.stationIndex || position.state === 'done';
        const mark: Mark = current ? STATE_MARK[position.state] : passed ? 'passed' : 'idle';
        const note = stationNote(run, station.id);
        return (
          <li
            key={station.id}
            className="factory-line-station"
            data-track={index < position.stationIndex ? 'passed' : undefined}
            data-current={current ? '' : undefined}
            aria-current={current ? 'step' : undefined}
            title={station.description}
          >
            <span className="factory-line-marker" data-mark={mark}>
              <MarkIcon mark={mark} />
            </span>
            <span className="factory-line-label">{station.label}</span>
            <span className="factory-line-note">{note ?? '\u00a0'}</span>
            <span className="sr-only">
              {current ? `Current: ${describedState}` : passed ? 'Passed' : 'Ahead'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function loadMark(load: StationLoad): Mark {
  if (load.blocked) return 'blocked';
  if (load.needsYou) return 'attention';
  if (load.live) return 'live';
  if (load.waiting) return 'waiting';
  if (load.paused) return 'paused';
  if (load.station === 'done' && load.total) return 'done';
  return 'idle';
}

function loadNote(load: StationLoad): string | null {
  if (load.blocked) return `${load.blocked} blocked`;
  if (load.needsYou) return `${load.needsYou} need${load.needsYou === 1 ? 's' : ''} you`;
  if (load.live) return `${load.live} running`;
  if (load.waiting) return `${load.waiting} waiting`;
  if (load.paused) return `${load.paused} paused`;
  if (load.station === 'done' && load.total) return 'merged';
  return null;
}

/** The factory floor: how many runs are at each station right now. */
export function StationBoard({
  loads,
  selected,
  onSelect,
}: {
  loads: StationLoad[];
  selected: FactoryStationId | null;
  onSelect: (station: FactoryStationId | null) => void;
}) {
  return (
    <div className="factory-line factory-board" role="group" aria-label="Runs by station">
      {FACTORY_STATIONS.map((station, index) => {
        const load = loads[index];
        const mark = loadMark(load);
        const note = loadNote(load);
        const pressed = selected === station.id;
        return (
          <button
            key={station.id}
            type="button"
            className="factory-line-station"
            aria-pressed={pressed}
            aria-label={`${station.label}: ${load.total} ${load.total === 1 ? 'run' : 'runs'}${note ? `, ${note}` : ''}. ${pressed ? 'Show all runs' : 'Show only this station'}`}
            title={station.description}
            onClick={() => onSelect(pressed ? null : station.id)}
          >
            <span className="factory-board-name">{station.label}</span>
            <span className="factory-board-count" data-empty={load.total ? undefined : ''}>
              {load.total}
            </span>
            <span className="factory-line-marker" data-mark={mark}>
              <MarkIcon mark={mark} />
            </span>
            <span className="factory-line-note mt-2">{note ?? '\u00a0'}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Eight-segment position track for dense lists. */
export function RunTrack({ run }: { run: FactoryRun }) {
  const position = runPosition(run);
  return (
    <span className="factory-track" aria-hidden="true">
      {FACTORY_STATIONS.map((station, index) => (
        <span
          key={station.id}
          data-mark={
            index === position.stationIndex
              ? STATE_MARK[position.state]
              : index < position.stationIndex || position.state === 'done'
                ? 'passed'
                : undefined
          }
        />
      ))}
    </span>
  );
}
