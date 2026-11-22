/**
 * The auth service: what the auth routes do, without Fastify (docs/plans/mvp/MVP-07.md §5).
 *
 * Everything the brief splits across five endpoints is here in one place, because they differ only in **which
 * two questions they ask** — may this account exist at all, and does the caller prove it — while the machinery
 * between them is identical: hash with argon2id, insert the user and their settings row atomically
 * (`users.repo.ts`), mint a session whose raw token exists only in the response cookie (`auth/tokens.ts`), and
 * hand the caller a `SessionUser` rather than a `users` row.
 *
 * Four rules are worth stating where the code that enforces them lives:
 *
 * * **The owner guard is a role query, never "is the table empty".** `POST /api/auth/setup` is open while no
 *   `role='owner'` row exists and closed for good after; `POST /api/auth/register` is the mirror image (it
 *   needs the flag *and* an owner). Both then lean on `users_one_owner_uidx` for the race, so the read is a
 *   courtesy: the loser of two concurrent `/setup` calls is stopped by the index and hears "this instance
 *   already has an owner" either way (plan §8).
 * * **A refusal must not say which half failed.** Unknown username and wrong password are the same `401` with
 *   the same message and the same cost (the dummy argon2 verify in `auth/passwords.ts`), so
 *   `POST /api/auth/login` cannot enumerate accounts or measure the password policy — the same reasoning that
 *   makes `loginSchema` permissive in the contract.
 * * **`auth_attempts` records credential outcomes; the sliding window does the blocking.** A login that
 *   succeeded and one that failed both get a durable row, and so does a self-sign-up whose username was taken:
 *   plan §9.2 #4 asks for both halves on `register`, and a taken-username flood is an enumeration of accounts.
 *   A request the limiter refused gets no row on either endpoint: it never checked a credential, and letting a
 *   blocked client write a row per attempt turns a lockout into a way to fill someone's disk. The two `403`s on
 *   `register` are refused for the same reason — `ALLOW_REGISTRATION` is off, or the install has no owner — they
 *   are the instance saying "not here", not an attempt on anything, and an unauthenticated flood would grow the
 *   audit table for free.
 * * **`POST /api/auth/setup` is deliberately not rate-limited** (plan §9.2 #3): there is no credential to guess
 *   before the install exists, and the one-owner index is the thing that actually stops a second attempt.
 */
import type { AuthStatusResponse, SessionUser } from '@note-taker/contracts';

import type { PasswordHasher } from '../auth/passwords.js';
import { hashToken, newToken, sessionExpiresAt } from '../auth/tokens.js';
import type { Db } from '../db/client.js';
import { attemptKey, recordAuthAttempt } from '../db/repositories/auth-attempts.repo.js';
import {
  deleteSessionByTokenHash,
  deleteSessionsOfUser,
  issueSession,
  rotateSessionToken,
} from '../db/repositories/sessions.repo.js';
import {
  createUserWithSettings,
  isUsernameTakenConflict,
  listUsers,
  ownerExists,
  setUserPassword,
  userByUsername,
} from '../db/repositories/users.repo.js';
import type { User } from '../db/schema.js';
import { ConflictError, ForbiddenError, RateLimitedError, UnauthorizedError } from '../domain/errors.js';
import { loginRateLimitKey, type RateLimiter, registerRateLimitKey } from '../http/rate-limit.js';

/** What a request carried with it that a session row records about the device. */
export interface RequestFacts {
  readonly ip: string;
  readonly userAgent: string | null;
}

