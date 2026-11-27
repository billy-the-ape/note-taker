/**
 * `GET /api/search`'s rules, measured at the service (docs/plans/mvp/MVP-11.md §6).
 *
 * The wire is `routes/search.int.test.ts`; this file is where the rules themselves are pinned, because every one
 * of them is a decision about rows rather than about a request: which notes a query can reach, what a snippet may
 * contain, and what a corrupt envelope costs (one skipped note and a log line — not a 500, and not a silent gap
 * in the answer).
 *
 * The fixture rule this file lives or dies by: **every body here is a real envelope.** `sealedContent()` in
 * `test/fixtures.ts` is a hash with the shape of one, and `openNoteContent()` would rightly refuse to read it
 * back, so a search test written against it would be a test of the skip path. `seedNotes()` seals with the process
 * keyring instead, and gives each row the `content_updated_at` it is told — which is what turns "the 501st most
 * recent note is not searched" from a statement about a race into a statement about an index.
 *
 * Corpus sizes are not decoration: 501 is {@link SEARCH_CANDIDATE_SCAN} + 1, 1 000 is §6's p95 fixture, and 30 is
 * the smallest number that overflows `SEARCH_RESULT_MAX` while still having an answer left over to prove the cut
 * was a cut and not a coincidence.
 */
import { SEARCH_RESULT_MAX, searchResponseSchema } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getKeyring } from '../crypto/keys.js';
import { createFolder } from '../db/repositories/folders.repo.js';
import { createMember, createOwner, fillerNotes, seedNotes } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { captureLogs } from '../test/helpers/log-capture.js';
import {
  createSearchService,
  SEARCH_CANDIDATE_SCAN,
  SEARCH_SCORE_CONTENT,
  SEARCH_SCORE_NAME,
  SEARCH_SKIP_LOG_MESSAGE,
  type SearchLog,
  SNIPPET_MAX_CODEPOINTS,
} from './search.service.js';

const db = testDb();
const keyring = getKeyring();

beforeEach(async () => {
  await resetDb();
});

/** A logger for the tests whose subject is not the log line. */
const quiet: SearchLog = { warn: () => {} };

const service = createSearchService({ db, keyring });

/** One search, from the caller's point of view: their id, their words, nothing else. */
function search(
  userId: string,
  q: string,
  options: { readonly limit?: number; readonly log?: SearchLog } = {},
) {
  return service.search({ userId, q, ...options, log: options.log ?? quiet });
}

/** The names, in the order the service ranked them — the shape most of these assertions compare. */
function namesOf(results: readonly { name: string }[]): string[] {
  return results.map((result) => result.name);
}

/** Code points, which is the unit a snippet's budget is written in (an emoji is one, not two). */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** A date `daysBefore` before a fixed instant, so a corpus's recency order is arithmetic rather than luck. */
function at(daysBefore: number): Date {
  return new Date(Date.UTC(2026, 0, 1) - daysBefore * 86_400_000);
}

/**
 * Makes one note unreadable the way real corruption does: keep the columns, break the authentication.
 *
 * Same trick as `routes/notes.routes.int.test.ts` — replace the ciphertext with a digest of it, which is a valid
 * `bytea` of the wrong bytes — and it is the whole failure mode: the row is present, owned, correctly shaped, and
 * refuses to open.
 */
async function tamperWith(noteId: string): Promise<void> {
  await catalogRows(sql`update notes set content_cipher = sha256(content_cipher) where id = ${noteId}`);
}

