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
  onReady?: () => void;
}

export function TerminalInstance({
  workspaceId,
  repoId,
  repoPath,
  visible,
  onReady,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  // Create terminal once on mount
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

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

    // Spawn PTY
    window.anvil.terminal
      .create(workspaceId, repoId, repoPath)
      .then(({ terminalId }) => {
        terminalIdRef.current = terminalId;
        onReady?.();
      })
      .catch((err) => {
        terminal.write(`\r\n\x1b[31mFailed to create terminal: ${err.message}\x1b[0m\r\n`);
      });

    // User input → main process
    const inputDisposable = terminal.onData((data) => {
      if (terminalIdRef.current) {
        window.anvil.terminal.input(terminalIdRef.current, data);
      }
    });

    // PTY output → terminal
    const removeDataListener = window.anvil.terminal.onData(({ terminalId, data }) => {
      if (terminalId === terminalIdRef.current) {
        terminal.write(data);
      }
    });

    // PTY exit
    const removeExitListener = window.anvil.terminal.onExit(({ terminalId, exitCode }) => {
      if (terminalId === terminalIdRef.current) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        terminalIdRef.current = null;
      }
    });

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      if (terminalIdRef.current) {
        window.anvil.terminal.close(terminalIdRef.current);
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
