export const SKETCH_MIN_HEIGHT = 48;
export const SKETCH_MAX_HEIGHT = 4000;

export type SketchBridgeMessage =
  | { kind: 'initialize'; id: string | number }
  | { kind: 'size'; height: number }
  | { kind: 'open-link'; url: string; id?: string | number }
  | { kind: 'ask'; prompt: string; id?: string | number }
  | { kind: 'unsupported-request'; id: string | number }
  | { kind: 'ignore' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function clampSketchHeight(height: number): number {
  return Math.round(Math.min(Math.max(height, SKETCH_MIN_HEIGHT), SKETCH_MAX_HEIGHT));
}

/** Accepts only absolute http(s) URLs. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Parses a JSON-RPC 2.0 message from a sketch frame. Source checks happen before this. */
export function parseSketchBridgeMessage(data: unknown): SketchBridgeMessage {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || typeof data.method !== 'string') {
    return { kind: 'ignore' };
  }
  const params = isRecord(data.params) ? data.params : {};
  const id = typeof data.id === 'string' || typeof data.id === 'number' ? data.id : undefined;
  switch (data.method) {
    case 'ui/initialize':
      return id === undefined ? { kind: 'ignore' } : { kind: 'initialize', id };
    case 'ui/notifications/size-changed': {
      const height = Number(params.height);
      return Number.isFinite(height) && height >= 0
        ? { kind: 'size', height: clampSketchHeight(height) }
        : { kind: 'ignore' };
    }
    case 'ui/open-link': {
      const url = safeExternalUrl(params.url);
      return url ? { kind: 'open-link', url, id } : { kind: 'ignore' };
    }
    case 'mezair/ask': {
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim().slice(0, 4000) : '';
      return prompt ? { kind: 'ask', prompt, id } : { kind: 'ignore' };
    }
    default:
      return id === undefined ? { kind: 'ignore' } : { kind: 'unsupported-request', id };
  }
}
