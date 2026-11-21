/**
 * Authentication and user DTOs (docs/plans/mvp/MVP-05.md §7, plan §9.2 #2–#11).
 *
 * The rules encoded here are the ones the server enforces in PR-07 and the forms in PR-08 mirror:
 * the password policy of plan §10, the one-owner model of §8, and the fact that a
 * `POST /api/users` account is always a `member`.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './api-envelope.js';

/** Shortest username. Three, so `id` and `me` stay unambiguous with future reserved names. */
export const USERNAME_MIN_LENGTH = 3;
/** Longest username. */
export const USERNAME_MAX_LENGTH = 32;
/** Plan §10: `≥ 10` characters. */
export const PASSWORD_MIN_LENGTH = 10;
/** Plan §10: `≤ 512` bytes — the argon2 pre-hash guard, so a huge body never reaches the hash. */
export const PASSWORD_MAX_LENGTH = 512;
/** `users.display_name`, which is optional in the database and trimmed on the way in. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

export const userIdSchema = z.uuid();

/** The two roles of §8. Only `/setup` ever writes `owner`; `users_one_owner_uidx` enforces the rest. */
export const userRoleSchema = z.enum(['owner', 'member']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * `[A-Za-z0-9._-]`, starting and ending with a letter or a digit.
 *
 * Uniqueness is case-insensitive (`users_username_lower_uidx`), so the character set is deliberately
 * ASCII and free of characters a human cannot re-type from memory: an accent, an `@`, or a space
 * would make `Bob` and `bob` look like different accounts that the index says are the same one.
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/i;

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .regex(
    USERNAME_PATTERN,
    `must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters of letters, digits, ".", "_" or "-", starting and ending with a letter or a digit`,
  );

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(DISPLAY_NAME_MAX_LENGTH, `must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);

/**
 * The user object every auth response returns. `displayName` is `null`, not absent, because the
 * column is nullable: a form can bind to the field without testing for two kinds of emptiness.
 *
 * `GET /api/users` (§9.2 #11) returns these too — the "minimal admin surface" of the plan is this
 * same object, so a user row has one shape in the whole API.
 */
export const sessionUserSchema = z.object({
  id: userIdSchema,
  username: usernameSchema,
  role: userRoleSchema,
  displayName: displayNameSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Plan §10: a password equal to the username (ignoring case) is not a password. */
export const passwordMatchesUsername = (value: {
  readonly username: string;
  readonly password: string;
}): boolean => value.password.toLowerCase() === value.username.toLowerCase();

/**
 * The words for that rule, exported because the body of `POST /api/auth/password` has to add the same issue
 * itself: its username is not in the body (it is what the cookie says it is), so no schema over the body alone
 * can state the rule — see `changePasswordBodySchemaFor` in `apps/server/src/routes/auth.schemas.ts`. One
 * string, so the four endpoints that enforce plan §10's second rule cannot answer in four different voices.
 */
export const PASSWORD_EQUALS_USERNAME_MESSAGE = 'must not be the same as the username';

/** The issue the credential schemas add for that rule, at the field a form highlights. */
const PASSWORD_EQUALS_USERNAME = {
  code: 'custom' as const,
  path: ['password'],
  message: PASSWORD_EQUALS_USERNAME_MESSAGE,
};

/** `POST /api/auth/setup` / `POST /api/auth/register` (§9.2 #3, #4). */
export const registerSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    displayName: displayNameSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (passwordMatchesUsername(value)) ctx.addIssue(PASSWORD_EQUALS_USERNAME);
  });

/**
 * `POST /api/users` (§9.2 #10): owner-created account, always `role='member'` — there is deliberately
 * no `role` field for a client to send.
 */
export const createUserSchema = z
  .object({ username: usernameSchema, password: passwordSchema })
  .superRefine((value, ctx) => {
    if (passwordMatchesUsername(value)) ctx.addIssue(PASSWORD_EQUALS_USERNAME);
  });

/**
 * `POST /api/auth/login` (§9.2 #5).
 *
 * Deliberately permissive: an unknown or oddly-shaped username must fail as `UNAUTHORIZED`, not as
 * `VALIDATION`, so the endpoint cannot be used to enumerate which account names exist or how long a
 * password policy is. Length caps stay, because a megabyte of body has to be refused before argon2.
 */
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/** `POST /api/auth/password` (§9.2 #9). Rotates the password and deletes every other session. */
export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: passwordSchema })
  .superRefine((value, ctx) => {
    if (value.currentPassword === value.newPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: 'must differ from the current password',
      });
    }
  });

/** `{user}` — the success body of `setup` (200), `register` (201), `login` (200) and `POST /api/users` (201). */
export const authResponseSchema = z.object({ user: sessionUserSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

/**
 * `GET /api/auth/session` (§9.2 #8): `{user|null, expiresAt?}`. `expiresAt` is absent exactly when
 * `user` is `null`, which is what lets the SPA skip a countdown for a signed-out boot.
 */
export const sessionResponseSchema = z
  .object({
    user: sessionUserSchema.nullable(),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.user === null && value.expiresAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'only accompanies a signed-in session',
      });
    }
  });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * `GET /api/auth/status` (§9.2 #2), the call every page makes before it can render a form. It also
 * (re-)issues the `note_csrf` cookie (PR-07), which is why `apps/web/src/lib/api.ts` may only refetch
 * it once per `403`.
 */
export const authStatusResponseSchema = z.object({
  needsSetup: z.boolean(),
  registrationOpen: z.boolean(),
});
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

/** `GET /api/users` (§9.2 #11). */
export const usersResponseSchema = z.object({ users: z.array(sessionUserSchema) });
export type UsersResponse = z.infer<typeof usersResponseSchema>;
