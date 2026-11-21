/**
 * The auth endpoints over a real Postgres (docs/plans/mvp/MVP-07.md §7).
 *
 * One rule shapes this file: **assert what the wire and the database say, not what the service returned.** The
 * unit tests next door already trust `services/auth.service.ts`; what could still be wrong here is the transport
 * — a cookie attribute, a status code, a header, a row that outlived the session that should have been deleted.
 * Where the brief's acceptance criteria name a thing ("`HttpOnly`, `SameSite=Lax`, `Path=/` on the responses"),
 * the assertion is written against the raw `Set-Cookie` header rather than a parsed jar, for the reason given in
 * `test/helpers/cookies.ts`.
 *
 * Two things are deliberately *not* asserted, because a test process cannot measure them honestly: argon2's
 * wall-clock cost, and whether the "no such user" path takes as long as the "wrong password" path. The first half
 * of the second claim — that both paths run the same hashing work — is structural and described in the service;
 * the byte-identical body below is what a client can actually observe.
 */

import {
  authResponseSchema,
  authStatusResponseSchema,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ROUTES,
  SESSION_COOKIE_NAME,
  sessionResponseSchema,
} from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { attributeSummary, jarAfter, jarHeaders, setCookies } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';

const PASSWORD = 'correct-horse-battery';
const OTHER_PASSWORD = 'a-different-secret';

/** The count of a table the test wants reported, read with a statement no repository owns. */
async function scalarCount(from: string, where = ''): Promise<number> {
  const rows = await catalogRows(sql`select count(*)::int as n from ${sql.raw(from)} ${sql.raw(where)}`);
  const first = rows[0]?.n;
  if (typeof first !== 'number') throw new Error(`no count came back from ${from}`);
  return first;
}

/** Every `Set-Cookie` on a response as `name → the attributes the criteria are phrased against`. */
function cookiesOf(response: {
  headers: Record<string, unknown>;
}): Map<string, Record<string, string | undefined>> {
  return new Map(setCookies(response).map((cookie) => [cookie.name, attributeSummary(cookie)]));
}

/**
 * The one session's `last_seen_at`. Nothing writes it except the guard's throttle (`plugins/auth-guard.ts`), so
 * reading it back is the only way to tell "the column exists" from "the write happens, and not on every request".
 */
async function lastSeenAt(): Promise<Date> {
  const rows = await catalogRows(sql`select last_seen_at from sessions`);
  return new Date(String(rows[0]?.last_seen_at));
}

/**
 * An error body minus the per-request correlation id, so two failed requests can be compared as *answers*.
 *
 * The envelope is `{code, message, details?, data?, requestId}` (plan §9.1); everything but `requestId` is what
 * the client is told, and `requestId` is what PR-05 added so a response can be found in a log again.
 */
function envelopeOf(response: { json(): unknown }): Record<string, unknown> {
  const { error } = response.json() as { error: Record<string, unknown> };
  const { requestId: _requestId, ...envelope } = error;
  return envelope;
}

/**
 * The one `settings` row of one account, as the columns the schema declares.
 *
 * §6 of the brief makes PR-07 responsible for this row — every account-creating path inserts it in the same
 * transaction as the user, and `settings.user_id` is the primary key with no trigger behind it. Reading the two
 * defaults back is the only way to notice a path that skipped the insert, since `GET /api/settings` (PR-09) would
 * otherwise get-or-create the row and hide the hole until PR-16's `PATCH` matched zero rows.
 */
async function settingsRow(userId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await catalogRows(
    sql`select autosave, theme, user_id from settings where user_id = ${userId}::uuid`,
  );
  return rows[0];
}

