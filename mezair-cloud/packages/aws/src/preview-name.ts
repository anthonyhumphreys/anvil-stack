export function normalizePreviewName(value: string | undefined): string {
  const lower = (value ?? "default").trim().toLowerCase();
  let normalized = "";
  let previousWasDash = false;

  for (const char of lower) {
    const isLower = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";

    if (isLower || isDigit) {
      normalized += char;
      previousWasDash = false;
      continue;
    }

    if (!previousWasDash) {
      normalized += "-";
      previousWasDash = true;
    }
  }

  let start = 0;
  let end = normalized.length;

  while (start < end && normalized[start] === "-") {
    start += 1;
  }

  while (end > start && normalized[end - 1] === "-") {
    end -= 1;
  }

  const trimmed = normalized.slice(start, end);
  return trimmed.length > 0 ? trimmed.slice(0, 48) : "default";
}
