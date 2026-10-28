/** Public route parameters are the only data allowed in an OAuth return path. */
export function sharePath(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `/artifacts/${id}` : null;
}

export const SHARE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function shareFailureMessage(status: number, code?: string): string {
  if (status === 401) return "Sign in to view this organisation share. You need the full link and current membership of the organisation that shared it.";
  if (status === 403) return "Access denied. Your signed-in account is not a current member of the organisation that shared this item. Ask the sender to check your membership.";
  if (code === "share-revoked") return "This share was revoked. Ask the sender for a new link.";
  if (code === "share-expired") return "This share has expired. Ask the sender for a new link.";
  if (status === 404 || status === 410) return "This link is unavailable. It may have been revoked, expired, or copied incorrectly. Ask the sender for a new link.";
  return "Couldn't reach the share service. Try again in a few minutes.";
}

export async function shareFailureCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("error" in body)) return;
    const error = body.error;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
      if ([404, 410].includes(response.status) && "details" in error && error.details && typeof error.details === "object" && "reason" in error.details && ["share-revoked", "share-expired"].includes(String(error.details.reason))) return String(error.details.reason);
      return error.code;
    }
  } catch { /* An upstream without a JSON error still gets a safe generic state. */ }
}

export function shareTitle(header: string | null, fallback = "Shared item"): string {
  if (header === null) return fallback;
  try { return decodeURIComponent(header).slice(0, 1000); } catch { return fallback; }
}
