/**
 * Per-user settings (docs/plans/mvp/MVP-05.md §7, plan §9.2 #22 and §8's `settings` table).
 *
 * `GET`/`PATCH /api/settings` land in **PR-09**, not PR-16, because PR-14's autosave engine needs the
 * flag before there is a settings screen. The row itself is created with the user by PR-07, and
 * `settings.service.get()` get-or-creates, so neither endpoint can 404.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './api-envelope.js';

/** The three themes of §8's `CHECK` constraint; `system` follows the OS and is the default. */
export const settingsThemeSchema = z.enum(['system', 'light', 'dark']);
export type SettingsTheme = z.infer<typeof settingsThemeSchema>;

/** The `Settings` row as the API returns it. `userId` is deliberately absent: it is the caller. */
export const settingsSchema = z.object({
  /** Autosave on/off; `true` by default, because the README asks for autosave that is simply on. */
  autosave: z.boolean(),
  theme: settingsThemeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * `PATCH /api/settings`. Partial, but never empty: an empty body would answer `200` with the
 * unchanged row and a UI would conclude the toggle it just sent had stuck.
 */
export const patchSettingsSchema = z
  .object({
    autosave: z.boolean().optional(),
    theme: settingsThemeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.autosave === undefined && value.theme === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'must change autosave and/or theme' });
    }
  });
export type PatchSettingsRequest = z.infer<typeof patchSettingsSchema>;
