/**
 * The contract's credential schemas, plus the two refinements the server adds (docs/plans/mvp/MVP-07.md §5):
 * the 512-**byte** cap on a chosen password, and plan §10's "never the username" rule on the one endpoint whose
 * body cannot state it.
 *
 * plan §10's password policy is three rules: at least 10 characters, never the username ignoring case, and at
 * most **512 bytes**. `@note-taker/contracts` implements the first two and expresses the third as
 * `passwordSchema.max(512)` — 512 *characters*, which is the same rule for every ASCII password and looser for
 * everything else. A 200-character CJK password is 600 bytes, so the server adds the byte check here rather
 * than loosening the shared one: the SPA mirrors `passwordSchema` and would otherwise be taught a rule it
 * cannot test in the browser (`TextEncoder` could, but the contract is what the browser shares).
 *
 * Why the check exists at all: argon2 has no maximum input length and does not pre-hash the way bcrypt's
 * 72-byte truncation forced, so the cap is not a correctness guard but a work-bound one — the reason
 * `PASSWORD_MAX_LENGTH` is described as the pre-hash guard in the contract. The failures these refinements
 * produce are ordinary `400 VALIDATION` with `details[].path` of `password`/`newPassword`, because they arrive
 * as `ZodError`s and `plugins/error-handler.ts` already renders those (PR-05).
 *
 * Deliberately **not** refined: `loginSchema`. Its permissiveness is the anti-enumeration property (plan §9.2
 * #5) — a login whose password is merely long has to fail as `401 UNAUTHORIZED`, not as `400 VALIDATION` that
 * announces how the server counts.
 */
import {
  changePasswordSchema,
  createUserSchema,
  PASSWORD_EQUALS_USERNAME_MESSAGE,
  PASSWORD_MAX_LENGTH,
  passwordMatchesUsername,
  registerSchema,
} from '@note-taker/contracts';

import { utf8ByteLength } from '../auth/passwords.js';

/** The issue a user sees: the same field the form highlights, in the words the envelope already carries. */
function byteCapIssue(path: readonly string[]) {
  return {
    code: 'custom' as const,
    path: [...path],
    message: `must be at most ${PASSWORD_MAX_LENGTH} bytes encoded as UTF-8`,
  };
}

/**
 * The same issue `registerSchema` and `createUserSchema` add, at whatever field this body calls the secret.
 *
 * The message comes from the contract rather than being retyped, so "that password is the same as your username"
 * cannot read differently on the one endpoint that has to add it by hand.
 */
function sameAsUsernameIssue(path: readonly string[]) {
  return {
    code: 'custom' as const,
    path: [...path],
    message: PASSWORD_EQUALS_USERNAME_MESSAGE,
  };
}

/**
 * `POST /api/auth/setup` and `POST /api/auth/register` (§9.2 #3, #4): `registerSchema` plus the byte cap.
 *
 * Both routes take the same body, so both take the same schema, and the shared shape is what keeps a
 * `member` self-signing up under the same rule the owner set themselves up under.
 */
export const setupSchema = registerSchema.superRefine((value, ctx) => {
  if (utf8ByteLength(value.password) > PASSWORD_MAX_LENGTH) ctx.addIssue(byteCapIssue(['password']));
});

/** `POST /api/users` (§9.2 #10): an owner-created account, same byte cap, no `displayName` to send. */
export const createUserBodySchema = createUserSchema.superRefine((value, ctx) => {
  if (utf8ByteLength(value.password) > PASSWORD_MAX_LENGTH) ctx.addIssue(byteCapIssue(['password']));
});

/**
 * `POST /api/auth/password` (§9.2 #9), for the account that is asking.
 *
 * A function of the username rather than a constant, for one reason: plan §10's rule "a password equal to the
 * username is not a password" is a rule about two fields, and this body carries only the new secret — the
 * username is what the session says it is, never what the body claims. `registerSchema` and `createUserSchema`
 * can state the rule because both fields are in their bodies; here it has to be added around the cookie's
 * value, and adding it *here* rather than in `AuthService.changePassword` is what makes the refusal cost
 * nothing: it runs before the argon2 verify and before the hash, so a request that can never be accepted does
 * not spend 64 MiB of work, and it answers as the ordinary `400 VALIDATION` with `details[].path` of
 * `newPassword` that the other three endpoints already produce.
 *
 * The cap lands on `newPassword` only: `currentPassword` is an existing secret being *checked*, and refusing to
 * test it because of how it was typed would lock someone out of an account they still own.
 */
export function changePasswordBodySchemaFor(username: string) {
  return changePasswordSchema.superRefine((value, ctx) => {
    if (passwordMatchesUsername({ username, password: value.newPassword })) {
      ctx.addIssue(sameAsUsernameIssue(['newPassword']));
    }
    if (utf8ByteLength(value.newPassword) > PASSWORD_MAX_LENGTH) ctx.addIssue(byteCapIssue(['newPassword']));
  });
}
