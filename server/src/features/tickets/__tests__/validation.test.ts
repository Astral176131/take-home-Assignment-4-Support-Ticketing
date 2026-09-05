import { describe, it, expect } from 'vitest';
import { LIMITS, readEmail, readText } from '../validation.js';
import { csvField } from '../csv.js';

describe('readText', () => {
  it('trims and accepts an ordinary value', () => {
    expect(readText('  hello  ', 'subject', 200)).toEqual({ ok: true, value: 'hello' });
  });

  it('refuses a missing, non-string or whitespace-only value', () => {
    for (const bad of [undefined, null, 42, ['a'], {}, '', '   \t\n ']) {
      expect(readText(bad, 'subject', 200).ok).toBe(false);
    }
  });

  it('accepts a value exactly at the limit and refuses one character more', () => {
    expect(readText('a'.repeat(200), 'subject', 200).ok).toBe(true);
    expect(readText('a'.repeat(201), 'subject', 200).ok).toBe(false);
  });

  it('measures the limit after trimming, so surrounding spaces do not count', () => {
    expect(readText(`  ${'a'.repeat(200)}  `, 'subject', 200).ok).toBe(true);
  });

  it('refuses a NUL byte, which Postgres cannot store in a text column', () => {
    // Left unchecked this reaches the database, which rejects it with
    // `22021 invalid byte sequence for encoding "UTF8"` — surfacing a bad request as a
    // 500 with a stack trace instead of a 400 saying what was wrong.
    const result = readText('before\u0000after', 'subject', 200);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('null bytes');
  });

  it('leaves unicode, emoji and combining characters alone', () => {
    const value = '🔥 Ünïcödé — 日本語 — العربية';
    expect(readText(value, 'subject', 200)).toEqual({ ok: true, value });
  });
});

describe('readEmail', () => {
  it('accepts an ordinary address and lowercases it', () => {
    expect(readEmail('  Jane.Doe@Corp.COM ', 'requester email')).toEqual({
      ok: true,
      value: 'jane.doe@corp.com',
    });
  });

  it('refuses the values a bare includes("@") check let through', () => {
    // "@" was accepted before. Since requesters.email is unique and lowercased, every such
    // entry collapses a different customer onto the same record — the split-history
    // failure the unique index exists to prevent, arriving from the other direction.
    for (const bad of ['@', 'no-at-sign', 'a@b', '@corp.com', 'jane@', 'ja ne@corp.com', '']) {
      expect(readEmail(bad, 'requester email').ok).toBe(false);
    }
  });

  it('refuses an address longer than the limit', () => {
    const long = `${'a'.repeat(LIMITS.requesterEmail)}@corp.com`;
    expect(readEmail(long, 'requester email').ok).toBe(false);
  });
});

describe('csvField', () => {
  it('quotes and doubles embedded quotes, per RFC 4180', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it('renders null and undefined as empty, but keeps zero', () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
    expect(csvField(0)).toBe('"0"');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // Quoting alone does not help: the spreadsheet strips the quotes while parsing and
    // then looks at the first character. A ticket subject is whatever a customer emailed,
    // so this is attacker-influenced text landing in a file someone opens in Excel.
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('+1')).toBe(`"'+1"`);
    expect(csvField('-1+1')).toBe(`"'-1+1"`);
    expect(csvField('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvField('=HYPERLINK("http://evil","click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""click"")"`
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(csvField('Printer will not print')).toBe('"Printer will not print"');
    expect(csvField('2026-09-04T12:00:00.000Z')).toBe('"2026-09-04T12:00:00.000Z"');
  });
});
