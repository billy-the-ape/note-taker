/**
 * `GET /api/search?q=&limit=` — names from SQL, bodies after decryption (docs/plans/mvp/MVP-11.md §4,
 * plan §9.2 #21).
 *
 * Two passes, deliberately, because the bodies are encrypted (ADR-0002) and Postgres cannot see inside them:
 *
 * * **The metadata pass** (`notes.repo.ts`'s `searchNotesByMetadata`) asks SQL for the notes whose name, or whose
 *   folder's name, matches the query. It covers the **whole corpus** and needs no key, and it is
 *   **accent-sensitive**: `unaccent` is not installed and NFD folding is not a `LIKE` pattern, so `cafe` does not
 *   find a note named `café` out here.
 * * **The candidate pass** takes up to {@link SEARCH_CANDIDATE_SCAN} of the caller's most recently updated notes,
 *   decrypts each one, and matches name, folder path and body. This is where a body can be searched at all, and
 *   where accent folding happens — which makes the *net* behavior asymmetric rather than uniformly fuzzy: `cafe`
 *   finds an in-window `café` and misses an out-of-window one. `docs/API.md` #21 says exactly that, and
 *   `search.service.int.test.ts` pins the miss so nobody later "fixes" the SQL branch by quietly adding
 *   `unaccent` (that is backlog PR-29, with the folded column or index it needs).
 *
 * The union of the two is scored, ordered and cut to `limit`:
 *
 * * **`name hit > body hit > recency`** (§4). A name hit is {@link SEARCH_SCORE_NAME}; a hit on the body or on a
 *   folder name is {@link SEARCH_SCORE_CONTENT}; and equal scores fall to `content_updated_at DESC`, then `id`,
 *   which is the order the candidate statement already arrives in.
 * * A **corpus-wide search and a per-request bound** are different promises, and this file makes both — in the
 *   right order. The metadata pass tests every note the caller owns and returns at most
 *   {@link SEARCH_CANDIDATE_SCAN} *matching rows*, tier-first (`name_matched DESC`, then newest first), so the cut
 *   can only ever fall on rows the endpoint would have ranked below the ones it kept: with
 *   {@link SEARCH_RESULT_MAX} slots and that ordering, the response is the same 25 rows whatever the row bound
 *   allowed. Remove the tier from that `order by` and 500 folder matches push an older name match out before
 *   scoring ever sees it, which is why the clause is load-bearing and tested (`search.service.int.test.ts`). The
 *   decryption pass, by contrast, always stops at 500 *notes*, and `limit` cannot raise it — the contract caps the
 *   response at {@link SEARCH_RESULT_MAX} whatever the caller asked for.
 * * **A note this process cannot read is skipped, not invented.** `openNoteContent()` throws rather than return
 *   blank-or-garbage text (PR-06's rule), so a corrupt row would otherwise fail a whole search over one
 *   unreadable note. It is dropped from both passes and its id is logged. An *out-of-window* corrupt body cannot
 *   be detected here at all — the metadata pass never decrypts — so such a note may still be found by name, which
 *   is the honest reading of "search does not need a key to answer about names".
 *
 * Snippets come from **plaintext**, never ciphertext, and are cut on a **code-point boundary** (§4): the match is
 * what a person typed, so it has to be inside the window, and a window that ends in half a surrogate pair is a
 * `U+FFFD` in the search results.
 *
 * What is deliberately absent:
 *
 * * **No pagination beyond `limit`.** Plan §9.2 #21 has no `offset`, and an offset over a score is a second
 *   ordering question, not a second page of one (§7).
 * * **No query cache, no rank tuning, no stopwords.** "Deliberately cheap and in-process" is the whole design
 *   argument of the brief; the first version that needs to be cleverer is PR-29's `pg_trgm`/`tsvector` conversation.
 */
import { SEARCH_RESULT_MAX, type SearchResponse } from '@note-taker/contracts';

import { EnvelopeError, openNoteContent } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keys.js';
import type { Db } from '../db/client.js';
import {
  likeContainsPattern,
  listRecentNotesForSearch,
  searchNotesByMetadata,
} from '../db/repositories/notes.repo.js';

