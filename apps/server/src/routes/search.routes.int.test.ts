/**
 * `GET /api/search` on the wire (docs/plans/mvp/MVP-11.md §6, plan §9.2 #21).
 *
 * The rules themselves — folding, tiers, snippets, the scan bound — are pinned in
 * `services/search.service.int.test.ts`, where they are statements about rows. This file is about the four
 * things that only exist on the wire:
 *
 * * **`401` before the handler runs.** A `GET` carries no CSRF token, so the guard's one visible failure is the
 *   session's, and it must be `401 UNAUTHORIZED` rather than the `403` a mutation without `X-CSRF-Token` gets.
 * * **`q` is validated as a query, not guessed at.** `?q=`, `?q=%20%20` and a missing `q` all answer
 *   `400 VALIDATION` from `mapError()` — the same code an invalid body gets, because the contract treats a
 *   request that cannot be answered as sent as one failure — and the `details[].path` says `q`, which is the
 *   field a client can put a form error under.
 * * **`limit` is coerced and capped** by that one schema: `?limit=5` is five results, `?limit=0` and `?limit=26`
 *   are `VALIDATION`, and `?limit=ten` is too — a coercion failure is a bad request, not a default.
 * * **The response is the contract's**, validated with `searchResponseSchema`, so a field renamed on either side
 *   stops this test rather than PR-17's screen.
 *
 * The notes are seeded through `seedNotes()` with the process keyring — the same ring `buildApp()` defaults to —
 * because a search body has to decrypt, and the users come from `/setup` and `POST /api/users` because the id
 * under test has to be a real session's.
 */
