import { describe, expect, it } from 'vitest';

import { expectOne, firstOrNone, rawBoolean, rawRows, rawTextArray, rawTimestamp } from './rows.js';

/**
 * The pure half of reading a **raw** statement (PR-09).
 *
 * These are unit tests rather than integration ones on purpose: what broke was not SQL, it was the assumption
 * about what a `timestamptz` costs when it arrives through `db.execute(sql`…`)` with no column metadata — every
 * `GET /api/tree` answered `500` in CI because a mapping asserted `Date` on text. The driver's shape is not
 * something a test should discover in production, and the parser is total: every branch here is a shape it may
 * meet.
 *
 * Which is also why `vitest.config.ts` gates **this file** rather than letting the integration report decide:
 * the integration job drives a real driver, which takes only the happy path of each branch, so the fallbacks
 * below are unreachable there by construction (`vitest.integration.config.ts` says the same from the other
 * side). A file whose whole purpose is surviving shapes the suite cannot produce has to be measured by the
 * suite that can produce them.
 */
describe('the row unwrappers', () => {
  it('takes the one row a scoped returning-statement produced', () => {
    expect(expectOne([{ id: 'a' }], 'insert note')).toEqual({ id: 'a' });
    // Nothing back means the row was deleted under the caller, which is a bug, and saying so beats handing
    // `undefined` back as data.
    expect(() => expectOne([], 'delete note')).toThrow(
      /expected exactly one row back from delete note, got 0/,
    );
  });

  it('reads the optional row as a value or as nothing', () => {
    expect(firstOrNone([{ id: 'a' }, { id: 'b' }])).toEqual({ id: 'a' });
    expect(firstOrNone([])).toBeUndefined();
  });

  it('accepts both shapes a raw statement comes back in', () => {
    // drizzle's own two spellings, which is why the tolerance exists once instead of in every repository.
    expect(rawRows<{ id: string }>([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(rawRows<{ id: string }>({ rows: [{ id: 'a' }], count: 1 })).toEqual([{ id: 'a' }]);
    // Anything else is no rows, which is what a `select` that found nothing has to mean.
    expect(rawRows(undefined)).toStrictEqual([]);
    expect(rawRows(null)).toStrictEqual([]);
    expect(rawRows({ rowCount: 0 })).toStrictEqual([]);
  });
});

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

describe('rawBoolean', () => {
  it('reads the parsed value a type-aware driver gives back', () => {
    expect(rawBoolean(true)).toBe(true);
    expect(rawBoolean(false)).toBe(false);
  });

  it('reads the text and numeric spellings a driver that parses nothing leaves behind', () => {
    // `select (name ilike …) as name_matched` is `bool`; a driver without the type lookup writes Postgres's own
    // text form, and a `case … then 1 else 0 end` variant arrives numeric. All of them mean the same tier.
    expect([
      rawBoolean('t'),
      rawBoolean('true'),
      rawBoolean('1'),
      rawBoolean(1),
      rawBoolean(1n),
    ]).toStrictEqual([true, true, true, true, true]);
    expect([
      rawBoolean('f'),
      rawBoolean('false'),
      rawBoolean('0'),
      rawBoolean(0),
      rawBoolean(0n),
    ]).toStrictEqual([false, false, false, false, false]);
  });

  it('refuses to invent a tier, because a false flag is the failure that keeps answering', () => {
    // The reason this is not `Boolean(value)`: `Boolean('false')` and `Boolean(0)` are opposite answers to the
    // same wire value, and a search that silently stopped ranking by name would still return 200.
    for (const value of [null, undefined, 'yes', 'no', 2, '', {}, []]) {
      expect(() => rawBoolean(value)).toThrow(/expected a boolean from a raw statement/);
    }
  });
});
