/** Preserve runtime operator opt-in and support flags embedded in candidate builds. */
export function isMeshEndpointFlagEnabled(
  runtimeValue: string | undefined,
  buildValue: string | undefined,
): boolean {
  return runtimeValue === undefined ? buildValue === 'true' : runtimeValue === 'true';
}
