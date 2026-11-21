/**
 * The auth service over a real Postgres (docs/plans/mvp/MVP-07.md §7).
 *
 * `routes/auth.routes.int.test.ts` is the transport's test: cookies, status codes, headers, rows that outlive
 * the session that should have deleted them. This file is for the one promise in this service that **has no
 * route-reachable failure**, which is the atomicity of `changePassword` (`POST /api/auth/password`, plan §9.2 #9,
 * and the sentence `docs/API.md` row 9 spends on "one transaction"). The state that makes its last statement
 * fail — the acting session vanishing between the guard reading the cookie and the service writing the new
 * hash — is not something an HTTP client can arrange, so the service is called directly here, with the real
 * repositories against the real database.
 *
 * Two things are asserted and both are load-bearing. **Nothing is left behind**: the new hash was written, the
 * other sessions were deleted, and both have to be gone. **The failure arrives as the service's own error**: the
 * transaction wrapper must rethrow the caller's exception rather than swallow it or wrap it in a driver error,
 * because a `500` from this endpoint is the same broken contract as a half-applied change — a wrapper that
 * mangled the exception would pass the first assertion and still leave the route answering the wrong code.
 *
 * The argon2 parameters here are the cheapest the module accepts, deliberately: this is a test about a
 * transaction, and paying 64 MiB and half a second per hash would be an honest way to hide a broken assertion
 * behind a slow suite. The parameters the plan pins are exercised end-to-end through the routes.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArgon2Hasher } from '../auth/passwords.js';
import { hashToken, newToken, sessionExpiresAt } from '../auth/tokens.js';
import { issueSession } from '../db/repositories/sessions.repo.js';
import { insertUserWithSettings, userByUsername } from '../db/repositories/users.repo.js';
import { UnauthorizedError } from '../domain/errors.js';
import { createRateLimiter } from '../http/rate-limit.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';

import { createAuthService } from './auth.service.js';

const OLD_PASSWORD = 'the-old-secret-of-the-account';
const NEW_PASSWORD = 'the-new-secret-of-the-account';

const passwords = createArgon2Hasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 });

/** The service, with no Fastify and no env in front of it: `buildApp()` wires the same four dependencies. */
function service() {
  return createAuthService({
    db: testDb(),
    passwords,
    rateLimiter: createRateLimiter({ max: 10 }),
    allowRegistration: false,
    sessionTtlDays: 30,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('changePassword (§9.2 #9) when its last statement fails', () => {
  it('leaves neither the new password nor a deleted session behind', async () => {
    const db = testDb();
    const user = await insertUserWithSettings(db, {
      username: 'owner',
      passwordHash: await passwords.hash(OLD_PASSWORD),
      role: 'owner',
    });

    // A second device exists, and it is the one the endpoint is supposed to end. The acting cookie, though, is
    // one that was never issued — which is the only way to make the *third* statement fail, because
    // `rotateSessionToken` then matches no row and the service refuses. Everything the transaction had already
    // written has to leave with it.
    const otherDevice = newToken();
    await issueSession(db, {
      userId: user.id,
      tokenHash: hashToken(otherDevice),
      expiresAt: sessionExpiresAt(30),
      userAgent: 'the device that must survive',
    });

    await expect(
      service().changePassword({
        user,
        actingTokenHash: hashToken(newToken()),
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Byte for byte, not "the old password still verifies": the update happened inside the transaction, and this
    // is the assertion that fails if it ever commits.
    const after = await userByUsername(db, 'owner');
    expect(after?.passwordHash).toBe(user.passwordHash);
    expect(await passwords.verify(String(after?.passwordHash), NEW_PASSWORD)).toBe(false);

    // …and the sweep that already ran is undone. Without the transaction this count is zero, which is the state a
    // caller who got a `500` would have no idea they were in: the old password works, and their other devices
    // are signed out for a change that did not happen.
    expect(await catalogRows(sql`select count(*)::int as n from sessions`)).toEqual([{ n: 1 }]);
  });
});
