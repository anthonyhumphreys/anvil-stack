import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronRight, Circle, OctagonX, Pause } from 'lucide-react';
import { formatProcessingElapsed, type ProcessingState } from './processing-state';

const ProcessingActiveContext = createContext(false);
export const useProcessingActive = () => useContext(ProcessingActiveContext);

const labels: Record<ProcessingState, string> = {
  working: 'Working',
  waiting: 'Your input is needed',
  answering: 'Work done',
  completed: 'Work completed',
  failed: 'Work failed',
  stopped: 'Work stopped',
  ended: 'Activity ended',
};
const icons = {
  waiting: Pause,
  answering: Check,
  completed: Check,
  failed: OctagonX,
  stopped: Pause,
  ended: Circle,
};

/**
 * The live mark shared by the turn card and a streaming answer: a forge dot
 * whose ring breathes while work continues and throws one ripple per strike.
 */
export function LiveGlyph({ strike = 0, size = 'md' }: { strike?: number; size?: 'sm' | 'md' }) {
  return (
    <span className={`live-glyph live-glyph--${size}`} aria-hidden="true">
      <span className="live-glyph-ring" />
      <span className="live-glyph-dot" />
      {strike > 0 && <span key={strike} className="live-glyph-strike" />}
    </span>
  );
}

/** Rolls the latest step into place, keeping the previous one long enough to leave. */
function StepTicker({ text }: { text: string }) {
  const [lines, setLines] = useState<{ current: string; previous: string | null; key: number }>({
    current: text,
    previous: null,
    key: 0,
  });
  useEffect(() => {
    setLines((value) =>
      value.current === text
        ? value
        : { current: text, previous: value.current, key: value.key + 1 },
    );
  }, [text]);
  return (
    <span className="processing-ticker mt-1 block text-text-secondary">
      {lines.previous !== null && (
        <span
          key={`out-${lines.key}`}
          className="processing-ticker-line is-leaving"
          aria-hidden="true"
          onAnimationEnd={() => setLines((value) => ({ ...value, previous: null }))}
        >
          {lines.previous}
        </span>
      )}
      <span
        key={`in-${lines.key}`}
        className={`processing-ticker-line ${lines.key > 0 ? 'is-entering' : ''}`}
      >
        {lines.current}
      </span>
    </span>
  );
}

export function ProcessingCard({
  state,
  detail,
  actions,
  failed,
  expanded,
  onToggle,
  startedAt,
  endedAt,
  children,
}: {
  state: ProcessingState;
  detail: string;
  actions: number;
  failed: number;
  expanded: boolean;
  onToggle: () => void;
  startedAt?: string;
  endedAt?: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  const active = state === 'working';
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const fallbackStart = useRef<number | null>(null);
  const stoppedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  // Motion is earned by change seen in this mount; replayed history stays still.
  const mountedState = useRef(state);
  const [settled, setSettled] = useState(false);
  const previousActions = useRef(actions);
  const [strike, setStrike] = useState(0);

  useEffect(() => {
    if (state !== mountedState.current) setSettled(true);
  }, [state]);

  useEffect(() => {
    if (actions > previousActions.current && active) setStrike((value) => value + 1);
    previousActions.current = actions;
  }, [actions, active]);

  useEffect(() => {
    if (!active) return;
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (cardRef.current) observer.observe(cardRef.current);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [active]);

  useEffect(() => {
    if (active && fallbackStart.current === null) fallbackStart.current = Date.now();
    const parsedStart = startedAt ? Date.parse(startedAt) : NaN;
    const start = Number.isFinite(parsedStart) ? parsedStart : fallbackStart.current;
    const parsedEnd = endedAt ? Date.parse(endedAt) : NaN;
    if (start === null) return;
    if (active) stoppedAt.current = null;
    else if (stoppedAt.current === null) stoppedAt.current = Date.now();
    // Never invent a duration for old history without an end timestamp.
    if (!active && fallbackStart.current === null && !Number.isFinite(parsedEnd)) return;
    const update = () =>
      setElapsed(
        (Number.isFinite(parsedEnd) ? parsedEnd : (stoppedAt.current ?? Date.now())) - start,
      );
    update();
    if (!active || !pageVisible || !visible) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt, endedAt, pageVisible, visible]);

  const Icon = state === 'working' ? null : icons[state];
  return (
    <ProcessingActiveContext.Provider value={active}>
      <div className="message-bubble flex min-w-0 justify-start">
        <div
          ref={cardRef}
          className="processing-card"
          data-processing-state={state}
          data-processing-motion={active && visible && pageVisible ? 'running' : 'paused'}
          data-processing-settled={settled ? 'true' : undefined}
          data-processing-expanded={expanded ? 'true' : undefined}
        >
          {strike > 0 && <span key={strike} className="processing-card-flare" aria-hidden="true" />}
          <button
            type="button"
            className="processing-card-header"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} processing details. ${labels[state]}`}
          >
            <span className="processing-state-mark">
              {Icon ? (
                <Icon
                  key={state}
                  size={15}
                  className="processing-state-icon shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <LiveGlyph strike={strike} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-text-primary" role="status">
                  {labels[state]}
                </span>
                {actions > 0 && (
                  <span className="text-text-secondary">
                    <span key={actions} className="processing-count tabular-nums">
                      {actions}
                    </span>{' '}
                    action{actions === 1 ? '' : 's'}
                  </span>
                )}
                {failed > 0 && <span className="text-error">{failed} failed</span>}
              </span>
              <StepTicker text={detail} />
            </span>
            {elapsed !== null && (
              <span className="shrink-0 tabular-nums text-text-secondary" aria-label="Elapsed time">
                {formatProcessingElapsed(elapsed)}
              </span>
            )}
            <ChevronRight size={13} className="processing-chevron shrink-0" aria-hidden="true" />
          </button>
          <div id={detailsId} className="processing-details">
            {children}
          </div>
        </div>
      </div>
    </ProcessingActiveContext.Provider>
  );
}
