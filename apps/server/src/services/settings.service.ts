/**
 * The settings service: `GET`/`PATCH /api/settings` (docs/plans/mvp/MVP-09.md §5.7, plan §9.2 #22).
 *
 * Three lines of behaviour, and the interesting part is what is *not* here:
 *
 * * **No 404 is possible.** `settings` has one row per user, created beside the user by PR-07 — but PR-04's
 *   fixtures, a restore, or a seed that inserted a user directly can all leave it out, and the contract says a
 *   settings request may not fail because of that. So both methods go through
 *   {@link getOrCreateSettings}/{@link patchSettings}, which ensure first, and this service never sees an
 *   "not found" it has to answer.
 * * **No `userId` anywhere in the response.** The contract's `settingsSchema` has no `userId`: the caller *is*
 *   the user, and the id the service uses comes from the resolved session, never from the body.
 * * **No theme validation here.** `patchSettingsSchema` in `@note-taker/contracts` owns the enum, and the
 *   database's `CHECK` constraint owns it again; a third copy in a service is one drift away from a lie.
 *
 * `updatedAt` is the database's, assigned by the update, so a `PATCH` that changes nothing visible still reports
 * the write it performed.
 */
import type { Settings, SettingsTheme } from '@note-taker/contracts';

import type { Db } from '../db/client.js';
import { getOrCreateSettings, patchSettings } from '../db/repositories/settings.repo.js';
import { NotFoundError } from '../domain/errors.js';

export interface SettingsService {
  /** The caller's settings, creating the row when it is missing. */
  readonly get: (input: { readonly userId: string }) => Promise<Settings>;
  /**
   * Applies a patch (at least one field, which the contract's schema already insists on). The `| undefined` is
   * `exactOptionalPropertyTypes` meeting a parsed body, where a key may be present with no value.
   */
  readonly patch: (input: {
    readonly userId: string;
    readonly autosave?: boolean | undefined;
    readonly theme?: SettingsTheme | undefined;
  }) => Promise<Settings>;
}

/** The DB row → the API row: `userId` out (the caller is the user), timestamps as ISO strings. */
export function toSettings(row: {
  readonly autosave: boolean;
  readonly theme: string;
  readonly updatedAt: Date;
}): Settings {
  return { autosave: row.autosave, theme: asTheme(row.theme), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The column's `text` back to the contract's three values.
 *
 * `settings.theme` is a `text` with a `CHECK (theme in ('system','light','dark'))` rather than a Postgres enum
 * (PR-04's §2: no enum, so a value can be added by a migration without a type rewrite), so drizzle hands this
 * file a `string` and *something* has to re-narrow it. Doing it by assertion rather than by a `switch` that
 * throws is the honest choice: the constraint is the rule, it is enforced on every write, and a branch that
 * returns `NOT_FOUND`-ish garbage for a value the database refuses to store would be theatre. A row that somehow
 * bypassed the CHECK (a hand-restored dump) fails the response's contract validation in the client, which is a
 * louder failure than a silent default to `'system'`.
 */
function asTheme(value: string): SettingsTheme {
  return value as SettingsTheme;
}

/** Builds the service over one pool; `buildApp()` registers one per process. */
export function createSettingsService(options: { readonly db: Db }): SettingsService {
  const { db } = options;

  return {
    async get({ userId }) {
      return toSettings(await getOrCreateSettings(db, userId));
    },
    async patch({ userId, autosave, theme }) {
      const updated = await patchSettings(db, { userId, autosave, theme });
      // The only way this is missing is the user's row being deleted while the request ran; the session guard
      // vouched for them a moment earlier, so it is the race rather than a caller error, and `NOT_FOUND` is the
      // honest answer to "who am I setting this for".
      if (updated === undefined) throw new NotFoundError('settings');
      return toSettings(updated);
    },
  };
}
