/**
 * The note routes on the wire (docs/plans/mvp/MVP-09.md §4 #16–#17, #19–#20, §7;
 * docs/plans/mvp/MVP-10.md §5 for #18).
 *
 * This is the only place in the API where a plaintext body crosses the HTTP boundary, so the criteria worth
 * hitting are about the response, not the service:
 *
 * * `POST` is `201` and `GET` is `200`, both `NoteWithContent`; `PATCH` is the **metadata** shape, which is
 *   asserted by the absence of a `content` key rather than by a comment saying so.
 * * `GET` carries `ETag: W/"v<version>"` — weak, because the representation is JSON, and carrying the counter
 *   rather than a digest, because the server cannot read the bytes it would have to hash. PR-10 closes that
 *   round-trip from the write side: the `PUT` answers its **new** tag, and honours the old one as `If-Match`.
 * * `PUT …/content` is where the version rules become visible on the wire: one of two clients wins, the loser
 *   gets `VERSION_CONFLICT` **carrying the server's content and version**, and an id that is not yours is a `404`
 *   rather than the `409` that would confirm the row exists.
 * * a body that fails to authenticate answers `500 INTERNAL` and **not** `200` with `content: ""`. That single
 *   pair is why the read path was placed in this PR: everything else about encryption is invisible from here.
 *
 * The empty-body case is checked on the wire too, because the type system permits `content: undefined` in a
 * created object while the contract requires `content: ""` in a served one.
 *
 * What is *not* here is the atomicity of the write — one statement against a row two clients are racing for, and
 * a request killed while it is in flight. Those need their own pools and a `pg_stat_activity` probe, so they live
 * in `notes.content-race.int.test.ts`.
 */