/** The `Set-Cookie` for `name`, or the only one a clearing response writes. */
function cookieOf(response: { headers: Record<string, unknown> }, name: string) {
  const found = setCookies(response).filter((cookie) => cookie.name === name);
  const last = found.at(-1);
  if (last === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return last;
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/auth/setup and the cookie it mints (§9.2 #3, plan §10)', () => {
  it('walks status → setup → session → logout → session-gone, with the flags on the responses', async () => {
    await withApp(
      async (app) => {
        // 1. The status of a fresh install, which is also the route that hands out the CSRF cookie.
        const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        expect(status.statusCode).toBe(200);
        expect(() => authStatusResponseSchema.parse(status.json())).not.toThrow();
        expect(status.json()).toEqual({ needsSetup: true, registrationOpen: false });
        let jar = jarAfter(status);
        expect(jar.csrf).toBeTruthy();

        // 2. Bootstrap. No `X-CSRF-Token` is possible here: this response is the first one the client has.
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(setup.statusCode).toBe(200);
        expect(() => authResponseSchema.parse(setup.json())).not.toThrow();
        expect(setup.json()).toMatchObject({ user: { username: 'owner', role: 'owner', displayName: null } });
        // `id` is a UUIDv7 and `createdAt` is now, so the DTO is checked for shape rather than value — and the
        // shape is the contract's, not a shape this test invented.
        const ownerId = String(setup.json().user.id);
        expect(ownerId).toMatch(/^[0-9a-f-]{36}$/);
        jar = jarAfter(setup, jar);
        expect(jar.session).toBeTruthy();

        // §6's other half: `setup` is the PR that creates the `settings` row, in the same transaction as the user.
        // Nothing else in the MVP would notice if it were missing — PR-09's `GET /api/settings` get-or-creates.
        expect(await settingsRow(ownerId)).toMatchObject({ autosave: true, theme: 'system' });

        const cookies = cookiesOf(setup);
        // plan §10's "implement exactly", read off the header a browser would have received. `Secure` and
        // `HttpOnly` are valueless attributes, so the helper normalises them to `'true'` / absent.
        expect(cookies.get(SESSION_COOKIE_NAME)).toMatchObject({
          path: '/',
          sameSite: 'Lax',
          httpOnly: 'true',
          maxAge: '2592000',
        });
        expect(cookies.get(SESSION_COOKIE_NAME)?.secure).toBeUndefined(); // `SECURE_COOKIES=false`, the dev default.
        // The CSRF cookie is the one the SPA reads, so it must not be `HttpOnly` — and it lives a day, not a month.
        expect(cookies.get(CSRF_COOKIE_NAME)).toMatchObject({ path: '/', sameSite: 'Lax', maxAge: '86400' });
        expect(cookies.get(CSRF_COOKIE_NAME)?.httpOnly).toBeUndefined();

        // 3. The session this cookie names, resolved from the row rather than from anything in the cookie.
        const whoami = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(jar),
        });
        expect(whoami.statusCode).toBe(200);
        expect(() => sessionResponseSchema.parse(whoami.json())).not.toThrow();
        expect(whoami.json()).toMatchObject({ user: { username: 'owner', role: 'owner' } });
        expect(whoami.json().expiresAt).toBeTruthy();

        // 4. Sign out: `204` with no body, and the row goes with it — the part a cookie cannot fake.
        const logout = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: jarHeaders(jar),
        });
        expect(logout.statusCode).toBe(204);
        expect(logout.body).toBe('');
        expect(attributeSummary(cookieOf(logout, SESSION_COOKIE_NAME)).maxAge).toBe('0');
        expect(await scalarCount('sessions')).toBe(0);

        // 5. The same cookie now answers as a stranger rather than as an error: the SPA calls this on every boot.
        jar = jarAfter(logout, jar);
        const after = await app.inject({ method: 'GET', url: ROUTES.auth.session, headers: jarHeaders(jar) });
        expect(after.statusCode).toBe(200);
        expect(after.json()).toEqual({ user: null });
      },
      { db: testDb() },
    );
  });

  it('answers 409 for a second owner, and for the username that is taken', async () => {
    await withApp(
      async (app) => {
        const first = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(first.statusCode).toBe(200);

        // The same username again, and a different username: both are "this instance already has an owner", and
        // neither is a `500` about a unique index. A taken username is a `CONFLICT` too rather than the `422`
        // an earlier draft of `docs/DATA-MODEL.md` §5 floated: plan §9.1 fixes nine codes, none of which renders
        // as 422, and inventing a tenth here would put it outside the envelope PR-05 pinned.
        for (const username of ['owner', 'someone-else']) {
          const again = await app.inject({
            method: 'POST',
            url: ROUTES.auth.setup,
            payload: { username, password: OTHER_PASSWORD },
          });
          expect(again.statusCode, username).toBe(409);
          expect(again.json()).toMatchObject({ error: { code: 'CONFLICT' } });
        }
        expect(await scalarCount('users', "where role = 'owner'")).toBe(1);
      },
      { db: testDb() },
    );
  });

  it('leaves exactly one owner row when three setups race', async () => {
    await withApp(
      async (app) => {
        // The read-then-insert that `setup` is cannot be made safe by reading first: three requests that all see
        // "no owner" have to be settled by `users_one_owner_uidx`, which is the only reason the index exists.
        const attempts = await Promise.all(
          ['alice', 'bob', 'carol'].map((username) =>
            app.inject({
              method: 'POST',
              url: ROUTES.auth.setup,
              payload: { username, password: PASSWORD },
            }),
          ),
        );
        const created = attempts.filter((response) => response.statusCode === 200);
        const conflicts = attempts.filter((response) => response.statusCode === 409);

        expect(created).toHaveLength(1);
        expect(conflicts).toHaveLength(2);
        expect(await scalarCount('users', "where role = 'owner'")).toBe(1);
        // The two losers wrote nothing at all. The user row, its settings row and the session are one
        // transaction, so a loser cannot leave a `settings` row for a user who was never created — the property
        // `users.repo.ts` documents, checked here from the outside.
        expect(await scalarCount('users')).toBe(1);
        expect(await scalarCount('settings')).toBe(1);
        expect(await scalarCount('sessions')).toBe(1);
      },
      { db: testDb() },
    );
  });
});

