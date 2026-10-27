import { describe, expect, it } from 'vitest';
import { displayCommand } from '../command-display';

describe('displayCommand', () => {
  it('strips login-shell wrappers', () => {
    expect(displayCommand("/bin/zsh -lc 'git branch --show-current'")).toBe(
      'git branch --show-current',
    );
    expect(displayCommand("bash -lc 'pnpm test'")).toBe('pnpm test');
    expect(displayCommand('/usr/bin/env sh -c "echo \\"hi\\""')).toBe('echo "hi"');
  });

  it('unescapes POSIX single-quote escapes', () => {
    expect(displayCommand("/bin/zsh -lc 'echo '\\''quoted'\\'''")).toBe("echo 'quoted'");
    expect(
      displayCommand(
        "/bin/zsh -lc 'rg -n \"PostHog|Sentry|daisyUI\" app package.json | sed -n '\\''1,12p'\\'''",
      ),
    ).toBe('rg -n "PostHog|Sentry|daisyUI" app package.json | sed -n \'1,12p\'');
  });

  it('leaves other commands and malformed wrappers unchanged', () => {
    expect(displayCommand('git status')).toBe('git status');
    expect(displayCommand("/bin/zsh -lc 'unterminated")).toBe("/bin/zsh -lc 'unterminated");
    expect(displayCommand("/bin/zsh -lc 'a' && rm -rf 'b'")).toBe("/bin/zsh -lc 'a' && rm -rf 'b'");
  });
});
