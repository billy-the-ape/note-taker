/**
 * The two secrets a session is made of, and the one-way form of one of them
 * (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * * **A session token is 32 random bytes, base64url-encoded.** 32 bytes is 256 bits of entropy, which
 *   is the widest a bearer secret has to be before "guessable" stops being a sentence worth arguing
 *   about; base64url (Node's `base64url`, i.e. no `+`, `/` or `=`) is what lets the value sit in a
 *   cookie and be compared byte-for-byte without any escaping rules in the way.
 * * **`sessions.token_hash` holds `sha256(token)` and nothing else.** A dump of the database therefore
 *   cannot sign a cookie: the hash is what the server looks a session up *by*, never what it hands to
 *   the browser. The raw token exists in exactly two places — the cookie, and the memory of the
 *   request that minted it.
 *
 * SHA-256 rather than argon2 here is not an inconsistency: argon2 slows down *low-entropy* inputs
 * (passwords, guessable by hand); this input is uniformly random, so a fast hash is the correct
 * primitive, and it has to be fast because it runs on every authenticated request.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Bytes in a session token and in a CSRF token: 256 bits each, encoded to 43 base64url characters. */
export const TOKEN_BYTES = 32;

/**
 * A fresh opaque token: 32 random bytes from the CSPRNG, as unpadded base64url.
 *
 * Used for both the session token and the CSRF token. They are the same *kind* of secret (opaque,
 * high-entropy, server-minted) even though they travel differently, and a single generator is what
 * keeps "32 bytes" from meaning two different things in two different files.
 */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The value that goes into `sessions.token_hash`.
 *
 * A `Uint8Array` because that is what the `bytea` column takes (see `db/schema.ts`'s `customType`);
 * the driver's `Buffer` is a subclass, so nothing maps on the way in.
 */
export function hashToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/** The `expires_at` of a session minted now, from `SESSION_TTL_DAYS`. */
export function sessionExpiresAt(ttlDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/** Whether a stored `expires_at` is still in the future, compared against one clock. */
export function sessionIsLive(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() > now.getTime();
}
