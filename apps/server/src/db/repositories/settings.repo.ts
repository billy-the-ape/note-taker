/**
 * The settings repository — the only place `settings` is read or written (docs/plans/mvp/MVP-09.md §5.7;
 * the row itself is created beside its user by PR-07's `insertUserWithSettings`).
 *
 * `docs/DATA-MODEL.md §2` calls this the "one-to-one of `users`" and there is **no trigger** in the schema, so
 * a row can legitimately be missing: PR-04's fixtures, a restore from a backup, or a seed that inserted a user
 * on its own. The plan's answer (§9.2 #22, and `packages/contracts/src/settings.schemas.ts`, which says so
 * outright) is that **neither settings endpoint can 404**, so every read here get-or-creates and every write
 * ensures first. That is why there is no plain `selectSettings` exported: a caller that forgot to ensure would
 * be one missing row away from the 404 the contract forbids, and this file is where that is decided.
 *
 * One row, one user id, and `user_id` is the primary key, so there is nothing to scope by beyond it — the
 * `userId` always comes from the resolved session, never from the request body.
 */

import type { SettingsTheme } from '@note-taker/contracts';
import { eq } from 'drizzle-orm';

import type { DbOrTx } from '../client.js';
import { expectOne, firstOrNone } from '../rows.js';
import { type Settings, settings } from '../schema.js';

/**
 * The columns `PATCH /api/settings` may change; an absent one keeps its value.
 *
 * The `| undefined` on both is what `exactOptionalPropertyTypes` requires of a value that came from
 * `patchSettingsSchema.parse(body)`, where Zod's `.optional()` means the key may be present and undefined; the
 * `theme` type is the contract's union rather than the column's `text`, so a caller cannot offer a fourth value
 * and discover `settings_theme_check` at runtime.
 */
export interface PatchSettingsInput {
  readonly userId: string;
  readonly autosave?: boolean | undefined;
  readonly theme?: SettingsTheme | undefined;
}

/**
 * Creates the row if it is missing, with the column defaults.
 *
 * `on conflict do nothing` rather than a read-then-insert: two requests from a user whose row a restore left
 * out must not both conclude "absent" and race to insert; one wins, the other's conflict is *the success case*,
 * and `users_one_owner_uidx`-style surprises cannot happen on a primary key.
 */
export async function ensureSettingsRow(db: DbOrTx, userId: string): Promise<void> {
  await db.insert(settings).values({ userId }).onConflictDoNothing({ target: settings.userId });
}

/**
 * The caller's settings, creating the row when it is not there.
 *
 * @returns the row **after** the ensure, always. Reading it back rather than returning an in-memory default is
 *   what keeps `updatedAt` honest: the database's `defaultNow()` is the timestamp the client is told about.
 */
export async function getOrCreateSettings(db: DbOrTx, userId: string): Promise<Settings> {
  await ensureSettingsRow(db, userId);
  const found = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  return expectOne(found, 'select from settings after ensure');
}

/**
 * Applies a patch, on a row that may not exist yet.
 *
 * The ensure is not redundant with {@link getOrCreateSettings}: `PATCH` is a legal first call (a client that
 * toggles autosave before it ever loads the settings screen), and updating a row that is not there would be a
 * zero-row write reported as success.
 *
 * @returns the updated row, or `undefined` when the user stopped existing mid-request — the session guard
 *   already vouches for the caller, so this is the race and not the ordinary path.
 */
export async function patchSettings(db: DbOrTx, input: PatchSettingsInput): Promise<Settings | undefined> {
  await ensureSettingsRow(db, input.userId);
  const patch: Partial<typeof settings.$inferInsert> = { updatedAt: new Date() };
  if (input.autosave !== undefined) patch.autosave = input.autosave;
  if (input.theme !== undefined) patch.theme = input.theme;

  const updated = await db.update(settings).set(patch).where(eq(settings.userId, input.userId)).returning();
  return firstOrNone(updated);
}