/** A session this service just minted: the raw token, and how long it lives. */
export interface IssuedSession {
  /** The raw token, which exists in exactly two places — here, and the `Set-Cookie` the route writes. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** A credential check that succeeded and also created a session. */
export interface SignedIn {
  readonly user: SessionUser;
  readonly session: IssuedSession;
}

export interface CreateAccountInput {
  readonly username: string;
  readonly password: string;
  /**
   * `| undefined` and not merely optional: `registerSchema`'s inferred output is exactly this shape under
   * `exactOptionalPropertyTypes`, and the route passes the parsed body straight in — a narrower type here
   * would force every call site to rewrite the key out.
   */
  readonly displayName?: string | undefined;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export interface ChangePasswordInput {
  /** The authenticated caller's row: its `password_hash` is what `currentPassword` is checked against. */
  readonly user: User;
  /** `sha256` of the caller's own cookie, so the rotation replaces one session instead of ending it. */
  readonly actingTokenHash: Uint8Array;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface AuthServiceOptions {
  readonly db: Db;
  readonly passwords: PasswordHasher;
  readonly rateLimiter: RateLimiter;
  /** `ALLOW_REGISTRATION`, read once by `buildApp()` — this file never touches `process.env` (PR-01). */
  readonly allowRegistration: boolean;
  /** `SESSION_TTL_DAYS`, which sets `expires_at` and, through `http/cookies.ts`, the cookie's `Max-Age`. */
  readonly sessionTtlDays: number;
  /** Injectable clock, so a test can hold a session past `expires_at` without waiting 30 days. */
  readonly now?: () => Date;
}

export interface AuthService {
  readonly status: () => Promise<AuthStatusResponse>;
  readonly setup: (input: CreateAccountInput, facts: RequestFacts) => Promise<SignedIn>;
  readonly register: (input: CreateAccountInput, facts: RequestFacts) => Promise<SignedIn>;
  readonly login: (input: LoginInput, facts: RequestFacts) => Promise<SignedIn>;
  readonly changePassword: (input: ChangePasswordInput) => Promise<IssuedSession>;
  /**
   * Drops one session by `sha256(cookie)` — the caller's own, in every route. Not by user id: that is
   * `logoutAll`'s job, and a function that deletes one row should not be handed a key that could mean many.
   */
  readonly logout: (tokenHash: Uint8Array) => Promise<boolean>;
  readonly logoutAll: (userId: string) => Promise<number>;
  readonly createMember: (input: LoginInput) => Promise<SessionUser>;
  readonly listUsers: () => Promise<SessionUser[]>;
}

/**
 * The one place a `users` row becomes a response body.
 *
 * `password_hash` is a credential and `password_set_at` is an audit fact, so neither travels: the DTO has no
 * field for them, which beats every route remembering to delete a key. Timestamps leave as ISO-8601 UTC
 * because that is what `JSON.stringify(new Date())` produces and what `isoDateTimeSchema` accepts.
 */
export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    username: user.username,
    // The column is `text` with a CHECK; the DTO narrows it. A row that escaped the CHECK is a corrupt
    // database, not a value worth inventing a third answer for.
    role: user.role === 'owner' ? 'owner' : 'member',
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Builds the service over one pool, one hasher and one rate-limit window. */
export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, passwords, rateLimiter, allowRegistration, sessionTtlDays } = options;
  const now = options.now ?? (() => new Date());

  /**
   * Mints the session for a user who has just been created or just proved their password.
   *
   * Order matters once: a session row for a user who was not created is a foreign-key error, and a user with
   * no session is the normal answer to "the password was right but this endpoint does not sign you in"
   * (`POST /api/users`).
   */
  async function signIn(user: User, facts: RequestFacts): Promise<SignedIn> {
    const token = newToken();
    const expiresAt = sessionExpiresAt(sessionTtlDays, now());
    await issueSession(db, {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt,
      userAgent: facts.userAgent,
    });
    return { user: toSessionUser(user), session: { token, expiresAt } };
  }

  /**
   * `GET /api/auth/status`: the two booleans a page needs before it can render a form.
   *
   * `needsSetup` is the owner row and nothing else (plan §9.2 #2). `registrationOpen` mirrors the flag *without*
   * the owner condition, because it answers "does the form offer Create account" while the server's `403`
   * answers "why your account was not created".
   */
  async function status(): Promise<AuthStatusResponse> {
    return { needsSetup: !(await ownerExists(db)), registrationOpen: allowRegistration };
  }

  /**
   * `POST /api/auth/setup` — the first-run bootstrap, and the only write of `role='owner'` in the codebase.
   *
   * The `ownerExists` read answers the common case (everyone who arrives after the install is set up) with the
   * right sentence; the unique index answers the race, inside `createUserWithSettings`.
   */
  async function setup(input: CreateAccountInput, facts: RequestFacts): Promise<SignedIn> {
    if (await ownerExists(db)) {
      throw new ConflictError('this instance already has an owner');
    }
    const user = await createUserWithSettings(db, {
      username: input.username,
      passwordHash: await passwords.hash(input.password),
      role: 'owner',
      displayName: input.displayName ?? null,
    });
    return signIn(user, facts);
  }

