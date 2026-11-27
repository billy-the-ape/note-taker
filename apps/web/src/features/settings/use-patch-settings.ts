/**
 * The only write of the settings row (docs/plans/mvp/MVP-16.md §5).
 *
 * Optimistic, and that is not a decoration: the criterion this file exists for is "toggling autosave
 * off takes effect **immediately** in the open editor". A mutation that waited for `PATCH
 * /api/settings` would leave the editor debouncing for the length of a round trip, and a flaky
 * connection would make the toggle look broken rather than merely slow. So:
 *
 * 1. `cancelQueries` first, so an in-flight `GET` cannot land *after* the optimistic write and
 *    repaint the value the person just changed back.
 * 2. `setQueryData` writes the patch into the same cache entry every consumer reads, which is what
 *    re-renders the toggle, the theme, and (via `useAutosaveEnabled()`) an open editor in one pass.
 * 3. `onError` puts back exactly the row that was there before. A toggle that silently un-told the
 *    editor it had turned itself off is worse than a toggle that failed.
 * 4. `onSettled` invalidates `['settings']` — the key PR-05 pinned in `lib/queryClient.ts`, with no
 *    new key and no new store (MVP-16 §5: "Cache keys stay `['settings']`") — so the server's
 *    `updatedAt` and any concurrent change win over the invented one.
 */

import type { PatchSettingsRequest, Settings } from '@note-taker/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiClient } from '../../lib/api-client-context.js';
import { queryKeys } from '../../lib/queryClient.js';
import { patchSettings } from './settings.api.js';
import { DEFAULT_SETTINGS, nowIso } from './use-settings.js';

/** What a successful/failed patch leaves behind: the row that was cached when the patch started. */
interface PatchContext {
  readonly previous: Settings | undefined;
}

export function usePatchSettings() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<Settings, Error, PatchSettingsRequest, PatchContext>({
    mutationFn: (patch) => patchSettings(client, patch),

    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings });
      const previous = queryClient.getQueryData<Settings>(queryKeys.settings);
      queryClient.setQueryData<Settings>(queryKeys.settings, (current) => {
        // No row yet means the read has not landed, which only happens on a screen that is still
        // showing its skeleton; write the server's defaults under the patch rather than nothing.
        const base = current ?? DEFAULT_SETTINGS;
        // Written field by field rather than spread, because `patchSettingsSchema` allows a body with
        // one key and `{...base, ...patch}` would let the absent key's `undefined` win.
        return {
          autosave: patch.autosave ?? base.autosave,
          theme: patch.theme ?? base.theme,
          updatedAt: nowIso(),
        };
      });
      return { previous };
    },

    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.settings, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