/**
 * How many notes the in-process pass decrypts and matches: the most recently updated {@link SEARCH_CANDIDATE_SCAN}
 * of the caller's notes, and no more, whatever the request asked for.
 *
 * It is the scan bound, not a page size. Raising it is a linear price on every search; removing it is what
 * ADR-0002 can only afford at a few thousand notes, which is the corpus size §7 of the brief puts
 * `pg_trgm`/`tsvector` at.
 */
export const SEARCH_CANDIDATE_SCAN = 500;

/** A hit on the note's own name — the top tier of `name hit > body hit > recency` (§4). */
export const SEARCH_SCORE_NAME = 2;

/** A hit on the note's body, or on one of its folder names: the lower tier, ordered within itself by recency. */
export const SEARCH_SCORE_CONTENT = 1;

/**
 * The snippet's budget, in **code points** (§4's "~120-char").
 *
 * Code points rather than UTF-16 units because the two differ exactly where a snippet would otherwise break: an
 * emoji is one character to the person reading the result and two units to `String.prototype.slice`.
 */
export const SNIPPET_MAX_CODEPOINTS = 120;

/**
 * How much context a snippet puts before its match, in code points: half the budget, which is what keeps the
 * match away from the left edge a person reads first.
 */
const SNIPPET_LEAD_CODEPOINTS = Math.floor(SNIPPET_MAX_CODEPOINTS / 2);

/** The log line of a search that skipped something. The ids are the whole payload: an operator reads them, a user does not. */
export const SEARCH_SKIP_LOG_MESSAGE = 'search skipped notes whose body did not authenticate';

/**
 * The combining marks NFD produces and a search key drops: U+0300…U+036F, the block the brief names as
 * "combining marks" (accents, cedillas, ogoneks, and their diacritic siblings).
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** The only ASCII folding `String.prototype.normalize` cannot do for you: `A` is not `a`. */
const HAS_ASCII_UPPER = /[A-Z]/;

/** Anything above `U+007F`: it may decompose, may carry combining marks, and may case-fold. */
const HAS_NON_ASCII = /[^\0-\u007f]/;

/**
 * `true` when folding could change `text`, which for NFD-plus-strip-plus-lowercase means: an ASCII uppercase
 * letter (normalization never touches ASCII), or a non-ASCII character (which may decompose, may carry marks, and
 * may case-fold).
 *
 * It is a fast path, not a semantic rule: answering `false` means `foldKey(text) === text`, and answering `true`
 * only costs a normalization pass.
 */
function needsFolding(text: string): boolean {
  return HAS_ASCII_UPPER.test(text) || HAS_NON_ASCII.test(text);
}

/**
 * The search key of one string: NFD-normalize, strip combining marks, lowercase.
 *
 * `café` and `cafe` fold to the same key, and `Å` folds to `a` rather than to the two-code-point `A`+ring that
 * its decomposition starts as. Applied to **both** the query and the candidate text, and only inside the
 * in-process pass: the SQL branch cannot express it (see the module header).
 */
