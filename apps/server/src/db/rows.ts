/**
 * Unwraps the results Drizzle hands back, without a single non-null assertion (Biome's
 * `noNonNullAssertion` is on for `src`, off only for tests).
 *
 * `noUncheckedIndexedAccess` makes every array index `T | undefined`, which is correct in general and noisy
 * for the two shapes a repository actually writes: a single-row `insert … returning` and a
 * `select … limit 1`. Those two get a named helper here instead of an inline `!` at 40 call sites.
 */

/**
 * The single-row case: `insert … returning` / `update … returning` on a statement the caller has already
 * scoped to one row.
 *
 * @throws {Error} if the statement returned nothing, which means the row was deleted concurrently — a bug or
 *   a race in the caller, never a value to hand back as data.
 */
export function expectOne<T>(rows: readonly T[], what: string): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error(`expected exactly one row back from ${what}, got ${String(rows.length)}`);
  }
  return first;
}

/** The optional-row case: `select … limit 1` finds nothing, and `undefined` is the answer (404 at the edge). */
export function firstOrNone<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

/**
 * The rows out of a raw `db.execute(sql`…`)`.
 *
 * drizzle hands back whatever the driver produced, and depending on the version that is the array of rows
 * itself or an object carrying them under `rows` — the same two shapes `src/test/helpers/db.ts`'s `catalogRows`
 * has to accept for the schema tests. PR-09's recursive walks (`folders.repo.ts`'s depth, height and tree
 * statements) are the first **application** code to read a raw statement, so the tolerance lives here once
 * rather than in every repository that grows one.
 *
 * Type parameters are unchecked here by necessity: a raw statement's result is only typed by the caller's
 * assertion, which is the trade for writing SQL drizzle cannot express. Never widen this into a parser.
 */
export function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { readonly rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * A `timestamptz` out of a raw statement, as a `Date`.
 *
 * A raw `db.execute(sql`…`)` carries no column metadata, so nothing between Postgres and the caller knows the
 * value was ever a timestamp: PR-09's first CI run proved it by answering every `GET /api/tree` with a `500`,
 * because `listFolderTree` wrote `row.created_at as Date` and `toFolderNode` then called `.toISOString()` on
 * what was actually text. Asserting a type the driver never promised is not a mapping.
 *
 * The tree statement therefore asks for **epoch milliseconds as a bigint** — the one shape with an unambiguous
 * JS reading — and this accepts that shape plus the two it might arrive in anyway (a real `Date`, from a typed
 * select or a parsing driver, and ISO or Postgres text, from one that does not) and refuses to invent a date
 * for anything else. A thrown error here is a `500` with a message that names the value's type, which is a
 * better failure than `1970-01-01`.
 *
 * Millisecond precision is what the wire needs (`isoDateTimeSchema` is second-granular anyway); the database
 * keeps the microsecond original for anything that reads the column itself.
 */
export function rawTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('raw timestamp is an Invalid Date');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return new Date(Number(value));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    // Epoch milliseconds written as text (a `numeric`/`bigint` the driver chose not to parse).
    if (/^-?\d+(\.\d+)?$/.test(text)) return new Date(Number(text));
    // `2026-11-23 03:12:04.123456+00` — Postgres's own text form — and plain ISO. `Date.parse` is not
    // guaranteed to read the first, so it is rewritten toward the second before it is tried.
    const iso = text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  throw new Error(`unexpected raw timestamp of type ${typeof value}`);
}

/**
 * A `text[]` out of a raw statement, as strings.
 *
 * Same hazard as {@link rawTimestamp}: PR-09's tree CTE builds a breadcrumb column, and whether the driver hands
 * back a JS array or the literal text Postgres wrote (`{"Top","Mid"}`) is its own business. Both are read here —
 * plus the JSON spelling, since a JSON-typed column would arrive that way — and anything this cannot honestly
 * parse becomes `[]`, which is a visible nothing in an assertion rather than a half-parsed breadcrumb a client
 * would happily render.
 *
 * The literal form needs a real scanner rather than `split(',')` because folder names are arbitrary text: a name
 * with a comma, a brace or a quote in it is legal (§1's name rules), and Postgres quotes and escapes those
 * elements (`{"a\"b",c}` for a name with a quote). An unquoted `NULL` element fails the parse rather than
 * inventing an empty name; `path` is built from `NOT NULL` names, so meeting one would mean the SQL is wrong.
 */
export function rawTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return [];
    if (text.startsWith('{')) {
      const literal = parsePostgresArrayLiteral(text);
      if (literal !== undefined) return literal;
    } else if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
      } catch {
        // Fall through to the empty answer below.
      }
    }
  }
  return [];
}

/**
 * The scanner behind {@link rawTextArray}: `{a,b}`, `{"a,b","c\"d"}`, `{}`, and the escapes in between.
 *
 * Returns `undefined` for anything it is not sure about, so the caller decides what "not an array literal" costs.
 * Escapes follow Postgres's own spelling (`\\`, `\"`, and `\n`/`\t` written by `array_to_string`-style output);
 * a name that legitimately contains a backslash is written with two, so reading `\\` as one is the pair that
 * round-trips.
 */
function parsePostgresArrayLiteral(text: string): string[] | undefined {
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined;
  const body = text.slice(1, -1);
  if (body === '') return [];

  const out: string[] = [];
  let index = 0;
  const at = (i: number): string => body[i] ?? '';

  while (index < body.length) {
    if (at(index) === '"') {
      let element = '';
      let closed = false;
      index += 1;
      while (index < body.length) {
        const char = at(index);
        if (char === '\\' && index + 1 < body.length) {
          const next = at(index + 1);
          element += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          index += 2;
          continue;
        }
        index += 1;
        if (char === '"') {
          closed = true;
          break;
        }
        element += char;
      }
      if (!closed) return undefined;
      out.push(element);
      // An element is followed by a separator or by the closing brace, which is already trimmed off.
      if (index >= body.length) return out;
      if (at(index) !== ',') return undefined;
      index += 1;
      if (index >= body.length) return undefined; // `,}` is not something Postgres writes.
      continue;
    }

    // Unquoted: only legal for elements that need no escaping, so the next comma ends it.
    const comma = body.indexOf(',', index);
    const token = (comma === -1 ? body.slice(index) : body.slice(index, comma)).trim();
    if (token === 'NULL') return undefined;
    out.push(token);
    if (comma === -1) return out;
    index = comma + 1;
    if (index >= body.length) return undefined;
  }
  return out;
}

/**
 * A boolean out of a raw statement: the parsed value, plus the text spellings a driver that does not parse
 * column types would hand over instead.
 *
 * Same reasoning as {@link rawTimestamp}: a raw `db.execute(sql`…`)` carries no column metadata, so a computed
 * predicate — `lower(name) ilike …` from the search statement — arrives parsed only because this particular
 * driver looks the column type up. Reading `row.some_flag` as a `boolean` regardless would turn a driver change
 * into a **false** flag, which is the worst failure a boolean has: the search keeps answering and quietly stops
 * ranking by tier. Anything unrecognized throws and names what arrived.
 */
export function rawBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true' || value === '1' || value === 1 || value === 1n) return true;
  if (value === 'f' || value === 'false' || value === '0' || value === 0 || value === 0n) return false;
  throw new Error(`expected a boolean from a raw statement, got ${typeof value}: ${String(value)}`);
}
