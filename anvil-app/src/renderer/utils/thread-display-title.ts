/** Build the same first-line title used for a new chat thread. */
export function buildThreadTitle(message: string, personaName: string): string {
  return summarizePromptTitle(message) ?? buildEmptyThreadLabel(personaName);
}

export function buildEmptyThreadLabel(personaName: string): string {
  return `New ${personaName} Thread`;
}

/** Use a prompt's first non-empty line as a compact task title. */
export function summarizePromptTitle(message: string, maxLength = 56): string | null {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  return truncate(firstLine, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}