import {
  apiErrorCodeForStatus,
  folderNodeSchema,
  isVersionConflictErrorData,
  NOTE_CONTENT_MAX_BYTES,
  noteNodeSchema,
  noteWithContentSchema,
  ROUTES,
  versionConflictErrorDataSchema,
} from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { withApp } from '../test/helpers/app.js';
import { type Jar, jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { captureLogs } from '../test/helpers/log-capture.js';
import { bootstrapOwner, createMember, envelopeOf, signedOutCsrfHeaders } from '../test/helpers/session.js';
import { ifMatchAdmits } from './notes.routes.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

/**
 * Writes a body the way the editor does: the version it read, and that version as `If-Match` too.
 *
 * Module-level rather than inside one `describe`, because two of them drive the same request shape — PR-10's
 * version rules and PR-19's `If-Match`-header-shapes block below.
 */
function put(
  app: FastifyInstance,
  jar: Jar,
  input: { readonly id: string; readonly content: string; readonly baseVersion: number },
  etag?: string,
) {
  const headers = { ...jarHeaders(jar), ...(etag === undefined ? {} : { 'if-match': etag }) };
  return app.inject({
    method: 'PUT',
    url: ROUTES.noteContent(input.id),
    headers,
    payload: { content: input.content, baseVersion: input.baseVersion },
  });
}

/** Reads one header as the string a client would compare, so `string | string[]` cannot hide a missing header. */
function headerOf(response: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = response.headers[name];
  return Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : undefined;
}

/** Makes a served note unreadable the way real corruption does: change the bytes, keep the shape. */
async function tamperWith(id: string): Promise<void> {
  await catalogRows(sql`update notes set content_cipher = sha256(content_cipher) where id = ${id}`);
}

describe('POST /api/notes (§9.2 #16)', () => {
  it('creates from an empty body: a generated name, and content that is the empty string on the wire', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const response = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: {},
        });
        expect(response.statusCode, response.body).toBe(201);

        const note = noteWithContentSchema.parse(response.json());
        expect(note.name).toMatch(/^new-file-\d+$/);
        expect(note.folderId).toBeNull();
        expect(note.version).toBe(1);
        // `""`, and the key present: the SPA binds an editor to it without a `?? ''` of its own.
        expect(note.content).toBe('');
        expect(Object.keys(note)).toContain('content');

        // And the same answer comes back from the other direction, which is the decryption round trip (§7).
        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(noteWithContentSchema.parse(read.json()).content).toBe('');
      },
      { db },
    );
  });

  it('creates from a request that carried no body at all, which is the request #16 is about', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        // `payload: {}` and no payload are two different requests. With no body there is no `Content-Type`, so
        // Fastify runs no content-type parser and the handler is handed `undefined` — and `createNoteSchema` is an
        // object schema, so a route that parses that directly answers the simplest request in the API with
        // `400 VALIDATION`. Every other test in this file sends a payload, which is why the wire-level assertion
        // belongs here: `docs/API.md` row 16 promises "no body is a valid note", and only a real request says
        // whether the server agrees.
        const response = await app.inject({ method: 'POST', url: ROUTES.notes, headers: jarHeaders(owner) });
        expect(response.statusCode, response.body).toBe(201);

        const note = noteWithContentSchema.parse(response.json());
        expect(note.name).toMatch(/^new-file-\d+$/);
        expect(note.folderId).toBeNull();
        expect(note.version).toBe(1);

        // And the 201 is backed by a row: the read decrypts the sealed empty string rather than inventing one.
        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(noteWithContentSchema.parse(read.json()).content).toBe('');
      },
      { db },
    );
  });

  it('stores a body verbatim and reports its UTF-8 size, then serves the same text back', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const content = '# Über\n\none two three\n';
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'Body.md', content },
        });
        expect(created.statusCode, created.body).toBe(201);
        const note = noteWithContentSchema.parse(created.json());
        expect(note.name).toBe('Body');
        expect(note.content).toBe(content);
        expect(note.contentBytes).toBe(new TextEncoder().encode(content).byteLength);
        expect(note.wordCount).toBe(5);

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(read.json()).content).toBe(content);
      },
      { db },
    );
  });

  it("refuses a body over the cap with the transport's own 413, before anything is stored", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        // Over the cap by one byte. The schema refuses it; the body still has to survive JSON, so this is the
        // size of the request the transport sees, not of a note anybody could edit.
        const response = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'huge', content: 'x'.repeat(NOTE_CONTENT_MAX_BYTES + 1) },
        });
        // Two honest doors to the same answer: the contract's schema refuses an over-cap body (400), and the
        // transport refuses an over-cap *request* (413) before the schema runs. Whichever it was, the code in the
        // envelope is the one that belongs to the status, and nothing was written.
        expect([400, 413]).toContain(response.statusCode);
        expect(envelopeOf(response).code).toBe(apiErrorCodeForStatus(response.statusCode));

        const mine = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        expect(mine.statusCode).toBe(200);
        expect(mine.body).not.toContain('huge');
      },
      { db },
    );
  });
});

describe('GET /api/notes/:id (§9.2 #17)', () => {
  it('sends the version as a weak entity-tag', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'tagged' },
        });
        const note = noteWithContentSchema.parse(created.json());

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(headerOf(read, 'etag')).toBe('W/"v1"');

        // A rename is not a content edit, so the tag must not move — and a move is not one either.
        const patched = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
          payload: { name: 'renamed' },
        });
        expect(patched.statusCode, patched.body).toBe(200);
        const again = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(headerOf(again, 'etag')).toBe('W/"v1"');
      },
      { db },
    );
  });

  it('answers a body that will not authenticate with 500, never with an empty note', async () => {
    const logs = captureLogs();
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'fragile', content: 'the only copy of this text' },
        });
        const note = noteWithContentSchema.parse(created.json());
        await tamperWith(note.id);

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(read.statusCode).toBe(500);
        expect(envelopeOf(read).code).toBe('INTERNAL');
        // The failure this assertion exists for: an empty body would be a plausible-looking note, and the user
        // would believe it is empty.
        expect(read.body).not.toContain('"content"');
        expect(read.body).not.toContain('the only copy');

        // …and the half the client is not allowed to see has to be somewhere, or "an operator can find the row"
        // is a sentence rather than a property. Same line as the `requestId` the envelope just returned.
        const failures = logs.matching('request failed');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ level: 50, code: 'INTERNAL', noteId: note.id });
        const requestId = headerOf(read, 'x-request-id');
        expect(typeof requestId).toBe('string');
        // …and it is on the *same* line, which is what lets a support ticket that quotes the envelope's
        // `requestId` find the row without anybody asking the operator to grep.
        const line = JSON.stringify(failures[0]);
        expect(line).toContain(String(requestId));
        // What must not be there: the plaintext, and the key-side detail (`EnvelopeError`'s own text names key
        // versions and fingerprints) that the envelope is not allowed to repeat either.
        expect(line).not.toContain('the only copy');
        expect(envelopeOf(read).message).toBe('internal error');
      },
      { db, logger: logs.logger },
    );
  });

  it("refuses another user's note, and says nothing about whether it exists", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'private', content: 'not for the member' },
        });
        const note = noteWithContentSchema.parse(created.json());

        const stolen = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(member),
        });
        const missing = await app.inject({
          method: 'GET',
          url: ROUTES.note('00000000-0000-4000-8000-000000000000'),
          headers: jarHeaders(member),
        });
        expect(stolen.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        // The two answers are the same answer, which is the only way "we do not confirm other users' rows" is
        // more than a slogan.
        expect(envelopeOf(stolen)).toEqual(envelopeOf(missing));
        expect(stolen.body).not.toContain('not for the member');
      },
      { db },
    );
  });
});

