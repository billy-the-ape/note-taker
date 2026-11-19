import { defineConfig } from 'drizzle-kit';

import { databaseUrl, loadDevEnvFile } from './src/env.js';

/**
 * drizzle-kit configuration (docs/plans/mvp/MVP-04.md §5).
 *
 * **These two calls are load-bearing and must stay at the top of this file.** drizzle-kit never imports
 * `src/env.ts` on its own, so without them `pnpm db:generate` / `pnpm db:migrate` would build a DSN from
 * whatever the shell happened to export and would ignore an edited repo-root `.env`. They are also why
 * `db:generate`/`db:migrate` declare their mode inline (`NODE_ENV=development drizzle-kit …`):
 * `loadDevEnvFile()` is a no-op unless the *process* `NODE_ENV` is `development`/`test`, and
 * `databaseUrl()` refuses to derive a DSN without a mode (plan §16). Run drizzle-kit without that mode —
 * `env -u NODE_ENV pnpm exec drizzle-kit migrate` — and it exits non-zero naming `NODE_ENV`, which is the
 * regression test for the loader.
 */
loadDevEnvFile();

export default defineConfig({
  // The schema is the single source of truth; `migrations/` is the committed SQL it generates.
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  // `generate` never connects, but resolving the DSN here is the point: an unresolvable configuration
  // fails the same way in both commands.
  dbCredentials: { url: databaseUrl() },
});
