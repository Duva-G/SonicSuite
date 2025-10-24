export type CsvPrimitive = string | number | boolean | null | undefined;

export type CsvRow = Record<string, CsvPrimitive>;

export function escapeCsvValue(value: CsvPrimitive): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const raw = String(value);
  const needsQuote = /[",\n\r]/.test(raw) || raw.trim() !== raw;
  if (!needsQuote) return raw;
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function serializeCsv(columns: readonly string[], rows: readonly CsvRow[]): string {
  const header = columns.map((column) => escapeCsvValue(column)).join(",");
  const body = rows
    .map((row) => columns.map((column) => escapeCsvValue(row[column])).join(","))
    .join("\r\n");
  return body.length > 0 ? `${header}\r\n${body}` : `${header}\r\n`;
}

export function buildCsvBlob(columns: readonly string[], rows: readonly CsvRow[]): Blob {
  const text = serializeCsv(columns, rows);
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