describe('PUT /api/notes/:id/content (§9.2 #18)', () => {
  /** The row's envelope, as bytes: how "this note is empty" is told apart from "this row was never written". */
  async function envelopeBytes(id: string): Promise<Record<string, number>> {
    const rows = await catalogRows(
      sql`select octet_length(content_cipher) as cipher_bytes,
                 octet_length(content_iv) as iv_bytes,
                 key_version,
                 content_bytes,
                 word_count,
                 version
            from notes where id = ${id}`,
    );
    return (rows[0] ?? {}) as Record<string, number>;
  }

  it('writes a new version, answers with it, and moves the ETag the read side had issued', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'round-trip', content: 'first draft', folderId: null },
        });
        const note = noteWithContentSchema.parse(created.json());

        // The read side of PR-09, which is where this version came from in the first place.
        const first = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(headerOf(first, 'etag')).toBe('W/"v1"');

        const written = await put(
          app,
          owner,
          { id: note.id, content: '# second draft\n\none two three four\n', baseVersion: 1 },
          headerOf(first, 'etag'),
        );
        expect(written.statusCode, written.body).toBe(200);

        const updated = noteWithContentSchema.parse(written.json());
        expect(updated.version).toBe(2);
        expect(updated.content).toBe('# second draft\n\none two three four\n');
        // §5's statistics, all three: plaintext bytes, whitespace-separated words, and the timestamp the recent
        // list is ordered by. `content_bytes` is the number the 1 MiB rule is asked about without decrypting.
        expect(updated.contentBytes).toBe(new TextEncoder().encode(updated.content).byteLength);
        // `#`, `second`, `draft`, then the four: whitespace-separated words, which is what `contentStats` counts
        // and what a listing shows without decrypting (docs/DATA-MODEL.md §2).
        expect(updated.wordCount).toBe(7);
        expect(Date.parse(updated.contentUpdatedAt)).toBeGreaterThanOrEqual(
          Date.parse(note.contentUpdatedAt),
        );
        // The new validator for the new state, in the same form `GET` quotes it, so an editor that just saved can
        // send it straight back as the next write's `If-Match`.
        expect(headerOf(written, 'etag')).toBe('W/"v2"');

        // …and the round-trip closes from the other side: the read decrypts what the write sealed, reports the
        // same version, and quotes the same tag. Nothing here is shared between the two handlers but the row.
        const again = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(again.statusCode, again.body).toBe(200);
        expect(noteWithContentSchema.parse(again.json()).content).toBe(updated.content);
        expect(headerOf(again, 'etag')).toBe('W/"v2"');
      },
      { db },
    );
  });

  it('accepts an emptied note and still stores a real envelope for it', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'emptied', content: 'text to delete' },
        });
        const note = noteWithContentSchema.parse(created.json());
        expect(note.wordCount).toBe(3);

        const emptied = await put(app, owner, { id: note.id, content: '', baseVersion: 1 });
        expect(emptied.statusCode, emptied.body).toBe(200);
        expect(noteWithContentSchema.parse(emptied.json())).toMatchObject({
          version: 2,
          content: '',
          contentBytes: 0,
          wordCount: 0,
        });
        const emptiedBody = emptied.json() as Record<string, unknown>;
        expect(Object.keys(emptiedBody)).toContain('content');

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        // `''` on the way out, and not because there was nothing to decrypt: §5 asks that an emptied note still
        // store a 12-byte IV and a 16-byte tag, which is the difference between "this note is empty" and "this
        // row was never written" — and PR-06 made empty-cipher rows impossible, so the API may not re-invent one
        // by writing a body of zero bytes as zero bytes of ciphertext.
        expect(noteWithContentSchema.parse(read.json()).content).toBe('');
        const stored = await envelopeBytes(note.id);
        expect(stored).toMatchObject({ iv_bytes: 12, content_bytes: 0, word_count: 0, version: 2 });
        expect(Number(stored.cipher_bytes)).toBeGreaterThanOrEqual(16);
      },
      { db },
    );
  });

  it('honours If-Match: a stale tag is refused, the current one is written', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'tagged-write', content: 'v1 body' },
        });
        const note = noteWithContentSchema.parse(created.json());

        const second = await put(app, owner, { id: note.id, content: 'v2 body', baseVersion: 1 }, 'W/"v1"');
        expect(second.statusCode, second.body).toBe(200);
        expect(headerOf(second, 'etag')).toBe('W/"v2"');

        // The tag from the state this request is no longer describing. `baseVersion` agrees with the tag, which is
        // what a client that lost a response sends, and the answer is the same `VERSION_CONFLICT` the body alone
        // would have produced: the header cannot turn a conflict into a write.
        const stale = await put(app, owner, { id: note.id, content: 'lost reply', baseVersion: 1 }, 'W/"v1"');
        expect(stale.statusCode, stale.body).toBe(409);
        expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
        // …and it carries the pair PR-14 compares with the snapshot it put on the wire, both fields asserted,
        // because that comparison is what stops a committed-but-unacknowledged autosave from being reported to
        // the user as a collision with somebody else.
        const data = versionConflictErrorDataSchema.parse(
          (stale.json() as { error: { data: unknown } }).error.data,
        );
        expect(data).toEqual({ content: 'v2 body', version: 2 });
        expect(isVersionConflictErrorData((stale.json() as { error: { data: unknown } }).error.data)).toBe(
          true,
        );

        // The current tag: the same request shape, now legal.
        const third = await put(app, owner, { id: note.id, content: 'v3 body', baseVersion: 2 }, 'W/"v2"');
        expect(third.statusCode, third.body).toBe(200);
        expect(noteWithContentSchema.parse(third.json()).version).toBe(3);
      },
      { db },
    );
  });

  it('refuses a header that names a different version than the body does, and writes nothing', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'contradiction', content: 'server body' },
        });
        const note = noteWithContentSchema.parse(created.json());

        // `baseVersion: 1` matches the row, so the conditional statement would have written. The precondition says
        // otherwise — "apply this only to the state I read", and the state it read is version 9, which this note
        // has never been — so nothing is written and the answer is the conflict the request is describing.
        const refused = await put(
          app,
          owner,
          { id: note.id, content: 'written anyway?', baseVersion: 1 },
          'W/"v9"',
        );
        expect(refused.statusCode, refused.body).toBe(409);
        expect(
          versionConflictErrorDataSchema.parse((refused.json() as { error: { data: unknown } }).error.data),
        ).toEqual({ content: 'server body', version: 1 });

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(read.json())).toMatchObject({
          version: 1,
          content: 'server body',
        });
      },
      { db },
    );
  });

  it('answers 404 — never 409 — for a note that is missing or somebody else', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'private', content: 'the owner text' },
        });
        const note = noteWithContentSchema.parse(created.json());
        const missing = '00000000-0000-4000-8000-000000000000';

        // The member's `baseVersion` is a guess, and a wrong one would be a conflict if the row were hers. It is
        // not, so the answer is the same 404 she would get for a uuid nobody ever minted — the conditional update
        // filtered on `user_id` too, and the scoped re-read is what tells these two apart (§4 of the brief).
        const stolen = await put(app, member, { id: note.id, content: 'not yours', baseVersion: 1 });
        const notFound = await put(app, member, { id: missing, content: 'nobody', baseVersion: 1 });
        expect(stolen.statusCode).toBe(404);
        expect(notFound.statusCode).toBe(404);
        expect(envelopeOf(stolen)).toEqual(envelopeOf(notFound));
        expect(stolen.body).not.toContain('VERSION_CONFLICT');
        expect(stolen.body).not.toContain('the owner text');

        // The owner, on a row that does not exist: 404, and `409` would have been the leak.
        const ownMissing = await put(app, owner, { id: missing, content: 'nobody', baseVersion: 7 });
        expect(ownMissing.statusCode).toBe(404);

        // Nothing was written anywhere near the owner's note.
        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(read.json())).toMatchObject({
          version: 1,
          content: 'the owner text',
        });
      },
      { db },
    );
  });

  it('refuses a body over the cap with 413, and accepts one that fits just under it', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'cap', content: 'small' },
        });
        const note = noteWithContentSchema.parse(created.json());

        // One byte past `MAX_NOTE_BYTES` of text: Fastify's app-level `bodyLimit` answers this before the handler
        // runs, which is the door §5 names, and `mapError()` gives the `413` its own code rather than
        // `VALIDATION`. Nothing was written, so the note is still on version 1.
        const over = await put(app, owner, {
          id: note.id,
          content: 'x'.repeat(NOTE_CONTENT_MAX_BYTES + 1),
          baseVersion: 1,
        });
        expect(over.statusCode).toBe(413);
        expect(envelopeOf(over).code).toBe('PAYLOAD_TOO_LARGE');
        const afterRefusal = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(afterRefusal.json())).toMatchObject({
          version: 1,
          content: 'small',
        });

        // The same request a few KiB lighter is legal, and it has to be: the cap is a limit, not a fence, and a
        // client that measured its buffer against `NOTE_CONTENT_MAX_BYTES` (as `apps/web` does, warning at 900 KiB
        // first) must not be refused for the length of its JSON braces. `contentBytes` is the proof the whole body
        // arrived, un-truncated.
        const fits = 'x'.repeat(NOTE_CONTENT_MAX_BYTES - 4096);
        const under = await put(app, owner, { id: note.id, content: fits, baseVersion: 1 });
        expect(under.statusCode, under.body).toBe(200);
        const written = noteWithContentSchema.parse(under.json());
        expect(written.contentBytes).toBe(fits.length);
        expect(written.content).toBe(fits);
      },
      { db },
    );
  });

  it('refuses a baseVersion the version column cannot hold, before it reaches SQL', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'bounded', content: 'small body' },
        });
        const note = noteWithContentSchema.parse(created.json());

        // `baseVersion` is compared against `notes.version`, which is an `int4`. A body naming a version past that
        // ceiling is not a stale state — no note has ever been at 3_000_000_000 — it is a field outside the range
        // the contract describes, and `noteVersionSchema` used to say only `min(1)`. Handed to Postgres it raises
        // `22003` (value out of range for integer), which `mapError()` deliberately has no case for, so the answer
        // was `500 INTERNAL`: a number nobody can store becoming the server's emergency, in a body the client
        // wrote. `400 VALIDATION` naming the field is the same door `If-Match` was bounded to in review, one
        // number and one code away.
        for (const baseVersion of [2_147_483_648, 3_000_000_000, 99_999_999_999]) {
          const refused = await put(app, owner, { id: note.id, content: 'x', baseVersion });
          expect(refused.statusCode, refused.body).toBe(400);
          expect(refused.json()).toMatchObject({
            error: { code: 'VALIDATION', details: [{ path: 'baseVersion' }] },
          });
        }

        // Refused without touching the row: `version` is still 1, and the top of the legal range is still writable
        // in principle (`baseVersion: 1` matches, which the tests above this one prove).
        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(read.json())).toMatchObject({
          version: 1,
          content: 'small body',
        });
      },
      { db },
    );
  });

  it('lets exactly one of two clients on the same version win, and tells the loser the server state', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'two-tabs', content: 'shared starting point' },
        });
        const note = noteWithContentSchema.parse(created.json());

        // Two tabs, one version, sent at the same moment. The conditional update is the arbiter: the second writer
        // waits on the row lock, then re-reads `version` under READ COMMITTED, finds `2`, matches nothing, and is
        // the one that gets the conflict. `Promise.all` is the whole test — a sequential pair would prove the
        // conflict and miss the race.
        const [first, second] = await Promise.all([
          put(app, owner, { id: note.id, content: 'tab A won', baseVersion: 1 }),
          put(app, owner, { id: note.id, content: 'tab B lost', baseVersion: 1 }),
        ]);
        const statuses = [first.statusCode, second.statusCode].sort();
        expect(statuses).toEqual([200, 409]);

        const winner = first.statusCode === 200 ? first : second;
        const loser = first.statusCode === 200 ? second : first;
        const won = noteWithContentSchema.parse(winner.json());
        // Exactly one increment: the loser's write did not happen *and* did not half-happen, so the note is on
        // version 2 with the winner's whole body, not on 3 and not on 2 with a mixture.
        expect(won.version).toBe(2);
        expect(headerOf(winner, 'etag')).toBe('W/"v2"');

        expect(loser.statusCode).toBe(409);
        const loserBody = loser.json() as { error: { code: string; data: unknown } };
        expect(loserBody.error.code).toBe('VERSION_CONFLICT');
        // Both fields, pinned: the content is what the loser compares against the snapshot it sent, and the
        // version is what it adopts if that comparison comes out equal. A 409 without them would be a dead end
        // that can only be escaped by re-fetching a note the client just failed to save.
        expect(versionConflictErrorDataSchema.parse(loserBody.error.data)).toEqual({
          content: won.content,
          version: 2,
        });

        const read = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        const settled = noteWithContentSchema.parse(read.json());
        expect(settled.version).toBe(2);
        expect(settled.content).toBe(won.content);
        expect(settled.contentBytes).toBe(won.contentBytes);
        expect(settled.wordCount).toBe(won.wordCount);
      },
      { db },
    );
  });
});
describe('PATCH and DELETE /api/notes/:id (§9.2 #19, #20)', () => {
  it('renames and moves, answering the metadata shape with no content key', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const folder = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(owner),
          payload: { name: 'somewhere' },
        });
        expect(folder.statusCode, folder.body).toBe(201);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'float', content: 'a body nobody asked to send' },
        });
        const note = noteWithContentSchema.parse(created.json());
        expect(note.folderId).toBeNull();

        const moved = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
          payload: { name: 'Moved.md', folderId: folderNodeSchema.parse(folder.json()).id },
        });
        expect(moved.statusCode, moved.body).toBe(200);
        const node = noteNodeSchema.parse(moved.json());
        expect([node.name, node.folderId, node.version]).toEqual([
          'Moved',
          folderNodeSchema.parse(folder.json()).id,
          1,
        ]);
        expect(moved.body).not.toContain('a body nobody asked to send');
        expect(moved.body).not.toContain('"content"');

        // And back to the root, because `folderId: null` is the contract's only way to say it.
        const back = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
          payload: { folderId: null },
        });
        expect(noteNodeSchema.parse(back.json()).folderId).toBeNull();
      },
      { db },
    );
  });

  it('judges a rename-and-move by the destination, and names the winner when it collides there', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const makeFolder = async (name: string) => {
          const response = await app.inject({
            method: 'POST',
            url: ROUTES.folders,
            headers: jarHeaders(owner),
            payload: { name },
          });
          expect(response.statusCode, response.body).toBe(201);
          return folderNodeSchema.parse(response.json()).id;
        };
        const makeNote = async (payload: Record<string, unknown>) => {
          const response = await app.inject({
            method: 'POST',
            url: ROUTES.notes,
            headers: jarHeaders(owner),
            payload,
          });
          expect(response.statusCode, response.body).toBe(201);
          return noteWithContentSchema.parse(response.json());
        };
        const from = await makeFolder('inbox');
        const to = await makeFolder('archive');
        // `minutes` is taken in the folder the note is leaving and free in the one it is going to. Renaming
        // before moving answered this request with a 409 for that clash — in the wrong folder — and the re-read
        // that looks for the winner found nothing in the right one.
        await makeNote({ name: 'minutes', folderId: from });
        const moving = await makeNote({ name: 'summary', folderId: from });

        const patched = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(moving.id),
          headers: jarHeaders(owner),
          payload: { name: 'minutes.md', folderId: to },
        });
        expect(patched.statusCode, patched.body).toBe(200);
        expect(noteNodeSchema.parse(patched.json())).toMatchObject({
          id: moving.id,
          name: 'minutes',
          folderId: to,
          version: 1,
        });

        // The same request shape the other way round is a real collision, and `data.id` — the row that won — is
        // the whole recovery. Refused, so nothing happened: neither the move nor the rename.
        const third = await makeNote({ name: 'outline', folderId: from });
        const clash = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(third.id),
          headers: jarHeaders(owner),
          payload: { name: 'minutes', folderId: to },
        });
        expect(clash.statusCode, clash.body).toBe(409);
        expect(clash.json()).toMatchObject({ error: { code: 'CONFLICT', data: { id: moving.id } } });

        const stillThere = await app.inject({
          method: 'GET',
          url: ROUTES.note(third.id),
          headers: jarHeaders(owner),
        });
        expect(noteWithContentSchema.parse(stillThere.json())).toMatchObject({
          name: 'outline',
          folderId: from,
          version: 1,
        });
      },
      { db },
    );
  });

  it('deletes with 204 and no body, and the row is gone for both readers', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'temporary' },
        });
        const note = noteWithContentSchema.parse(created.json());

        const removed = await app.inject({
          method: 'DELETE',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(removed.statusCode).toBe(204);
        expect(removed.body).toBe('');

        const rows = await catalogRows(sql`select count(*)::int as n from notes where id = ${note.id}`);
        expect(rows[0]?.n).toBe(0);
        const again = await app.inject({
          method: 'GET',
          url: ROUTES.note(note.id),
          headers: jarHeaders(owner),
        });
        expect(again.statusCode).toBe(404);
      },
      { db },
    );
  });

  it('refuses every note route without a session', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        // The mutations carry a live CSRF pair (which `GET /api/auth/status` hands to anybody) so that the answer
        // under test is the session guard's `401` and not the CSRF hook's `403`, which it would answer first —
        // the ordering is PR-07's and the last request below pins it. The `GET` needs no pair: only mutations
        // are checked.
        const anonymous = await signedOutCsrfHeaders(app);
        const missing = '00000000-0000-4000-8000-000000000000';
        const attempts = await Promise.all([
          app.inject({ method: 'POST', url: ROUTES.notes, headers: anonymous, payload: {} }),
          app.inject({ method: 'GET', url: ROUTES.note(missing) }),
          app.inject({
            method: 'PATCH',
            url: ROUTES.note(missing),
            headers: anonymous,
            payload: { name: 'whoever' },
          }),
          app.inject({ method: 'DELETE', url: ROUTES.note(missing), headers: anonymous }),
          app.inject({
            method: 'PUT',
            url: ROUTES.noteContent(missing),
            headers: anonymous,
            payload: { content: 'whoever', baseVersion: 1 },
          }),
        ]);
        for (const response of attempts) {
          expect(response.statusCode).toBe(401);
          expect(envelopeOf(response).code).toBe('UNAUTHORIZED');
        }

        // …and without the token half, the same anonymous request is refused earlier and differently: `403`, never
        // `401`, because a missing `X-CSRF-Token` says nothing about whether the caller is signed in. A client
        // that has been signed out therefore sees `403` on its first mutation and refreshes its pair — which is
        // what `apps/web/src/lib/api.ts`'s one-shot recovery is for.
        const noToken = await app.inject({
          method: 'PUT',
          url: ROUTES.noteContent(missing),
          payload: { content: 'whoever', baseVersion: 1 },
        });
        expect(noToken.statusCode).toBe(403);
        expect(envelopeOf(noToken).code).toBe('FORBIDDEN');
      },
      { db },
    );
  });
});