  /**
   * `POST /api/auth/register` — self-sign-up; the account is always a `member`.
   *
   * Three doors, in this order: the limiter (so a flood costs a map lookup rather than argon2), then the flag
   * (the operator's choice), then the owner row (the install's state). The third is not redundant with the
   * second: without it, the first visitor to a fresh database with `ALLOW_REGISTRATION=true` creates a
   * `member`, `needsSetup` is false forever, and the install is left with no owner and no `/setup` —
   * recoverable only by editing the database by hand (plan §9.2 #4).
   *
   * The window is the **address's**, not the username's ({@link registerRateLimitKey} says why: the failure
   * being throttled is a sweep of usernames, and a username-keyed window is evaded by typing a new one every
   * request), and every attempt spends a slot — including the ones answered `403`, which is what keeps a flood
   * from reading the role query over and over. Plan §9.2 #4 asks for "rate-limited + `auth_attempts` like
   * login", so the taken-username `CONFLICT` writes a `succeeded=false` row too: one window's worth of guesses
   * per address (10 per 15 minutes unless the operator moves `LOGIN_RATE_LIMIT_MAX`), each with a durable line
   * for the operator, is the shape of the username enumeration the plan names as the reason
   * `ALLOW_REGISTRATION` defaults to off.
   */
  async function register(input: CreateAccountInput, facts: RequestFacts): Promise<SignedIn> {
    takeWhenRateLimited(registerRateLimitKey(facts.ip));

    if (!allowRegistration) {
      throw new ForbiddenError('self-sign-up is closed on this instance');
    }
    if (!(await ownerExists(db))) {
      throw new ForbiddenError('this instance has no owner yet, so only setup can create accounts');
    }

    let user: User;
    try {
      user = await createUserWithSettings(db, {
        username: input.username,
        passwordHash: await passwords.hash(input.password),
        role: 'member',
        displayName: input.displayName ?? null,
      });
    } catch (error) {
      // Only the username index is an attempt on something. The one-owner `CONFLICT` cannot reach this path (the
      // role is `member`, and `users_one_owner_uidx` is partial on `role='owner'`), and any other failure is a
      // bug that must arrive at the handler unmapped — so neither gets an audit row.
      if (isUsernameTakenConflict(error)) {
        await recordAuthAttempt(db, { userKey: attemptKey(input.username), succeeded: false });
      }
      throw error;
    }

    await recordAuthAttempt(db, { userKey: attemptKey(input.username), succeeded: true });
    return signIn(user, facts);
  }

  /**
   * `POST /api/auth/login` — the endpoint with the most code behind its one line of handler.
   *
   * Order matters twice over. The limiter is consulted **before** argon2, so a flood costs a map lookup rather
   * than 64 MiB per request — which would turn a brute-force attempt into denial of service on a machine with
   * 128 MiB to spare — and consulting it *takes the slot* rather than asking whether one is free: N
   * simultaneous guesses would all see an empty window and all reach argon2, which is how the eleventh bad login
   * stops being the eleventh. And the failure path is a single `throw`: the unknown-user branch runs the dummy
   * verify first and then falls into the same statement, so "no such user" and "wrong password" cannot be told
   * apart by the message, the code, or the time it took.
   *
   * A username that Postgres cannot be asked about at all — one containing `U+0000`, which the driver refuses
   * with SQLSTATE 22021 rather than treating as a value — reaches that same unknown-user branch, because
   * `userByUsername` answers it as the miss it is (`couldBeAnAccountName`, `db/repositories/users.repo.ts`).
   * That is worth stating here because the alternative was a `500` on the one endpoint whose job is refusing
   * strangers: an unauthenticated caller would have gotten a different answer, a different status, an error log
   * line, and no audit row, all from a character they did not have to guess.
   */
  async function login(input: LoginInput, facts: RequestFacts): Promise<SignedIn> {
    takeWhenRateLimited(loginRateLimitKey(input.username, facts.ip));

    const user = await userByUsername(db, input.username);
    const passwordMatches =
      user === undefined
        ? await verifyAgainstDummy(input.password)
        : await passwords.verify(user.passwordHash, input.password);

    if (!passwordMatches || user === undefined) {
      // Nothing records the failure here: `take` already charged this attempt the moment it arrived, and
      // charging it twice would make the window tighten by one every time it is reported.
      await recordAuthAttempt(db, { userKey: attemptKey(input.username), succeeded: false });
      throw new UnauthorizedError('wrong username or password');
    }

    // A correct password clears the window: otherwise one person at a shared address (an office, a family)
    // would be locked out of their own account by a stranger's ten mistakes, permanently for 15 minutes.
    rateLimiter.reset(loginRateLimitKey(input.username, facts.ip));
    await recordAuthAttempt(db, { userKey: attemptKey(user.username), succeeded: true });
    return signIn(user, facts);
  }