export function foldKey(text: string): string {
  if (!needsFolding(text)) return text;
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * One code point's own fold: the same three steps {@link foldKey} takes, applied to a single character.
 *
 * Whole-string and per-character NFD agree here because every mark is discarded: canonical reordering can only
 * shuffle marks within a combining run, and marks are not in the answer, so the surviving characters stay in
 * their original order whichever way the marks were sorted. {@link foldWithOffsets} carries the one caveat where
 * the two really can differ, and why it costs a snippet's placement and nothing else.
 */
function foldCodePoint(point: string): string {
  return point.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * The folded text plus the map back to the source: for each **UTF-16 index** of `folded`, the index in `text` of
 * the character it came from.
 *
 * `offsets` is `undefined` when the fold was the identity — which is the common case (lowercase ASCII needs no
 * fold at all) and the case where the map would be `0,1,2,3…` anyway.
 *
 * It exists for one purpose: {@link foldKey} can answer *whether* a body matches, but a snippet has to answer
 * *where*, and an index into folded text is not an index into the plaintext the snippet is cut from. Folding
 * changes length (marks disappear) and changes case, so the two indexes drift apart exactly where a snippet would
 * otherwise start in the wrong sentence.
 *
 * **Why it folds one code point at a time, and what that costs.** Building the map means knowing which source
 * character produced which folded character, so normalization is per character here and whole-string in
 * {@link foldKey}, where one native pass over a corpus is worth the single call. NFD is context-free, so the two
 * agree on decomposition and on stripping in either order. What is *not* context-free is one rule of
 * `String.prototype.toLowerCase`: Unicode maps a word-final `Σ` to `ς` and `Σ` elsewhere to `σ`. That is the only
 * input on which the two folds can differ — Greek text queried through a word-final sigma — and the cost is
 * bounded by the design rather than by luck: the offset map is always consistent with the string it indexes, so
 * the worst outcome is `indexOf` finding nothing, which is {@link snippetAround}'s documented fallback (a window
 * from the front of the text), never a wrong index and never a lost result.
 */
function foldWithOffsets(text: string): {
  readonly folded: string;
  readonly offsets: Int32Array | undefined;
} {
  if (!needsFolding(text)) return { folded: text, offsets: undefined };

  const units: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (const point of text) {
    const foldedPoint = foldCodePoint(point);
    // Per UTF-16 **unit**, not per code point: `folded` is indexed by `indexOf`, which speaks UTF-16, and a
    // multi-unit folded character has to keep pointing at the one source character it came from.
    for (let i = 0; i < foldedPoint.length; i += 1) {
      units.push(foldedPoint.charAt(i));
      starts.push(at);
    }
    at += point.length;
  }
  return { folded: units.join(''), offsets: Int32Array.from(starts) };
}

/** The source index a folded index came from (`offsets === undefined` is the identity fold: they are equal). */
function sourceIndexAt(offsets: Int32Array | undefined, foldedIndex: number, fallback: number): number {
  if (offsets === undefined) return foldedIndex;
  return offsets[foldedIndex] ?? fallback;
}

/** How many code points `text` holds: its UTF-16 length, less one for every low surrogate in it. */
function codePointCount(text: string): number {
  let lowSurrogates = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ((text.charCodeAt(i) & 0xfc00) === 0xdc00) lowSurrogates += 1;
  }
  return text.length - lowSurrogates;
}

/**
 * The UTF-16 index just past the first `count` code points of `text`, clamped to its end.
 *
 * Both snippet boundaries come out of here, which is the whole reason the cut cannot split a character: a slice
 * that starts and ends on a code-point boundary cannot contain half of a surrogate pair, and `slice` itself cannot
 * be trusted to find one.
 */
function utf16IndexAfter(text: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    // A low surrogate is the tail of the code point before it, already counted by that code point's iteration.
    if ((text.charCodeAt(i) & 0xfc00) === 0xdc00) continue;
    seen += 1;
    if (seen === count) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      return (next & 0xfc00) === 0xdc00 ? i + 2 : i + 1;
    }
  }
  return text.length;
}

/**
 * A window of at most {@link SNIPPET_MAX_CODEPOINTS} code points of `text` that contains the first occurrence of
 * `needle` (already folded, as is `text`'s fold).
 *
 * The window opens with {@link SNIPPET_LEAD_CODEPOINTS} of context before the match, so the match is not jammed
 * against the left edge a person reads first; when the match itself would not fit, the window grows around it and
 * its start is pulled back instead, which keeps the promise that matters — a snippet that contains the match.
 *
 * **It is called with the *plaintext*, and returns plaintext.** Folding happens inside it, for the offset map
 * only; the characters a caller sees are the ones that were typed, accents and emoji intact.
 *
 * @throws nothing, ever. If the two folds ever disagree about where the match is — they should not, and
 * `search.service.test.ts` pins them together — the window is cut from the front of the text rather than throwing
 * away a result whose snippet cannot be placed.
 */
export function snippetAround(text: string, needle: string): string {
  const { folded, offsets } = foldWithOffsets(text);
  const at = needle.length === 0 ? 0 : folded.indexOf(needle);
  if (at === -1) return windowFrom(text, 0, Math.min(text.length, needle.length));

  const matchStart = sourceIndexAt(offsets, at, 0);
  // The end of the match is the start of the first folded character *after* it that came from a different source
  // character: a multi-character fold ('Ǆ' → 'ǆ') maps several folded units to one source character, and stopping
  // at that source character's own index would cut the match in half.
  let after = at + needle.length;
  const lastMatched = sourceIndexAt(offsets, at + needle.length - 1, matchStart);
  if (offsets !== undefined) {
    while (after < offsets.length && offsets[after] === lastMatched) after += 1;
  }
  const matchEnd =
    offsets === undefined
      ? matchStart + needle.length
      : after < offsets.length
        ? (offsets[after] ?? text.length)
        : text.length;

  return windowFrom(text, matchStart, matchEnd);
}

