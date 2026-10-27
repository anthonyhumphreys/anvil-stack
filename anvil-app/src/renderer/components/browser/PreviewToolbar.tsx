import type { FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Globe,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  MoreHorizontal,
  PanelRightOpen,
  PictureInPicture2,
  Plug,
  PlugZap,
  Plus,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import type {
  BrowserBridgeStatus,
  DevServerTarget,
  SimulatorPreviewStatus,
} from '../../../shared/types';
import { IconButton, Menu, MenuItem, MenuSeparator, SegmentedControl } from '../ui';
import type { PreviewMode } from './BrowserPanel';

export interface PreviewToolbarProps {
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  url: string;
  onUrlChange: (url: string) => void;
  onNavigate: (event: FormEvent) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  loading: boolean;
  hasUrl: boolean;
  targets: DevServerTarget[];
  onTargetSelect: (target: DevServerTarget) => void;
  onAddTarget: () => void;
  bridge: BrowserBridgeStatus;
  bridgeStarting: boolean;
  onStartBridge: () => void;
  mcpStatus: 'idle' | 'registering' | 'registered' | 'error';
  onRegisterMcp: () => void;
  simulator: SimulatorPreviewStatus;
  simulatorStarting: boolean;
  onStartSimulator: () => void;
  onStopSimulator: () => void;
  annotating: boolean;
  onToggleAnnotation: () => void;
  onSendToChat: () => void;
  onOpenAlongsideChat?: () => void;
  onDetach?: () => void;
  onClose?: () => void;
}

/** Shared controls stay put; the second row belongs to the selected preview mode. */
export function PreviewToolbar(props: PreviewToolbarProps) {
  const simulatorMode = props.mode === 'simulator';
  return (
    <div className="shrink-0 border-b border-border-subtle bg-bg-secondary" data-preview-toolbar>
      <div className="flex min-h-11 min-w-0 items-center gap-1 px-2 py-1">
        <SegmentedControl
          label="Preview mode"
          value={props.mode}
          onChange={props.onModeChange}
          options={[
            { value: 'browser', label: 'Web', icon: Globe },
            { value: 'simulator', label: 'Simulator', icon: MonitorSmartphone },
          ]}
        />
        <div className="flex-1" />
        <IconButton
          icon={MessageSquare}
          label={props.annotating ? 'Close preview note' : 'Add preview note'}
          className="h-8 w-8"
          disabled={!props.hasUrl}
          aria-pressed={props.annotating}
          onClick={props.onToggleAnnotation}
        />
        {!simulatorMode && (
          <Menu
            label="Agent connection"
            trigger={(trigger) => (
              <button
                {...trigger}
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <PlugZap
                  size={13}
                  className={
                    props.mcpStatus === 'registered' ? 'text-success' : 'text-text-tertiary'
                  }
                  aria-hidden="true"
                />
                Agent
                <ChevronDown size={11} aria-hidden="true" />
              </button>
            )}
            menuClassName="w-72"
          >
            <div className="px-3 py-2 text-xs leading-5 text-text-secondary">
              <p className="font-medium text-text-primary">Agent connection</p>
              <p>
                {props.bridge.running
                  ? `Browser bridge on port ${props.bridge.port}`
                  : 'Browser bridge is off'}
              </p>
              <p>
                {props.mcpStatus === 'registered'
                  ? 'Chrome MCP registered with Codex'
                  : 'Connect Chrome MCP to let Codex inspect this preview.'}
              </p>
              {props.mcpStatus === 'error' && (
                <p role="alert" className="text-error">
                  Registration failed. Try again.
                </p>
              )}
            </div>
            {!props.bridge.running ? (
              <MenuItem
                icon={<Plug size={14} />}
                disabled={props.bridgeStarting || !props.hasUrl}
                onSelect={props.onStartBridge}
              >
                {props.bridgeStarting ? 'Starting bridge…' : 'Start browser bridge'}
              </MenuItem>
            ) : (
              props.mcpStatus !== 'registered' && (
                <MenuItem
                  icon={<PlugZap size={14} />}
                  disabled={props.mcpStatus === 'registering'}
                  onSelect={props.onRegisterMcp}
                >
                  {props.mcpStatus === 'registering' ? 'Registering…' : 'Register Chrome MCP'}
                </MenuItem>
              )
            )}
          </Menu>
        )}
        <Menu
          label="Preview actions"
          trigger={(trigger) => (
            <IconButton
              {...trigger}
              icon={MoreHorizontal}
              label="Preview actions"
              className="h-8 w-8"
            />
          )}
        >
          <MenuItem
            icon={<MessageSquare size={14} />}
            disabled={!props.hasUrl}
            onSelect={props.onSendToChat}
          >
            Send context to chat
          </MenuItem>
          {props.onOpenAlongsideChat && (
            <MenuItem icon={<PanelRightOpen size={14} />} onSelect={props.onOpenAlongsideChat}>
              Open alongside chat
            </MenuItem>
          )}
          {props.onDetach && (
            <MenuItem icon={<PictureInPicture2 size={14} />} onSelect={props.onDetach}>
              Open in new window
            </MenuItem>
          )}
          {simulatorMode && (
            <>
              <MenuSeparator />
              <div className="space-y-1 px-3 py-2 text-xs text-text-secondary">
                <p className="font-medium text-text-primary">Simulator connection</p>
                <p className="break-all">{props.simulator.url ?? 'Simulator is off'}</p>
                {props.simulator.metroUrl && (
                  <p className="break-all">Metro: {props.simulator.metroUrl}</p>
                )}
              </div>
            </>
          )}
        </Menu>
        {props.onClose && (
          <IconButton icon={X} label="Close preview" onClick={props.onClose} className="h-8 w-8" />
        )}
      </div>

      <div className="flex min-h-10 min-w-0 items-center gap-1 px-2 pb-2">
        {simulatorMode ? (
          <>
            <MonitorSmartphone
              size={14}
              className="mx-1 shrink-0 text-text-tertiary"
              aria-hidden="true"
            />
            <span
              className="min-w-0 flex-1 truncate text-xs text-text-secondary"
              title={props.simulator.url}
              role="status"
            >
              {props.simulatorStarting
                ? 'Starting simulator…'
                : props.simulator.running
                  ? 'Simulator running'
                  : 'Simulator offline'}
            </span>
            <IconButton
              icon={props.loading ? Loader2 : RotateCw}
              label="Reload simulator"
              disabled={!props.hasUrl}
              onClick={props.onReload}
              className={`h-8 w-8 ${props.loading ? '[&>svg]:animate-spin' : ''}`}
            />
            <button
              type="button"
              disabled={props.simulatorStarting}
              onClick={props.simulator.running ? props.onStopSimulator : props.onStartSimulator}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
            >
              {props.simulatorStarting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : props.simulator.running ? (
                <Square size={12} />
              ) : (
                <Plug size={12} />
              )}
              {props.simulator.running ? 'Stop' : 'Start simulator'}
            </button>
          </>
        ) : (
          <>
            <IconButton
              icon={ArrowLeft}
              label="Back"
              disabled={!props.canGoBack}
              onClick={props.onBack}
              className="h-8 w-7"
            />
            <IconButton
              icon={ArrowRight}
              label="Forward"
              disabled={!props.canGoForward}
              onClick={props.onForward}
              className="h-8 w-7"
            />
            <IconButton
              icon={props.loading ? Loader2 : RotateCw}
              label="Reload preview"
              disabled={!props.hasUrl}
              onClick={props.onReload}
              className={`h-8 w-7 ${props.loading ? '[&>svg]:animate-spin' : ''}`}
            />
            <form
              onSubmit={props.onNavigate}
              className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border border-border bg-bg-primary focus-within:border-accent/50"
            >
              <input
                aria-label="Preview URL"
                value={props.url}
                onChange={(event) => props.onUrlChange(event.target.value)}
                placeholder="Enter URL…"
                className="h-8 min-w-0 flex-1 bg-transparent pl-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
              <Menu
                label="Development servers"
                trigger={(trigger) => (
                  <button
                    {...trigger}
                    type="button"
                    aria-label={`Development servers: ${props.targets.length} detected`}
                    className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                  >
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
                )}
                menuClassName="w-72"
              >
                <div className="px-3 py-2 text-xs text-text-secondary">
                  {props.targets.length
                    ? 'Development servers'
                    : 'Start a dev server in the terminal to see it here.'}
                </div>
                {props.targets.map((target) => (
                  <MenuItem
                    key={target.id}
                    icon={<Globe size={14} />}
                    onSelect={() => props.onTargetSelect(target)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{target.label}</span>
                      <span className="block truncate text-xs text-text-tertiary">
                        {target.url}
                      </span>
                    </span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  icon={<Plus size={14} />}
                  disabled={!props.url.trim()}
                  onSelect={props.onAddTarget}
                >
                  Add current URL
                </MenuItem>
              </Menu>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
