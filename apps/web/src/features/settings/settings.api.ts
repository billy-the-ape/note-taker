/**
 * The settings and credential calls this app makes (`docs/API.md` #22, #9 and #7).
 *
 * Two PRs met in this file, and the merge is worth stating because the two halves answer different
 * questions:
 *
 * * **PR-14** wrote it first, for the autosave engine: `autosave: boolean` is an **injected** input,
 *   and the caller that injects it needs somewhere honest to get it from. Hence {@link
 *   settingsOptions} (the cache entry, so PR-14's editor and PR-16's toggle cannot disagree about
 *   which row is the truth), {@link fetchSettings} (the app-level singleton transport) and {@link
 *   autosaveFlag} — the default is the load-bearing part, because the only ways to see no row are a
 *   request in flight and a request that failed, and a note whose autosave quietly turned itself off
 *   because a settings `GET` was slow is precisely the silent behaviour the README rules out.
 * * **PR-16** added the rest of the surface the settings screen needs — {@link patchSettings},
 *   {@link changePassword}, {@link signOutEverywhere} — against an **injected** {@link ApiClient},
 *   because a component cannot pass constructor options to a module singleton and PR-16's tests drive
 *   a fake server through `lib/api-client-context.tsx`. `lib/api.ts` (PR-05) exports the singleton, so
 *   {@link fetchSettings} is now one call to {@link getSettings} rather than a second implementation
 *   of the same request: one URL, one schema, two entry points for two kinds of caller.
 *
 * Every response is parsed with the same Zod schema the server compiles against, so a contract change
 * breaks a test here rather than a render deep in a component. There is deliberately no error handling
 * in this file: `lib/api.ts` already turns every non-2xx into an `ApiError` carrying the envelope, and
 * the caller that can *show* something is the form or the page, not the transport.
 *
 * All four endpoints exist in this tree now: PR-09 registered `GET`/`PATCH /api/settings` (its
 * `settings.routes.int.test.ts` is the server-side half), and PR-07 registered `ROUTES.auth.password`
 * and `ROUTES.auth.logoutAll`.
 */
import { type PatchSettingsRequest, ROUTES, type Settings, settingsSchema } from '@note-taker/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient, api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';

/** What this app does with "no answer yet": on. The plan's default, not a coin flip. */
export const AUTOSAVE_DEFAULT = true;

/**
 * `GET /api/settings` (§9.2 #22) with an injected client — the form PR-16's hooks and its tests use.
 *
 * Get-or-create on the server, so this never 404s and never answers an empty body: a fresh account
 * gets the defaults row, which is what lets the settings page skip the "no settings yet" branch
 * entirely (MVP-16 §6).
 */
export function getSettings(client: ApiClient): Promise<Settings> {
  return client.json<Settings>(ROUTES.settings, { schema: settingsSchema });
}

/** `GET /api/settings` on the application singleton — PR-14's entry point, and the one PR-14 tested. */
export function fetchSettings(): Promise<Settings> {
  return getSettings(api);
}

export function settingsOptions() {
  return queryOptions({ queryKey: queryKeys.settings, queryFn: fetchSettings });
}

/** The flag out of a row, with the default for `undefined`. Pure, so the rule has a test of its own. */
export function autosaveFlag(settings: Settings | undefined): boolean {
  return settings?.autosave ?? AUTOSAVE_DEFAULT;
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
