/**
 * Every auth call and every auth rule the forms enforce, in one file
 * (docs/plans/mvp/MVP-08.md §5, §6).
 *
 * Two halves, deliberately:
 *
 * * **The calls** are thin — `api.json(ROUTES.x, { schema })`, so a request leaves with the CSRF
 *   header PR-05 attaches, a response is checked against the same schema PR-07 compiles against, and
 *   every failure is an `ApiError` carrying the server's own words. There is no second fetch wrapper
 *   and no `any` at the edge.
 * * **The validation** is the *shared* `registerSchema`, not a re-typed list of rules. That is the
 *   whole point of PR-05: "must be at least 10 characters", "must not be the same as the username"
 *   and the 32-character cap are one definition in `@note-taker/contracts`, mirrored here for the
 *   browser and re-checked by the server on the way in. A form that invented its own policy would be
 *   wrong the first time the contract moved; this one cannot drift, because it *is* the contract.
 *
 * Client-side validation is a courtesy, never a gate: the required-field checks below exist so a
 * person who tabbed through an empty form sees three messages instead of one round-trip, and the
 * server still decides everything.
 */
import {
  type AuthStatusResponse,
  authResponseSchema,
  authStatusResponseSchema,
  type ErrorDetail,
  ROUTES,
  registerSchema,
  type SessionResponse,
  type SessionUser,
  sessionResponseSchema,
} from '@note-taker/contracts';

import { ApiError, api } from '../../lib/api';

/** The pair `login` takes and `setup`/`register` take plus a confirm field in the form only. */
export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** What a credentials form holds: the body, plus the confirmation that never leaves the browser. */
export interface CredentialDraft extends Credentials {
  /** Absent (or `undefined`) on `/login`, which has no confirmation box. */
  readonly confirmPassword?: string | undefined;
}

/** The fields `CredentialDraft` can complain about. */
export type CredentialField = 'username' | 'password' | 'confirmPassword';

/** Field-level messages, keyed the way a form wants them. Absent means valid. */
export type FieldErrors = Partial<Record<CredentialField, string>>;

/**
 * Words for the two states `registerSchema` cannot express. Its minimum length is the rule for a
 * *chosen* password; somebody who has not typed anything yet needs a different sentence, and a
 * "must be at least 10 characters" under an empty box reads as a scold.
 */
export const REQUIRED_USERNAME_MESSAGE = 'enter a username';
export const REQUIRED_PASSWORD_MESSAGE = 'enter a password';
/** The one rule that exists in no schema, because the confirm field is never sent. */
export const CONFIRM_MISMATCH_MESSAGE = 'the two passwords do not match';
/** A failure with no envelope: the browser could not reach the API at all. */
export const UNREACHABLE_MESSAGE = 'the server did not answer — is it running?';

/** `GET /api/auth/status` (§9.2 #2). Also re-issues `note_csrf`; the only route that may be refetched. */
export function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return api.json(ROUTES.auth.status, { schema: authStatusResponseSchema });
}

/** `GET /api/auth/session` (§9.2 #8). Answers `{user: null}` for a stranger rather than `401`. */
export function fetchSession(): Promise<SessionResponse> {
  return api.json(ROUTES.auth.session, { schema: sessionResponseSchema });
}

/**
 * The three routes that answer `{user}` and set the session cookie (§9.2 #3–#5).
 *
 * They share one helper because they differ only in path and status code, and the shape they return
 * is the same `authResponseSchema` — the 200/201 difference is the server's business, and the SPA
 * treats "you are now signed in" identically either way.
 */
async function signInWith(path: string, body: Credentials): Promise<SessionUser> {
  const response = await api.json(path, { method: 'POST', body, schema: authResponseSchema });
  return response.user;
}

/** `POST /api/auth/login` (§9.2 #5): `401` for a wrong answer, `429` once the window is full. */
export function login(credentials: Credentials): Promise<SessionUser> {
  return signInWith(ROUTES.auth.login, credentials);
}

/** `POST /api/auth/setup` (§9.2 #3): the first-run bootstrap that creates the single `owner`. */
export function setupAccount(credentials: Credentials): Promise<SessionUser> {
  return signInWith(ROUTES.auth.setup, credentials);
}

