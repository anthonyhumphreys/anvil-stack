import { describe, expect, it } from 'vitest';
import { boundedRemoteAssistantOutput } from '../mesh-session-output';

describe('remote assistant result transport', () => {
  it('retains normal responses up to the character limit', () => {
    const text = 'a'.repeat(20_000);
    expect(boundedRemoteAssistantOutput(text)).toEqual({ text, truncated: false });
  });
  it.each(['界', '🦄', '\u0000', '\\'])('fits encrypted-report budgets for %j', (character) => {
    const text = character.repeat(32_000);
    const output = boundedRemoteAssistantOutput(text);
    expect(output.truncated).toBe(true);
    expect(output.text.startsWith(text.slice(0, output.text.indexOf('\n\n[Output truncated')))).toBe(
      true,
    );
    expect(output.text).toContain('[Output truncated by Anvil]');
    expect(Buffer.byteLength(JSON.stringify(output.text), 'utf8')).toBeLessThanOrEqual(36_000);
    expect(output.text.length).toBeLessThanOrEqual(32_000);
    expect(output.text.endsWith('\ud83e')).toBe(false);
    const result = JSON.stringify({
      assistantOutput: output.text,
      assistantOutputTruncated: output.truncated,
      resumeHandle: 'thread-test',
    });
    const encryptedBytes = Buffer.byteLength(result, 'utf8') + 16;
    expect(Math.ceil(encryptedBytes / 3) * 4 + 1024).toBeLessThan(64 * 1024);
  });

  it('marks output truncated when the JSON byte budget is reached before the character cap', () => {
    const output = boundedRemoteAssistantOutput('\u0000'.repeat(20_000));
    expect(output.truncated).toBe(true);
    expect(output.text).toContain('[Output truncated by Anvil]');
    expect(Buffer.byteLength(JSON.stringify(output.text), 'utf8')).toBeLessThanOrEqual(36_000);
  });
});
