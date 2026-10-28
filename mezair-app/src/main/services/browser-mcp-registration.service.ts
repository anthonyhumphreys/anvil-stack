export interface CodexStdioMcpRegistration {
  name: string;
  transport: {
    type: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string> | null;
  };
}

export function buildBrowserMcpAddArgs(
  name: string,
  electronPath: string,
  scriptPath: string,
): string[] {
  // A packaged Electron executable otherwise starts a second GUI process. Codex launches stdio
  // MCPs in a background process group, so that GUI process can be suspended when it touches TTY input.
  return ['mcp', 'add', name, '--env', 'ELECTRON_RUN_AS_NODE=1', '--', electronPath, scriptPath];
}

export function parseCodexStdioMcpRegistration(output: string): CodexStdioMcpRegistration | null {
  try {
    const registration = JSON.parse(output) as Partial<CodexStdioMcpRegistration>;
    const transport = registration.transport;
    if (
      typeof registration.name !== 'string' ||
      transport?.type !== 'stdio' ||
      typeof transport.command !== 'string' ||
      !Array.isArray(transport.args) ||
      !transport.args.every((arg) => typeof arg === 'string')
    ) {
      return null;
    }

    return registration as CodexStdioMcpRegistration;
  } catch {
    return null;
  }
}

export function isCurrentBrowserMcpRegistration(
  registration: CodexStdioMcpRegistration,
  electronPath: string,
  scriptPath: string,
): boolean {
  return (
    registration.transport.command === electronPath &&
    registration.transport.args.length === 1 &&
    registration.transport.args[0] === scriptPath &&
    registration.transport.env?.ELECTRON_RUN_AS_NODE === '1'
  );
}
