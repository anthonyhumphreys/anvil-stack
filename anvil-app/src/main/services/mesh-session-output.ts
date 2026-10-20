export interface BoundedRemoteAssistantOutput {
  text: string;
  truncated: boolean;
}

/** Leave room for result metadata and base64 encryption in the 64 KiB report limit. */
export function boundedRemoteAssistantOutput(text: string): BoundedRemoteAssistantOutput {
  const maximumChars = 32_000;
  const maximumJsonBytes = 36_000;
  const truncationMarker = '\n\n[Output truncated by Anvil]';
  const prefix = (length: number): string => {
    let result = text.slice(0, length);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
    return result;
  };
  let high = Math.min(text.length, maximumChars);
  if (
    high === text.length &&
    Buffer.byteLength(JSON.stringify(text), 'utf8') <= maximumJsonBytes
  ) {
    return { text, truncated: false };
  }

  high = Math.min(high, maximumChars - truncationMarker.length);
  const fits = (length: number): boolean =>
    Buffer.byteLength(JSON.stringify(`${prefix(length)}${truncationMarker}`), 'utf8') <=
    maximumJsonBytes;
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return { text: `${prefix(low)}${truncationMarker}`, truncated: true };
}
