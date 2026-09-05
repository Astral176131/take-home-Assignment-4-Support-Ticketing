/**
 * Characters that make Excel, Google Sheets and LibreOffice treat a cell as a formula
 * rather than text. Quoting per RFC 4180 does not stop this: the spreadsheet strips the
 * quotes while parsing, then looks at what the cell starts with.
 *
 * That matters here because the fields being exported are not the desk's own words. A
 * ticket subject is whatever a customer put in an email, and a requester name is whatever
 * they typed — so "=..." in a subject becomes a formula in the file a supervisor opens.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Quote a single CSV field per RFC 4180: wrap in double quotes and double any embedded
 * quote. Applied to every field unconditionally rather than only when a comma or newline
 * is detected — simpler, and correct either way.
 *
 * A field that would otherwise be read as a formula gets a leading apostrophe, the
 * conventional "treat this as text" marker, which spreadsheets consume on import rather
 * than displaying. The value is altered on the way out, which is the trade: a subject
 * genuinely starting with a minus sign shows an apostrophe in the export, and in exchange
 * opening the file cannot execute anything.
 */
export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvField).join(',') + '\r\n';
}
