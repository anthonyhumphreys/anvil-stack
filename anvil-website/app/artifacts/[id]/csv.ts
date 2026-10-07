/** Minimal RFC4180-ish CSV parser for preview tables. */
export function parseCsv(text: string, maxRows = 60): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (rows.length < maxRows && (row.length > 1 || row[0] !== "")) rows.push(row);
  }
  return rows;
}

export function mediaTypeLabel(mediaType: string): string {
  if (mediaType === "text/markdown") return "Markdown";
  if (mediaType === "text/html") return "HTML";
  if (mediaType === "text/csv") return "CSV";
  if (mediaType === "application/json") return "JSON";
  if (mediaType === "text/vnd.mermaid") return "Mermaid";
  if (mediaType === "text/plain") return "Text";
  if (mediaType === "application/pdf") return "PDF";
  if (mediaType.includes("wordprocessingml")) return "Word";
  if (mediaType.includes("presentationml")) return "PowerPoint";
  if (mediaType.includes("spreadsheetml")) return "Excel";
  return mediaType;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
