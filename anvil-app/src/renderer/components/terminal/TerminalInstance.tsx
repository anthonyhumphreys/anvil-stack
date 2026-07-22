import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalInstanceProps {
  workspaceId: string;
  repoId: string;
  repoPath: string;
  visible: boolean;
  onReady?: (terminalId: string) => void;
  onClosed?: () => void;
}

export function TerminalInstance({
  workspaceId,
  repoId,
  repoPath,
  visible,
  onReady,
  onClosed,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const lastSequenceRef = useRef(0);
  const initializedRef = useRef(false);

  // Create terminal once on mount
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    let replayComplete = false;
    let pendingExitCode: number | null = null;
    const pendingOutput: Array<{ sequence: number; data: string }> = [];

    const terminal = new Terminal({
      theme: {
        background: '#121314',
        foreground: '#f5f2ec',
        cursor: '#b5121b',
        cursorAccent: '#121314',
        selectionBackground: '#b5121b33',
        black: '#232528',
        red: '#e67a79',
        green: '#72b589',
        yellow: '#fd9029',
        blue: '#79a7c6',
        magenta: '#c77d4b',
        cyan: '#8fb2b7',
        white: '#f5f2ec',
        brightBlack: '#555656',
        brightRed: '#f0a2a1',
        brightGreen: '#9fd0ae',
        brightYellow: '#ffc17f',
        brightBlue: '#a7c7dd',
        brightMagenta: '#e0a77c',
        brightCyan: '#b1d0d3',
        brightWhite: '#fffaf3',
      },
      fontFamily:
        '"MesloLGS Nerd Font Mono", "MesloLGS NF", "Hack Nerd Font", "FiraCode Nerd Font", "IBM Plex Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Auto-fit on container resize (triggered by panel drag)
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        if (terminalIdRef.current) {
          window.anvil.terminal.resize(
            terminalIdRef.current,
            terminalRef.current.cols,
            terminalRef.current.rows,
          );
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    // User input → main process
    const inputDisposable = terminal.onData((data) => {
      if (terminalIdRef.current) {
        window.anvil.terminal.input(terminalIdRef.current, data);
      }
    });

    // PTY output → terminal
    const removeDataListener = window.anvil.terminal.onData(({ terminalId, sequence, data }) => {
      if (terminalId === terminalIdRef.current) {
        if (!replayComplete) {
          pendingOutput.push({ sequence, data });
          return;
        }
        if (sequence <= lastSequenceRef.current) return;
        terminal.write(data);
        lastSequenceRef.current = sequence;
      }
    });

    // PTY exit
    const removeExitListener = window.anvil.terminal.onExit(({ terminalId, exitCode }) => {
      if (terminalId === terminalIdRef.current) {
        if (!replayComplete) {
          pendingExitCode = exitCode;
          return;
        }
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
    });
    const removeClosedListener = window.anvil.terminal.onClosed(({ terminalId }) => {
      if (terminalId === terminalIdRef.current) {
        terminal.write('\r\n\x1b[90m[Terminal closed]\x1b[0m\r\n');
        onClosed?.();
      }
    });

    // Spawn or reconnect to the workspace/repository PTY. The PTY is owned by the
    // main process; this renderer merely attaches while it is visible.
    window.anvil.terminal
      .create(workspaceId, repoId, repoPath)
      .then(async ({ terminalId }) => {
        if (cancelled) return;
        terminalIdRef.current = terminalId;
        const attachment = await window.anvil.terminal.attach(terminalId);
        if (cancelled) {
          window.anvil.terminal.detach(terminalId);
          return;
        }

        for (const chunk of attachment.output) {
          if (chunk.sequence <= lastSequenceRef.current) continue;
          terminal.write(chunk.data);
          lastSequenceRef.current = chunk.sequence;
        }
        for (const chunk of pendingOutput.sort((left, right) => left.sequence - right.sequence)) {
          if (chunk.sequence <= lastSequenceRef.current) continue;
          terminal.write(chunk.data);
          lastSequenceRef.current = chunk.sequence;
        }
        replayComplete = true;

        if (attachment.session.status === 'exited' || pendingExitCode !== null) {
          terminal.write(
            `\r\n\x1b[90m[Process exited with code ${pendingExitCode ?? attachment.session.exitCode ?? 0}]\x1b[0m\r\n`,
          );
        }
        onReady?.(terminalId);
      })
      .catch((err) => {
        if (!cancelled) {
          terminal.write(`\r\n\x1b[31mFailed to create terminal: ${err.message}\x1b[0m\r\n`);
        }
      });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      removeClosedListener();
      if (terminalIdRef.current) {
        window.anvil.terminal.detach(terminalIdRef.current);
      }
      terminal.dispose();
    };
  }, []);

  // Fit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      // Delay fit to allow DOM to update
      const timeout = setTimeout(() => {
        fitAddonRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal && terminalIdRef.current) {
          window.anvil.terminal.resize(terminalIdRef.current, terminal.cols, terminal.rows);
        }
      }, 50);
      return () => clearTimeout(timeout);
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
