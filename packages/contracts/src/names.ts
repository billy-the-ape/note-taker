/**
 * The note-name rules (docs/plans/mvp/MVP-05.md §8).
 *
 * The README's `new-file-<msepoch>.md` rule lives **here and nowhere else**: PR-09 generates it when
 * a note is created without a name, PR-15 prefills the "new note" dialog with it, and PR-12 renders
 * it. Duplicating the format anywhere is how it silently drifts.
 *
 * Storage rule (§8 of the plan): `notes.name` is **extension-free**. `stripMd()` is applied once on
 * the way in and `withMd()` adds the extension back for display only — which is only safe because
 * `isValidNoteName()` rejects a stripped name that still ends in `.md` (see `nested-extension`
 * below), i.e. one strip provably suffices.
 */

/** `notes.name` / `folders.name` are capped at this many characters (the DB column has no CHECK for it). */
export const NOTE_NAME_MAX = 120;

/** Folder names follow the same character and length rules as note names (no extension handling). */
export const FOLDER_NAME_MAX = 120;

/** The extension the app displays and never stores. */
export const MD_EXT = '.md';

/**
 * `NOTE_NAME_RE` of plan §7: the reserved characters — path separators, the Windows-forbidden set, and
 * the control characters. Names are rendered as breadcrumbs and are later reused by the FS-style export
 * of backlog PR-24, so the rules are written for the worst-case consumer, not the current one.
 *
 * It matches a character that is **not** allowed, so `NOTE_NAME_RE.test(name) === true` means the name
 * is refused — which is why the API to call is `isValidNoteName`/`isValidFolderName` rather than this.
 * No `g` flag, so `test` carries no `lastIndex` state between calls.
 *
 * `\p{Cc}` rather than a `\u0000-\u001f` range: control characters are invisible in a character class,
 * and the named category also covers DEL and the C1 set, which are just as unwanted.
 */
export const NOTE_NAME_RE = /[\\/:*?"<>|\p{Cc}]/u;

/** `.` and `..` are not names, in either tree. */
const RESERVED_NAMES = ['.', '..'];

/** Why a name was refused, so a schema can report the rule that actually failed. */
export type NameRejection =
  | 'empty'
  | 'too-long'
  | 'reserved-characters'
  | 'whitespace-padded'
  | 'reserved-name'
  | 'nested-extension';

/** Human-readable rule text, keyed by `NameRejection`; reused verbatim in the Zod issues. */
export const NAME_REJECTION_MESSAGES: Readonly<Record<NameRejection, string>> = {
  empty: 'must not be empty',
  'too-long': `must be at most ${NOTE_NAME_MAX} characters`,
  'reserved-characters': 'must not contain \\ / : * ? " < > | or control characters',
  'whitespace-padded': 'must not start or end with whitespace',
  'reserved-name': 'is reserved',
  'nested-extension': `must not carry the ${MD_EXT} extension — names are stored without it`,
};

/** The README's default: `new-file-<msepoch>.md`, with the extension for display and prefill. */
export const newFileName = (msEpoch: number = Date.now()): string => `new-file-${msEpoch}${MD_EXT}`;
/** `true` when the value ends in `.md`, case-insensitively. */
export const endsInMd = (value: string): boolean => value.toLowerCase().endsWith(MD_EXT);

/**
 * `"Draft.md"` → `"Draft"`; `"plan"` → `"plan"`; `"foo.md.MD"` → `"foo.md"`.
 *
 * Exactly **one** suffix is removed. That is only safe because every name rule runs on the stripped
 * value and a stripped name that still ends in `.md` is invalid — otherwise `foo.md.md` would store
 * as `foo.md`, render identically to a stored note called `foo`, and lose characters the next time a
 * rename prefill stripped again.
 */
export const stripMd = (name: string): string => (endsInMd(name) ? name.slice(0, -MD_EXT.length) : name);

/** Display only: `plan` → `plan.md`, and idempotent over stored names. */
export const withMd = (name: string): string => `${stripMd(name)}${MD_EXT}`;

/**
 * Every rule but the extension one, evaluated on the **stripped** value (note names) or the raw
 * value (folder names). Returns the first rule that failed, or `undefined` when the name is usable.
 */
function rejectName(base: string, max: number): NameRejection | undefined {
  if (base.length === 0) return 'empty';
  if (base.length > max) return 'too-long';
  if (NOTE_NAME_RE.test(base)) return 'reserved-characters';
  // `"foo .md"` strips to `"foo "`: padding is a mistake the UI cannot see, so it is refused rather
  // than silently trimmed (a silent trim would also make `"foo "` and `"foo"` collide as siblings).
  if (base !== base.trim()) return 'whitespace-padded';
  if (RESERVED_NAMES.includes(base)) return 'reserved-name';
  return undefined;
}

/**
 * Why `raw` cannot be a note name — checked on `stripMd(raw)`, so `"..md"` (→ `"."`) and `"foo .md"`
 * (→ `"foo "`) fail on the rules they actually break, and `"foo.md.md"` / `"foo.md.MD"` fail as
 * `nested-extension` rather than storing `foo.md` in a column that promises extension-free names.
 */
export const noteNameRejection = (raw: string): NameRejection | undefined => {
  const base = stripMd(raw);
  return rejectName(base, NOTE_NAME_MAX) ?? (endsInMd(base) ? 'nested-extension' : undefined);
};

/** `true` when `raw` may be stored as a note name (after one `stripMd`). */
export const isValidNoteName = (raw: string): boolean => noteNameRejection(raw) === undefined;

/** Folder names: the same character and length rules, **no extension handling** (`.md` is a note idea). */
export const folderNameRejection = (raw: string): NameRejection | undefined =>
  rejectName(raw, FOLDER_NAME_MAX);

/** `true` when `raw` may be stored as a folder name. */
export const isValidFolderName = (raw: string): boolean => folderNameRejection(raw) === undefined;

/**
 * A field error in the shape a Zod `superRefine` context expects, so a name rule that fails arrives
 * as `{ path: ['name'], message: <the rule> }` — which is exactly one entry of the error envelope's
 * `details` list, and the reason the schemas do not re-state the rules in their own words.
 */
export type NameIssue = {
  code: 'custom';
  path: string[];
  message: string;
};

/** `undefined` for a usable note name, otherwise the issue for the rule it broke. */
export const noteNameIssue = (raw: string, path: string[] = ['name']): NameIssue | undefined => {
  const rejection = noteNameRejection(raw);
  return rejection === undefined
    ? undefined
    : { code: 'custom', path, message: NAME_REJECTION_MESSAGES[rejection] };
};

/** `undefined` for a usable folder name, otherwise the issue for the rule it broke. */
export const folderNameIssue = (raw: string, path: string[] = ['name']): NameIssue | undefined => {
  const rejection = folderNameRejection(raw);
  return rejection === undefined
    ? undefined
    : { code: 'custom', path, message: NAME_REJECTION_MESSAGES[rejection] };
};

/**
 * A sibling-unique name on the extension-free **base** that is stored: `plan` → `plan-2` → `plan-3`.
 *
 * `taken` holds the names already used by siblings (the same case sensitivity as the DB unique
 * indexes), so `"plan.md-2"` is never produced — `withMd()` adds the extension, `uniquify()` must not.
 * A name that arrives with an extension is stripped first, for the same reason.
 *
 * Length is the caller's job: `isValidNoteName` caps a base at 120 characters and the schemas refuse
 * anything longer, so a candidate that would overflow past the cap cannot reach a repository insert.
 */
export const uniquify = (name: string, taken: ReadonlySet<string>): string => {
  const base = stripMd(name);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};
