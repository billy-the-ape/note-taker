/**
 * `GET /api/tree` on the wire (docs/plans/mvp/MVP-09.md §4 #12, §7).
 *
 * The service test next door already proves the SQL. What could still be wrong here is the transport, and there
 * are exactly three ways it can be:
 *
 * * the guard does not run, so an anonymous request reads somebody's titles;
 * * a serializer sneaks a field in — the criterion is that **no `content` key** appears anywhere in the payload,
 *   which is asserted against the response *text*, because that is what a client parses;
 * * the route leaks another user's rows by ignoring the resolved session and taking a `userId` from the request.
 *
 * The third is the reason every request here is made with a real session cookie: an id the caller does not have is
 * only distinguishable from a missing one if the guard is what scoped the query.
 */
import { ROUTES, treeResponseSchema } from '@note-taker/contracts';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { getKeyring } from '../crypto/keys.js';
import { createFolderService } from '../services/folder.service.js';
import { createNoteService } from '../services/note.service.js';
import { withApp } from '../test/helpers/app.js';
import { jarHeaders } from '../test/helpers/cookies.js';
import { resetDb, testDb } from '../test/helpers/db.js';
import { bootstrapOwner, createMember, whoAmI } from '../test/helpers/session.js';

const db = testDb();
const folders = createFolderService({ db });
const notes = createNoteService({ db, keyring: getKeyring() });

beforeEach(async () => {
  await resetDb();
});

describe('GET /api/tree (§9.2 #12)', () => {
  it('refuses an anonymous request before the tree is read', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const userId = await whoAmI(app, owner);
        const created = await folders.create({ userId, name: 'invisible' });

        const anonymous = await app.inject({ method: 'GET', url: ROUTES.tree });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.body).not.toContain('invisible');

        const mine = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        expect(mine.statusCode, mine.body).toBe(200);
        expect(treeResponseSchema.parse(mine.json()).folders.map((folder) => folder.id)).toEqual([
          created.id,
        ]);
      },
      { db },
    );
  });

  it('serves metadata: two lists, and no content key anywhere in the payload', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const userId = await whoAmI(app, owner);
        const folder = await folders.create({ userId, name: 'notes-folder' });
        const created = await notes.create({
          userId,
          name: 'with-a-body',
          folderId: folder.id,
          content: 'the sentence that must never be on this wire',
        });

        const response = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        expect(response.statusCode, response.body).toBe(200);

        const parsed = treeResponseSchema.parse(response.json());
        expect(parsed.folders.map((node) => node.id)).toEqual([folder.id]);
        expect(parsed.notes.map((node) => node.id)).toEqual([created.id]);
        // The response *text*, because that is what a client parses: `"content"` as a key of a note node is what
        // §7 forbids. `contentBytes`/`contentUpdatedAt` are metadata and stay.
        expect(response.body).not.toContain('"content"');
        expect(response.body).not.toContain('the sentence that must never be on this wire');
      },
      { db },
    );
  });

  it("answers for one user with only that user's rows", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const ownerTree = await folders.create({ userId: await whoAmI(app, owner), name: 'owners-only' });
        const memberTree = await folders.create({ userId: await whoAmI(app, member), name: 'members-only' });

        const asOwner = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        const asMember = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(member) });
        expect(asOwner.statusCode, asOwner.body).toBe(200);
        expect(asMember.statusCode, asMember.body).toBe(200);

        expect(treeResponseSchema.parse(asOwner.json()).folders.map((folder) => folder.id)).toEqual([
          ownerTree.id,
        ]);
        expect(treeResponseSchema.parse(asMember.json()).folders.map((folder) => folder.id)).toEqual([
          memberTree.id,
        ]);
        expect(asOwner.body).not.toContain(memberTree.id);
        expect(asMember.body).not.toContain(ownerTree.id);
      },
      { db },
    );
  });
});
