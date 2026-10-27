// Agents run commands through a login shell (`/bin/zsh -lc '…'`). Show the
// command the agent meant; copying still uses the full original string.

const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/(?:env\s+)?)?(?:ba|z|da|k)?sh\s+-l?c\s+([\s\S]+)$/;

function unquoteShellArgument(value: string): string | null {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    // POSIX single quotes: the only escape is closing, escaping and reopening (`'\''`).
    const inner = text.slice(1, -1);
    if (/'(?!\\'')/.test(inner.replace(/'\\''/g, ''))) return null;
    return inner.replace(/'\\''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return null;
}

/** `/bin/zsh -lc 'git status'` → `git status`; anything else is returned unchanged. */
export function displayCommand(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  if (!match) return command;
  return unquoteShellArgument(match[1]) ?? command;
}
