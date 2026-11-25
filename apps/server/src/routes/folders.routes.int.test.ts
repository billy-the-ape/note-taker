/**
 * The folder routes on the wire (docs/plans/mvp/MVP-09.md §4 #13–#15, §7).
 *
 * The service test owns the recursive walks and the per-user advisory lock. What the transport adds is four things
 * a unit test cannot see:
 *
 * * the **status codes the brief names** — `201`/`200`/`204`, and the two `409`s (a taken sibling name, and a
 *   non-empty folder deleted without `cascade=true`) that a client has to tell apart from a `404`;
 * * the **two different doors that both answer `400 VALIDATION`**: an over-long name is refused by the contract's
 *   schema before a row is touched, while a 101st level is refused by the service mid-transaction with a message
 *   that *names the cap*. One code, because a client renders both with the same form error;
 * * `DELETE`'s query string, which is a transport fact and nothing else: no query means no cascade, and
 *   `folderDeletePath(id, true)` is the only sanctioned way to ask for it;
 * * and that these routes are **not** CSRF-exempt, so a request carrying a session but no `X-CSRF-Token` never
 *   reaches the write.
 */
import {
  apiErrorCodeForStatus,
  folderDeletePath,
  folderNodeSchema,
  NOTE_NAME_MAX,
  ROUTES,
  SESSION_COOKIE_NAME,
  treeResponseSchema,
} from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { cookieHeader, type Jar, jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import {
  bootstrapOwner,
  createMember,
  envelopeOf,
  signedOutCsrfHeaders,
  whoAmI,
} from '../test/helpers/session.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

/** What the caller owns right now, counted outside every repository so a route cannot flatter itself. */
async function ownedBy(app: FastifyInstance, jar: Jar): Promise<{ folders: number; notes: number }> {
  const userId = await whoAmI(app, jar);
  const rows = await catalogRows(
    sql`select (select count(*)::int from folders where user_id = ${userId}) as folders,
               (select count(*)::int from notes where user_id = ${userId}) as notes`,
  );
  return { folders: Number(rows[0]?.folders ?? -1), notes: Number(rows[0]?.notes ?? -1) };
}

/** One `POST /api/folders`, parsed, or a loud failure carrying the body the server actually sent. */
async function createFolder(
  app: FastifyInstance,
  jar: Jar,
  name: string,
  parentId: string | null,
): Promise<{ id: string; parentId: string | null; name: string }> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTES.folders,
    headers: jarHeaders(jar),
    payload: { name, parentId },
  });
  if (response.statusCode !== 201) throw new Error(`POST ${name} → ${response.statusCode}: ${response.body}`);
  return folderNodeSchema.parse(response.json());
}

/** `levels` nested folders, created one request at a time, root-first. */
async function createChain(app: FastifyInstance, jar: Jar, levels: number, prefix = 'lvl') {
  const created: { id: string; parentId: string | null; name: string }[] = [];
  let parentId: string | null = null;
  for (let level = 0; level < levels; level += 1) {
    const folder = await createFolder(app, jar, `${prefix}${String(level).padStart(3, '0')}`, parentId);
    created.push(folder);
    parentId = folder.id;
  }
  return created;
}

/** The single entry a one-item chain produced, or a failure that names the test's own mistake. */
function only<T>(items: readonly T[], what: string): T {
  const first = items[0];
  if (first === undefined) throw new Error(`expected exactly one ${what}`);
  return first;
}

