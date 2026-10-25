/** A fragment is a browser-only secret. Persist only a validated key, for this tab. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_MS = 10 * 60 * 1000;
const storageKey = (id: string) => `anvil:share-sign-in:${id}`;

export function fragmentKey(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const keys = params.getAll("k");
  return keys.length === 1 && KEY_PATTERN.test(keys[0]) ? keys[0] : null;
}

export function preserveShareFragment(id: string, browser: Pick<Window, "location" | "sessionStorage" | "history">, now = Date.now()): void {
  // Never navigate if a supplied fragment cannot be retained safely.
  if (!browser.location.hash) {
    browser.sessionStorage.removeItem(storageKey(id));
    return;
  }
  const key = fragmentKey(browser.location.hash);
  if (key === null) throw new Error("The decryption key in this link is damaged. Ask the sender for the full link again.");
  browser.sessionStorage.setItem(storageKey(id), JSON.stringify({ key, expiresAt: now + MAX_AGE_MS }));
  browser.history.replaceState(null, "", `/artifacts/${id}`);
}

export function restoreShareFragment(id: string, browser: Pick<Window, "location" | "sessionStorage" | "history">, now = Date.now()): void {
  try {
    const saved = browser.sessionStorage.getItem(storageKey(id));
    browser.sessionStorage.removeItem(storageKey(id));
    if (!saved || browser.location.hash) return;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object" || !("key" in value) || !("expiresAt" in value)) return;
    if (typeof value.key !== "string" || !KEY_PATTERN.test(value.key) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + MAX_AGE_MS) return;
    browser.history.replaceState(null, "", `/artifacts/${id}#k=${value.key}`);
  } catch { /* Storage can be disabled. Missing keys are reported by the decryptor. */ }
}

/** Drop share analytics altogether and strip fragments from all other events. */
export function analyticsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/artifacts" || parsed.pathname.startsWith("/artifacts/")) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch { return null; }
}