/** `POST /api/auth/register` (§9.2 #4): a `member`, and only when the server says registration is open. */
export function registerAccount(credentials: Credentials): Promise<SessionUser> {
  return signInWith(ROUTES.auth.register, credentials);
}

/**
 * `POST /api/auth/logout` (§9.2 #6): deletes the session row *and* expires the cookie, which is why
 * the local cache is dropped by the caller only after this answered — a sign-out that failed should
 * not pretend to have worked.
 */
export async function signOut(): Promise<void> {
  await api.json(ROUTES.auth.logout, { method: 'POST' });
}

/**
 * Runs the shared `registerSchema` over the draft and adds the two rules that live only in the form.
 *
 * `username` is trimmed first because `usernameSchema` is `z.string().trim()` and the server would do
 * the same: checking the untrimmed value would tell somebody their password is fine while their
 * username with a trailing space is not.
 */
export function validateCredentials(draft: CredentialDraft): FieldErrors {
  const username = draft.username.trim();
  const password = draft.password;
  const errors: FieldErrors = {};

  // The required checks come first so an empty form produces "enter a username", and the schema runs
  // only on values worth validating — otherwise an empty password would also report its length.
  if (username.length === 0) errors.username = REQUIRED_USERNAME_MESSAGE;
  if (password.length === 0) errors.password = REQUIRED_PASSWORD_MESSAGE;
  if (username.length > 0 && password.length > 0) {
    const result = registerSchema.safeParse({ username, password });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (field !== 'username' && field !== 'password') continue;
        // First issue per field wins: three messages under one box is three ways to miss the point.
        if (errors[field] === undefined) errors[field] = issue.message;
      }
    }
  }

  // Compared against the raw password: the confirmation has to match what would be sent, spaces and all.
  if (draft.confirmPassword !== undefined && draft.confirmPassword !== password) {
    errors.confirmPassword = CONFIRM_MISMATCH_MESSAGE;
  }

  return errors;
}

/**
 * What `loginSchema` enforces (§9.2 #5): both fields merely present. Its permissiveness is deliberate
 * — an unknown name and a wrong password answer `401` with the same words, so the form must not
 * validate a username into a shape that reveals what the server accepts.
 */
export function validateLogin(draft: CredentialDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.username.trim().length === 0) errors.username = REQUIRED_USERNAME_MESSAGE;
  if (draft.password.length === 0) errors.password = REQUIRED_PASSWORD_MESSAGE;
  return errors;
}

/**
 * The server's field errors, from the envelope's `details` (§9.1), for the inputs they came from.
 *
 * Only the fields this form owns are lifted out; `body` and anything unknown stay in the form-level
 * message, because a paragraph about `body` under a username box is worse than the same sentence above
 * the button. Unknown paths are dropped rather than guessed at, since a `details[].path` is a dotted
 * *request-body* path and the form has no vocabulary beyond its three fields.
 */
export function fieldErrorsFromDetails(details: readonly ErrorDetail[] | undefined): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details ?? []) {
    const field = detail.path.split('.')[0];
    if (field !== 'username' && field !== 'password') continue;
    if (errors[field] === undefined) errors[field] = detail.message;
  }
  return errors;
}

/**
 * The sentence to show for a failure: the server's own `message` when there is one (PR-07 writes them
 * for humans — "wrong username or password", "self-sign-up is closed on this instance"), and an honest
 * "could not reach it" otherwise. Never a stack, and never blank.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return UNREACHABLE_MESSAGE;
}

/** Whether this failure was the login/sign-up rate limit (429, `RATE_LIMITED`). */
export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'RATE_LIMITED';
}

/**
 * The `Retry-After` wait, in words, or `undefined` when the server did not say.
 *
 * A `429` whose message is "too many attempts, try again later" is still a guess about when "later"
 * is; the window's own number (docs/API.md) is the difference between waiting and hammering. Minutes
 * above a minute because 900 s is not something a person counts.
 */
export function retryAfterNotice(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.retryAfterSeconds === undefined) return undefined;
  const seconds = error.retryAfterSeconds;
  if (seconds < 60) return `try again in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `try again in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
