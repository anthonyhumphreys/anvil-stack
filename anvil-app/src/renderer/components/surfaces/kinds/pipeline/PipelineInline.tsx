import { useMemo, useState } from 'react';
import { issuesByNode } from '../../../../../shared/surfaces/kinds/pipeline';
import { Button } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import {
  ActionStatusLine,
  SurfaceSkeleton,
  useSurfaceActions,
} from '../../shared-ui/useSurfaceActions';
import { PipelineGraph } from './PipelineGraph';
import { IssueLine, PipelineFacts } from './PipelineParts';
import { INLINE_LAYOUT, nodeAnchor, prepareGraph, readPipelineData } from './model';

const INLINE_MAX_HEIGHT = 320;

export function PipelineInline(props: SurfaceViewProps) {
  const { intent, onOpenStage, onComment, onAction } = props;
  const raw = intent.payload.data;
  const data = useMemo(() => readPipelineData(raw), [raw]);
  const graph = useMemo(() => prepareGraph(data, false, INLINE_LAYOUT), [data]);
  const issues = useMemo(() => issuesByNode(data.issues), [data.issues]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { run, pending, status } = useSurfaceActions(onAction);
  const topIssues = [...data.issues]
    .sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : b.severity === 'error' ? 1 : 0,
    )
    .slice(0, 3);
  const labelFor = (id?: string) =>
    id ? data.nodes.find((node) => node.id === id)?.label : undefined;
  const activeNode = activeId ? data.nodes.find((node) => node.id === activeId) : undefined;

  if (intent.payload.streaming && data.nodes.length === 0) {
    return <SurfaceSkeleton label="Analysing pipelines" />;
  }

  return (
    <section aria-label={intent.payload.title} className="flex flex-col gap-3">
      <PipelineFacts data={data} />
      {data.nodes.length > 0 ? (
        <div
          className="overflow-auto rounded-lg border border-border-subtle"
          style={{ height: Math.min(INLINE_MAX_HEIGHT, graph.layout.height + 16) }}
        >
          <PipelineGraph
            label={`Pipeline graph for ${data.repoName ?? data.repoId}. Arrow keys move between nodes.`}
            graph={graph}
            issues={issues}
            activeId={activeId}
            onSelect={setActiveId}
            onActivate={(id) => onOpenStage(id)}
            onNodeKey={(event, id) => {
              const node = data.nodes.find((candidate) => candidate.id === id);
              if (!node) return false;
              if (event.key === 'f') {
                event.preventDefault();
                void run('ask_fix_node', [id]);
                return true;
              }
              if (event.key === 'c') {
                event.preventDefault();
                onComment(nodeAnchor(node));
                return true;
              }
              return false;
            }}
            width={graph.layout.width}
            height={graph.layout.height + 8}
            labelMax={18}
          />
        </div>
      ) : (
        <p className="text-sm text-text-tertiary">
          No CI/CD pipeline files were found in this repository.
        </p>
      )}
      {topIssues.length > 0 && (
        <ul aria-label="Validation issues" className="flex flex-col">
          {topIssues.map((issue) => (
            <IssueLine key={issue.id} issue={issue} nodeLabel={labelFor(issue.nodeId)} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {activeNode && (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending !== null}
              onClick={() => void run('ask_fix_node', [activeNode.id])}
            >
              Ask agent to fix “{activeNode.label}”
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onComment(nodeAnchor(activeNode))}>
              Comment
            </Button>
          </>
        )}
        {data.nodes.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onOpenStage(activeId ?? undefined)}>
            Open pipeline
          </Button>
        )}
      </div>
      <ActionStatusLine status={status} />
    </section>
  );
}
