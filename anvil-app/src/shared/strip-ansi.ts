import ansiRegex from 'ansi-regex';

/** Remove terminal formatting while preserving diagnostic text and line breaks. */
export function stripAnsi(value: string): string {
  return value.replace(ansiRegex(), '');
}