describe('POST /api/folders (§9.2 #13)', () => {
  it('creates at the root and under a parent, reporting parentId both times', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const chain = await createChain(app, owner, 3);
        expect(chain.map((folder) => folder.parentId)).toEqual([null, chain[0]?.id, chain[1]?.id]);
        expect(chain.map((folder) => folder.name)).toEqual(['lvl000', 'lvl001', 'lvl002']);

        const underTop = await createFolder(app, owner, 'under-top', chain[2]?.id ?? null);
        expect(underTop.parentId).toBe(chain[2]?.id);
        expect(await ownedBy(app, owner)).toEqual({ folders: 4, notes: 0 });

        // The tree the client will render from is the one this route wrote.
        const tree = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        expect(tree.statusCode, tree.body).toBe(200);
      },
      { db },
    );
  });

  it("refuses a sibling name with 409 and the winner's id in data", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const first = only(await createChain(app, owner, 1, 'docs'), 'root folder');

        const clash = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(owner),
          payload: { name: 'docs000' },
        });
        expect(clash.statusCode).toBe(409);
        expect(envelopeOf(clash).code).toBe('CONFLICT');
        expect(envelopeOf(clash).data).toEqual({ id: first.id });
        expect(await ownedBy(app, owner)).toEqual({ folders: 1, notes: 0 });

        // The same name under a different parent is not a clash at all, which is what "sibling" is for.
        const elsewhere = await createFolder(app, owner, 'elsewhere', null);
        const underElsewhere = await createFolder(app, owner, 'docs000', elsewhere.id);
        expect(underElsewhere.parentId).toBe(elsewhere.id);
      },
      { db },
    );
  });

  it('refuses a name the contract forbids, as a field error, before anything is inserted', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const response = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(owner),
          payload: { name: 'n'.repeat(NOTE_NAME_MAX + 1) },
        });
        expect(response.statusCode).toBe(400);
        expect(envelopeOf(response).code).toBe('VALIDATION');
        const details = envelopeOf(response).details as { path: string; message: string }[];
        expect(details[0]?.path).toBe('name');
        expect(await ownedBy(app, owner)).toEqual({ folders: 0, notes: 0 });
      },
      { db },
    );
  });

  it('refuses a 101st level with a VALIDATION that names the cap', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const chain = await createChain(app, owner, 100);
        expect(chain).toHaveLength(100);
        const deepest = chain[99];
        if (!deepest) throw new Error('the chain did not reach the cap');

        const refused = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(owner),
          payload: { name: 'one-too-deep', parentId: deepest.id },
        });
        expect(refused.statusCode).toBe(400);
        expect(envelopeOf(refused).code).toBe('VALIDATION');
        // §4 #13: the message names the cap, because `parentId` was otherwise a perfectly well-formed uuid and
        // "too deep" is the only thing the caller can act on.
        expect(String(envelopeOf(refused).message)).toContain('100 levels');
        expect(await ownedBy(app, owner)).toEqual({ folders: 100, notes: 0 });
      },
      { db },
    );
  });

  it("refuses another user's folder as a parent, a mutation without the CSRF header, and one without a session", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const theirs = only(await createChain(app, owner, 1, 'owners'), 'owner folder');

        const intruder = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: jarHeaders(member),
          payload: { name: 'intruder', parentId: theirs.id },
        });
        expect(intruder.statusCode).toBe(404);
        expect(envelopeOf(intruder).code).toBe('NOT_FOUND');

        // Session cookie, no `X-CSRF-Token`: the guard stops a cross-site form before the service sees a write.
        const cookiesOnly = { cookie: cookieHeader({ [SESSION_COOKIE_NAME]: member.session }) ?? '' };
        const noCsrf = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: cookiesOnly,
          payload: { name: 'cross-site' },
        });
        expect(noCsrf.statusCode).toBe(403);
        expect(apiErrorCodeForStatus(noCsrf.statusCode)).toBe('FORBIDDEN');

        // With the token half present, the same anonymous mutation reaches `requireAuth` and answers `401`: the two
        // refusals above and below are different guards, and a test that only ever sent bare anonymous requests
        // would measure the CSRF hook and call the session guard tested.
        const anonymous = await app.inject({
          method: 'POST',
          url: ROUTES.folders,
          headers: await signedOutCsrfHeaders(app),
          payload: { name: 'nobody' },
        });
        expect(anonymous.statusCode).toBe(401);
        expect(envelopeOf(anonymous).code).toBe('UNAUTHORIZED');

        // None of the three wrote anything for the member, and the owner's folder is where it was.
        expect(await ownedBy(app, member)).toEqual({ folders: 0, notes: 0 });
        expect(await ownedBy(app, owner)).toEqual({ folders: 1, notes: 0 });
      },
      { db },
    );
  });
});

