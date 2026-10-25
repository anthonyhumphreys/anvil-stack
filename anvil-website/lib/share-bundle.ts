import { validateThreadContinuation, type ThreadContinuation } from "../../anvil-app/cloud/contract/thread-pickup";

export const MAX_BUNDLE_CHARS = 12 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface ShareBundleFile { name: string; mediaType: string; dataBase64: string }
export interface AnvilShareBundle {
  format: "anvil-share/v1";
  title: string;
  kind: string;
  version: number;
  sharedAt: string;
  digest: string;
  snapshot: { html: string; css: string; images?: Record<string, string>; height?: number };
  interactive?: { html: string; kitVersion?: string };
  files?: ShareBundleFile[];
  continuation?: ThreadContinuation;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const string = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** Validate untrusted decrypted input before JSX or the sandbox sees any field. */
export function parseShareBundle(text: string): AnvilShareBundle | null {
  if (text.length > MAX_BUNDLE_CHARS) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!record(v) || v.format !== "anvil-share/v1" || !string(v.title, 1000) || !string(v.kind, 128) ||
      !Number.isSafeInteger(v.version) || (v.version as number) < 1 ||
      !string(v.sharedAt, 64) || !Number.isFinite(Date.parse(v.sharedAt)) || !string(v.digest, 16000) ||
      !record(v.snapshot) || !string(v.snapshot.html, MAX_DOCUMENT_CHARS) || !string(v.snapshot.css, MAX_DOCUMENT_CHARS)) return null;
    const snap = v.snapshot;
    if (snap.height !== undefined && (typeof snap.height !== "number" || !Number.isFinite(snap.height) || snap.height <= 0)) return null;
    if (snap.images !== undefined && (!record(snap.images) || Object.keys(snap.images).length > 128 ||
      !Object.entries(snap.images).every(([key, data]) => /^[A-Za-z0-9_.-]{1,128}$/.test(key) &&
        string(data, MAX_BUNDLE_CHARS) && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/i.test(data)))) return null;
    if (v.interactive !== undefined && (!record(v.interactive) || !string(v.interactive.html, MAX_DOCUMENT_CHARS) ||
      (v.interactive.kitVersion !== undefined && !string(v.interactive.kitVersion, 128)))) return null;
    // Thread snapshots are always read-only: never accept their interactive payload.
    if ((v.kind === "thread" || v.kind.startsWith("thread:")) && v.interactive !== undefined) return null;
    if (v.files !== undefined) {
      if (!Array.isArray(v.files) || v.files.length > 16) return null;
      let total = 0;
      for (const file of v.files) {
        if (!record(file) || !string(file.name, 255) || file.name.length === 0 || !string(file.mediaType, 128) ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mediaType) ||
          !string(file.dataBase64, MAX_BUNDLE_CHARS) || file.dataBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) return null;
        total += (file.dataBase64.length / 4) * 3 - (file.dataBase64.endsWith("==") ? 2 : file.dataBase64.endsWith("=") ? 1 : 0);
        if (total > MAX_FILE_BYTES) return null;
      }
    }
    if (v.continuation !== undefined) {
      if (v.kind !== "thread") return null;
      v.continuation = validateThreadContinuation(v.continuation, Array.isArray(v.files) ? v.files.length : 0);
    }
    return v as unknown as AnvilShareBundle;
  } catch { return null; }
}

export function shareDownloadName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").slice(0, 255) || "attachment";
}
