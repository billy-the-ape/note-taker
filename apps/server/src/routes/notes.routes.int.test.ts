/**
 * The note routes on the wire (docs/plans/mvp/MVP-09.md §4 #16–#17, #19–#20, §7).
 *
 * This is the only place in the API where a plaintext body crosses the HTTP boundary, so the criteria worth
 * hitting are about the response, not the service:
 *
 * * `POST` is `201` and `GET` is `200`, both `NoteWithContent`; `PATCH` is the **metadata** shape, which is
 *   asserted by the absence of a `content` key rather than by a comment saying so.
 * * `GET` carries `ETag: W/"v<version>"` — weak, because the representation is JSON, and carrying the counter
 *   rather than a digest, because the server cannot read the bytes it would have to hash.
 * * a body that fails to authenticate answers `500 INTERNAL` and **not** `200` with `content: ""`. That single
 *   pair is why the read path was placed in this PR: everything else about encryption is invisible from here.
 *
 * The empty-body case is checked on the wire too, because the type system permits `content: undefined` in a
 * created object while the contract requires `content: ""` in a served one.
 */
import {
  apiErrorCodeForStatus,
  folderNodeSchema,
  NOTE_CONTENT_MAX_BYTES,
  noteNodeSchema,
  noteWithContentSchema,
  ROUTES,
} from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { captureLogs } from '../test/helpers/log-capture.js';
import { bootstrapOwner, createMember, envelopeOf } from '../test/helpers/session.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

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
        const attempts = await Promise.all([
          app.inject({ method: 'POST', url: ROUTES.notes, payload: {} }),
          app.inject({ method: 'GET', url: ROUTES.note('00000000-0000-4000-8000-000000000000') }),
          app.inject({
            method: 'PATCH',
            url: ROUTES.note('00000000-0000-4000-8000-000000000000'),
            payload: { name: 'whoever' },
          }),
          app.inject({ method: 'DELETE', url: ROUTES.note('00000000-0000-4000-8000-000000000000') }),
        ]);
        for (const response of attempts) {
          expect(response.statusCode).toBe(401);
          expect(envelopeOf(response).code).toBe('UNAUTHORIZED');
        }
      },
      { db },
    );
  });
});
