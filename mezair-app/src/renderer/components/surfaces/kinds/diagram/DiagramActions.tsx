import { useId, useRef, useState } from 'react';
import { ExternalLink, MessageSquarePlus, Save, Sparkles } from 'lucide-react';
import type {
  DiagramNodeRef,
  DiagramSurfaceData,
} from '../../../../../shared/surfaces/kinds/diagram';
import { Button } from '../../../ui';
import { actionAvailability } from '../../surface-utils';
import type { useSurfaceActions } from '../../shared-ui/useSurfaceActions';

type SurfaceActions = ReturnType<typeof useSurfaceActions>;

/**
 * Save to repo (mutation: confirm first, hidden in Read only), Open in
 * draw.io (draw.io diagrams only) and Ask agent to revise (optional note,
 * scoped to the selected node when there is one).
 */
export function DiagramActions({
  data,
  readOnly,
  actions,
  selectedNode,
  onCommentSurface,
  compact = false,
}: {
  data: DiagramSurfaceData;
  readOnly?: boolean;
  actions: SurfaceActions;
  selectedNode?: DiagramNodeRef | null;
  onCommentSurface?: () => void;
  compact?: boolean;
}) {
  const available = actionAvailability('diagram', readOnly);
  const { run, pending, confirm } = actions;
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const askRevise = async () => {
    const result = await run('ask_revise', selectedNode ? [selectedNode.id] : [], note.trim());
    if (result.ok) {
      setRevising(false);
      setNote('');
    }
  };

  const save = () =>
    confirm({
      action: 'save_to_repo',
      targetIds: [],
      title: data.savedPath ? 'Update the saved diagram?' : 'Save diagram to the repository?',
      description: data.savedPath
        ? `Overwrites ${data.savedPath} with this version.`
        : `Writes “${data.title}” into the repository’s docs/diagrams/ folder as a ${data.format === 'drawio' ? '.drawio' : '.mmd'} file.`,
      confirmLabel: data.savedPath ? 'Update file' : 'Save',
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {available('save_to_repo') && (
          <Button size="sm" variant="secondary" disabled={pending !== null} onClick={save}>
            <Save size={14} aria-hidden="true" />
            {data.savedPath ? 'Update saved file' : 'Save to repo'}
          </Button>
        )}
        {data.format === 'drawio' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => void run('open_drawio')}
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open in draw.io
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={revising}
          aria-controls={revising ? noteId : undefined}
          disabled={pending !== null}
          onClick={() => {
            setRevising((open) => !open);
            requestAnimationFrame(() => noteRef.current?.focus());
          }}
        >
          <Sparkles size={14} aria-hidden="true" />
          {selectedNode && !compact
            ? `Ask agent to revise “${selectedNode.label}”`
            : 'Ask agent to revise'}
        </Button>
        {onCommentSurface && (
          <Button size="sm" variant="ghost" onClick={onCommentSurface}>
            <MessageSquarePlus size={14} aria-hidden="true" />
            Comment
          </Button>
        )}
      </div>
      {data.savedPath && (
        <p className="text-xs text-text-tertiary">
          Saved to <span className="font-mono [overflow-wrap:anywhere]">{data.savedPath}</span>
        </p>
      )}
      {revising && (
        <form
          id={noteId}
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void askRevise();
          }}
        >
          <label htmlFor={`${noteId}-note`} className="text-xs text-text-secondary">
            What should change?{' '}
            <span className="text-text-tertiary">
              (optional{selectedNode ? `; focused on “${selectedNode.label}”` : ''})
            </span>
          </label>
          <textarea
            id={`${noteId}-note`}
            ref={noteRef}
            value={note}
            rows={2}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void askRevise();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setRevising(false);
              }
            }}
            className="w-full resize-y rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            placeholder="e.g. Group the services by layer"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" type="submit" disabled={pending !== null}>
              Send to agent
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevising(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