describe('POST /api/auth/login (§9.2 #5)', () => {
  const loginAs = (app: FastifyInstance, username: string, password: string, ip = '203.0.113.1') =>
    app.inject({
      method: 'POST',
      url: ROUTES.auth.login,
      payload: { username, password },
      remoteAddress: ip,
    });

  it('signs the owner in with a case-insensitive username and mints a session row', async () => {
    await withApp(
      async (app) => {
        await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD, displayName: 'Olive Owner' },
        });

        const response = await loginAs(app, 'OWNER', PASSWORD);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ user: { username: 'owner', displayName: 'Olive Owner' } });
        expect(await scalarCount('sessions')).toBe(2); // the setup session and this one
        // `password_hash` is a credential and `password_set_at` is an audit fact, so neither is in the body even
        // though the handler read the row that holds both.
        expect(response.body).not.toMatch(/password/i);
      },
      { db: testDb() },
    );
  });

  it('answers the identical 401 for a wrong password and for an account that does not exist', async () => {
    await withApp(
      async (app) => {
        await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });

        const wrongPassword = await loginAs(app, 'owner', 'wrong-password-here');
        const unknownUser = await loginAs(app, 'nobody-here', PASSWORD);

        expect(wrongPassword.statusCode).toBe(401);
        expect(unknownUser.statusCode).toBe(401);
        // Not "both 401 with a message about the same subject" — the same envelope. `requestId` is stripped
        // because PR-05 gives every error its own correlation id, and a test that ignored that would be
        // asserting that two different requests are the same request.
        expect(envelopeOf(unknownUser)).toEqual(envelopeOf(wrongPassword));
        // The literal, not `expect.any(String)`: the whole point is that neither branch has its own sentence, so
        // a later "helpful" message naming the missing account has to break this test to exist.
        expect(envelopeOf(wrongPassword)).toEqual({
          code: 'UNAUTHORIZED',
          message: 'wrong username or password',
        });
        // And neither answer says which half it was: the account name does not appear in the body at all.
        expect(wrongPassword.body).not.toMatch(/owner/i);
        expect(await scalarCount('sessions')).toBe(1);
      },
      { db: testDb() },
    );
  });

  it('refuses the eleventh attempt with 429 and Retry-After, and records every outcome in auth_attempts', async () => {
    await withApp(
      async (app) => {
        await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'Owner', password: PASSWORD },
        });
        await testDb().execute(sql`delete from sessions`);

        // The tenth failure is still a `401`; the *eleventh attempt* is the one that costs a `429` (plan §10:
        // "10 per 15 min"). Each attempt is a fresh failure at a new instant, which is what a sliding window is.
        const failures = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
          failures.push(await loginAs(app, 'Owner', 'not-the-password'));
        }
        expect(failures.map((response) => response.statusCode)).toEqual(new Array(10).fill(401));

        // The correct password, refused: the window does not care what was being guessed, and saying so would
        // turn a lockout into an oracle.
        const blocked = await loginAs(app, 'Owner', PASSWORD);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

        // A `Retry-After` a client can trust: present, a whole number of seconds, inside the window it describes.
        const retryAfter = Number(blocked.headers['retry-after']);
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(15 * 60);
        // …and that is the whole header surface. `RateLimitDecision.remaining` exists in the limiter (and its
        // unit test watches it fall to zero), but plan §9.1 defines the envelope and §10 names `Retry-After`;
        // inventing `X-RateLimit-*` here would put a second, undocumented contract on the endpoint.
        expect(blocked.headers).not.toHaveProperty('x-ratelimit-remaining');

        // The durable half, which the in-memory window is not a substitute for: ten failures and the attempt that
        // the tenth of them refused, keyed by `lower(username)` even though the name was typed capitalised. The
        // `200` from the other address is the success row; eleven login requests arrived, and only these rows
        // exist, because the request the limiter refused never reached the code that writes them.
        // …and the window is `lower(username)`+IP, so the same account from another address is a different
        // window: one victim cannot be locked out of the whole internet, and one mistyping person cannot lock a
        // household out (the reset on success is `auth.service.ts`'s, and it is unit-tested there).
        const elsewhere = await loginAs(app, 'owner', PASSWORD, '198.51.100.9');
        expect(elsewhere.statusCode).toBe(200);

        const rows = await catalogRows(
          sql`select user_key, succeeded, count(*)::int as n from auth_attempts group by 1, 2 order by 1, 2`,
        );
        expect(rows).toEqual([
          { user_key: 'owner', succeeded: false, n: 10 },
          { user_key: 'owner', succeeded: true, n: 1 },
        ]);
      },
      { db: testDb() },
    );
  });

  it('refuses a burst of simultaneous logins instead of verifying them all', async () => {
    await withApp(
      async (app) => {
        await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        await testDb().execute(sql`delete from sessions`);

        // Three guesses dispatched together, none awaited before the next is sent. Under the limiter this endpoint
        // first shipped with — ask whether the window is full, verify, *then* record the failure — all three
        // would have read an empty window on their way in, and the box would have run three argon2 verifications
        // to answer `401` three times. `take` is synchronous, so exactly `max` requests get a slot and the rest
        // are refused **whatever order the first ones finish in**: that is the property, and it does not need ten
        // concurrent 64 MiB verifications to be proven, so `LOGIN_RATE_LIMIT_MAX=2` says the same sentence at a
        // fifth of the cost — and shows the operator's knob being read by the window rather than defaulted.
        const burst = await Promise.all(
          Array.from({ length: 3 }, () => loginAs(app, 'owner', 'not-the-password')),
        );
        const codes = burst.map((response) => response.statusCode);

        expect(codes.filter((code) => code === 401)).toHaveLength(2);
        expect(codes.filter((code) => code === 429)).toHaveLength(1);
        // …and the one refusal is the same `429` the sequential test inspects, header and all: a burst must not
        // be answerable with a bare `429` that leaves the client guessing when to come back.
        const refused = burst.find((response) => response.statusCode === 429);
        expect(String(refused?.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);

        // The durable half agrees with the in-memory one: two attempts reached the code that writes rows, and the
        // refused one wrote nothing — the same rule `registration.int.test.ts` checks from the other side.
        expect(
          await catalogRows(sql`select count(*)::int as n from auth_attempts where not succeeded`),
        ).toEqual([{ n: 2 }]);
      },
      { db: testDb(), env: { LOGIN_RATE_LIMIT_MAX: '2' } },
    );
  });
});