describe('GET /api/search — accent folding happens in the in-process pass (§6)', () => {
  it('finds an in-window note named "café" from "cafe", and one whose body says "café" from "cafe"', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'café', body: 'a note about coffee' },
        { name: 'ledger', body: 'the café on the corner closed early' },
        { name: 'unrelated', body: 'nothing diacritical here' },
      ],
    });

    // Both directions the criterion asks for, in one run: a note whose **name** carries the accent, and one whose
    // **body** does. Both are inside the window, so the fold is what found them.
    const folded = await search(owner.id, 'cafe');
    expect(new Set(namesOf(folded.results))).toEqual(new Set(['café', 'ledger']));

    // The accented query finds the same two, because the query is folded too — not just the candidate text.
    const accented = await search(owner.id, 'café');
    expect(new Set(namesOf(accented.results))).toEqual(new Set(['café', 'ledger']));

    // And the snippet is plaintext: the window a person reads keeps the accent the note was written with, so the
    // fold never leaks into what the client is shown.
    expect(folded.results.find((result) => result.name === 'ledger')?.snippet).toContain('café');
  });

  it('is accent-sensitive outside the 500-candidate window — the asymmetry backlog PR-29 closes', async () => {
    const owner = await createOwner(db);
    // Exactly {@link SEARCH_CANDIDATE_SCAN} notes filling the window, and one accented note one place past it.
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        ...fillerNotes(SEARCH_CANDIDATE_SCAN, 'filler', { baseTime: at(0) }),
        { name: 'café-old', body: 'a body nobody is searching for', contentUpdatedAt: at(365) },
      ],
    });

    // Exact form: the SQL branch sees the whole corpus, so the out-of-window note comes back.
    expect(namesOf((await search(owner.id, 'café')).results)).toEqual(['café-old']);

    // Folded form: SQL cannot fold (no `unaccent` is installed, and a fold is not a `LIKE` pattern), and the pass
    // that can fold reaches only the newest 500 rows. The answer is empty.
    //
    // That is the documented asymmetry (docs/API.md #21), asserted rather than commented: if somebody later
    // makes name search uniformly accent-insensitive by quietly enabling `unaccent`, this run goes red and the
    // migration decision it stands for has to be made out loud.
    expect((await search(owner.id, 'cafe')).results).toEqual([]);
  });
});

describe('GET /api/search — wildcards are literal (§6)', () => {
  it('treats % and _ as themselves, so "100%" and "a_b" do not match everything', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: '100% cotton', body: 'the tag says 100% cotton' },
        { name: 'a_b note', body: 'a_b is a name with an underscore' },
        { name: 'axb note', body: 'the letters axb appear here' },
        { name: 'plain', body: 'nothing in this body matches a wildcard' },
      ],
    });

    // The control: the corpus is searchable, so an empty answer below means "literal", not "broken".
    expect(namesOf((await search(owner.id, 'note')).results).sort()).toEqual(['a_b note', 'axb note']);

    // `%` unescaped would make this `%%%`, i.e. "everything", and this `_` unescaped would reach `axb`.
    expect(namesOf((await search(owner.id, '100%')).results)).toEqual(['100% cotton']);
    expect(namesOf((await search(owner.id, '%')).results)).toEqual(['100% cotton']);
    expect(namesOf((await search(owner.id, 'a_b')).results)).toEqual(['a_b note']);
    expect(namesOf((await search(owner.id, '_')).results)).toEqual(['a_b note']);

    // A backslash is the LIKE escape character, so a literal one has to survive escaping itself too. The name
    // rules forbid `\` in a name, so the body is the only place it can be typed.
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [{ name: 'escaped', body: 'a backslash \\ in the body' }],
    });
    expect(namesOf((await search(owner.id, '\\')).results)).toEqual(['escaped']);
  });

  it('finds a wildcard query one row past the 500-candidate window, where only SQL can see it', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        // Newer than every filler, so it is inside the window and either pass could return it…
        {
          name: '100% cotton-new',
          body: 'a tag nobody is searching for',
          contentUpdatedAt: new Date(at(0).getTime() + 60_000),
        },
        ...fillerNotes(SEARCH_CANDIDATE_SCAN, 'filler', { baseTime: at(0) }),
        // …and its twin a year older, i.e. the 501st row and beyond the scan bound. It can only come back through
        // the metadata statement, which is the half whose "whole corpus" promise this query actually tests.
        // An ESCAPE clause Postgres reads as empty makes both rows vanish, not just this one.
        {
          name: '100% cotton-old',
          body: 'a tag nobody is searching for',
          contentUpdatedAt: at(365),
        },
      ],
    });

    // Recency inside the tier, so the in-window row is first and the out-of-window row second: the second element
    // is the assertion this test exists for (PR-11 review, inline `r4721929072`).
    expect(namesOf((await search(owner.id, '100%')).results)).toEqual(['100% cotton-new', '100% cotton-old']);

    // The same shape for `_`, which is the wildcard that turns a name into a wildcard match on one character.
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'a_b-new', body: 'nothing', contentUpdatedAt: new Date(at(0).getTime() + 60_000) },
        { name: 'a_b-old', body: 'nothing', contentUpdatedAt: at(365) },
        // The foil: one character away from `a_b`, and outside the window too, so an unescaped `_` would answer
        // three names here and this assertion would fail on the SQL half it is meant to protect.
        { name: 'axb-old', body: 'nothing', contentUpdatedAt: at(366) },
      ],
    });
    expect(namesOf((await search(owner.id, 'a_b')).results)).toEqual(['a_b-new', 'a_b-old']);
  });
});

