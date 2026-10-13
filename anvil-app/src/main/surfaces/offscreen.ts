// Offscreen rendering of sketch documents: measure height, screenshot, and
// freeze (serialise the settled DOM, canvases to images). Owned by the
// surface-contract workstream; used by sketches and sharing.

export interface OffscreenRenderOptions {
  width: number;
  /** Wait after load before measuring/serialising. */
  settleMs?: number;
  screenshot?: boolean;
  freeze?: boolean;
}

export interface OffscreenRenderResult {
  height: number;
  /** Base64 PNG when `screenshot`. */
  png?: string;
  /** Script-free serialised document when `freeze`. */
  frozenHtml?: string;
}

export async function renderOffscreen(
  _document: string,
  _options: OffscreenRenderOptions,
): Promise<OffscreenRenderResult> {
  throw new Error('renderOffscreen not implemented');
}
