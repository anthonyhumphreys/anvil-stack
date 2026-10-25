/** Portable inert continuation data. No share keys, paths, credentials or actions. */
export const MAX_THREAD_PICKUP_BYTES = 12 * 1024 * 1024;
export const MAX_THREAD_PICKUP_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_THREAD_PICKUP_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_THREAD_PICKUP_FILES = 16;
export interface ThreadContinuation {
  format: 'anvil-thread-continuation/v1';
  entries: Array<{
    role: 'user' | 'assistant';
    text: string;
    at: string;
    source: 'Conversation' | 'Mesh';
    note?: string;
  }>;
  context: {
    repoNames: string[];
    ticket?: { id: string; provider: 'jira' | 'linear' | 'ado'; title?: string };
    plan?: string;
    goal?: string;
  };
  items: Array<{
    kind: 'artifact' | 'surface' | 'attachment';
    title: string;
    text?: string;
    fileIndex?: number;
  }>;
}
export interface ThreadPickupFile {
  name: string;
  mediaType: string;
  dataBase64: string;
}
export interface ThreadPickupPackage {
  format: 'anvil-thread/v1';
  title: string;
  sharedAt: string;
  source: { shareId: string; version: number; viewerUrl?: string };
  continuation: ThreadContinuation;
  files?: ThreadPickupFile[];
  snapshot?: { html: string; css: string };
}
const encoder = new TextEncoder();
function invalid(): never {
  throw new Error('This thread package is invalid or exceeds the supported limits.');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maxBytes ||
    encoder.encode(value).byteLength > maxBytes
  )
    return invalid();
  return value;
}
function date(value: unknown): string {
  const result = string(value, 64);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) return invalid();
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export function validateThreadContinuation(value: unknown, fileCount = 0): ThreadContinuation {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || fileCount > MAX_THREAD_PICKUP_FILES)
    return invalid();
  const v = object(value, ['format', 'entries', 'context', 'items']);
  if (v.format !== 'anvil-thread-continuation/v1') return invalid();
  let textBytes = 0;
  const text = (input: unknown, max = MAX_THREAD_PICKUP_TEXT_BYTES): string => {
    const result = string(input, max);
    textBytes += encoder.encode(result).byteLength;
    if (textBytes > MAX_THREAD_PICKUP_TEXT_BYTES) return invalid();
    return result;
  };
  const entries = array(v.entries, 10_000).map((input): ThreadContinuation['entries'][number] => {
    const e = object(input, ['role', 'text', 'at', 'source', 'note']);
    if (e.role !== 'user' && e.role !== 'assistant') return invalid();
    if (e.source !== 'Conversation' && e.source !== 'Mesh') return invalid();
    return {
      role: e.role,
      text: text(e.text),
      at: date(e.at),
      source: e.source,
      ...(e.note !== undefined ? { note: text(e.note, 4000) } : {}),
    };
  });
  const c = object(v.context, ['repoNames', 'ticket', 'plan', 'goal']);
  const repoNames = array(c.repoNames, 100).map((name) => text(name, 1000));
  let ticket: ThreadContinuation['context']['ticket'];
  if (c.ticket !== undefined) {
    const t = object(c.ticket, ['id', 'provider', 'title']);
    if (!['jira', 'linear', 'ado'].includes(String(t.provider))) return invalid();
    const id = text(t.id, 200);
    if (!id.trim()) return invalid();
    ticket = {
      id,
      provider: t.provider as 'jira' | 'linear' | 'ado',
      ...(t.title !== undefined ? { title: text(t.title, 1000) } : {}),
    };
  }
  const items = array(v.items, 16).map((input): ThreadContinuation['items'][number] => {
    const item = object(input, ['kind', 'title', 'text', 'fileIndex']);
    if (!['artifact', 'surface', 'attachment'].includes(String(item.kind))) return invalid();
    if (item.text === undefined && item.fileIndex === undefined) return invalid();
    if (
      item.fileIndex !== undefined &&
      (!Number.isSafeInteger(item.fileIndex) ||
        (item.fileIndex as number) < 0 ||
        (item.fileIndex as number) >= fileCount)
    )
      return invalid();
    return {
      kind: item.kind as 'artifact' | 'surface' | 'attachment',
      title: text(item.title, 1000),
      ...(item.text !== undefined ? { text: text(item.text) } : {}),
      ...(item.fileIndex !== undefined ? { fileIndex: item.fileIndex as number } : {}),
    };
  });
  return {
    format: 'anvil-thread-continuation/v1',
    entries,
    context: {
      repoNames,
      ...(ticket ? { ticket } : {}),
      ...(c.plan !== undefined ? { plan: text(c.plan) } : {}),
      ...(c.goal !== undefined ? { goal: text(c.goal) } : {}),
    },
    items,
  };
}
export function validateThreadPickupPackage(value: unknown): ThreadPickupPackage {
  const v = object(value, [
    'format',
    'title',
    'sharedAt',
    'source',
    'continuation',
    'files',
    'snapshot',
  ]);
  if (v.format !== 'anvil-thread/v1') return invalid();
  const title = string(v.title, 1000),
    sharedAt = date(v.sharedAt);
  const source = object(v.source, ['shareId', 'version', 'viewerUrl']);
  const shareId = string(source.shareId, 128);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(shareId) ||
    !Number.isSafeInteger(source.version) ||
    (source.version as number) < 1
  )
    return invalid();
  let viewerUrl: string | undefined;
  if (source.viewerUrl !== undefined) {
    viewerUrl = string(source.viewerUrl, 2048);
    let url: URL;
    try {
      url = new URL(viewerUrl);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/artifacts/${shareId}` ||
      viewerUrl !== `${url.origin}/artifacts/${shareId}`
    )
      return invalid();
  }
  let fileBytes = 0;
  const files =
    v.files === undefined
      ? undefined
      : array(v.files, MAX_THREAD_PICKUP_FILES).map((input): ThreadPickupFile => {
          const file = object(input, ['name', 'mediaType', 'dataBase64']);
          const name = string(file.name, 255),
            mediaType = string(file.mediaType, 128);
          if (
            !name.trim() ||
            name === '.' ||
            name === '..' ||
            /[\\/\u0000-\u001f\u007f]/.test(name)
          )
            return invalid();
          if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)) return invalid();
          const dataBase64 = string(file.dataBase64, MAX_THREAD_PICKUP_BYTES);
          if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64))
            return invalid();
          fileBytes +=
            (dataBase64.length / 4) * 3 -
            (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0);
          if (fileBytes > MAX_THREAD_PICKUP_FILE_BYTES) return invalid();
          return { name, mediaType, dataBase64 };
        });
  const continuation = validateThreadContinuation(v.continuation, files?.length ?? 0);
  let snapshot: ThreadPickupPackage['snapshot'];
  if (v.snapshot !== undefined) {
    const snap = object(v.snapshot, ['html', 'css']);
    const html = string(snap.html, MAX_THREAD_PICKUP_TEXT_BYTES),
      css = string(snap.css, MAX_THREAD_PICKUP_TEXT_BYTES);
    if (
      encoder.encode(html).byteLength + encoder.encode(css).byteLength >
      MAX_THREAD_PICKUP_TEXT_BYTES
    )
      return invalid();
    snapshot = { html, css };
  }
  const result: ThreadPickupPackage = {
    format: 'anvil-thread/v1',
    title,
    sharedAt,
    source: { shareId, version: source.version as number, ...(viewerUrl ? { viewerUrl } : {}) },
    continuation,
    ...(files ? { files } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_THREAD_PICKUP_BYTES) return invalid();
  return result;
}
export function parseThreadPickupPackage(text: string): ThreadPickupPackage {
  string(text, MAX_THREAD_PICKUP_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid();
  }
  return validateThreadPickupPackage(value);
}
