// Builds the sandboxed document for a sketch: CSP, --anvil-* tokens, the
// host bridge (size, links, selection, ask, tools/call over MCP Apps-style
// JSON-RPC postMessage) and anvil-kit. Owned by the renderer workstream;
// also used by main (measure/freeze) and sharing (interactive bundles).

export type SketchTokenSet = Record<string, string>;

export interface SketchDocumentOptions {
  /** Single theme (in-app, follows the active theme) or light+dark (shares). */
  tokens: SketchTokenSet | { light: SketchTokenSet; dark: SketchTokenSet };
  /** 'inline' talks to the Anvil host; 'share' is standalone (no tools/ask). */
  mode: 'inline' | 'share';
}

/** Default token values for the base dark and light themes (shares, offscreen). */
export const DEFAULT_SKETCH_TOKENS: { dark: SketchTokenSet; light: SketchTokenSet } = {
  dark: {},
  light: {},
};

export function buildSketchDocument(html: string, _options: SketchDocumentOptions): string {
  return html;
}
