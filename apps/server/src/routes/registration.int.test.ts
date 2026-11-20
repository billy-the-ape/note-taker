/**
 * The two doors into a `member` account, and who is allowed to walk through them (§4 of the brief, plan §9.2 #4,
 * #10, #11).
 *
 * `POST /api/auth/register` and `POST /api/users` are the only routes in the API that create a user, and both are
 * about *who may create one* rather than about the row: `register` is gated by the operator's
 * `ALLOW_REGISTRATION` **and** by the existence of an owner, and `POST /api/users` is gated by the caller's role.
 * The interesting assertions are therefore the ones where a request is refused and the database proves it stayed
 * refused — a `403` that created a row would still look fine in the response body.
 *
 * `ALLOW_REGISTRATION` defaults to `false`, and each case below names the configuration it needs rather than
 * inheriting whatever the previous test left behind; `withApp`'s `env` override exists for exactly this.
 */
import { ROUTES, usersResponseSchema } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { jarAfter, jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';

const PASSWORD = 'correct-horse-battery';
const MEMBER_PASSWORD = 'a-members-own-secret';

/** The `username → role` of every account, oldest first — read from the table, not from a response. */
async function roles(): Promise<{ username: string; role: string }[]> {
  const rows = await catalogRows(sql`select username, role from users order by created_at, username`);
  return rows.map((row) => ({ username: String(row.username), role: String(row.role) }));
}

/**
 * The one `settings` row §6 of the brief makes every account-creating path responsible for, read back as the
 * schema's own defaults rather than as a count.
 */
async function settingsRow(userId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await catalogRows(
    sql`select autosave, theme, user_id from settings where user_id = ${userId}::uuid`,
  );
  return rows[0];
}

/** Signs the owner in and hands back the jar plus the app, because most cases below need both. */
async function ownerJar(app: FastifyInstance) {
  const setup = await app.inject({
    method: 'POST',
    url: ROUTES.auth.setup,
    payload: { username: 'owner', password: PASSWORD },
  });
  expect(setup.statusCode, setup.body).toBe(200);
  return jarAfter(setup);
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/auth/register (§9.2 #4)', () => {
  const register = (app: FastifyInstance, username: string, password = MEMBER_PASSWORD) =>
    app.inject({ method: 'POST', url: ROUTES.auth.register, payload: { username, password } });

  it('is closed by default, and the status route says so before anyone tries', async () => {
    await withApp(
      async (app) => {
        await ownerJar(app);

        const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        expect(status.json()).toEqual({ needsSetup: false, registrationOpen: false });

        const refused = await register(app, 'colleague');
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        // The refusal is the whole story: the account name was never heard of, and nothing was written.
        expect(await roles()).toEqual([{ username: 'owner', role: 'owner' }]);
        expect(await catalogRows(sql`select count(*)::int as n from auth_attempts`)).toEqual([{ n: 0 }]);
      },
      { db: testDb() },
    );
  });

  it('refuses to bootstrap: with the flag on but no owner, only setup may create the first account', async () => {
    await withApp(
      async (app) => {
        // The plan §9.2 #4 rule the flag alone would forget: registration open on a fresh install is a way for
        // whoever reaches the instance first to name themselves owner by accident. `register` cannot create an
        // owner (the role is not writable there), but it would still leave a member on an unclaimed install.
        const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        expect(status.json()).toEqual({ needsSetup: true, registrationOpen: true });

        const refused = await register(app, 'first-visitor');
        expect(refused.statusCode).toBe(403);
        expect(await catalogRows(sql`select count(*)::int as n from users`)).toEqual([{ n: 0 }]);
      },
      { db: testDb(), env: { ALLOW_REGISTRATION: 'true' } },
    );
  });

  it('creates a signed-in member, its settings row and one audit row when the flag is on', async () => {
    await withApp(
      async (app) => {
        const owner = await ownerJar(app);

        const created = await register(app, 'colleague');
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({
          user: { username: 'colleague', role: 'member', displayName: null },
        });
        // Signed in, not merely created: the two cookies arrive on the same response that mints the session, or
        // the new member could not make a single mutation afterwards.
        const jar = jarAfter(created);
        expect(jar.session).toBeTruthy();
        expect(jar.csrf).toBeTruthy();

        // …and the row that `insertUserWithSettings` writes in the same transaction as the user.
        expect(await roles()).toEqual([
          { username: 'owner', role: 'owner' },
          { username: 'colleague', role: 'member' },
        ]);
        expect(await catalogRows(sql`select count(*)::int as n from settings`)).toEqual([{ n: 2 }]);
        // …and what the new row says. `settings.user_id` is the primary key, there is no trigger, and PR-09's
        // `GET /api/settings` get-or-creates, so a create path that forgot the insert would stay invisible until
        // PR-16's autosave `PATCH` matched zero rows. §7 of the brief names this criterion for a reason.
        const colleagueId = String(created.json().user.id);
        expect(await settingsRow(colleagueId)).toMatchObject({
          autosave: true,
          theme: 'system',
          user_id: colleagueId,
        });

        expect(
          await catalogRows(
            sql`select user_key, succeeded from auth_attempts where user_key = 'colleague' order by at`,
          ),
        ).toEqual([{ user_key: 'colleague', succeeded: true }]);

        // The new member can sign in, and is not an owner: `POST /api/users` is the route that would tell.
        const login = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'Colleague', password: MEMBER_PASSWORD },
        });
        expect(login.statusCode).toBe(200);
        const memberJar = jarAfter(login);
        const asOwner = await app.inject({
          method: 'POST',
          url: ROUTES.users,
          headers: jarHeaders(memberJar),
          payload: { username: 'a-third-person', password: PASSWORD },
        });
        expect(asOwner.statusCode).toBe(403);
        expect(asOwner.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

        // The owner still is: `GET /api/users` is the minimal admin surface of the plan, oldest first.
        const list = await app.inject({ method: 'GET', url: ROUTES.users, headers: jarHeaders(owner) });
        expect(list.statusCode).toBe(200);
        expect(() => usersResponseSchema.parse(list.json())).not.toThrow();
        expect(list.json().users.map((user: { username: string }) => user.username)).toEqual([
          'owner',
          'colleague',
        ]);
      },
      { db: testDb(), env: { ALLOW_REGISTRATION: 'true' } },
    );
  });

  it('answers 409 for a username that is taken, whatever case it was typed in', async () => {
    await withApp(
      async (app) => {
        await ownerJar(app);
        const first = await register(app, 'colleague');
        expect(first.statusCode).toBe(201);

        // `users_username_lower_uidx` is what refuses, and `users.repo.ts` is what turns it into a `ConflictError`
        // rather than a `500` about an index name.
        for (const username of ['colleague', 'COLLEAGUE', 'Colleague']) {
          const again = await register(app, username);
          expect(again.statusCode, username).toBe(409);
          expect(again.json()).toMatchObject({ error: { code: 'CONFLICT' } });
        }
        expect(await catalogRows(sql`select count(*)::int as n from users`)).toEqual([{ n: 2 }]);
        expect(await catalogRows(sql`select count(*)::int as n from settings`)).toEqual([{ n: 2 }]);
      },
      { db: testDb(), env: { ALLOW_REGISTRATION: 'true' } },
    );
  });
});