describe('GET /api/search — folders, paths and the shape of a result', () => {
  it("finds a note by its folder's name, and reports the path it was found under", async () => {
    const owner = await createOwner(db);
    const work = await createFolder(db, { userId: owner.id, name: 'work' });
    const deep = await createFolder(db, { userId: owner.id, name: '2026', parentId: work.id });
    const rows = await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'quarterly', body: 'budget planning', folderId: deep.id },
        { name: 'rooty', body: 'a note at the root' },
      ],
    });

    // A hit on a folder *name* in the breadcrumb, which is the tier a body hit shares.
    const byFolder = await search(owner.id, 'work');
    expect(namesOf(byFolder.results)).toEqual(['quarterly']);
    expect(byFolder.results[0]?.folderPath).toBe('work/2026');
    expect(byFolder.results[0]?.score).toBe(SEARCH_SCORE_CONTENT);
    expect(byFolder.results[0]?.snippet).toBe(''); // the match was in the path, not in a body

    // The path a client renders: `/`-joined for a nested note, empty for a root note (§9.2 #21's contract).
    const byName = await search(owner.id, 'rooty');
    expect(byName.results[0]?.folderPath).toBe('');
    expect(byName.results[0]?.noteId).toBe(rows[1]?.id);

    // A segment is the unit, so a query containing the joining `/` matches nothing rather than every note under
    // some folder — folder names cannot contain `/` (docs/NAME-RULES.md).
    expect((await search(owner.id, 'work/2026')).results).toEqual([]);
  });
});