describe('GET /api/auth/session (§9.2 #8)', () => {
  it('answers a stranger with {user:null} and no expiresAt, rather than with a 401', async () => {
    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: ROUTES.auth.session });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ user: null });

        // …and a cookie that is not a session at all is the same answer, not an error about cookies. This is the
        // route's whole job, and a 401 here would put `lib/api.ts`'s unauthorized handler in a loop.
        const forged = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: { cookie: `${SESSION_COOKIE_NAME}=${'x'.repeat(43)}` },
        });
        expect(forged.statusCode).toBe(200);
        expect(forged.json()).toEqual({ user: null });
      },
      { db: testDb() },
    );
  });

  it('drops an expired row on the request that proves it is dead, so it cannot authenticate twice', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const jar = jarAfter(setup);
        expect(await scalarCount('sessions')).toBe(1);

        // A live session first, so the update below can only be doing what it claims to do.
        const live = await app.inject({ method: 'GET', url: ROUTES.auth.session, headers: jarHeaders(jar) });
        expect(live.json()).toMatchObject({ user: { username: 'owner' } });

        // No sleep and no injected clock: the row is moved into the past, which is exactly the state a session
        // reaches by waiting `SESSION_TTL_DAYS`.
        await testDb().execute(sql`update sessions set expires_at = now() - interval '1 second'`);

        const dead = await app.inject({ method: 'GET', url: ROUTES.auth.session, headers: jarHeaders(jar) });
        expect(dead.statusCode).toBe(200);
        expect(dead.json()).toEqual({ user: null });

        // The row is gone rather than merely expired: `sessions` should hold only sessions that can still be
        // used, and a cookie that outlived its session by weeks would otherwise accumulate unnoticed.
        expect(await scalarCount('sessions')).toBe(0);

        // A mutation on the expired cookie is the envelope's 401, not the session route's 200-with-null.
        const mutation = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: jarHeaders(jar),
        });
        expect(mutation.statusCode).toBe(401);
        expect(mutation.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
      },
      { db: testDb() },
    );
  });

  it('moves last_seen_at forward once it is stale, and then leaves it alone', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const jar = jarAfter(setup);

        // Backdated in SQL rather than with a Date parameter, so the row's own clock decides: the guard's
        // threshold is five minutes (`auth-guard.ts`), so ten is the state a laptop that slept over lunch comes
        // back in, and `GET /api/auth/session` is an authenticated request like any other.
        const staleBefore = Date.now() - 10 * 60 * 1000;
        await testDb().execute(sql`update sessions set last_seen_at = now() - interval '10 minutes'`);

        const whoami = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(jar),
        });
        expect(whoami.statusCode).toBe(200);
        const touched = await lastSeenAt();
        expect(touched.getTime()).toBeGreaterThan(staleBefore);

        // …and the write is throttled rather than per-request, which is the other half: an SPA polling its
        // settings page would otherwise make `last_seen_at` the busiest column in the database, and PR-16's
        // device list would be showing a timestamp that changed underneath it.
        const again = await app.inject({ method: 'GET', url: ROUTES.auth.session, headers: jarHeaders(jar) });
        expect(again.statusCode).toBe(200);
        expect(await lastSeenAt()).toEqual(touched);
      },
      { db: testDb() },
    );
  });
});

