/**
 * Quote a single CSV field per RFC 4180: wrap in double quotes and double any embedded
 * quote. Applied to every field unconditionally rather than only when a comma or newline
 * is detected — simpler, and correct either way.
 */
export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvField).join(',') + '\r\n';
}