describe('GET /api/search — ordering and bounds (§6)', () => {
  it('ranks a name hit above a body hit, and equal scores by content_updated_at DESC', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        // The only name hit, and the corpus's oldest note: recency must not buy it a lower place than tier 1.
        { name: 'needle-name', body: 'nothing here', contentUpdatedAt: at(90) },
        // Three body hits at three ages, so the tiebreak order has to be read off the clock, not the insert order.
        { name: 'alpha', body: 'a needle appears', contentUpdatedAt: at(1) },
        { name: 'bravo', body: 'a needle appears', contentUpdatedAt: at(10) },
        { name: 'charlie', body: 'a needle appears', contentUpdatedAt: at(5) },
      ],
    });

    const results = (await search(owner.id, 'needle')).results;
    expect(namesOf(results)).toEqual(['needle-name', 'alpha', 'charlie', 'bravo']);
    expect(results.map((result) => result.score)).toEqual([
      SEARCH_SCORE_NAME,
      SEARCH_SCORE_CONTENT,
      SEARCH_SCORE_CONTENT,
      SEARCH_SCORE_CONTENT,
    ]);
  });

  it('returns at most 25 results, and honours a smaller limit, from the newest of the matches', async () => {
    const owner = await createOwner(db);
    // 30 notes that all match, each a second-older than the last, so the cut is checkable by name.
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: Array.from({ length: 30 }, (_, i) => ({
        name: `dupe-${i}`,
        body: 'carpool karaoke plans',
        // One second apart, newest first, so "the 25 that came back are the 25 newest" is a check on names.
        contentUpdatedAt: new Date(at(0).getTime() - i * 1000),
      })),
    });

    const all = await search(owner.id, 'carpool');
    expect(searchResponseSchema.parse(all).results).toHaveLength(SEARCH_RESULT_MAX);
    expect(namesOf(all.results)).toEqual(Array.from({ length: 25 }, (_, i) => `dupe-${i}`));

    const few = await search(owner.id, 'carpool', { limit: 5 });
    expect(few.results).toHaveLength(5);
    expect(namesOf(few.results)).toEqual(['dupe-0', 'dupe-1', 'dupe-2', 'dupe-3', 'dupe-4']);
  });

  it('stops at the 500-candidate scan bound, while the SQL branch still covers the corpus', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        // The newest note matches by body, and it is found.
        { name: 'fresh-soup', body: 'the quinoa salad recipe', contentUpdatedAt: at(0) },
        // …500 notes filling the window with things that do not match…
        ...fillerNotes(SEARCH_CANDIDATE_SCAN, 'filler', { baseTime: at(1) }),
        // …and the 501st, oldest of all, matches by body too. It is out of reach by design.
        { name: 'old-soup', body: 'the quinoa soup recipe', contentUpdatedAt: at(500) },
      ],
    });

    const byBody = await search(owner.id, 'quinoa');
    expect(namesOf(byBody.results)).toEqual(['fresh-soup']);

    // The other half of the bound: it is a bound on *decryption*, not on what search can reach. A name outside
    // the window still answers, because the metadata branch needs no key and no window.
    expect(namesOf((await search(owner.id, 'old-soup')).results)).toEqual(['old-soup']);
  });
});