/**
 * The code-point window itself: `text`'s characters between `from` and `to` (UTF-16 indexes into the match),
 * widened to the match and narrowed to the budget, cut on code-point boundaries.
 */
function windowFrom(text: string, from: number, to: number): string {
  if (text.length === 0) return '';

  const total = codePointCount(text);
  const before = codePointCount(text.slice(0, from));
  const matched = codePointCount(text.slice(from, to));

  let start = Math.max(0, before - SNIPPET_LEAD_CODEPOINTS);
  let end = Math.min(total, start + SNIPPET_MAX_CODEPOINTS);
  if (before + matched > end) {
    // The match is longer than what is left of the budget. Anchor the window at the match's **start** and quote as
    // much of it as fits: a query longer than the snippet is rare, but of the two ways to cut it, the one that
    // drops the beginning of what the person searched for is the worse one.
    start = before;
    end = Math.min(total, start + SNIPPET_MAX_CODEPOINTS);
  }
  return text.slice(utf16IndexAfter(text, start), utf16IndexAfter(text, end));
}

/** A note the caller may see, with the reason it is in the result and the text a snippet can be cut from. */
interface Hit {
  readonly id: string;
  readonly name: string;
  readonly folderPath: string;
  readonly score: number;
  readonly contentUpdatedAt: Date;
  /** The decrypted body, kept only while it matched, and only so the surviving rows owe at most `limit` snippets. */
  readonly body?: string | undefined;
}

/** The one method of the service, and the only place a note body is decrypted on the read path besides `GET /api/notes/:id`. */
export interface SearchService {
  readonly search: (input: SearchNotes) => Promise<SearchResponse>;
}

/**
 * What a search needs from its caller.
 *
 * `log` is a parameter rather than a constructor option so the line lands on the **request's** logger: the skip
 * is worth reading next to the `requestId` an envelope already carries, and a per-process logger would have
 * neither. It is a two-method structural type instead of `FastifyBaseLogger` because a service must not import
 * the transport to write a message.
 */
export interface SearchNotes {
  readonly userId: string;
  /** The query as `searchQuerySchema` left it: trimmed, non-blank, at most `SEARCH_QUERY_MAX_LENGTH`. */
  readonly q: string;
  /** Defaults to {@link SEARCH_RESULT_MAX}; a larger value is refused by the schema before it gets here. */
  readonly limit?: number | undefined;
  readonly log: SearchLog;
}

