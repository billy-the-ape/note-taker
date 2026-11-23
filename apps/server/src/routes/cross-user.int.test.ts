/**
 * Two users, four requests, one answer (docs/plans/mvp/MVP-09.md §5.4, §7).
 *
 * Every id that arrives in a **body** — `folderId` on a note, `parentId` on a folder — is looked up scoped to the
 * caller before anything is written, and this file is why that rule exists rather than a nicer-sounding one:
 *
 * * `notes_folder_fk` and `folders_folder_fk` are the only constraints on those columns, and they are *not*
 *   user-aware. A repository that inserted straight away would let user B write a row whose parent belongs to user
 *   A, and Postgres would let it — the FK is satisfied, the row is nonsense, and A's tree now holds a note B owns.
 *   Where the parent id is genuinely unknown the insert dies with `23503`, which is a `500` about the database's
 *   internal state and an existence oracle for other people's uuids.
 * * So the four calls below must all answer `404 NOT_FOUND`, with the same bytes a nonexistent id produces, and
 *   must leave **both** users' trees exactly as they were. The two halves matter together: a 404 that still wrote
 *   the row would be a worse bug than the 500 it replaced.
 *
 * The requests are sent over HTTP rather than against the services because the criterion is about the wire: the
 * envelope, the absence of a Postgres code, and the fact that a tree payload is byte-comparable before and after.
 */
import {
  apiErrorCodeForStatus,
  folderNodeSchema,
  noteSchema,
  ROUTES,
  treeResponseSchema,
} from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { type Jar, jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { bootstrapOwner, createMember, envelopeOf } from '../test/helpers/session.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

/** A folder, created through the route, parsed as the route returns it. */
async function createFolder(app: FastifyInstance, jar: Jar, name: string, parentId: string | null) {
  const response = await app.inject({
    method: 'POST',
    url: ROUTES.folders,
    headers: jarHeaders(jar),
    payload: { name, parentId },
  });
  if (response.statusCode !== 201) throw new Error(`POST ${name} → ${response.statusCode}: ${response.body}`);
  return folderNodeSchema.parse(response.json());
}

/** A note with a body, so a stray write would have content rows to leave behind too. */
async function createNote(app: FastifyInstance, jar: Jar, name: string, folderId: string, content: string) {
  const response = await app.inject({
    method: 'POST',
    url: ROUTES.notes,
    headers: jarHeaders(jar),
    payload: { name, folderId, content },
  });
  if (response.statusCode !== 201) throw new Error(`POST ${name} → ${response.statusCode}: ${response.body}`);
  return response.json() as { id: string };
}

/** The whole tree as one string: the comparison the criterion asks for is byte-for-byte. */
async function treeBody(app: FastifyInstance, jar: Jar): Promise<string> {
  const response = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(jar) });
  expect(response.statusCode, response.body).toBe(200);
  // Parsed on the way through, so a payload that stopped matching the contract fails here rather than passing a
  // string comparison by being equally wrong on both sides.
  treeResponseSchema.parse(response.json());
  return response.body;
}

async function rowCount(table: 'folders' | 'notes'): Promise<number> {
  const rows = await catalogRows(sql.raw(`select count(*)::int as n from ${table}`));
  return Number(rows[0]?.n ?? -1);
}