describe('POST /api/auth/password (§9.2 #9)', () => {
  it('kills the old password, keeps this session alive, and deletes every other one', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const acting = jarAfter(setup);

        // A second device, which is the one the rotation is supposed to end.
        const second = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: PASSWORD },
          remoteAddress: '198.51.100.4',
        });
        const other = jarAfter(second);
        expect(other.session).toBeTruthy();
        expect(other.session).not.toBe(acting.session);
        expect(await scalarCount('sessions')).toBe(2);

        const setAtBefore = await catalogRows(sql`select password_set_at from users limit 1`);

        const rotated = await app.inject({
          method: 'POST',
          url: ROUTES.auth.password,
          headers: jarHeaders(acting),
          payload: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
        });
        expect(rotated.statusCode).toBe(204);
        expect(rotated.body).toBe('');
        // The response carries a *new* cookie value. Every row this user owned was deleted, this one included, so
        // the caller stays signed in only because the reply handed them their replacement (§4 of the brief).
        const rotatedJar = jarAfter(rotated, acting);
        expect(rotatedJar.session).toBeTruthy();
        expect(rotatedJar.session).not.toBe(acting.session);

        // The old password is dead and the new one works.
        const oldPassword = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: PASSWORD },
          remoteAddress: '198.51.100.5',
        });
        expect(oldPassword.statusCode).toBe(401);
        const newPassword = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: OTHER_PASSWORD },
          remoteAddress: '198.51.100.6',
        });
        expect(newPassword.statusCode).toBe(200);

        // The device that asked is still signed in; the other one is not.
        const stillHere = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(rotatedJar),
        });
        expect(stillHere.json()).toMatchObject({ user: { username: 'owner' } });
        const deadDevice = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(other),
        });
        expect(deadDevice.json()).toEqual({ user: null });

        // Two rows, and they are the two that can still authenticate: the rotated one and the proof-login above.
        expect(await scalarCount('sessions')).toBe(2);

        // `password_set_at` moved, which is the only evidence an operator has of when a credential last changed —
        // and the reason the reset script cannot be a bare `UPDATE users SET password_hash = …`.
        const setAtAfter = await catalogRows(sql`select password_set_at from users limit 1`);
        const before = Date.parse(String(setAtBefore[0]?.password_set_at));
        const after = Date.parse(String(setAtAfter[0]?.password_set_at));
        expect(Number.isNaN(before)).toBe(false);
        expect(after).toBeGreaterThan(before);
      },
      { db: testDb() },
    );
  });

  it('refuses the rotation when the current password is wrong, and changes nothing at all', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const jar = jarAfter(setup);

        const refused = await app.inject({
          method: 'POST',
          url: ROUTES.auth.password,
          headers: jarHeaders(jar),
          payload: { currentPassword: 'not-the-current-one', newPassword: OTHER_PASSWORD },
        });
        expect(refused.statusCode).toBe(401);
        // The same `code` as the login route and a different sentence, deliberately: this route is reachable only
        // from an authenticated session, so naming the field that failed cannot tell an attacker anything they
        // did not already have — which is exactly what is not true of `POST /api/auth/login`, where the message
        // above has to stay mute (§5).
        expect(envelopeOf(refused)).toEqual({
          code: 'UNAUTHORIZED',
          message: 'the current password is not right',
        });

        // Still signed in with the old password, and still one session: a failed rotation is not a partial one.
        const session = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(jar),
        });
        expect(session.json()).toMatchObject({ user: { username: 'owner' } });
        expect(await scalarCount('sessions')).toBe(1);
      },
      { db: testDb() },
    );
  });
});