import { ROUTES, SEARCH_RESULT_MAX, searchPath, searchResponseSchema } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { getKeyring } from '../crypto/keys.js';
import { fillerNotes, seedNotes } from '../test/fixtures.js';
import { withApp } from '../test/helpers/app.js';
import { type Jar, jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { bootstrapOwner, createMember, envelopeOf, whoAmI } from '../test/helpers/session.js';

const db = testDb();
const keyring = getKeyring();

beforeEach(async () => {
  await resetDb();
});

/** One search over the wire, with the contract's own path builder so the encoding is the client's too. */
function get(app: FastifyInstance, jar: Jar, q: string, limit?: number) {
  return app.inject({ method: 'GET', url: searchPath(q, limit), headers: jarHeaders(jar) });
}

/** A corpus with one obvious hit, one body hit and one note that should never appear. */
async function seedCorpus(userId: string): Promise<void> {
  await seedNotes(db, {
    userId,
    keyring,
    notes: [
      { name: 'quarterly report', body: 'numbers, mostly' },
      { name: 'notes on the retreat', body: 'the quarterly report is due Friday' },
      { name: 'shopping', body: 'oats, honey, tea' },
    ],
  });
}

describe('GET /api/search (§9.2 #21)', () => {
  it('refuses an anonymous caller before the handler runs', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const response = await app.inject({ method: 'GET', url: searchPath('quarterly') });
        expect(response.statusCode).toBe(401);
        // A `GET` never reaches the CSRF guard's `403`, so this is the session guard's own answer: no cookie, no
        // search, and no information about whether the query would have hit anything.
        expect(envelopeOf(response).code).toBe('UNAUTHORIZED');
      },
      { db },
    );
  });

  it('answers the contract shape, with a snippet for the body hit and none for the name hit', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const ownerId = await whoAmI(app, owner);
        await seedCorpus(ownerId);

        const response = await get(app, owner, 'quarterly');
        expect(response.statusCode, response.body).toBe(200);

        const body = searchResponseSchema.parse(response.json());
        expect(body.results.map((result) => result.name)).toEqual([
          'quarterly report', // the name hit, first whatever its age
          'notes on the retreat', // the body hit, with the window around the match
        ]);
        expect(body.results[0]?.folderPath).toBe(''); // the root has no path to show
        expect(body.results[0]?.snippet).toBe('');
        expect(body.results[1]?.snippet).toContain('quarterly report');
        // Ids are the note's, so the client can build `/app/note/<id>` without a second request.
        expect(body.results[0]?.noteId).toMatch(/^[0-9a-f-]{36}$/);
      },
      { db },
    );
  });

  it('asks for a trimmed, non-blank q, and says which field is wrong', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        await seedCorpus(await whoAmI(app, owner));

        // Missing, blank, and whitespace-only are the same request as far as the contract is concerned: an empty
        // search is a UI state, not a query over the whole corpus.
        const cases = [
          { url: `${ROUTES.search}`, label: 'no q at all' },
          { url: `${ROUTES.search}?q=`, label: 'empty q' },
          { url: `${ROUTES.search}?q=%20%20`, label: 'whitespace-only q' },
        ];
        for (const testCase of cases) {
          const response = await app.inject({ method: 'GET', url: testCase.url, headers: jarHeaders(owner) });
          expect(response.statusCode, `${testCase.label}: ${response.body}`).toBe(400);
          const envelope = envelopeOf(response);
          expect(envelope.code, testCase.label).toBe('VALIDATION');
          const details = envelope.details as { path: string; message: string }[];
          expect(
            details.map((detail) => detail.path),
            testCase.label,
          ).toContain('q');
        }
      },
      { db },
    );
  });

  it('coerces limit, caps it at the contract maximum, and refuses what it cannot honour', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const ownerId = await whoAmI(app, owner);
        // 30 matching notes: the default cuts at SEARCH_RESULT_MAX, `?limit=5` cuts at 5.
        await seedNotes(db, {
          userId: ownerId,
          keyring,
          notes: Array.from({ length: 30 }, (_, i) => ({
            name: `dupe-${String(i).padStart(2, '0')}`,
            body: 'carpool karaoke plans',
            contentUpdatedAt: new Date(Date.UTC(2026, 0, 1) - i * 1000),
          })),
        });

        const defaulted = await get(app, owner, 'carpool');
        expect(defaulted.statusCode, defaulted.body).toBe(200);
        expect(searchResponseSchema.parse(defaulted.json()).results).toHaveLength(SEARCH_RESULT_MAX);

        const five = await get(app, owner, 'carpool', 5);
        expect(five.statusCode, five.body).toBe(200);
        expect(searchResponseSchema.parse(five.json()).results).toHaveLength(5);

        for (const limit of ['0', '26', 'ten', '-3', '1.5']) {
          const response = await app.inject({
            method: 'GET',
            url: `${ROUTES.search}?q=carpool&limit=${limit}`,
            headers: jarHeaders(owner),
          });
          expect(response.statusCode, `limit=${limit}: ${response.body}`).toBe(400);
          expect(envelopeOf(response).code).toBe('VALIDATION');
        }
      },
      { db },
    );
  });

  it('finds nothing of another user, and answers the same as an empty corpus would', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner);
        const ownerId = await whoAmI(app, owner);
        const memberId = await whoAmI(app, member);

        await seedNotes(db, {
          userId: ownerId,
          keyring,
          notes: [{ name: 'household accounts', body: 'the shared ledger of the household' }],
        });
        await seedNotes(db, {
          userId: memberId,
          keyring,
          notes: [{ name: 'private ledger', body: 'these entries belong to their author alone' }],
        });

        // The member searching the owner's words: a 200 with nothing in it. The body says no more than "these
        // notes do not contain that", so the endpoint cannot be read as an oracle over other people's corpora.
        const crossUser = await get(app, member, 'household accounts');
        expect(crossUser.statusCode, crossUser.body).toBe(200);
        expect(searchResponseSchema.parse(crossUser.json()).results).toEqual([]);

        const own = await get(app, member, 'private');
        expect(searchResponseSchema.parse(own.json()).results.map((result) => result.name)).toEqual([
          'private ledger',
        ]);

        // …and the owner's own answer to the same query cannot contain the member's text, quoted or otherwise.
        const ownerSide = await get(app, owner, 'household');
        expect(ownerSide.body).toContain('household accounts');
        expect(ownerSide.body).not.toContain('belong to their author');
      },
      { db },
    );
  });

  it('answers 200 with the readable notes when one body in the corpus does not authenticate', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const [good, broken] = await seedNotes(db, {
          userId: await whoAmI(app, owner),
          keyring,
          notes: [
            { name: 'readable', body: 'needle in the readable body' },
            { name: 'corrupt', body: 'needle in the unreadable body' },
          ],
        });
        if (!good || !broken) throw new Error('fixture returned no rows');
        await catalogRows(
          sql`update notes set content_cipher = sha256(content_cipher) where id = ${broken.id}`,
        );

        // The half of the criterion that belongs on the wire: one broken row is not a `500`, and it is not a `200`
        // that quotes garbage either. `mapError()` never sees an `EnvelopeError` here, because the service skipped
        // the row instead of failing on it.
        const response = await get(app, owner, 'needle');
        expect(response.statusCode, response.body).toBe(200);
        expect(searchResponseSchema.parse(response.json()).results.map((r) => r.name)).toEqual(['readable']);
      },
      { db },
    );
  });

  it('answers a query that matches nothing with an empty result set, not an error', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        await seedNotes(db, {
          userId: await whoAmI(app, owner),
          keyring,
          notes: fillerNotes(3, 'filler'),
        });

        const response = await get(app, owner, 'no Such Term Here');
        expect(response.statusCode, response.body).toBe(200);
        expect(searchResponseSchema.parse(response.json())).toEqual({ results: [] });
      },
      { db },
    );
  });
});
