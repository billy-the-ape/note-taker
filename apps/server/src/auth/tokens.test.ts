/**
 * The two secrets a session is made of (docs/plans/mvp/MVP-07.md §5).
 *
 * The one-way property is what the acceptance criterion "a database dump cannot authenticate" rests on, and it
 * is a property of a hash function, so it belongs in a unit test rather than in an integration one: nothing
 * about Postgres can tell you whether someone later swapped `sha256` for an encryption, whereas a fixed vector
 * does.
 */
import { describe, expect, it } from 'vitest';

import { hashToken, newToken, sessionExpiresAt, sessionIsLive, TOKEN_BYTES } from './tokens.js';

/** `sha256("note-taker-session-token")` as hex, computed once, outside this file. */
const SHA256_OF_THE_TEST_TOKEN = '0a43e444478eb2b81fcc9143bc8ed15e67cdc7d8b5a16f677c04a6b0f5e89f79';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('newToken', () => {
  it('is 32 random bytes as unpadded base64url, i.e. 43 characters with nothing a cookie would need quoting', () => {
    const token = newToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(token, 'base64url')).toHaveLength(TOKEN_BYTES);
  });

  it('never repeats, so two logins on the same account are two sessions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(newToken());
    expect(seen.size).toBe(2_000);
  });
});

describe('hashToken', () => {
  it('is the SHA-256 of the token as text, by a fixed vector', () => {
    // The vector is the point: `sessions.token_hash` is a primary key, and changing what is hashed — a different
    // digest, or the *decoded* bytes of a base64url token rather than its text — would silently orphan every
    // session in the database at the next deploy, or make the lookup accept a second token.
    expect(hex(hashToken('note-taker-session-token'))).toBe(SHA256_OF_THE_TEST_TOKEN);
  });

  it('is 32 bytes, deterministic, and different for different tokens', () => {
    const a = hashToken('a');
    expect(a).toHaveLength(32);
    expect(hashToken('a')).toEqual(a);
    expect(hashToken('b')).not.toEqual(a);
  });

  it('is not the token, which is the whole reason a database dump cannot authenticate', () => {
    const token = newToken();
    const stored = hashToken(token);
    const rawTokenBytes = new TextEncoder().encode(token);
    // The failure this guards is the "simplification" of storing the token in `token_hash` because the column is
    // already `bytea` and the code is right there. It is a one-line change that survives every test except this
    // one, and it turns a stolen database into every live session on the instance.
    expect(stored).not.toEqual(rawTokenBytes.subarray(0, 32));
    expect(Buffer.from(stored).toString('base64url')).not.toBe(token);
  });
});

describe('the session lifetime', () => {
  it('adds SESSION_TTL_DAYS as days, not hours or seconds', () => {
    const at = new Date('2026-03-01T12:00:00.000Z');
    expect(sessionExpiresAt(30, at).toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(sessionExpiresAt(1, at).getTime() - at.getTime()).toBe(86_400_000);
  });

  it('is live strictly before `expires_at` and dead at it', () => {
    const expires = new Date('2026-04-01T00:00:00.000Z');
    expect(sessionIsLive(expires, new Date('2026-03-31T23:59:59.999Z'))).toBe(true);
    // Exactly at the instant is dead: `<=` would let a session whose row said "expired now" authenticate one
    // final request, which is not a fact anybody reading `expires_at` would agree to.
    expect(sessionIsLive(expires, expires)).toBe(false);
    expect(sessionIsLive(expires, new Date('2026-04-01T00:00:00.001Z'))).toBe(false);
  });
});