describe('POST /api/auth/logout-all (§9.2 #7)', () => {
  it('ends every session of this user, including the one asking', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const acting = jarAfter(setup);
        await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: PASSWORD },
          remoteAddress: '198.51.100.7',
        });
        expect(await scalarCount('sessions')).toBe(2);

        const everywhere = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logoutAll,
          headers: jarHeaders(acting),
        });
        expect(everywhere.statusCode).toBe(204);
        expect(everywhere.body).toBe('');
        expect(await scalarCount('sessions')).toBe(0);

        const after = await app.inject({
          method: 'GET',
          url: ROUTES.auth.session,
          headers: jarHeaders(acting),
        });
        expect(after.json()).toEqual({ user: null });
      },
      { db: testDb() },
    );
  });
});

describe('the CSRF guard (§9.3, plan §10)', () => {
  it('refuses a mutation whose header was removed, and the one-shot re-issue makes the replay succeed', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const jar = jarAfter(setup);
        expect(jar.csrf).toBeTruthy();

        // The refusal: same cookies, same body, one header missing. `POST /api/auth/logout` is a mutation that
        // exists in this PR (the notes routes are PR-08+), and the point is that it did not happen.
        const { [CSRF_HEADER_NAME.toLowerCase()]: dropped, ...withoutHeader } = jarHeaders(jar);
        expect(dropped).toBeTruthy();
        const refused = await app.inject({ method: 'POST', url: ROUTES.auth.logout, headers: withoutHeader });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        // What the guard must not do is say *which* half failed, or hand back anything it looked at. The message
        // does name the CSRF check itself, and that is fine on reflection: the mechanism is in `docs/API.md`, in
        // the header name the client sends, and in this file — the secret is the token's value, not the rule. The
        // three refusals (missing header, stale token, foreign origin) are then shown to be indistinguishable
        // below, which is the property that actually matters.
        expect(refused.body).not.toContain(String(jar.csrf));
        expect(await scalarCount('sessions')).toBe(1);

        // A stale token is the same sentence, and also not a logout: `403` is one code with one message, and the
        // `401` that a bad *session* answers is a different failure that must not be reachable from here.
        const stale = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: { ...withoutHeader, [CSRF_HEADER_NAME.toLowerCase()]: 'a-stale-token' },
        });
        expect(stale.statusCode).toBe(403);
        // One sentence for both halves of the pair and for a cross-origin request: the message never says which
        // check failed, so a probe cannot tell "you have no token" from "your token is right but your Origin is
        // not" — the second of which would be an oracle for the guard's own rules. (`requestId` aside, since two
        // requests are two requests.)
        expect(envelopeOf(stale)).toEqual(envelopeOf(refused));

        // PR-05's client recovers by refetching the *one* route that mints the cookie and replaying once. That
        // refetch is the "re-issue": a 403 does not carry a cookie of its own, because the refusal happens in
        // `onRequest`, before any route has run to decide what to write.
        const refreshed = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        const replay = jarAfter(refreshed, jar);
        expect(replay.csrf).toBeTruthy();
        expect(replay.csrf).not.toBe(jar.csrf);

        const replayed = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: jarHeaders(replay),
        });
        expect(replayed.statusCode).toBe(204);
        expect(await scalarCount('sessions')).toBe(0);

        // …and the replay is not a coin that can be spent twice: the session is gone, so a third attempt is the
        // caller's `401` rather than a second success.
        const third = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: jarHeaders(replay),
        });
        expect(third.statusCode).toBe(401);
      },
      { db: testDb() },
    );
  });

  it('refuses a cross-origin mutation before it reaches a route, even with a matching token pair', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const jar = jarAfter(setup);

        const refused = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: { ...jarHeaders(jar), origin: 'http://evil.example' },
        });
        expect(refused.statusCode).toBe(403);
        expect(await scalarCount('sessions')).toBe(1);

        // The login-family exemptions are exemptions from the *token* check, not from the origin check: a hostile
        // page cannot use `/api/auth/login` as a relay for someone else's credentials, and cannot use it to
        // discover that the account exists either.
        const crossSiteLogin = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          headers: { origin: 'http://evil.example' },
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(crossSiteLogin.statusCode).toBe(403);
      },
      { db: testDb() },
    );
  });

  it('follows `X-Forwarded-Host` under TRUST_PROXY, and refuses the same pair without it', async () => {
    await withApp(
      async (app) => {
        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(setup.statusCode, setup.body).toBe(200);

        // The pair PR-07's review found: a proxy that rewrote `Host` to the API target while the browser kept its
        // own `Origin`. `POST /api/auth/login` is decided by the origin half alone — exempt from the token check,
        // and needing no cookie — so it is the request that tells the two configurations apart, and the reason
        // `apps/web/vite.config.ts` pins `changeOrigin: false` rather than depending on this flag being set.
        const proxied = { host: '127.0.0.1:3000', origin: 'http://localhost:5173' };
        const credentials = { username: 'owner', password: PASSWORD };

        // Without the flag a rewrite by a proxy this process knows nothing about is indistinguishable from a
        // hostile one, so it stays a `403`: the guard fails closed on evidence it does not trust.
        const refused = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          headers: proxied,
          payload: credentials,
        });
        expect(refused.statusCode).toBe(403);
        // A request the guard refused never reached the route, so it minted nothing: still the one session
        // `/setup` created.
        expect(await scalarCount('sessions')).toBe(1);

        const accepted = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          headers: { ...proxied, 'x-forwarded-host': 'localhost:5173', 'x-forwarded-proto': 'http' },
          payload: credentials,
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(jarAfter(accepted).session).toBeTruthy();

        // The forwarded host names *an* origin; it does not vouch for every `Origin` that turns up. Same headers,
        // hostile page, still `403` — which is the difference between trusting a proxy and trusting the client.
        const hostile = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          headers: {
            'x-forwarded-host': 'localhost:5173',
            'x-forwarded-proto': 'http',
            origin: 'http://evil.example',
          },
          payload: credentials,
        });
        expect(hostile.statusCode).toBe(403);

        // …and both refusals cost nothing: two sessions exist, the one `/setup` minted and the one the accepted
        // login did. A request the guard refused never reached the route that would have minted a third.
        expect(await scalarCount('sessions')).toBe(2);
      },
      { db: testDb(), env: { TRUST_PROXY: 'true' } },
    );
  });
});

