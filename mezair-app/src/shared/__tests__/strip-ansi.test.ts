import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../strip-ansi';

describe('plain-text review diagnostics', () => {
  it('removes Playwright timeout formatting without losing the locator or call log', () => {
    const message =
      'locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n' +
      '\u001b[2m  - waiting for locator(\'[data-testid="result"]\') to be visible\u001b[22m\n';
    expect(stripAnsi(message)).toBe(
      'locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n' +
        '  - waiting for locator(\'[data-testid="result"]\') to be visible\n',
    );
  });

  it('preserves literal bracketed diagnostics and already plain errors', () => {
    const message = 'Expected "[2m]", received "[22m]".\n\tSelector: [role="status"]';
    expect(stripAnsi(message)).toBe(message);
  });

  it('removes terminal hyperlinks while retaining their displayed text', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007trace\u001b]8;;\u0007')).toBe('trace');
  });
});
