import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronRight, Circle, OctagonX, Pause, Wrench } from 'lucide-react';
import { formatProcessingElapsed, type ProcessingState } from './processing-state';

const ProcessingActiveContext = createContext(false);
export const useProcessingActive = () => useContext(ProcessingActiveContext);

const labels: Record<ProcessingState, string> = {
  working: 'Working',
  waiting: 'Your input is needed',
  completed: 'Work completed',
  failed: 'Work failed',
  stopped: 'Work stopped',
  ended: 'Activity ended',
};
const icons = {
  working: Wrench,
  waiting: Pause,
  completed: Check,
  failed: OctagonX,
  stopped: Pause,
  ended: Circle,
};

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

  const Icon = icons[state];
  return (
    <ProcessingActiveContext.Provider value={active}>
      <div className="message-bubble flex min-w-0 justify-start">
        <div
          ref={cardRef}
          className="processing-card"
          data-processing-state={state}
          data-processing-motion={active && visible && pageVisible ? 'running' : 'paused'}
        >
          <button
            type="button"
            className="processing-card-header"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} processing details. ${labels[state]}`}
          >
            <Icon size={15} className="processing-state-icon shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-text-primary" role="status">
                  {labels[state]}
                </span>
                {actions > 0 && (
                  <span className="text-text-secondary">
                    {actions} action{actions === 1 ? '' : 's'}
                  </span>
                )}
                {failed > 0 && <span className="text-error">{failed} failed</span>}
              </span>
              <span className="mt-1 block truncate text-text-secondary">{detail}</span>
            </span>
            {elapsed !== null && (
              <span className="shrink-0 tabular-nums text-text-secondary" aria-label="Elapsed time">
                {formatProcessingElapsed(elapsed)}
              </span>
            )}
            {expanded ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
          </button>
          <div id={detailsId} className="processing-details">
            {children}
          </div>
        </div>
      </div>
    </ProcessingActiveContext.Provider>
  );
}