describe('POST /api/users and GET /api/users (§9.2 #10, #11)', () => {
  it('need an owner: a stranger gets 401, a member gets 403, and neither creates a row', async () => {
    await withApp(
      async (app) => {
        const owner = await ownerJar(app);
        const member = await createMemberThroughOwner(app, owner);

        // No cookies at all: `auth-guard.ts` answers this before the route runs, and its answer is 401 rather
        // than the 403 a member gets below.
        const stranger = await app.inject({ method: 'GET', url: ROUTES.users });
        expect(stranger.statusCode).toBe(401);

        const forbidden = await app.inject({
          method: 'GET',
          url: ROUTES.users,
          headers: jarHeaders(member),
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

        const created = await app.inject({
          method: 'POST',
          url: ROUTES.users,
          headers: jarHeaders(member),
          payload: { username: 'someone-else', password: PASSWORD },
        });
        expect(created.statusCode).toBe(403);
        // 401 and 403 are different sentences on purpose: the first means "we have no idea who you are", which
        // `auth-guard.ts` answers before a route runs, and the second means "you are known and not allowed",
        // which is `guard.requireOwner`. Merging them would make a member wonder whether they were signed in.
        expect(await catalogRows(sql`select count(*)::int as n from users`)).toEqual([{ n: 2 }]);
      },
      { db: testDb() },
    );
  });

  it('creates a member without a session, and ignores a role a client tried to send', async () => {
    await withApp(
      async (app) => {
        const owner = await ownerJar(app);

        const created = await app.inject({
          method: 'POST',
          url: ROUTES.users,
          headers: jarHeaders(owner),
          // The body also carries `role` and `displayName`, neither of which `createUserSchema` has a field for:
          // Fastify's validator strips unknown keys rather than refusing them, so the question is what the row
          // says, and the answer must be `member` with no display name either way.
          payload: { username: 'someone-else', password: PASSWORD, role: 'owner', displayName: 'The Boss' },
        });
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json()).toMatchObject({
          user: { username: 'someone-else', role: 'member', displayName: null },
        });

        // No cookie: an owner who creates a colleague stays signed in as themselves. A response that set a session
        // for the new user would swap the owner's identity out from under their own browser.
        expect(created.headers['set-cookie']).toBeUndefined();
        expect(await catalogRows(sql`select count(*)::int as n from sessions`)).toEqual([{ n: 1 }]);

        // …but the `settings` row is created all the same: §7 of the brief lists this route third, next to
        // `setup` and `register`, and all three go through the same insert in `users.repo.ts`.
        const createdId = String(created.json().user.id);
        expect(await settingsRow(createdId)).toMatchObject({
          autosave: true,
          theme: 'system',
          user_id: createdId,
        });

        // Exactly one owner, still the one who set the install up.
        expect(await roles()).toEqual([
          { username: 'owner', role: 'owner' },
          { username: 'someone-else', role: 'member' },
        ]);
      },
      { db: testDb() },
    );
  });
});

/** A member created through the owner's route, signed in: the shape almost every case above needs twice. */
async function createMemberThroughOwner(app: FastifyInstance, owner: ReturnType<typeof jarAfter>) {
  const created = await app.inject({
    method: 'POST',
    url: ROUTES.users,
    headers: jarHeaders(owner),
    payload: { username: 'member', password: MEMBER_PASSWORD },
  });
  expect(created.statusCode, created.body).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: ROUTES.auth.login,
    payload: { username: 'member', password: MEMBER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return jarAfter(login);
}
