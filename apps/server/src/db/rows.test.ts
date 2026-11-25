import { describe, expect, it } from 'vitest';

import { rawTextArray, rawTimestamp } from './rows.js';

/**
 * The pure half of reading a **raw** statement (PR-09).
 *
 * These are unit tests rather than integration ones on purpose: what broke was not SQL, it was the assumption
 * about what a `timestamptz` costs when it arrives through `db.execute(sql`…`)` with no column metadata — every
 * `GET /api/tree` answered `500` in CI because a mapping asserted `Date` on text. The driver's shape is not
 * something a test should discover in production, and the parser is total: every branch here is a shape it may
 * meet.
 */
describe('rawTimestamp', () => {
  it('reads the epoch-milliseconds shape the tree statement asks for', () => {
    const millis = 1_700_000_000_000;
    expect(rawTimestamp(BigInt(millis)).getTime()).toBe(millis);
    expect(rawTimestamp(millis).getTime()).toBe(millis);
    // A driver that hands back `numeric`/`bigint` as text is the same instant.
    expect(rawTimestamp(String(millis)).getTime()).toBe(millis);
    expect(rawTimestamp(`${millis}.000`).getTime()).toBe(millis);
  });

  it('passes a Date through, which is what a typed select produces', () => {
    const now = new Date();
    expect(rawTimestamp(now)).toBe(now);
  });

  it('reads the text Postgres itself writes for a timestamptz column', () => {
    // `select '2026-11-23 03:12:04.123456+00'::timestamptz` is what the raw statement returns un-parsed, and
    // `Date.parse` is not specified to read the space separator or the two-digit offset — this pins that it
    // works after the rewrite rather than leaving it to the V8 that happens to be running.
    const fromPostgres = rawTimestamp('2026-11-23 03:12:04.123456+00');
    expect(fromPostgres.toISOString()).toBe('2026-11-23T03:12:04.123Z');
    expect(rawTimestamp('2026-11-23T03:12:04.123Z').toISOString()).toBe('2026-11-23T03:12:04.123Z');
    expect(rawTimestamp('2026-11-23 03:12:04+00:00').getTime()).toBe(
      new Date('2026-11-23T03:12:04.000Z').getTime(),
    );
  });

  it('refuses to invent a date, naming the type it was handed', () => {
    expect(() => rawTimestamp(null)).toThrow(/unexpected raw timestamp of type object/);
    expect(() => rawTimestamp(undefined)).toThrow(/unexpected raw timestamp/);
    expect(() => rawTimestamp('not a date at all')).toThrow(/unexpected raw timestamp of type string/);
    expect(() => rawTimestamp(new Date(Number.NaN))).toThrow(/Invalid Date/);
  });
});

describe('rawTextArray', () => {
  it('reads a parsed jsonb array, and the JSON text of one', () => {
    expect(rawTextArray(['Top', 'Mid', 'Leaf'])).toStrictEqual(['Top', 'Mid', 'Leaf']);
    expect(rawTextArray('["Top","Mid","Leaf"]')).toStrictEqual(['Top', 'Mid', 'Leaf']);
    expect(rawTextArray([])).toStrictEqual([]);
    expect(rawTextArray('[]')).toStrictEqual([]);
  });

  it('reads the array literal Postgres writes, quotes and escapes included', () => {
    // What an unparsing driver hands back for a `text[]` column, in Postgres's own spelling.
    expect(rawTextArray('{}')).toStrictEqual([]);
    expect(rawTextArray('{Top}')).toStrictEqual(['Top']);
    expect(rawTextArray('{"Top","Mid","Leaf"}')).toStrictEqual(['Top', 'Mid', 'Leaf']);
    // An unquoted element is only legal when it needs no escaping, and a name that does get quoted — so both
    // spellings have to work in the same literal.
    expect(rawTextArray('{Top,"Mid, the third",Leaf}')).toStrictEqual(['Top', 'Mid, the third', 'Leaf']);
    expect(rawTextArray('{"a\\"b","c\\\\d","{braces}"}')).toStrictEqual(['a"b', 'c\\d', '{braces}']);
    expect(rawTextArray('{"  spaced  "}')).toStrictEqual(['  spaced  ']);
  });

  it('is empty rather than a half-parsed breadcrumb', () => {
    // A `NULL` element would mean the SQL that built the breadcrumb is wrong (names are `NOT NULL`), so the
    // honest answer is nothing rather than an empty name in the middle of someone's path.
    expect(rawTextArray('{Top,NULL,Leaf}')).toStrictEqual([]);
    expect(rawTextArray('{"unterminated')).toStrictEqual([]);
    expect(rawTextArray('Top,Mid')).toStrictEqual([]);
    expect(rawTextArray(null)).toStrictEqual([]);
    expect(rawTextArray(undefined)).toStrictEqual([]);
    expect(rawTextArray(42)).toStrictEqual([]);
  });
});