describe('GET /api/search — snippets come from plaintext (§6)', () => {
  it('cuts at ~120 code points, keeps the match inside, and never splits an emoji or a surrogate pair', async () => {
    const owner = await createOwner(db);
    const field = '🦄'.repeat(80); // 160 UTF-16 units, 80 code points: the cut can only be honest in code points.
    // 120 combining marks **before** the match, so the folded index of `needle` (320) is 120 code points away
    // from its index in the plaintext (440). A window cut at the folded index lands a whole sentence early and
    // stops containing the match, which is the failure `foldWithOffsets` exists to prevent.
    const marked = `${'a\u0301'.repeat(120)}${'x'.repeat(200)}needle${' tail'.repeat(8)}`;
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'emoji', body: `${field}needle${field}` },
        { name: 'cjk', body: `${'目'.repeat(100)}needle${'文'.repeat(100)}` },
        { name: 'marks', body: marked },
      ],
    });

    const results = await search(owner.id, 'needle');
    expect(namesOf(results.results).sort()).toEqual(['cjk', 'emoji', 'marks']);

    for (const result of results.results) {
      const { snippet } = result;
      expect(snippet, result.name).toContain('needle');
      expect(codePoints(snippet), result.name).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
      // A dangling half of a pair would serialise as U+FFFD in the client and is what "code-point boundary" means:
      // no lone high surrogate followed by a non-low one, and no low surrogate without a high one before it.
      // (Deliberately not `/u` patterns: the point is to match the surrogates that are there.)
      expect(snippet, result.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(snippet, result.name).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }

    // The emoji case is the one where the budget and the units disagree, so it is asserted as a number too:
    // 120 code points of a body that would have been 240 UTF-16 units wide.
    const emoji = results.results.find((result) => result.name === 'emoji');
    expect(codePoints(emoji?.snippet ?? '')).toBe(SNIPPET_MAX_CODEPOINTS);
  });

  it('quotes the front of the match when the query is longer than the snippet budget', async () => {
    const owner = await createOwner(db);
    const phrase = 'the quarterly operating plan for the offsite'.padEnd(140, '.');
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'long', body: `${'x'.repeat(60)}${phrase}${'y'.repeat(60)}` },
        { name: 'other', body: 'a note the long query must not drag in' },
      ],
    });

    // 140 characters of query cannot fit in 120 of snippet. The result is still correct — the corpus matched it —
    // and the snippet quotes its beginning rather than 120 characters of unrelated context.
    const results = await search(owner.id, phrase);
    expect(namesOf(results.results)).toEqual(['long']);
    const { snippet } = results.results[0] ?? { name: 'missing', snippet: '' };
    expect(codePoints(snippet)).toBe(SNIPPET_MAX_CODEPOINTS);
    expect(snippet).toBe(phrase.slice(0, SNIPPET_MAX_CODEPOINTS));
  });

  it('leaves the snippet empty when the match was in the name, and fills it when the body matched too', async () => {
    const owner = await createOwner(db);
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        // Tier first, then the clock: `hinge` is the older of the two name hits, and `hinge-both` is a name hit
        // whose body matched too, so its age has to be stated rather than inherited from "inserted just now".
        { name: 'hinge', body: 'a note about door hardware', contentUpdatedAt: at(2) }, // name only
        { name: 'plan', body: 'the hinge on the door is loose', contentUpdatedAt: at(3) }, // body only
        { name: 'hinge-both', body: 'hinge, also the name', contentUpdatedAt: at(1) }, // name and body
      ],
    });

    const results = await search(owner.id, 'hinge');
    expect(namesOf(results.results)).toEqual(['hinge-both', 'hinge', 'plan']);
    expect(results.results.find((r) => r.name === 'hinge')?.snippet).toBe('');
    expect(results.results.find((r) => r.name === 'plan')?.snippet).toContain('hinge');
    // A name hit whose body also matched still gets the window: `snippet` describes the body, not the tier.
    expect(results.results.find((r) => r.name === 'hinge-both')?.snippet).toContain('hinge');
  });
});

describe('GET /api/search — cross-user isolation (§6)', () => {
  it('finds nothing of another user, in names, folders, bodies or snippets', async () => {
    const owner = await createOwner(db);
    const member = await createMember(db, 'member');

    // The same words in both corpora, and words only one of them owns.
    const shared = { name: 'shared word', body: 'the shared word appears here too' };
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [shared, { name: 'owner-only', body: 'the owner phrase, written by the owner' }],
    });
    const memberFolder = await createFolder(db, { userId: member.id, name: 'secretpath' });
    await seedNotes(db, {
      userId: member.id,
      keyring,
      notes: [
        shared,
        { name: 'member-only', body: 'the member phrase, written by the member', folderId: memberFolder.id },
      ],
    });

    const ownerResults = await search(owner.id, 'shared word');
    expect(ownerResults.results).toHaveLength(1);
    expect(namesOf(ownerResults.results)).toEqual(['shared word']);

    // The word only the member's rows carry: a 200 with nothing in it, which is the same answer an empty corpus
    // gives, so search cannot be used to ask whether somebody else has the word.
    expect((await search(owner.id, 'member phrase')).results).toEqual([]);
    expect((await search(owner.id, 'secretpath')).results).toEqual([]);
    expect((await search(owner.id, 'owner phrase')).results).toHaveLength(1);

    // …and the member sees their own copy, whose snippet quotes their own text. Nothing here can be compared
    // against the owner's to leak a string they did not already have.
    const memberResults = await search(member.id, 'member phrase');
    expect(namesOf(memberResults.results)).toEqual(['member-only']);
    expect(memberResults.results[0]?.snippet).toContain('member');
    expect(memberResults.results[0]?.folderPath).toBe('secretpath');
    expect(JSON.stringify(memberResults)).not.toContain('owner phrase');

    const ownerProbe = await search(owner.id, 'the');
    expect(JSON.stringify(ownerProbe)).not.toContain('member phrase');
    expect(JSON.stringify(ownerProbe)).not.toContain('secretpath');
  });
});

