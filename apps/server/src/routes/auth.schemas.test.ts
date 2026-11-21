/**
 * The two rules the server adds to the contract's credential schemas: the 512-**byte** cap (§5 of the brief),
 * and plan §10's "never the username" on `POST /api/auth/password`, the one credential body that cannot state
 * that rule by itself.
 *
 * The boundary is the test for the first rule. `@note-taker/contracts` bounds `passwordSchema` at 512
 * *characters* — a rule the browser can check, which is what a shared contract is for — and the server bounds
 * bytes, because that is the unit argon2's work bound is written in. For an ASCII password the two are the same
 * statement, so every test that uses a Latin password would pass with either implementation; these are the
 * cases where they differ.
 *
 * The second rule is tested here rather than only end to end because it is a *function of the username*: the
 * endpoint used to accept `alice.smith` as the new password of `alice.smith` with a `204`, which is plan §10's
 * policy stated twice in the briefs and enforced by three of the four endpoints that take a password.
 *
 * The failures are asserted as issues on a *field path* rather than as HTTP responses, because
 * `plugins/error-handler.ts` already turns any `ZodError` into `400 VALIDATION` with `details[]` (PR-05), and
 * `routes/auth.routes.int.test.ts` proves both of them end to end.
 */
import { loginSchema, PASSWORD_EQUALS_USERNAME_MESSAGE } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { changePasswordBodySchemaFor, createUserBodySchema, setupSchema } from './auth.schemas.js';

/** `n` copies of a three-byte code point, so `n` characters is `3n` bytes by construction. */
const wideChars = (n: number) => '记'.repeat(n);
const asciiChars = (n: number) => 'a'.repeat(n);

/** The issue paths a parse produced, so a refusal can be pinned to the field the form highlights. */
function issuePaths(result: unknown): string[] {
  const issues = (result as { error?: { issues: { path: unknown }[] } }).error?.issues ?? [];
  return issues.map((issue) => String(issue.path));
}

/** The issue messages a parse produced, so the *words* can be pinned to the contract's rather than retyped. */
function issueMessages(result: unknown): string[] {
  const issues = (result as { error?: { issues: { message: unknown }[] } }).error?.issues ?? [];
  return issues.map((issue) => String(issue.message));
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
    // The schema is a function of the account being changed, so the test names one: whose username it is that the
    // new secret must not equal is the subject of the other describe, not of this one.
    const forAda = changePasswordBodySchemaFor('ada.lovelace');
    expect(forAda.safeParse(bothFit).success).toBe(true);

    const overLong = forAda.safeParse({ ...bothFit, newPassword: wide });
    expect(overLong.success).toBe(false);
    expect(issuePaths(overLong)).toContain('newPassword');

    // …and the same value in the other field is fine, which is the half that proves which one is capped.
    const overWideCurrent = forAda.safeParse({ ...bothFit, currentPassword: wide });
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

describe('the "never the username" rule on POST /api/auth/password (plan §10)', () => {
  // Twelve characters, so it clears `passwordSchema.min(10)` and can only be refused by the rule under test: a
  // shorter username would make every case below fail for the wrong reason. It is also why `owner` — the account
  // every other test in this file creates, at five characters — could never have shown the hole at all: five
  // characters was already refused, for being short, and the review found this by asking about a long name.
  const body = { currentPassword: 'the-current-one', newPassword: 'ada.lovelace' };

  it('refuses a new password equal to the username, ignoring case', () => {
    const exact = changePasswordBodySchemaFor('ada.lovelace').safeParse(body);
    expect(exact.success).toBe(false);
    expect(issuePaths(exact)).toContain('newPassword');
    // The same words the two creating endpoints produce: one policy, one voice, even though this endpoint has to
    // add the issue by hand because its username is not in its body.
    expect(issueMessages(exact)).toContain(PASSWORD_EQUALS_USERNAME_MESSAGE);
    // …and case is not a way round it, because `users_username_lower_uidx` already says `Bob` and `bob` are one
    // account, so a case-sensitive check here would refuse `ada.lovelace` and accept `ADA.LOVELACE`.
    expect(changePasswordBodySchemaFor('ADA.LOVELACE').safeParse(body).success).toBe(false);
  });

  it('refuses it without consulting the current password, because the rule is about the new one', () => {
    // The proof that the refusal is *free*, which is the reason it lives in the body schema rather than in
    // `AuthService.changePassword`: a body whose `currentPassword` is nonsense still produces the issue on
    // `newPassword`, so parsing rejected it before anything could spend an argon2 verify — half a second and
    // 64 MiB that a request which can never be accepted should not buy.
    const wrongCurrent = changePasswordBodySchemaFor('ada.lovelace').safeParse({
      ...body,
      currentPassword: 'not-what-they-are-signed-in-with',
    });
    expect(wrongCurrent.success).toBe(false);
    expect(issuePaths(wrongCurrent)).toContain('newPassword');
  });

  it('still accepts a password that merely contains the username, which is what the shared rule says', () => {
    // `passwordMatchesUsername` is equality ignoring case, not a substring test — the rule §10 states and the one
    // `packages/contracts/src/schemas.test.ts` pins for `ada` against `adams-family`. Refusing `ada.lovelace-2026`
    // here would quietly make the change endpoint stricter than the two endpoints that create accounts.
    expect(
      changePasswordBodySchemaFor('ada.lovelace').safeParse({
        currentPassword: 'the-current-one',
        newPassword: 'ada.lovelace-2026',
      }).success,
    ).toBe(true);
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