describe('PATCH /api/folders/:id (§9.2 #14)', () => {
  it("renames and moves in one request, and refuses a move into the folder's own subtree", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const a = only(await createChain(app, owner, 1, 'A'), 'folder A');
        const b = only(await createChain(app, owner, 1, 'B'), 'folder B');
        const child = await createFolder(app, owner, 'child', a.id);

        const moved = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder(child.id),
          headers: jarHeaders(owner),
          payload: { name: 'renamed', parentId: b.id },
        });
        expect(moved.statusCode, moved.body).toBe(200);
        const node = folderNodeSchema.parse(moved.json());
        expect([node.name, node.parentId]).toEqual(['renamed', b.id]);

        // Now `b` holds `child`, and `a` holds nothing. Pushing `a` under `b`'s old… no: the cycle case is
        // `a` under something inside `a`. `child` left `a`, so move `a` under `b`, then `b` under `a` — the
        // second is the one that would close the loop.
        const aUnderB = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder(a.id),
          headers: jarHeaders(owner),
          payload: { parentId: b.id },
        });
        expect(aUnderB.statusCode, aUnderB.body).toBe(200);
        const closing = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder(b.id),
          headers: jarHeaders(owner),
          payload: { parentId: a.id },
        });
        expect(closing.statusCode).toBe(409);
        expect(String(envelopeOf(closing).message)).toContain('itself');
        // Never a raw Postgres code on the wire, whichever way the refusal was reached.
        expect(closing.body).not.toContain('23505');

        // And the tree is still a tree: `b` at the root, `a` and `child` inside it.
        const after = await app.inject({ method: 'GET', url: ROUTES.tree, headers: jarHeaders(owner) });
        expect(after.statusCode).toBe(200);
        const nodes = treeResponseSchema.parse(after.json()).folders;
        const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
        expect(parentOf).toEqual(
          new Map([
            [b.id, null],
            [a.id, b.id],
            [child.id, b.id],
          ]),
        );
      },
      { db },
    );
  });

  it("refuses a folder that is not the caller's exactly as it refuses one that does not exist", async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const theirs = only(await createChain(app, owner, 1, 'private'), 'owner folder');

        const stolen = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder(theirs.id),
          headers: jarHeaders(member),
          payload: { name: 'mine-now' },
        });
        const missing = await app.inject({
          method: 'PATCH',
          url: ROUTES.folder('00000000-0000-4000-8000-000000000000'),
          headers: jarHeaders(member),
          payload: { name: 'mine-now' },
        });
        expect(stolen.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(envelopeOf(stolen)).toEqual(envelopeOf(missing));
      },
      { db },
    );
  });
});

describe('DELETE /api/folders/:id (§9.2 #15)', () => {
  it('refuses a non-empty folder without cascade, then takes the whole subtree with it', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const top = only(await createChain(app, owner, 1, 'top'), 'root folder');
        const nested = await createFolder(app, owner, 'nested', top.id);
        const note = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'inside-nested', folderId: nested.id },
        });
        expect(note.statusCode, note.body).toBe(201);

        const refused = await app.inject({
          method: 'DELETE',
          url: folderDeletePath(top.id, false),
          headers: jarHeaders(owner),
        });
        expect(refused.statusCode).toBe(409);
        expect(String(envelopeOf(refused).message)).toContain('cascade');
        expect(await ownedBy(app, owner)).toEqual({ folders: 2, notes: 1 });

        const removed = await app.inject({
          method: 'DELETE',
          url: folderDeletePath(top.id, true),
          headers: jarHeaders(owner),
        });
        expect(removed.statusCode).toBe(204);
        expect(removed.body).toBe('');
        // §7: one statement. The note went with the folder it sat in, two levels down, and nothing was orphaned.
        expect(await ownedBy(app, owner)).toEqual({ folders: 0, notes: 0 });
      },
      { db },
    );
  });

  it('deletes an empty folder with 204, and refuses a folder that belongs to someone else', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });
        const theirs = only(await createChain(app, owner, 1, 'theirs'), 'owner folder');

        const stolen = await app.inject({
          method: 'DELETE',
          url: folderDeletePath(theirs.id, true),
          headers: jarHeaders(member),
        });
        expect(stolen.statusCode).toBe(404);
        expect(await ownedBy(app, owner)).toEqual({ folders: 1, notes: 0 });

        const mine = only(await createChain(app, member, 1, 'mine'), 'member folder');
        const removed = await app.inject({
          method: 'DELETE',
          url: folderDeletePath(mine.id, false),
          headers: jarHeaders(member),
        });
        expect(removed.statusCode).toBe(204);
        expect(await ownedBy(app, member)).toEqual({ folders: 0, notes: 0 });
      },
      { db },
    );
  });
});
