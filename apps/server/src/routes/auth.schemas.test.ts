/**
 * The one rule the server adds to the contract's credential schemas: the 512-**byte** cap (§5 of the brief).
 *
 * The boundary is the test. `@note-taker/contracts` bounds `passwordSchema` at 512 *characters* — a rule the
 * browser can check, which is what a shared contract is for — and the server bounds bytes, because that is the
 * unit argon2's work bound is written in. For an ASCII password the two are the same statement, so every test
 * that uses a Latin password would pass with either implementation; these are the cases where they differ.
 *
 * The failures are asserted as issues on a *field path* rather than as HTTP responses, because
 * `plugins/error-handler.ts` already turns any `ZodError` into `400 VALIDATION` with `details[]` (PR-05), and
 * `routes/auth.routes.int.test.ts` proves one of them end to end.
 */
import { loginSchema } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { changePasswordBodySchema, createUserBodySchema, setupSchema } from './auth.schemas.js';

/** `n` copies of a three-byte code point, so `n` characters is `3n` bytes by construction. */
const wideChars = (n: number) => '记'.repeat(n);
const asciiChars = (n: number) => 'a'.repeat(n);

/** The issue paths a parse produced, so a refusal can be pinned to the field the form highlights. */
function issuePaths(result: unknown): string[] {
  const issues = (result as { error?: { issues: { path: unknown }[] } }).error?.issues ?? [];
  return issues.map((issue) => String(issue.path));
}

describe('the 512-byte cap the server adds', () => {
  it('accepts a 512-byte ASCII password and refuses one byte more', () => {
    // Both halves of the boundary are one character apart, which is what makes this a real boundary test.
    expect(setupSchema.safeParse({ username: 'owner', password: asciiChars(512) }).success).toBe(true);

    const over = setupSchema.safeParse({ username: 'owner', password: asciiChars(513) });
    expect(over.success).toBe(false);
    expect(issuePaths(over)).toContain('password');
  });

  it('refuses a 513-byte password made of 171 characters, which the shared character rule would let through', () => {
    // The case the whole file exists for: 171 CJK characters is well inside `passwordSchema.max(512)` and 3 bytes
    // over the cap the brief names. If this test starts passing, someone has deleted the refinement.
    expect(wideChars(171).length).toBe(171);
    const result = setupSchema.safeParse({ username: 'owner', password: wideChars(171) });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('password');
  });

  it('accepts the widest password that still fits: 170 characters, 510 bytes', () => {
    expect(setupSchema.safeParse({ username: 'owner', password: wideChars(170) }).success).toBe(true);
  });

  it('keeps the rules it inherits, because a refinement adds to a schema rather than replacing it', () => {
    // Both from `passwordSchema`/`registerSchema`, both still enforced through the byte-cap refinement: nine
    // characters is too short (§10), and a password equal to the username ignoring case is not a password.
    expect(setupSchema.safeParse({ username: 'owner', password: 'tooshort' }).success).toBe(false);
    expect(setupSchema.safeParse({ username: 'ownerowner', password: 'OWNEROWNER' }).success).toBe(false);
  });

  it('caps the new password of POST /api/auth/password, and not the one being checked', () => {
    const wide = wideChars(171); // 171 characters, 513 bytes: inside the shared character cap, over the byte cap.
    // `currentPassword` is an existing secret being *tested*: refusing to test it because of how it was typed
    // would lock someone out of an account they still hold. `newPassword` is a choice, so it takes the cap —
    // which is only visible if the two are swapped in turn, as both halves below do.
    const bothFit = { currentPassword: 'the-current-one', newPassword: 'a-new-one!' };
    expect(changePasswordBodySchema.safeParse(bothFit).success).toBe(true);

    const overLong = changePasswordBodySchema.safeParse({ ...bothFit, newPassword: wide });
    expect(overLong.success).toBe(false);
    expect(issuePaths(overLong)).toContain('newPassword');

    // …and the same value in the other field is fine, which is the half that proves which one is capped.
    const overWideCurrent = changePasswordBodySchema.safeParse({ ...bothFit, currentPassword: wide });
    expect(overWideCurrent.success).toBe(true);
  });

  it('applies the same cap to POST /api/users, which takes no displayName', () => {
    const parsed = createUserBodySchema.safeParse({ username: 'member', password: asciiChars(20) });
    expect(parsed.success).toBe(true);
    // The role is not in the body at all: `createUserSchema` has no such field, so an owner cannot promote a
    // colleague and a member cannot promote themselves through the same door.
    expect(parsed.success && Object.keys(parsed.data)).toEqual(['username', 'password']);

    const over = createUserBodySchema.safeParse({ username: 'member', password: wideChars(171) });
    expect(over.success).toBe(false);
    expect(issuePaths(over)).toContain('password');
  });
});

describe('what is deliberately not refined', () => {
  it('leaves loginSchema permissive, so a long password fails as 401 and not as a hint', () => {
    // Plan §9.2 #5: login accepts anything shaped like a string and answers the same `401` either way. A
    // `400 VALIDATION` for an over-long password would announce that the server counts bytes, which is a fact
    // about the server that a probe should not get.
    const result = loginSchema.safeParse({ username: 'owner', password: wideChars(400) });
    expect(result.success).toBe(true);
  });
});
