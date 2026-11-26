/**
 * The two lines of the settings API this app needs before there is a settings screen
 * (§9.2 #22 of docs/API.md; docs/plans/mvp/MVP-14.md §2).
 *
 * PR-14 is the reason `GET /api/settings` has a client at all: the autosave engine takes
 * `autosave: boolean` as an **injected** input, and the caller that injects it needs somewhere
 * honest to get it from. PR-16 builds the toggle and the rest of the screen on top of this file — the
 * read and the cache key are here so that a page which only wants the flag does not have to own a
 * query, and so PR-14's editor and PR-16's toggle can never disagree about which row is the truth.
 *
 * The default is the load-bearing part. The endpoint get-or-creates (PR-09: a caller with no row
 * reads the column defaults with `200`), so the only ways to see no row here are a request in flight
 * and a request that failed — and a note whose autosave quietly turned itself off because a settings
 * `GET` was slow is precisely the silent behaviour the README's "autosave that is simply on" rules
 * out. So {@link autosaveFlag} answers `true` for `undefined`, and a slow or dead settings read costs
 * a debounce window, never the feature.
 */
import { ROUTES, type Settings, settingsSchema } from '@note-taker/contracts';
import { queryOptions } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';

/** What this app does with "no answer yet": on. The plan's default, not a coin flip. */
export const AUTOSAVE_DEFAULT = true;

/** `GET /api/settings`. Never a 404 (get-or-create), so no "settings missing" state reaches the UI. */
export function fetchSettings(): Promise<Settings> {
  return api.json(ROUTES.settings, { schema: settingsSchema });
}

export function settingsOptions() {
  return queryOptions({ queryKey: queryKeys.settings, queryFn: fetchSettings });
}

/** The flag out of a row, with the default for `undefined`. Pure, so the rule has a test of its own. */
export function autosaveFlag(settings: Settings | undefined): boolean {
  return settings?.autosave ?? AUTOSAVE_DEFAULT;
}
