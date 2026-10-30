/** Preserve explicit operator overrides; app builds enable Mesh endpoints by default. */
export function isMeshEndpointFlagEnabled(
  runtimeValue: string | undefined,
  buildValue: string | undefined,
): boolean {
  if (runtimeValue !== undefined) return runtimeValue === 'true';
  return buildValue === undefined ? true : buildValue === 'true';
}
