/** Leave room for result metadata and base64 encryption in the 64 KiB report limit. */
export function boundedRemoteAssistantOutput(text: string): string {
  const maximumChars = 32_000;
  const maximumJsonBytes = 36_000;
  const prefix = (length: number): string => {
    let result = text.slice(0, length);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
    return result;
  };
  let high = Math.min(text.length, maximumChars);
  if (Buffer.byteLength(JSON.stringify(prefix(high)), 'utf8') <= maximumJsonBytes)
    return prefix(high);
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(prefix(middle)), 'utf8') <= maximumJsonBytes) low = middle;
    else high = middle - 1;
  }
  return prefix(low);
}
