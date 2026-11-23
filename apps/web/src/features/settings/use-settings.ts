/**
 * The one read of the settings row, shared by every consumer in the app (docs/plans/mvp/MVP-16.md §5).
 *
 * `queryKeys.settings` is a global key with no user id in it (`lib/queryClient.ts`, PR-05): there is
 * exactly one settings row per signed-in user and the session cookie says who that is, so the tree,
 * the editor and this screen cannot disagree about whether autosave is on. That single cache entry is
 * the whole mechanism behind PR-16's headline criterion — the toggle does not "tell" the editor
 * anything, it changes the value the editor is already subscribed to, which is why the flag lands in
 * an open editor within one render rather than on the next page load.
 *
 * Two rules travel with the read:
 *
 * * **The defaults are the server's defaults.** `GET /api/settings` is get-or-create (PR-09), so a
 *   fresh account gets `{autosave: true, theme: 'system'}` and never an error state. {@link
 *   DEFAULT_SETTINGS} is the same row for the moments before the first response lands, and it is
 *   *not* a fallback for a failure: `useSettingsStatus()` reports `error` for that.
 * * **A consumer that cannot see the value yet behaves as autosave-on** — README: "Auto-save can be
 *   enabled (default on)", and PR-14 §6 says a missing settings row must never silently flip the
 *   flag off. Falling back to `true` is the client half of that sentence.
 */

import type { Settings, SettingsTheme } from '@note-taker/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '../../lib/api-client-context.js';
import { queryKeys } from '../../lib/queryClient.js';
import { getSettings } from './settings.api.js';

/** The row PR-09 get-or-creates for a fresh account, before the first response has landed. */
export const DEFAULT_SETTINGS: Settings = {
  autosave: true,
  theme: 'system',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** The `updatedAt` a `PATCH` answers with, for the optimistic write in `use-patch-settings.ts`. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The settings query itself. Mount it once per surface and read it everywhere; because the key is
 * global, a second consumer costs a cache hit rather than a second request.
 */
export function useSettingsQuery() {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => getSettings(client),
    // No `retry` override: `createQueryClient` (PR-05) already retries at most once and never on a
    // `4xx`, which is the correct policy here — a signed-out visitor's `401` is not going to turn
    // into a `200` a second later, and the root layout mounts this on every page.
  });
}

/**
 * The flag PR-14's `useAutosave()` takes as an injected input (MVP-14 §6: "`settings.autosave` …
 * **you take it as an injected flag**"). PR-16 owns the value; PR-14 owns what is done with it.
 *
 * Anything that hosts an editor calls this and passes the result down, which is the only wiring the
 * engine needs: `useAutosaveEnabled()` re-renders its caller the moment the cache entry changes —
 * including the optimistic write from `usePatchSettings()`, which is what makes the toggle effective
 * in an already-open editor instead of on the next navigation.
 */
export function useAutosaveEnabled(): boolean {
  return useSettingsQuery().data?.autosave ?? DEFAULT_SETTINGS.autosave;
}

/** The stored theme, which is `system` until the server says otherwise (MVP-16 §5). */
export function useSettingsTheme(): SettingsTheme {
  return useSettingsQuery().data?.theme ?? DEFAULT_SETTINGS.theme;
}

/**
 * What the page needs beyond the value: whether the row is still loading, whether the failure is
 * the kind a person can act on, and — the one that is easy to leave out — **whether there is a row
 * at all to keep showing**.
 *
 * React Query v5 sets `isError` for a failed *background refetch* while keeping `data`, and this
 * screen refetches after every `PATCH` (`use-patch-settings` invalidates in `onSettled`), so
 * `isError` alone cannot be read as "nothing to show". The page's rule is therefore
 * `isError && !hasData`: a row that exists stays on screen (see `settings-page.tsx`, where the
 * failed refresh gets its own note instead of replacing four working controls and throwing away
 * half-typed passwords).
 *
 * PR-09's get-or-create means a fresh account never lands on the failure path; a `401` (signed out
 * in another tab) and a `5xx` do, and both get the same "try again" affordance.
 */
export interface SettingsStatus {
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** `false` only before the first response has ever landed, or after a failure that cleared the row. */
  readonly hasData: boolean;
  readonly error: unknown;
  /**
   * Invalidates the settings row so it refetches — the "try again" button's whole job. It marks the
   * entry stale rather than evicting it, so the row stays readable (and `hasData` stays `true`) while
   * the retry is in flight: a retry that blanks the screen it is standing on would be a worse one.
   */
  readonly retry: () => void;
}

export function useSettingsStatus(): SettingsStatus {
  const query = useSettingsQuery();
  const queryClient = useQueryClient();
  return {
    isLoading: query.isPending,
    isError: query.isError,
    hasData: query.data !== undefined,
    error: query.error,
    retry: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  };
}