/** The slice of a logger the service uses. `request.log` satisfies it; so does a test's recorder. */
export interface SearchLog {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface SearchServiceOptions {
  readonly db: Db;
  readonly keyring: Keyring;
}

/** Builds the service over one pool and one keyring; `buildApp()` registers one per process. */
export function createSearchService(options: SearchServiceOptions): SearchService {
  const { db, keyring } = options;

  return {
    async search({ userId, q, limit = SEARCH_RESULT_MAX, log }): Promise<SearchResponse> {
      // The net under a caller that reached the service past `searchQuerySchema`, and the same shape as
      // `note.service.ts`'s byte cap: the schema is the wire's promise, this is the process's.
      const max = Math.max(1, Math.min(Math.trunc(limit), SEARCH_RESULT_MAX));
      const needle = foldKey(q);
      const pattern = likeContainsPattern(q);

      // Two statements, issued together: neither can tell the service anything the other can, and the union they
      // feed is scored after both arrive.
      const [metadataRows, candidates] = await Promise.all([
        searchNotesByMetadata(db, { userId, pattern, limit: SEARCH_CANDIDATE_SCAN }),
        listRecentNotesForSearch(db, { userId, limit: SEARCH_CANDIDATE_SCAN }),
      ]);

      const hits = new Map<string, Hit>();
      const unreadable: string[] = [];

      for (const row of candidates) {
        let body: string;
        try {
          body = openNoteContent(row, keyring);
        } catch (error) {
          // One unreadable note must not fail a search: skip it, and say which one (§4's last criterion). An
          // `EnvelopeError` is the expected shape (tampered bytes, a key version the ring lost); anything else is
          // a bug and propagates to `mapError()` like any other.
          if (!(error instanceof EnvelopeError)) throw error;
          unreadable.push(row.id);
          continue;
        }

        const nameHit = foldKey(row.name).includes(needle);
        const bodyHit = foldKey(body).includes(needle);
        const contentHit = bodyHit || pathHits(row.folderPath, needle);
        if (!nameHit && !contentHit) continue;

        hits.set(row.id, {
          id: row.id,
          name: row.name,
          folderPath: row.folderPath,
          score: nameHit ? SEARCH_SCORE_NAME : SEARCH_SCORE_CONTENT,
          contentUpdatedAt: row.contentUpdatedAt,
          ...(bodyHit ? { body } : {}),
        });
      }

      const skipped = new Set(unreadable);
      for (const row of metadataRows) {
        // A row the in-process pass already saw keeps its own verdict: it decrypted the body, so it knows whether
        // a snippet is available. And a row it could not read stays dropped from *both* passes, so the skipped set
        // is checked here rather than being a fact about one statement.
        if (hits.has(row.id) || skipped.has(row.id)) continue;
        hits.set(row.id, {
          id: row.id,
          name: row.name,
          folderPath: row.folderPath,
          // `name hit > body hit`. SQL reports which of its two predicates matched (`nameMatched`) and the fold
          // gets the last word, because the two languages are not asking the same question: a note named `café`
          // queried as `café` is a name hit in both, and where they disagree the statement matched a *folder*
          // while the fold may have found the name. Falling through to the content tier when neither test matches
          // is deliberate — the statement did match the row, so it is a hit that merely does not name its field,
          // and dropping it would lose a result to a case-folding difference between Postgres and JavaScript.
          score:
            row.nameMatched || foldKey(row.name).includes(needle) ? SEARCH_SCORE_NAME : SEARCH_SCORE_CONTENT,
          contentUpdatedAt: row.contentUpdatedAt,
        });
      }

      if (unreadable.length > 0) {
        // The id is the point: the client gets a result set that happens to be one note short, and only the log
        // can say why. Same reasoning as PR-09's `EnvelopeError` line, which logs the id of the note that answered
        // `INTERNAL` — a body that will not authenticate is an operator's problem, not the caller's.
        log.warn({ noteIds: unreadable, scanned: candidates.length }, SEARCH_SKIP_LOG_MESSAGE);
      }

      const ordered = [...hits.values()].sort(compareHits);
      const results = ordered.slice(0, max).map((hit) => ({
        noteId: hit.id,
        name: hit.name,
        folderPath: hit.folderPath,
        // Empty for a name-only match (the contract's own reading of `snippet`): there is no body window around a
        // match that happened in a name, and inventing one would put text under a highlight that is not there.
        snippet: hit.body === undefined ? '' : snippetAround(hit.body, needle),
        score: hit.score,
      }));

      return { results };
    },
  };
}

/**
 * `name hit > body hit > recency`, then `id` (§4).
 *
 * Recency is a tiebreak rather than a component of `score` so the two tiers cannot be shuffled by a big corpus:
 * a name hit found today still loses to nothing, and a body hit from this morning still beats a body hit from
 * last year. `id` is last because `content_updated_at` is millisecond-granular and two autosaved notes can share
 * one — an unordered tie between them would make the cut at 25 non-reproducible, which is worse than arbitrary.
 */
function compareHits(a: Hit, b: Hit): number {
  if (a.score !== b.score) return b.score - a.score;
  const newer = b.contentUpdatedAt.getTime() - a.contentUpdatedAt.getTime();
  if (newer !== 0) return newer;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether any **folder name** in a note's breadcrumb contains the needle.
 *
 * Segment by segment, matching `notes.repo.ts`'s SQL branch (`unnest(path)`), for the same reason: folder names
 * cannot contain `/` (`docs/NAME-RULES.md`'s forbidden characters), so `work/2026` should match nothing rather
 * than every note under `work`. A root note's path is `''`, whose single empty segment can never contain a
 * non-empty needle.
 */
function pathHits(folderPath: string, needle: string): boolean {
  if (folderPath === '') return false;
  for (const segment of folderPath.split('/')) {
    if (foldKey(segment).includes(needle)) return true;
  }
  return false;
}
