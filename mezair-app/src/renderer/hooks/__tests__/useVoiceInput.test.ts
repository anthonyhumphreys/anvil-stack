import { describe, expect, it } from 'vitest';
import { describeVoiceInputError } from '../useVoiceInput';

describe('describeVoiceInputError', () => {
  it('turns permission failures into an actionable macOS message', () => {
    expect(describeVoiceInputError('not-allowed')).toContain(
      'System Settings → Privacy & Security → Microphone',
    );
  });

  it('explains an immediate no-speech stop instead of silently resetting', () => {
    expect(describeVoiceInputError('no-speech')).toBe(
      'No speech was detected. Try again and speak after the microphone turns red.',
    );
  });

  it('keeps a useful runtime message for unknown errors', () => {
    expect(describeVoiceInputError('unknown', 'Recognizer unavailable')).toBe(
      'Recognizer unavailable',
    );
  });
});