describe('the security headers of plan §10', () => {
  it('come from helmet on a GET, with no unsafe-eval and no x-powered-by', async () => {
    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        const csp = String(response.headers['content-security-policy']);
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toMatch(/unsafe-eval/);
        // The one concession, and it is a *style* one: CodeMirror inserts `<style>` elements at runtime.
        expect(csp).toMatch(/style-src[^;]*unsafe-inline/);
        expect(csp).toContain("frame-ancestors 'none'");

        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['x-frame-options']).toBe('DENY');
        // The header whose absence is the point: Fastify adds `x-powered-by` unless it is told not to.
        expect(response.headers['x-powered-by']).toBeUndefined();
      },
      { db: testDb() },
    );
  });

  it('turn `Secure` on with SECURE_COOKIES=true, on both cookies', async () => {
    await withApp(
      async (app) => {
        const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        expect(cookiesOf(status).get(CSRF_COOKIE_NAME)?.secure).toBe('true');

        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        const cookies = cookiesOf(setup);
        expect(cookies.get(SESSION_COOKIE_NAME)).toMatchObject({ secure: 'true', httpOnly: 'true' });
        expect(cookies.get(CSRF_COOKIE_NAME)?.secure).toBe('true');
      },
      { db: testDb(), env: { SECURE_COOKIES: 'true' } },
    );
  });
});

