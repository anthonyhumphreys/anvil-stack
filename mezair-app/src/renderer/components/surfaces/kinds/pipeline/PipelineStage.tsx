import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { issuesByNode } from '../../../../../shared/surfaces/kinds/pipeline';
import { IconButton } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import {
  ActionStatusLine,
  SurfaceSkeleton,
  useSurfaceActions,
} from '../../shared-ui/useSurfaceActions';
import { PipelineGraph } from './PipelineGraph';
import { IssueLine, NodeDetail, PipelineFacts } from './PipelineParts';
import {
  STAGE_LAYOUT,
  ensureVisible,
  fitViewport,
  nodeAnchor,
  prepareGraph,
  readPipelineData,
  zoomAround,
  type Viewport,
} from './model';

const DEFAULT_SIZE = { width: 800, height: 480 };

export function PipelineStage(props: SurfaceViewProps & { focusTargetId?: string }) {
  const { intent, onComment, onAction } = props;
  const raw = intent.payload.data;
  const data = useMemo(() => readPipelineData(raw), [raw]);
  const hasSteps = data.nodes.some((node) => node.type === 'step');
  const [includeSteps, setIncludeSteps] = useState(data.nodes.length <= 80);
  const graph = useMemo(() => prepareGraph(data, includeSteps, STAGE_LAYOUT), [data, includeSteps]);
  const issues = useMemo(() => issuesByNode(data.issues), [data.issues]);
  const [activeId, setActiveId] = useState<string | null>(props.focusTargetId ?? null);
  const { run, pending, status } = useSurfaceActions(onAction);
  const ready = !(intent.payload.streaming && data.nodes.length === 0);

  const paneRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [viewport, setViewport] = useState<Viewport>(() =>
    fitViewport(graph.layout, DEFAULT_SIZE.width, DEFAULT_SIZE.height),
  );
  const fittedFor = useRef<string>('');
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);

  useEffect(() => {
    if (props.focusTargetId) setActiveId(props.focusTargetId);
  }, [props.focusTargetId]);

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
  }, [ready]);

  const fit = useCallback(
    () => setViewport(fitViewport(graph.layout, size.width, size.height)),
    [graph.layout, size.width, size.height],
  );

  // Fit once per graph shape and pane size.
  useEffect(() => {
    const key = `${graph.layout.width}x${graph.layout.height}@${size.width}x${size.height}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [fit, graph.layout.width, graph.layout.height, size.width, size.height]);

  // Wheel: pinch / ctrl+wheel zooms, plain wheel pans. Native listener so we can preventDefault.
  useEffect(() => {
    const element = paneRef.current;
    if (!element) return;
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
  }, [ready]);

  const zoomBy = (factor: number) =>
    setViewport((current) => zoomAround(current, factor, size.width / 2, size.height / 2));

  const select = (id: string) => {
    setActiveId(id);
    const placed = graph.layout.nodes.find((node) => node.id === id);
    if (placed) setViewport((current) => ensureVisible(current, placed, size.width, size.height));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-node-id]')) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      vx: viewport.x,
      vy: viewport.y,
      id: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setViewport((current) => ({
      ...current,
      x: start.vx + event.clientX - start.x,
      y: start.vy + event.clientY - start.y,
    }));
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  const activeNode = activeId ? data.nodes.find((node) => node.id === activeId) : undefined;
  const fileIssues = data.issues.filter((issue) => !issue.nodeId);

  if (!ready) {
    return <SurfaceSkeleton rows={6} label="Analysing pipelines" />;
  }

  return (
    <section aria-label={intent.payload.title} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <PipelineFacts data={data} />
        <div role="toolbar" aria-label="Graph view" className="ml-auto flex items-center gap-1">
          <IconButton icon={Minus} label="Zoom out (-)" onClick={() => zoomBy(1 / 1.2)} />
          <span
            className="w-10 text-center text-xs tabular-nums text-text-tertiary"
            aria-live="polite"
          >
            {Math.round(viewport.scale * 100)}%
          </span>
          <IconButton icon={Plus} label="Zoom in (+)" onClick={() => zoomBy(1.2)} />
          <IconButton icon={Maximize} label="Fit to view (0)" onClick={fit} />
          {hasSteps && (
            <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={includeSteps}
                onChange={(event) => setIncludeSteps(event.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Show steps
            </label>
          )}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <div className="flex min-h-0 flex-col gap-2">
          <div
            ref={paneRef}
            className="relative min-h-[320px] flex-1 cursor-grab overflow-hidden rounded-lg border border-border-subtle bg-bg-primary active:cursor-grabbing"
          >
            {data.nodes.length > 0 ? (
              <PipelineGraph
                label={`Pipeline graph for ${data.repoName ?? data.repoId}. Arrow keys move between nodes; plus and minus zoom.`}
                graph={graph}
                issues={issues}
                activeId={activeId}
                onSelect={select}
                onNodeKey={(event, id) => {
                  const node = data.nodes.find((candidate) => candidate.id === id);
                  if (!node || event.metaKey || event.ctrlKey || event.altKey) return false;
                  if (event.key === 'f') void run('ask_fix_node', [id]);
                  else if (event.key === 'c') onComment(nodeAnchor(node));
                  else if (event.key === '+' || event.key === '=') zoomBy(1.2);
                  else if (event.key === '-') zoomBy(1 / 1.2);
                  else if (event.key === '0') fit();
                  else return false;
                  event.preventDefault();
                  return true;
                }}
                width="100%"
                height="100%"
                viewport={viewport}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="absolute inset-0 h-full w-full touch-none"
              />
            ) : (
              <p className="p-4 text-sm text-text-tertiary">No CI/CD pipeline files were found.</p>
            )}
          </div>
          <p className="text-xs text-text-tertiary">
            Keys: arrows move · f ask fix · c comment · +/− zoom · 0 fit · drag or scroll to pan
          </p>
        </div>
        <aside
          aria-label="Node detail"
          className="min-h-0 overflow-auto border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
        >
          {activeNode ? (
            <NodeDetail
              data={data}
              node={activeNode}
              issues={issues.get(activeNode.id) ?? []}
              busy={pending !== null}
              onAskFix={() => void run('ask_fix_node', [activeNode.id])}
              onComment={() => onComment(nodeAnchor(activeNode))}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-text-tertiary">
                Select a node to see its YAML and validation.
              </p>
              {fileIssues.length > 0 && (
                <ul aria-label="File issues">
                  {fileIssues.map((issue) => (
                    <IssueLine key={issue.id} issue={issue} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
      <ActionStatusLine status={status} />
    </section>
  );
}
