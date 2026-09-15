export function redactRehearsalEvidence(value) {
  if (typeof value === "string")
    return value
      .replace(/anvil_(?:at|rt)_[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/anvil-ec-[A-Za-z0-9-]+/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactRehearsalEvidence);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:accessToken|refreshToken|authorization|code|adminToken|enrollmentCode)$/i.test(key)
          ? "[REDACTED]"
          : redactRehearsalEvidence(item),
      ]),
    );
  return value;
}