describe('GET /api/search — a body that does not authenticate (§6)', () => {
  it('skips the unreadable note, logs its id, and still answers the rest', async () => {
    const owner = await createOwner(db);
    const [good, broken, namedBroken] = await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: [
        { name: 'good', body: 'needle in the good body' },
        { name: 'broken', body: 'needle in the broken body' },
        { name: 'needle-mark', body: 'needle in the name-matching broken body' },
      ],
    });
    if (!good || !broken || !namedBroken) throw new Error('fixture returned no rows');

    await tamperWith(broken.id);
    await tamperWith(namedBroken.id);

    const logs = captureLogs();
    const results = await search(owner.id, 'needle', { log: logs.logger });

    // No throw, no `INTERNAL`, no blank-or-garbage body standing in for the unreadable one: the two corrupt rows
    // are simply not in the answer, and the good one is.
    expect(searchResponseSchema.parse(results).results.map((r) => r.noteId)).toEqual([good.id]);

    // The skipped rows are dropped from **both** passes: `needle-mark` matches by name, which the SQL branch
    // could have answered without a key, and it still stays out, because a note the search had to open in order
    // to rank is a note the search has to be able to open.
    expect(namesOf(results.results)).toEqual(['good']);

    const lines = logs.matching(SEARCH_SKIP_LOG_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(new Set(lines[0]?.noteIds as string[])).toEqual(new Set([broken.id, namedBroken.id]));
    expect(lines[0]?.scanned).toBe(3);

    // …and an unreadable row that another query would have found by name alone is not searchable by that name.
    expect((await search(owner.id, 'needle-mark', { log: logs.logger })).results).toEqual([]);
  });
});

describe('GET /api/search — the p95 of §6', () => {
  it('searches a 1 000-note corpus in well under 300 ms', async () => {
    const owner = await createOwner(db);
    // 1 000 notes of ~200-byte bodies. The query matches **every** one of them, which is the pessimistic case:
    // the whole 500-note window decrypts, folds and hits, and the score has nothing to prune. Every third body
    // carries accents, so the number is a measurement of the folding path as much as of the ASCII fast path —
    // and of the per-character `normalize` the snippet window needs — rather than of the cheap case.
    const lorem =
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore ';
    const accented = 'café crème naïve Ærlig ångström';
    await seedNotes(db, {
      userId: owner.id,
      keyring,
      notes: Array.from({ length: 1000 }, (_, i) => ({
        name: `note-${i}`,
        body: `${lorem}${i % 3 === 0 ? `${accented} ` : ''}(${i})`,
        contentUpdatedAt: new Date(at(0).getTime() - i * 1000),
      })),
    });

    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();
      const results = await search(owner.id, 'lorem');
      samples.push(performance.now() - started);
      expect(results.results).toHaveLength(SEARCH_RESULT_MAX);
    }

    samples.sort((a, b) => a - b);
    const median = samples.at(Math.floor(samples.length / 2)) ?? 0;
    const p95 = samples.at(Math.ceil(samples.length * 0.95) - 1) ?? 0;
    // The number §8 of the brief asks the PR body to quote, printed where a passing run can still read it.
    console.info(
      `[search p95] corpus=1000 runs=${samples.length} median=${median.toFixed(1)}ms ` +
        `p95=${p95.toFixed(1)}ms limit=300ms`,
    );
    expect(p95).toBeLessThan(300);
  }, 120_000);
});
