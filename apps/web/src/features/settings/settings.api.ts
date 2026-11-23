/**
 * The four calls `/app/settings` makes (docs/plans/mvp/MVP-16.md §2, `docs/API.md` #9, #7 and #22).
 *
 * Every one of them is a thin wrapper over the shared {@link ApiClient}, and every response is
 * parsed with the same Zod schema the server compiles against, so a contract change breaks a test
 * here rather than a render deep in a component.
 *
 * There is deliberately no error handling in this file: `lib/api.ts` already turns every non-2xx
 * into an `ApiError` carrying the envelope, and the caller that can *show* something is the form or
 * the page, not the transport.
 *
 * Which endpoints exist in this tree is worth stating, because it explains the test layout:
 * `ROUTES.auth.password` and `ROUTES.auth.logoutAll` are served (PR-07), while `ROUTES.settings`
 * is **PR-09's and is not registered yet** — `app.ts` mounts health, auth and users only. So the two
 * settings calls are covered by the fake in `src/test/fake-api.ts`, whose semantics are taken from
 * `docs/API.md` #22 and `db/schema.ts`'s `settings` defaults (PR-04), not invented here; PR-09's own
 * integration suite is the server-side half, and should keep the two in step the way
 * `auth.routes.int.test.ts` does for #9.
 */
import { type PatchSettingsRequest, ROUTES, type Settings, settingsSchema } from '@note-taker/contracts';

import type { ApiClient } from '../../lib/api.js';

/**
 * `GET /api/settings` (§9.2 #22). Get-or-create on the server, so this never 404s and never answers
 * an empty body: a fresh account gets the defaults row, which is what lets the page skip the
 * "no settings yet" branch entirely (MVP-16 §6).
 */
export function getSettings(client: ApiClient): Promise<Settings> {
  return client.json<Settings>(ROUTES.settings, { schema: settingsSchema });
}

/**
 * `PATCH /api/settings` (§9.2 #22): the body is exactly the field that changed — `patchSettingsSchema`
 * refuses an empty patch precisely so a client cannot mistake "nothing happened" for success.
 */
export function patchSettings(client: ApiClient, patch: PatchSettingsRequest): Promise<Settings> {
  return client.json<Settings>(ROUTES.settings, {
    method: 'PATCH',
    body: patch,
    schema: settingsSchema,
  });
}

/** The body of `POST /api/auth/password` (§9.2 #9). */
export interface ChangePasswordRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * `POST /api/auth/password` (§9.2 #9) → `204`.
 *
 * The two things a caller must not do with this call are the whole reason it is its own function:
 * it must not be treated as a re-login (the acting session is rotated and *kept*, and the response
 * carries the rotated cookie), and it must not be retried on a `401`, because a `401` here means
 * "the current password you typed is wrong", not "your session expired" (`lib/api.ts`'s
 * one-shot CSRF replay is the only automatic second attempt this request ever gets).
 */
export function changePassword(client: ApiClient, body: ChangePasswordRequest): Promise<void> {
  return client.json<void>(ROUTES.auth.password, { method: 'POST', body });
}

/**
 * `POST /api/auth/logout-all` (§9.2 #7) → `204`: every session row of this user, including the one
 * making the request. How many rows went is not in the body, so nothing here tries to count them.
 */
export function signOutEverywhere(client: ApiClient): Promise<void> {
  return client.json<void>(ROUTES.auth.logoutAll, { method: 'POST' });
}