/**
 * The `If-Match` shapes §5 promises, which are the half of PR-10 a client can get wrong in a way that looks
 * like success: this API has no `412` member, so a header that names no state at all is answered by the same
 * `VERSION_CONFLICT` the database would have produced, and never by the write.
 *
 * `ifMatchAdmits()` is asserted directly as well as through the wire because the two are different questions:
 * the wire says what a browser gets, and the pure function owns the rules the wire cannot reach — a repeated
 * header arriving as `string[]`, and the `MAX_NOTE_VERSION` ceiling the header and the body half of one request
 * share (a tag naming `2147483648` names nothing, so it cannot quietly agree with a body asking for the same
 * unreachable number).
 */
describe('If-Match on PUT /api/notes/:id/content (PR-10 §5)', () => {
  /** A note at version 1, in a folder of its own, owned by a fresh owner. */
  async function noteAtV1(app: FastifyInstance): Promise<{ jar: Jar; id: string }> {
    const owner = await bootstrapOwner(app);
    const created = await app.inject({
      method: 'POST',
      url: ROUTES.notes,
      headers: jarHeaders(owner),
      payload: { name: 'header-shapes', content: 'v1 body' },
    });
    return { jar: owner, id: noteWithContentSchema.parse(created.json()).id };
  }

  it('takes `*` and a list that names the base version, and refuses every shape that names none', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const { jar, id } = await noteAtV1(app);

        // `*` — "apply this to whatever is there" (RFC 9110), which is what a client that read the note through a
        // proxy it does not trust uses. Existence is not the header's business: a foreign id 404s either way.
        const wildcard = await put(app, jar, { id, content: 'v2 body', baseVersion: 1 }, '*');
        expect(wildcard.statusCode, wildcard.body).toBe(200);
        expect(headerOf(wildcard, 'etag')).toBe('W/"v2"');

        // A list is the set of states the client is willing to overwrite, so `some`, not `every`: `W/"v1"` is
        // stale here and `"v2"` is exactly right, and the request is legal.
        const list = await put(app, jar, { id, content: 'v3 body', baseVersion: 2 }, 'W/"v1", "v2"');
        expect(list.statusCode, list.body).toBe(200);

        // Shapes that name no version: a digest (the shape `ETag` would have with a real validator), a version
        // past the `integer` column, version 0 which no note has ever had, and a header that is not a tag. None
        // of them writes; all of them get the answer with a recovery.
        for (const header of ['"deadbeef"', 'W/"v2147483648"', 'W/"v0"', 'not-a-tag']) {
          const refused = await put(
            app,
            jar,
            { id, content: 'written by a header that names nothing', baseVersion: 3 },
            header,
          );
          expect(refused.statusCode, `${header} → ${refused.body}`).toBe(409);
          expect(refused.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
        }

        // The row is what the last accepted write left there — "refused" is not "wrote and then reported".
        const read = await app.inject({ method: 'GET', url: ROUTES.note(id), headers: jarHeaders(jar) });
        expect(noteWithContentSchema.parse(read.json()).content).toBe('v3 body');
      },
      { db },
    );
  });

  it('reads the header shapes the wire cannot produce, against the same ceiling as the body', () => {
    // A repeated header arrives as an array, and each entry is its own candidate rather than somebody else's
    // comma-separated problem.
    expect(ifMatchAdmits(['W/"v1"', '"v2"'], 2)).toBe(true);
    expect(ifMatchAdmits(['"v1"', '"v3"'], 2)).toBe(false);
    // Absent is not a precondition, and `*` is whitespace-tolerant because HTTP says so.
    expect(ifMatchAdmits(undefined, 7)).toBe(true);
    expect(ifMatchAdmits('  *  ', 7)).toBe(true);
    expect(ifMatchAdmits('', 7)).toBe(false);
    // The ceiling `noteVersionSchema` puts on `baseVersion` is the ceiling on what a tag can name, so the two
    // halves of one request cannot disagree about what the domain is.
    expect(ifMatchAdmits('W/"v2147483648"', 2147483648)).toBe(false);
    expect(ifMatchAdmits('W/"v2147483647"', 2147483647)).toBe(true);
  });
});