  /**
   * Takes a slot in `key`'s window, and answers `429 RATE_LIMITED` with the window's own `Retry-After` if the
   * window was already full. Takes rather than asks — see {@link RateLimiter.take} for why a check that records
   * nothing is not a rate limit on an endpoint whose work is asynchronous.
   */
  function takeWhenRateLimited(key: string): void {
    const decision = rateLimiter.take(key);
    if (decision.allowed) return;
    throw new RateLimitedError(undefined, { retryAfterSeconds: decision.retryAfterSeconds });
  }

  /** Spends the work of a real verify on a password that matches nothing, then says "no". */
  async function verifyAgainstDummy(password: string): Promise<false> {
    await passwords.verifyDummy(password);
    return false;
  }

  /**
   * `POST /api/auth/password` — rotate the password, keep this device, sign out every other one.
   *
   * Three statements in **one transaction**. This is the endpoint you reach for when someone else is signed in
   * as you, so the half-applied version — the new hash committed, the sweep of the other sessions failed, `500`
   * to the caller and the stolen session still alive — is precisely the state it must not be able to leave
   * behind. `docs/API.md` row 9 says "one transaction"; here it is, with the two statements' repositories
   * taking `DbOrTx` so they can be embedded. Order inside the transaction is still the design: write the new
   * hash, delete every *other* session of this user, then **rotate this session's token hash in place** so the
   * acting row survives as the same row — same `created_at`, same `user_agent` — while the cookie it was
   * authenticated with stops working. Plan §9.2 #9 asks for both halves ("rotates … the acting session
   * survives"); a delete-then-insert would satisfy only the first, and would leave the old cookie valid until
   * its `Max-Age` if the insert half failed.
   *
   * The argon2 hash is computed **before** the transaction opens: it is the step that costs half a second and
   * 64 MiB, and a row lock held across it would let one slow client block the next password change of the same
   * account, which is the same request doing two denial-of-service tricks at once.
   */
  async function changePassword(input: ChangePasswordInput): Promise<IssuedSession> {
    const currentMatches = await passwords.verify(input.user.passwordHash, input.currentPassword);
    if (!currentMatches) {
      // `401`, not `403`: the caller proved they were signed in but not that they know the secret, and the
      // SPA's unauthorized handler is the right place for "the password you typed was wrong" to land.
      throw new UnauthorizedError('the current password is not right');
    }

    // Both are decided before the transaction opens, so that nothing asynchronous is awaited inside it and so
    // that the token handed to the caller below is the same one whose hash is written above — whichever of the
    // two statements fails, the cookie is never issued for a row that does not exist.
    const passwordHash = await passwords.hash(input.newPassword);
    const token = newToken();
    const expiresAt = sessionExpiresAt(sessionTtlDays, now());

    await db.transaction(async (tx) => {
      const updated = await setUserPassword(tx, { userId: input.user.id, passwordHash });
      if (updated === undefined) {
        // The account was deleted while this request was in flight — which, for `role='owner'`, is the whole
        // install disappearing. Nothing here may create a user as a side effect, so this is a refusal, and the
        // rollback takes back the update that made the refusal necessary.
        throw new UnauthorizedError('this account no longer exists');
      }

      await deleteSessionsOfUser(tx, { userId: input.user.id, exceptTokenHash: input.actingTokenHash });

      const rotated = await rotateSessionToken(tx, {
        fromTokenHash: input.actingTokenHash,
        toTokenHash: hashToken(token),
        expiresAt,
      });
      if (rotated === undefined) {
        // The session that authenticated this request vanished mid-flight (signed out from another tab). Under
        // the transaction that is a clean no-op rather than a half-applied change — the password is still the
        // old one and no other device was touched — so `401` is simply the truth, and the client signs in again.
        throw new UnauthorizedError('this session is no longer signed in');
      }
    });

    return { token, expiresAt };
  }

  return {
    status,
    setup,
    register,
    login,
    changePassword,
    logout: (tokenHash) => deleteSessionByTokenHash(db, tokenHash),
    logoutAll: (userId) => deleteSessionsOfUser(db, { userId }),
    /**
     * `POST /api/users` — an owner-created account, always `member`, and **no session**: the owner is signed in
     * as themselves, and creating a colleague's account must not hand the caller that colleague's cookie. Not
     * rate-limited (the caller authenticated as the owner) and not an `auth_attempt` (no credential was
     * checked). A duplicate username arrives as `CONFLICT` from `users.repo.ts`.
     */
    createMember: async (input) => {
      const user = await createUserWithSettings(db, {
        username: input.username,
        passwordHash: await passwords.hash(input.password),
        role: 'member',
      });
      return toSessionUser(user);
    },
    listUsers: async () => (await listUsers(db)).map(toSessionUser),
  };
}
