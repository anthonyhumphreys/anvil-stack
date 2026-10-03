import { describe, expect, it } from 'vitest';
import { boundedRemoteAssistantOutput } from '../mesh-session-output';

describe('remote assistant result transport', () => {
  it('retains normal responses up to the character limit', () => {
    const text = 'a'.repeat(40_000);
    expect(boundedRemoteAssistantOutput(text)).toBe(text.slice(0, 32_000));
  });
  it.each(['界', '🦄', '\u0000', '\\'])('fits encrypted-report budgets for %j', (character) => {
    const text = character.repeat(32_000);
    const output = boundedRemoteAssistantOutput(text);
    expect(text.startsWith(output)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(36_000);
    expect(output.length).toBeLessThanOrEqual(32_000);
    expect(output.endsWith('\ud83e')).toBe(false);
    const result = JSON.stringify({ assistantOutput: output, resumeHandle: 'thread-test' });
    const encryptedBytes = Buffer.byteLength(result, 'utf8') + 16;
    expect(Math.ceil(encryptedBytes / 3) * 4 + 1024).toBeLessThan(64 * 1024);
  });
});