describe('the cross-user body-id matrix (§5.4)', () => {
  it('answers four different intrusions with one identical 404, and moves nothing', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        // `a` is the install's owner and `b` a member; neither role is relevant to the answer, which is the point.
        const a = await bootstrapOwner(app);
        const b = await createMember(app, a, { username: 'b' });

        // A's subtree is three rows deep, so "A's subtree is byte-identical" has folders, notes and a nesting to lose.
        const aHome = await createFolder(app, a, 'a-home', null);
        const aChild = await createFolder(app, a, 'a-child', aHome.id);
        await createNote(app, a, 'a-note', aChild.id, '# A\n\nthe owner of this note is not you\n');
        const bHome = await createFolder(app, b, 'b-home', null);
        const bNote = await createNote(app, b, 'b-note', bHome.id, '# B\n');

        const aBefore = await treeBody(app, a);
        const bBefore = await treeBody(app, b);
        const before = { folders: await rowCount('folders'), notes: await rowCount('notes') };

        const intrusions = [
          [
            "POST /api/notes with A's folderId",
            { method: 'POST', url: ROUTES.notes, payload: { name: 'sneak', folderId: aHome.id } },
          ],
          [
            "POST /api/folders with A's parentId",
            { method: 'POST', url: ROUTES.folders, payload: { name: 'sneak', parentId: aHome.id } },
          ],
          [
            "PATCH B's folder onto A's",
            { method: 'PATCH', url: ROUTES.folder(bHome.id), payload: { parentId: aHome.id } },
          ],
          [
            "PATCH B's note into A's folder",
            { method: 'PATCH', url: ROUTES.note(bNote.id), payload: { folderId: aHome.id } },
          ],
        ] as const;

        const envelopes: Record<string, unknown>[] = [];
        for (const [what, request] of intrusions) {
          const response = await app.inject({
            method: request.method,
            url: request.url,
            headers: jarHeaders(b),
            payload: request.payload,
          });
          // A 404, not a 403: the id is not B's to know about, and `403` would confirm it exists.
          expect([what, response.statusCode], response.body).toEqual([what, 404]);
          expect(apiErrorCodeForStatus(response.statusCode)).toBe('NOT_FOUND');
          // Never the constraint: `23503` in a body would say "that uuid is real and belongs to someone".
          expect(response.body).not.toContain('23503');
          expect(response.body).not.toContain('violates foreign key');
          envelopes.push(envelopeOf(response));
        }

        // One answer, four ways: every intrusion is refused in exactly the bytes a nonexistent parent would be,
        // so the response cannot be used to ask "does this uuid exist?".
        const missing = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(b),
          payload: { name: 'sneak', parentId: '00000000-0000-4000-8000-000000000000' },
        });
        expect(missing.statusCode).toBe(404);
        expect(envelopes).toEqual([
          envelopeOf(missing),
          envelopeOf(missing),
          envelopeOf(missing),
          envelopeOf(missing),
        ]);

        // Both trees are exactly what they were, byte for byte: nothing was created, nothing re-parented, and no
        // `updatedAt` moved — which is what "the check ran before the write" looks like from outside.
        expect(await treeBody(app, a)).toBe(aBefore);
        expect(await treeBody(app, b)).toBe(bBefore);
        expect({ folders: await rowCount('folders'), notes: await rowCount('notes') }).toEqual(before);

        // And the four refusals are the four the FKs could not have caught: they are all real rows of A's, reached
        // through a body field, with no `:id` in the path at all.
        expect([aHome.id, aChild.id]).not.toContain('00000000-0000-4000-8000-000000000000');
      },
      { db },
    );
  });

  it('lets the same four requests through when the caller owns the ids', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        // The control: the refusals above are about ownership and nothing else, so the identical calls with the
        // caller's own ids must land. A test without this half passes on a server that always answers 404.
        const a = await bootstrapOwner(app);
        const home = await createFolder(app, a, 'home', null);
        const other = await createFolder(app, a, 'other', null);
        const note = await createNote(app, a, 'note', home.id, 'text\n');

        const created = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(a),
          payload: { name: 'second', folderId: home.id, content: 'in a folder I own\n' },
        });
        expect(created.statusCode, created.body).toBe(201);
        expect(noteSchema.parse(created.json()).folderId).toBe(home.id);

        const folder = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(a),
          payload: { name: 'child', parentId: home.id },
        });
        expect(folder.statusCode, folder.body).toBe(201);

        const moved = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder(home.id),
          headers: jarHeaders(a),
          payload: { parentId: other.id },
        });
        expect(moved.statusCode, moved.body).toBe(200);

        const refiled = await app.inject({
          method: 'PATCH',
          url: ROUTES.note(note.id),
          headers: jarHeaders(a),
          payload: { folderId: other.id },
        });
        expect(refiled.statusCode, refiled.body).toBe(200);
        expect(noteSchema.parse(refiled.json()).folderId).toBe(other.id);
      },
      { db },
    );
  });
});
