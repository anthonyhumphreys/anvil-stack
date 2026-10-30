import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Copy, Ellipsis, MessageSquarePlus, Share2 } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type { ShareTarget } from '../../../shared/shares-ipc';
import { getSurfaceKind } from '../../../shared/surfaces/registry';
import { copyTextToClipboard } from '../../utils/clipboard';
import { ShareDialog } from '../share/ShareDialog';
import { Button, IconButton, Menu, MenuItem } from '../ui';
import { getSurfaceView } from './registry';
import { useSurfaces } from './surfaces-context';
import type { SurfacePresentation, SurfaceViewProps } from './types';
import { canShareSurface, readSketchSurfaceData, resolveShareTarget } from './surface-utils';

class SurfaceErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null; resetKey: string }
> {
  state: { error: Error | null; resetKey: string } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; resetKey: string },
  ) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[Surfaces] Surface failed to render:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex items-start gap-2.5 py-2 text-sm text-text-secondary">
        <AlertTriangle size={14} aria-hidden="true" className="mt-1 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p>This preview couldn’t be shown. The agent’s summary is still available below.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
}

/** Renders a surface with its kind's view for a presentation, inside an error boundary. */
export function SurfaceKindRenderer({
  intent,
  presentation,
  onAction,
  onComment,
  onOpenStage,
  focusTargetId,
}: Omit<SurfaceViewProps, 'presentation' | 'readOnly'> & { presentation: SurfacePresentation }) {
  const { readOnly } = useSurfaces();
  const view = getSurfaceView(intent.payload.surfaceKind);
  if (!view) {
    return (
      <div className="space-y-1 text-sm text-text-secondary">
        <p className="text-xs text-text-tertiary">
          This version of Mezair can’t display this output type: {intent.payload.surfaceKind}.
        </p>
        <p className="whitespace-pre-wrap break-words">{intent.payload.digest}</p>
      </div>
    );
  }
  const View = presentation === 'inline' ? view.Inline : (view.Stage ?? view.Inline);
  return (
    <SurfaceErrorBoundary resetKey={`${intent.id}:${intent.revision}`}>
      <View
        intent={intent}
        presentation={presentation}
        onAction={onAction}
        onComment={onComment}
        onOpenStage={onOpenStage}
        focusTargetId={focusTargetId}
        readOnly={readOnly}
      />
    </SurfaceErrorBoundary>
  );
}

/** Share… for any surface: artifacts and shareable kinds directly, sketches after Keep. */
export function useSurfaceShare(intent: AgentUISurfaceIntent) {
  const definition = getSurfaceKind(intent.payload.surfaceKind);
  const shareable = definition?.shareable === true;
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    const direct = resolveShareTarget(intent, shareable);
    if (direct) {
      setTarget(direct);
      return;
    }
    const sketch = readSketchSurfaceData(intent.payload.data);
    if (intent.payload.surfaceKind !== 'sketch' || !sketch) return;
    setBusy(true);
    try {
      const artifact = await window.mezair.surfaces.keepSketch(
        sketch.sketchId,
        intent.payload.title,
      );
      setTarget({ itemType: 'artifact', itemId: artifact.id });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The sketch could not be kept for sharing.',
      );
    } finally {
      setBusy(false);
    }
  }, [intent, shareable]);

  const dialog = target ? (
    <ShareDialog
      target={target}
      title={intent.payload.title}
      open
      onClose={() => setTarget(null)}
    />
  ) : null;

  return { canShare: canShareSurface(intent, shareable), start, busy, error, dialog };
}

export function SurfaceOverflowMenu({
  intent,
  canComment,
  onCommentSurface,
  share,
  className,
}: {
  intent: AgentUISurfaceIntent;
  canComment: boolean;
  onCommentSurface: () => void;
  share: ReturnType<typeof useSurfaceShare>;
  className?: string;
}) {
  return (
    <Menu
      label={`${intent.payload.title} actions`}
      align="end"
      className={className}
      trigger={(props) => (
        <IconButton {...props} icon={Ellipsis} label="More output actions" size="sm" />
      )}
    >
      <MenuItem
        icon={<Copy size={14} aria-hidden="true" />}
        onSelect={() => void copyTextToClipboard(intent.payload.digest)}
      >
        Copy summary
      </MenuItem>
      {canComment && (
        <MenuItem
          icon={<MessageSquarePlus size={14} aria-hidden="true" />}
          onSelect={onCommentSurface}
        >
          Add comment
        </MenuItem>
      )}
      {share.canShare && (
        <MenuItem
          icon={<Share2 size={14} aria-hidden="true" />}
          disabled={share.busy}
          onSelect={() => void share.start()}
        >
          {intent.payload.surfaceKind === 'sketch' ? 'Keep and share…' : 'Share…'}
        </MenuItem>
      )}
    </Menu>
  );
}
