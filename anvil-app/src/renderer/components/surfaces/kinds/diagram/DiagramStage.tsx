import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Copy, Maximize, Minus, Plus, SquareDashedMousePointer } from 'lucide-react';
import { describeDiagramFormat } from '../../../../../shared/surfaces/kinds/diagram';
import { Button, IconButton, SegmentedControl, cx } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import {
  ActionStatusLine,
  CommentButton,
  FilterInput,
  SurfaceSkeleton,
  useSurfaceActions,
} from '../../shared-ui/useSurfaceActions';
import { fitViewport, zoomAround, type Viewport } from '../pipeline/model';
import { DiagramActions } from './DiagramActions';
import {
  DiagramDrawing,
  DiagramRenderStatus,
  DiagramSource,
  useDiagramRender,
} from './DiagramContent';
import { RegionOverlay } from './RegionOverlay';
import { filterNodes, formatMeta, nodeAnchor, readDiagramData, regionAnchor } from './model';

type StageMode = 'diagram' | 'source';

const DEFAULT_SIZE = { width: 800, height: 520 };
const PAN_STEP = 48;
const FILTER_THRESHOLD = 12;

export function DiagramStage(props: SurfaceViewProps) {
  const { intent, onAction, onComment, readOnly, focusTargetId } = props;
  const raw = intent.payload.data;
  const data = useMemo(() => readDiagramData(raw), [raw]);
  const nodes = data.nodes ?? [];
  const render = useDiagramRender(data);
  const actions = useSurfaceActions(onAction);
  const [mode, setMode] = useState<StageMode>('diagram');
  const [selectedId, setSelectedId] = useState<string | null>(focusTargetId ?? null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [query, setQuery] = useState('');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [viewport, setViewport] = useState<Viewport>({ x: 16, y: 16, scale: 1 });
  const fittedFor = useRef('');
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const showingDiagram = mode === 'diagram' && render.ready && render.width > 0;

  useEffect(() => {
    if (focusTargetId) setSelectedId(focusTargetId);
  }, [focusTargetId]);

  useEffect(() => {
    const element = paneRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingDiagram]);

  const fit = useCallback(
    () =>
      setViewport(
        fitViewport({ width: render.width, height: render.height }, size.width, size.height),
      ),
    [render.width, render.height, size.width, size.height],
  );

  // Fit once per drawing size and pane size.
  useEffect(() => {
    if (!showingDiagram) return;
    const key = `${render.width}x${render.height}@${size.width}x${size.height}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [fit, showingDiagram, render.width, render.height, size.width, size.height]);

  // Ctrl/⌘ + wheel or pinch zooms around the pointer; plain wheel pans.
  useEffect(() => {
    const element = paneRef.current;
    if (!element || !showingDiagram) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.01);
        setViewport((current) =>
          zoomAround(current, factor, event.clientX - box.left, event.clientY - box.top),
        );
      } else {
        setViewport((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [showingDiagram]);

  const zoomBy = (factor: number) =>
    setViewport((current) => zoomAround(current, factor, size.width / 2, size.height / 2));

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const visibleNodes = useMemo(() => filterNodes(nodes, query), [nodes, query]);

  const onPaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target !== event.currentTarget)
      return;
    const pan = (dx: number, dy: number) =>
      setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    if (event.key === '+' || event.key === '=') zoomBy(1.2);
    else if (event.key === '-') zoomBy(1 / 1.2);
    else if (event.key === '0') fit();
    else if (event.key === 'ArrowLeft') pan(PAN_STEP, 0);
    else if (event.key === 'ArrowRight') pan(-PAN_STEP, 0);
    else if (event.key === 'ArrowUp') pan(0, PAN_STEP);
    else if (event.key === 'ArrowDown') pan(0, -PAN_STEP);
    else if (event.key === 'c' && selectedNode) onComment(nodeAnchor(selectedNode));
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (selectingRegion || event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      vx: viewport.x,
      vy: viewport.y,
      id: event.pointerId,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (
      Math.abs(dx) + Math.abs(dy) > 3 &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setViewport((current) => ({ ...current, x: start.vx + dx, y: start.vy + dy }));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(data.source);
      setCopyStatus('Source copied.');
    } catch {
      setCopyStatus('Could not copy. Select the source and copy it manually.');
    }
  };

  if (intent.payload.streaming && !data.source) {
    return <SurfaceSkeleton rows={6} label="Drawing diagram" />;
  }

  const meta = formatMeta(data, describeDiagramFormat(data));
  const pages = render.drawio && render.drawio.pageCount > 1 ? render.drawio.pageCount : 0;

  return (
    <section aria-label={intent.payload.title} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <p className="text-xs text-text-tertiary">
            {meta}
            {pages ? ` · page 1 of ${pages} shown` : ''}
          </p>
          {data.description && (
            <p className="max-w-[72ch] text-sm text-text-secondary">{data.description}</p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl<StageMode>
            label="View"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setSelectingRegion(false);
            }}
            options={[
              { value: 'diagram', label: 'Diagram' },
              { value: 'source', label: 'Source' },
            ]}
          />
          {mode === 'diagram' ? (
            <div role="toolbar" aria-label="Diagram view" className="flex items-center gap-1">
              <IconButton
                icon={Minus}
                label="Zoom out (-)"
                disabled={!showingDiagram}
                onClick={() => zoomBy(1 / 1.2)}
              />
              <span
                className="w-10 text-center text-xs tabular-nums text-text-tertiary"
                aria-live="polite"
              >
                {Math.round(viewport.scale * 100)}%
              </span>
              <IconButton
                icon={Plus}
                label="Zoom in (+)"
                disabled={!showingDiagram}
                onClick={() => zoomBy(1.2)}
              />
              <IconButton
                icon={Maximize}
                label="Fit to view (0)"
                disabled={!showingDiagram}
                onClick={fit}
              />
              <Button
                size="sm"
                variant={selectingRegion ? 'secondary' : 'ghost'}
                aria-pressed={selectingRegion}
                disabled={!showingDiagram}
                onClick={() => setSelectingRegion((value) => !value)}
              >
                <SquareDashedMousePointer size={14} aria-hidden="true" />
                {selectingRegion ? 'Cancel selection' : 'Comment on a region'}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void copySource()}>
              <Copy size={14} aria-hidden="true" />
              Copy source
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
        <div className="flex min-h-0 flex-col gap-2">
          {mode === 'source' ? (
            <>
              <DiagramSource source={data.source} className="min-h-[320px] flex-1" />
              <p
                role="status"
                aria-live="polite"
                className="min-h-[1rem] text-xs text-text-tertiary"
              >
                {copyStatus ?? ''}
              </p>
            </>
          ) : (
            <>
              <DiagramRenderStatus render={render} />
              {showingDiagram ? (
                <div
                  ref={paneRef}
                  tabIndex={0}
                  role="group"
                  aria-label={`${data.title} canvas. Arrow keys pan, plus and minus zoom, 0 fits.`}
                  onKeyDown={onPaneKeyDown}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  className={cx(
                    'relative min-h-[320px] flex-1 touch-none overflow-hidden rounded-lg border border-border-subtle bg-bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    selectingRegion ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  <div
                    className="absolute left-0 top-0 origin-top-left"
                    style={{
                      width: render.width,
                      height: render.height,
                      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                    }}
                  >
                    <DiagramDrawing
                      data={data}
                      render={render}
                      selectedId={selectedId}
                      onSelectNode={setSelectedId}
                    />
                    {selectingRegion && (
                      <RegionOverlay
                        onRegion={(rect) => {
                          setSelectingRegion(false);
                          onComment(regionAnchor(rect));
                        }}
                        onCancel={() => {
                          setSelectingRegion(false);
                          paneRef.current?.focus();
                        }}
                      />
                    )}
                  </div>
                </div>
              ) : render.format === 'mermaid' && render.mermaid?.status !== 'error' ? (
                <SurfaceSkeleton rows={6} label="Rendering diagram" />
              ) : (
                <DiagramSource source={data.source} className="min-h-[320px] flex-1" />
              )}
              <p className="text-xs text-text-tertiary">
                Keys: arrows pan · +/− zoom · 0 fit · c comment on the selected node · drag or
                scroll to pan
              </p>
            </>
          )}
        </div>

        <aside
          aria-label="Diagram nodes and actions"
          className="flex min-h-0 flex-col gap-3 overflow-auto border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
        >
          <DiagramActions
            data={data}
            readOnly={readOnly}
            actions={actions}
            selectedNode={selectedNode}
            onCommentSurface={() => onComment({ type: 'surface', label: data.title || undefined })}
          />
          <ActionStatusLine status={actions.status} />
          <div className="flex min-h-0 flex-col gap-2">
            <h3 className="text-xs font-medium text-text-secondary">
              Nodes{nodes.length ? ` (${nodes.length})` : ''}
            </h3>
            {nodes.length === 0 ? (
              <p className="text-xs text-text-tertiary">
                No nodes were read from this diagram. Comment on a region instead.
              </p>
            ) : (
              <>
                {nodes.length > FILTER_THRESHOLD && (
                  <FilterInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Filter nodes"
                    label="Filter nodes"
                  />
                )}
                <ul aria-label="Nodes" className="flex flex-col">
                  {visibleNodes.map((node) => {
                    const selected = node.id === selectedId;
                    return (
                      <li
                        key={node.id}
                        className={cx(
                          'flex items-center gap-1 rounded-md',
                          selected && 'bg-bg-tertiary',
                        )}
                      >
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSelectedId(selected ? null : node.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'c') {
                              event.preventDefault();
                              onComment(nodeAnchor(node));
                            }
                          }}
                          className={cx(
                            'flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                            selected ? 'text-text-primary' : 'text-text-secondary',
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-sm [overflow-wrap:anywhere]">
                            {selected && (
                              <span
                                aria-hidden="true"
                                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                              />
                            )}
                            {node.label || node.id}
                          </span>
                          {node.label && node.label !== node.id && (
                            <span className="font-mono text-[11px] text-text-tertiary [overflow-wrap:anywhere]">
                              {node.id}
                            </span>
                          )}
                        </button>
                        <CommentButton
                          anchor={nodeAnchor(node)}
                          onComment={onComment}
                          label={`Comment on ${node.label || node.id}`}
                        />
                      </li>
                    );
                  })}
                  {visibleNodes.length === 0 && (
                    <li className="px-2 py-1 text-xs text-text-tertiary">No nodes match.</li>
                  )}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
      {actions.confirmDialog}
    </section>
  );
}