describe('the CSRF cookie is re-issued wherever an identity changes (§5, §7)', () => {
  it('writes note_csrf on status, setup, login, register and logout — a day old each time', async () => {
    await withApp(
      async (app) => {
        // The criterion is a list, so it is asserted as one: §5 says the cookie is "(re-)issued by GET
        // /api/auth/status *and* by every setup/login/register/logout response", and a route that forgot the
        // call would still work for everybody who happened to visit `/status` first.
        const responses: [string, { headers: Record<string, unknown> }][] = [];
        const push = (label: string, response: { headers: Record<string, unknown> }) => {
          responses.push([label, response]);
          return jarAfter(response);
        };

        const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
        let jar = push('GET /status', status);

        const setup = await app.inject({
          method: 'POST',
          url: ROUTES.auth.setup,
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(setup.statusCode, setup.body).toBe(200);
        jar = push('POST /setup', setup);

        const login = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: PASSWORD },
          // The credential routes are exempt from the double-submit check (§4), which is what lets a browser
          // sign in before it has ever held a token to echo.
          headers: jarHeaders(jar),
        });
        expect(login.statusCode, login.body).toBe(200);
        jar = push('POST /login', login);

        const register = await app.inject({
          method: 'POST',
          url: ROUTES.auth.register,
          payload: { username: 'colleague', password: OTHER_PASSWORD },
        });
        expect(register.statusCode, register.body).toBe(201);
        jar = push('POST /register', register);

        // `logout` is a mutation, so this one needs the pair — the cookie it is about to re-issue is the proof
        // that a signed-out browser is left with a usable token rather than a half-cleared one.
        const logout = await app.inject({
          method: 'POST',
          url: ROUTES.auth.logout,
          headers: jarHeaders(jar),
        });
        expect(logout.statusCode, logout.body).toBe(204);
        push('POST /logout', logout);

        const tokens: string[] = [];
        for (const [label, response] of responses) {
          const csrf = attributeSummary(cookieOf(response, CSRF_COOKIE_NAME));
          expect(csrf, `${label} did not re-issue ${CSRF_COOKIE_NAME}`).toMatchObject({
            path: '/',
            sameSite: 'Lax',
            // §5, and shorter than the session on purpose: the cookie is a CSRF pair-tag, not a credential, and
            // a stale one is re-minted by the next status call rather than trusted.
            maxAge: '86400',
          });
          // Not HttpOnly, or the SPA's `readCsrfCookie()` cannot see it and every mutation 403s.
          expect(csrf.httpOnly, `${label} made ${CSRF_COOKIE_NAME} unreadable by the client`).toBeUndefined();
          tokens.push(String(cookieOf(response, CSRF_COOKIE_NAME).value));
        }

        // A new random value each time, or "re-issued" would just mean "sent the same one again" — and the
        // rotation is what keeps a token stolen on one page from being valid for a day across a sign-in.
        expect(new Set(tokens).size).toBe(tokens.length);
        expect(tokens).toHaveLength(5);
      },
      { db: testDb(), env: { ALLOW_REGISTRATION: 'true' } },
    );
  });
});
