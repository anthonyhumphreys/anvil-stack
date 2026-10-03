export type StablePreviewStatus = 'idle' | 'pending' | 'ready' | 'error';

export interface StablePreviewState<T> {
  identity: string | null;
  value: T | null;
  renderedSource: string | null;
  requestedSource: string | null;
  requestId: number;
  status: StablePreviewStatus;
  error: string | null;
}

export function createStablePreviewState<T>(): StablePreviewState<T> {
  return {
    identity: null,
    value: null,
    renderedSource: null,
    requestedSource: null,
    requestId: 0,
    status: 'idle',
    error: null,
  };
}

export function beginStablePreview<T>(
  current: StablePreviewState<T>,
  identity: string,
  source: string,
  requestId: number,
): StablePreviewState<T> {
  const sameIdentity = current.identity === identity;
  const retained = sameIdentity ? current : createStablePreviewState<T>();
  const alreadyRendered = retained.renderedSource === source && retained.value !== null;

  return {
    ...retained,
    identity,
    requestedSource: source,
    requestId,
    status: alreadyRendered ? 'ready' : 'pending',
    error: null,
  };
}

export function resolveStablePreview<T>(
  current: StablePreviewState<T>,
  identity: string,
  source: string,
  requestId: number,
  value: T,
): StablePreviewState<T> {
  if (!isCurrentPreviewRequest(current, identity, source, requestId)) return current;

  return {
    ...current,
    value,
    renderedSource: source,
    status: 'ready',
    error: null,
  };
}

export function rejectStablePreview<T>(
  current: StablePreviewState<T>,
  identity: string,
  source: string,
  requestId: number,
  error: string,
): StablePreviewState<T> {
  if (!isCurrentPreviewRequest(current, identity, source, requestId)) return current;

  return { ...current, status: 'error', error };
}

function isCurrentPreviewRequest<T>(
  current: StablePreviewState<T>,
  identity: string,
  source: string,
  requestId: number,
): boolean {
  return (
    current.identity === identity &&
    current.requestedSource === source &&
    current.requestId === requestId
  );
}
