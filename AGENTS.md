See @README.md for initial pre-MVP information about this repo. 

- When making changes, keep any relevant docs & agent instructions correct, in the same PR where changes are made.
- MVP work breakdown: the plan of record is `docs/plans/mvp/MVP-FULL-PLAN.md`; each PR also has a self-contained work
  order at `docs/plans/mvp/MVP-NN.md` (index: `docs/plans/mvp/README.md`). Work those briefs in dependency order, keep
  the briefs and the plan in sync when a decision changes, and never start the post-MVP backlog (PR-21+) before PR-20
  merges.

## Commands

Available since PR-01 (Node 22 — see `.nvmrc` — and pnpm, pinned by `packageManager`):

| Command             | What it does                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm i`            | install the workspace (`apps/server`, `apps/web`, `packages/contracts`).                                                              |
| `pnpm dev`          | `build:packages` (compiles `packages/contracts` to `dist`, which both apps import), then every app's `dev` in parallel: API on `:3000` (`tsx watch`), Vite on `:5173` proxying `/api`. |
| `pnpm build`        | `build:packages` first, then `tsc` → `apps/server/dist` (no bundler), `vite build` → `apps/web/dist`.                                   |
| `pnpm lint`         | Biome checks: lint + formatting + import sorting.                                                                                       |
| `pnpm format`       | Biome rewrites the same.                                                                                                               |
| `pnpm typecheck`    | `tsc --noEmit` in every package; resolves `@note-taker/contracts` from its `dist`, so it only passes once `build:packages` has run. |
| `pnpm test`         | Vitest unit suites (`src/**/*.test.{ts,tsx}`, `*.int.test.ts` excluded).                                                                |
| `pnpm coverage`     | The same with v8 coverage — this is what the `unit` CI job (PR-03) runs, so keep its thresholds in the Vitest configs, not in CI flags. Its scopes are at plan §14's **post-PR-19 column**: `packages/contracts` 95/95/95/95, `apps/server/src/{crypto,domain}` (and `src/db/rows.ts`, measured with them) 85/85/85/85, `apps/web/src/lib` 85/85/85/85 and overall `apps/web/src` 65/65/65/65. PR-06 armed the first at 80/80/75/80 and PR-19 raised all of them; a scope that cannot meet its floor gets tests, never a lower number. |
| `pnpm test:integration` | The `*.int.test.ts` suite (`apps/server/vitest.integration.config.ts`, PR-04) — the only suite that touches a database, so `make db-up` first. `src/test/setup.ts` applies the committed migration, then `resetDb()` truncates between tests, and the files run one at a time. It boots the app under test, which imports `@note-taker/contracts` from its `dist`, so `pnpm build:packages` (PR-05) has to have run. |
| `pnpm coverage:integration` | The same with `--coverage`. This is what the `integration` CI job (PR-04) runs, and the `apps/server/src/{db,services,routes}` thresholds (plan §14's 80/80/75/80 — `db` armed by PR-04, `services`/`routes` by PR-09, **all raised to 85/85/85/85 by PR-19**) live in that config too, never in a CI flag. |
| `pnpm test:e2e` | The Playwright suite and the MVP acceptance proof (PR-19 — `apps/web/playwright.config.ts`, `apps/web/e2e/*.spec.ts`): `pnpm build` first, then `NODE_ENV=test node apps/server/dist/index.js` is started as the `webServer`, so the browser is driven against the **compiled** app on the **one port** PR-18 ships (the SPA is served by PR-12's `static-spa`, the migration runs before `listen()`), against a throwaway Postgres. It needs a database and a browser: `make db-up` plus `pnpm --filter @note-taker/web exec playwright install chromium`. Local settings come from `process.env` → the gitignored repo-root `.env.test` (`DATABASE_URL`, `NOTE_ENCRYPTION_KEY`) → the throwaway defaults in `e2e/env.ts`; the CI `e2e` job supplies the same two values as job env, because the key is a non-secret test constant, not a secret. See the rules below before adding a spec. |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit (PR-04), run in `apps/server`: generate the SQL into the committed `apps/server/migrations/`, or apply it. Both need a running Postgres; neither needs a `.env`. There is **no `db:push`**, by design (plan §5): the migration history is what ships. |
| `pnpm db:seed` | The demo tree, idempotently (PR-09 — `apps/server/src/scripts/seed-demo.ts`, run with `NODE_ENV=development tsx`): the owner, the nested folders and the notes, **sealed with the keyring of the process that runs it** rather than a test key, and readable by the app afterwards. Needs a running Postgres; refuses `NODE_ENV=production` before it builds a keyring or opens a pool. It never truncates and never reseeds — a run reports `created`/`kept` per folder and note, so a second run on edited content is a no-op — and the password it prints is stored only as its argon2 hash. `src/scripts/seed-demo.int.test.ts` proves both halves. |
| `pnpm generate:key` | Prints a fresh 32-byte note-encryption key as base64 on stdout, for `NOTE_ENCRYPTION_KEY` (PR-06, dev/CI only — root `scripts/generate-keys.ts`, run through the server workspace's `tsx`). A production host generates its key with the `docker run --rm node:22-slim node -e '…randomBytes(32)…'` one-liner instead, which PR-18's runbook documents. |
| `pnpm check:env` | The production `.env` preflight (PR-18 — root `scripts/check-env.ts`, `NODE_ENV=production tsx`, which reads `DOTENV_PATH ?? <repo root>/.env` **as text with its own parser**). It is a linter, not a boot path: `loadDevEnvFile()` is a no-op in `production` by design and it would judge the shell rather than the file, so the preflight could not tell an operator anything about the file they were deploying. Its rules are `env.ts`'s production invariants plus the DSN carve-out (`check-env.ts`'s header): the file may carry `DATABASE_URL` **or** the `POSTGRES_*` trio, fails only with neither, warns when both disagree. Exit 1 on any problem. Nothing it reports is a secret: every value is reported by shape and length (`previewValue`, `previewLine`, `safeName`, `safeTag`, behind `looksLikeMaterial`), **whatever variable the value was typed into** — a key pasted into `SECURE_COOKIES`, or left on a line of its own (which parses as a variable *named* after the key), is still a key, and the failure output is pasted into tickets. `docs/DEPLOY.md` §4 is the table it enforces, and CI asserts all four fixtures, including that the two redaction ones still *fail* while printing neither the fixture key nor its first 20 characters. Because it reads only `.env`, an installation on §3's mounted-key variant is reported as keyless **by design**; §3 states the two ways to reconcile that, and which one you are on. |
| `make prod-up` / `prod-down` / `prod-ps` / `prod-logs` / `prod-build` / `prod-config` | The production stack (`docker/compose.yml` + `docker/Dockerfile`, PR-18): `db` + `app`, **one** published port (`${HOST_PORT:-3000}:3000`), database unpublished, migrations run inside the app before `listen()`. `prod-config` is the parse-time preflight that fails naming `NOTE_ENCRYPTION_KEY` without contacting the daemon. `docs/DEPLOY.md` is the runbook and pins the same invocation; these targets are that command behind `make`, and unlike `db-*` they do **not** depend on `bootstrap-env`, because a production `.env` is generated (§2) and a copied `.env.example` has no key. |
| `make db-up` / `db-down` / `db-reset` | Dev Postgres 16 in Docker (`docker/compose.dev.yml`, PR-02): start it (and wait for healthy), stop it, or recreate it with its volume. `make dev`/`build`/`test`/`coverage` are the `pnpm` equivalents behind one interface, and `make bootstrap-env` only creates `.env`. The database commands are `pnpm`-only (`pnpm db:generate`, `pnpm db:migrate`); `make` has no `db:*` target for them, and `pnpm db:seed` (PR-09) is a pnpm script for the same reason. |

- **Compose is always invoked with both flags, from the repo root**:
  `docker compose --env-file .env -f docker/compose.dev.yml <up|down|…>` (and, since PR-18,
  `… -f docker/compose.yml <up|ps|exec|run|config|…>`). Compose resolves its project directory from the
  compose file's location, so `-f docker/compose.dev.yml` alone would load `.env` from `docker/` instead of
  the repo root, and a missing `--env-file` path is a hard error. The `Makefile` pins the invocation so nobody
  has to remember it, and PR-18 copies the rule verbatim: `docker/compose.yml`'s header, `docs/DEPLOY.md` and
  `make prod-*` all spell the same command, so a runbook cannot quietly grow a one-flag version of it.
- **`.env` is bootstrapped, never assumed**: `make bootstrap-env` runs `test -f .env || cp .env.example .env`,
  and every target that passes `--env-file .env` (`db-up`, `db-down`, `db-reset`, `dev`) depends on it. Only
  `.env.example` is committed — dev defaults (`POSTGRES_*`, `HOST_PORT`) and, deliberately, **no
  `DATABASE_URL`**, so `databaseUrl()` derives it and one `POSTGRES_PORT` edit moves the container and every
  host process together.
- **No `.env` is needed.** `pnpm dev` boots from a bare clone; `cp .env.example .env` is only for overriding something.
- **`NODE_ENV` is required and never defaulted** (`env.ts` fails in every mode without it). Every host script that reads
  env declares its own mode on its own command line (`NODE_ENV=development tsx …`, `NODE_ENV=test vitest …`); a line in
  `.env` can never supply it. Never paper over a missing value with a default.
- **There is no plaintext mode, and `crypto/keys.ts` is the only way to get a key** (PR-06): `buildKeyring()`
  reads `NOTE_ENCRYPTION_KEY` (base64, 32 bytes) — or `NOTE_ENCRYPTION_KEY_FILE`, so a mounted secret file works
  without shell interpolation — plus `NOTE_ENCRYPTION_KEY_PREVIOUS` (JSON `{"1":"<base64>"}`, decrypt-only) and
  **`NOTE_ENCRYPTION_KEY_VERSION`** (default `1`). The current version *is* that variable and is never derived as
  `max(previous)+1`, which would silently orphan every row tagged 2 the moment the map is emptied. A
  configured-but-broken key is a boot failure in **every** mode; only development and test, with nothing
  configured at all, may generate a key and persist it to `.dev/note-key` (mode `0600`, gitignored, so dev rows
  survive a restart), and `production` refuses to start. The keyring logs a fingerprint (first 8 hex of its
  sha256) so an operator can tell which key a database was written with. `apps/server/src/crypto/envelope.ts`
  owns the envelope's shape (`AES-256-GCM`, AAD `note:<uuid>`, tag appended); `notes.repo.ts` stores the sealed
  triple it is handed and never sees plaintext or a key.
- **Key rotation is one script, and it ships inside the image** (PR-06):
  `apps/server/src/scripts/rotate-note-key.ts` (`--dry-run`, `--verify`) lives under the server workspace on
  purpose, so `pnpm build` emits `apps/server/dist/scripts/rotate-note-key.js` for PR-18's image to run inside
  the container. Its dependencies are the shipped ones — `env.ts`, `db/client.ts`, `crypto/*`, `logger.ts` — and
  never `src/test/**` or the root `scripts/`. Per batch it takes `SELECT … FOR UPDATE`, then writes conditionally
  (`WHERE id AND version AND key_version`), re-reads instead of re-using a buffered ciphertext when that write
  matches nothing, and **never bumps `notes.version`** — rotation is not a content edit. In integration tests it
  is driven as a `tsx` subprocess with `NOTE_ENCRYPTION_KEY_VERSION=2` and the old key in `_PREVIOUS`, because
  editing `.env` and restarting the app are operator steps a script cannot do to its own container.
- **The e2e suite drives the compiled app, and says what it cannot drive** (PR-19): specs select only through
  `data-testid`s (the rule from the testing strategy — every element a UI test needs has a hook; if one is
  missing, **add the hook in the PR that needs it**, never a structural selector), the `webServer` is the compiled
  entry with `NODE_ENV=test` (not `tsx`, not Vite dev), `workers: 1` because the suite owns one database and
  `e2e/reset.ts` truncates it per file the way `resetDb()` does for the integration suite, and `e2e/db.ts` — the
  scenario-7 reader, on `postgres` (postgres.js) at **PR-04's pinned version** as a devDependency of `apps/web`,
  because pnpm does not expose one workspace's dependencies to another and the assertion must not drift onto a
  second driver — is read-only down to `SET TRANSACTION READ ONLY`, so nothing that reads a row can write one.
  A scenario that has no element to happen to is `test.fixme` with the missing file named in its title, never a
  passing test that asserts nothing and never a deletion: today those are the editor scenarios (`routes/app/note/$noteId.tsx`,
  PR-13) and the new-note dialog's own fields (`useNewNoteDialog()` is merged but mounted by nobody). Deleting a
  `fixme` is how PR-13 finishes its own acceptance; scenario 7 — "DB rows are ciphertext", the DB leg of the MVP
  proof — may never be skipped or `fixme`'d, and a run where it does not execute is a red build.
- **Scripts that do not exist yet stay that way**: nothing is outstanding — `check:env` arrived with PR-18 and
  `test:e2e` with PR-19, each in the PR that created the files it runs. Adding a script before those exist is a
  plan violation, and so is adding one that cannot go green.
- **Folder mutations are serialized per user, and ids in bodies are checked before they are written** (PR-09):
  every `create`/`rename`/`move`/`delete` in `services/folder.service.ts` runs in one transaction that starts with
  `takeFolderMoveLock(userId)` — `pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))` — and
  only then runs `isDescendantOrSelf()` plus the depth arithmetic. A new folder write that skips the lock is not
  "the same thing minus a line": two moves of disjoint pairs commit a four-node cycle through it, which is asserted
  both ways in `services/folder.service.int.test.ts`. Second half: a `folderId`/`parentId` that arrives in a **body**
  is resolved with `folderById`/`noteById` scoped to the caller *before* the insert or update, and answered
  `404 NOT_FOUND` — never a `500` from `23503`, and never a `403` that would confirm the id exists. The route
  handlers stay thin: ownership, cycles, the 100-level cap and the envelope failures are decided in the service,
  and `plugins/error-handler.ts`'s `mapError()` is the one place a status is chosen.
- **A delete's emptiness gate locks the folder row, and a generated name never conflicts** (PR-09): the advisory
  lock above serializes folder mutations against each other, but a note `INSERT` takes no such lock — it takes the
  `KEY SHARE` on the folder row that every foreign-key insert takes. So `remove()` in `services/folder.service.ts`
  calls `lockFolderRow()` (`SELECT … FOR UPDATE`, which answers the ownership question with `404` in the same
  statement) **before** `countChildren()`/`countNotesInFolder()`. Count first and the gate can answer "empty" about
  a folder someone is writing into; the `DELETE` then waits on that same `KEY SHARE` only after the gate opened, and
  cascades over the row that won — a `204` for a delete that destroyed a note whose `POST` had returned `201`. Do
  not "simplify" that read back into `folderById`. Both races are asserted in
  `services/folder.service.int.test.ts`. Second half: a unique violation on a **generated** `new-file-<msepoch>`
  name is re-picked with a fresh read (`GENERATED_NAME_ATTEMPTS` in `services/note.service.ts`) and never answered
  `409` with a stranger's id, because a generated name is the one name the server may change (§5.5); a name the
  client typed still clashes on purpose. Concurrent creates are asserted in `services/note.service.int.test.ts`.
- **The production image is four stages and the last one runs `node` and nothing else** (PR-18):
  `docker/Dockerfile` installs (dev deps included), builds **inside the image** (`rm -rf` the copied `dist`
  dirs, then the root `pnpm build`), prunes with `pnpm --filter @note-taker/server deploy --prod`, and the
  runtime stage copies only `node_modules`, `apps/server/{package.json,dist,migrations}` and `apps/web/dist`.
  It bakes `ENV NODE_ENV=production` (so the `env.ts` guard is always armed and nobody hand-sets a mode),
  runs as `USER node`, `EXPOSE 3000`, and healthchecks with a **Node `fetch`** — this image installs no download
  tool of its own, and the base's own layers are not knowable from `docker history` (whose layer *commands*
  mention `curl` because `node:22-slim`'s ancestors installed it), so "no toolchain in the runtime layer" is
  verified by walking `/app` inside a container (`docs/DEPLOY.md` §2 step 5: no tool by name anywhere; no `.ts`—
  source of ours, scoped to the payload paths the image ships, because third-party packages legitimately
  ship hundreds of their own; nothing under `/app` owned by the app user). A `command -v` loop is the tempting wrong version — it searches
  `$PATH`, which contains nothing under `/app`, so it prints `clean` whatever the image contains. **No `COPY` in
  the runtime stage takes `--chown=node:node`**: application code arrives root-owned and world-readable, so the
  process cannot rewrite the code it executes, and the runtime stage asserts `find /app -user node` is empty —
  which CI's `docker build` therefore checks, while §2 step 5 of the runbook is the same three checks for a
  human with a daemon. `docker/entrypoint.sh` is `exec node apps/server/dist/index.js` and nothing else: no pnpm,
  no tsx, no `.ts`. Env checking and migrations therefore happen **inside** the compiled bootstrap, before the
  port is bound. The pruned install must carry the **compiled** `@note-taker/contracts`
  (`package.json` + `dist/`, reached through `exports`) and the stage asserts that with Node's own resolver.
  `docker/compose.yml` publishes exactly one port (`${HOST_PORT:-3000}:3000`), pins `PORT=3000` and
  `NODE_ENV=production` in the app's `environment:` (which beats `env_file:`), composes
  `DATABASE_URL` with host `db`, and **the database publishes nothing** — `pg_dump`, `createdb` and `psql`
  all run through `docker compose exec -T db`. Operator scripts run as
  `exec app node apps/server/dist/scripts/rotate-note-key.js`; if one ever needs pnpm, tsx, a `.ts` entry or
  a published DB port, the fix is to move it under `apps/server/src/scripts/` and rebuild, never to add dev
  tooling to the runtime stage. **`.dockerignore` patterns are anchored at the context root** (learned in
  PR-16's review): unlike `.gitignore` they do *not* repeat at every level, so plain `node_modules` and `dist`
  matched only the root's while a workspace's real ones live under `apps/*/`, and `COPY . .` poured them over
  the image's own install — hence `**/node_modules`, `**/dist`, `**/*.tsbuildinfo`, with the Dockerfile's
  `rm -rf` of the dists demoted to the second line of defence. `docs/DEPLOY.md` is the runbook PR-18 owns: backups (with the key), the
  restore drill, rotation, password recovery, and the troubleshooting table. Its own commands are review
  targets, not decoration: they source `.env` before using `$VARS` (`--env-file` fills Compose's interpolation,
  never your shell), they print whole pino lines (pino writes `msg` last, so `grep -o 'keyring ready.*'` throws
  away `keyVersion` and `keyFingerprint`, the fields the text then tells you to compare), and §3 says up front
  what the section does to `pnpm check:env`.
- **The schema lives in one file and the docs follow it.** `apps/server/src/db/schema.ts` is the source of truth;
  a new column ships with its generated SQL in `apps/server/migrations/` in the same PR, and
  `docs/DATA-MODEL.md` (created by PR-04) is rewritten in that same PR — it is what PR-06/07/09/10 read.
  `pnpm db:generate` alone is not "shipped": the journal and the `.sql` must be committed, and the one hand-added
  statement above the generated block (`CREATE EXTENSION IF NOT EXISTS pgcrypto`, which drizzle-orm 0.45 cannot
  declare in `schema.ts`) must survive regeneration — drizzle-kit hashes applied files, so never rewrite one.
- **A DB-backed test is `.int.test.ts` and nothing else.** Unit configs exclude that suffix; the integration
  config is the only Vitest config that reads the DSN, its setup file applies the committed migration, and its
  files never run concurrently (one database, `resetDb()` in `beforeEach`) — concurrency *inside* one test is
  deliberate, because that is how the optimistic-locking race is proven.
- **The web unit env stays `node`; a DOM test opts in per file** (PR-16): `apps/web/vitest.config.ts` keeps
  `environment: 'node'` and every component test opens with `// @vitest-environment jsdom`, so PR-05's `lib/api.ts`
  suite keeps proving it needs no `document` — and keeps failing the moment one appears. The instruments a DOM test
  needs live in `apps/web/src/test/**` (excluded from coverage, like the server's `src/test/**`): a
  session-accurate fake API (a cookie jar per tab, its own `Set-Cookie` obeyed, and `holdNextPatch()` to keep a
  request in flight, which is the only honest way to assert "effective immediately"), a drivable `matchMedia`, and a
  `window.location` that records instead of navigating — "lands on `/login`" is asserted as the `assign('/login')`
  *instruction*, not an arrival, which keeps a settings test out of the router (PR-08's real `/login` and PR-19's e2e
  are where an arrival is worth proving). `apps/web/src/test/editor-harness.tsx` is a **stand-in for PR-14's autosave
  engine**: it is the only consumer of `useAutosaveEnabled()` inside these tests, and the round-trip assertions beside it
  are PR-16's acceptance evidence. PR-14 has since merged with its real engine (`features/notes/useAutosave.ts`, fed by
  `settingsOptions()` from `features/settings/settings.api.ts`); the harness stayed because these tests assert the *flag
  contract*, and the open follow-up is to cover those rows with the engine rather than keep two implementations.
- **A screen gates its error state on `isError && !hasData`, never `isError` alone** (PR-16): React Query v5 raises
  `isError` when a *background refetch* fails and keeps `data`, and settings invalidates after every patch — so
  `isError` usually means "these values may be stale", not "nothing loaded". Replace a working form with an error
  screen only when there is no row to show; otherwise say the refresh failed beside the controls (`/app/settings`'s
  `settings-refresh-error`). Silently stale is the other half of that same bug.
- **A `401` from a route that takes a credential in its body does not say what it means** (PR-16):
  `POST /api/auth/password` sits behind `guard.requireAuth`, so the *same* `401 UNAUTHORIZED` covers an
  expired session, a wrong `currentPassword`, and a session deleted mid-write (`docs/API.md` #9) — the code
  is derived from the status and only PR-07's prose differs, so neither a route exemption nor a message match
  is correct. `apps/web/src/lib/api.ts` asks `GET /api/auth/session` instead (`sessionGoneError`; #8 answers
  `{user:null}`, not `401`, so it cannot loop) and fires the app-wide expiry hook only when that says gone —
  an unanswered probe (network, `5xx`) is *not* evidence, per PR-08's "a dead API is explained by the page".
  A new authenticated credential route is added to `isCredentialBodyRoute`; a route whose `401` is only ever
  about the session must stay out, and the login family stays out because it has no session to be about.
- **Two mechanisms state a theme; one rule decides** (PR-16 + PR-08, settled at merge): PR-08's
  `components/layout/ThemeToggle.tsx` writes `data-theme` on `<html>` for *this* browser (localStorage, works signed
  out), and PR-16's `features/settings/theme.ts` writes `class="dark"`/`"light"` from the **account** setting —
  **one of the two, always written**, because the media-query block ends in `:not(.light)`: an absent `dark` is
  "ask the operating system", not light, so a stored `light` that only removed `dark` loses to a dark OS. They are
  different attributes, so CSS decides the tie-break: `styles/globals.css` lists the precedence (media query < class <
  `data-theme`) and the dark rule carries `:root.dark:not([data-theme="light"])` so an explicit per-browser choice is
  never silently beaten by the stored default. `SettingsEffects` is mounted by `routes/app/route.tsx`, not the root:
  only an authed page has a settings row, and PR-12 says the root owns no furniture. That mount is also why
  `useThemeSync` **removes both classes in its cleanup** — sign-out is a client-side navigation, and an account's
  `.dark` left on the document paints `/login` dark over the OS and the knob until a hard reload. Adding a third
  mechanism, or mounting the effects somewhere else, reopens the fight.


- `apps/web/src/routeTree.gen.ts` is generated by the TanStack Router plugin (by `pnpm dev`/`pnpm build`). Commit its
  diff; never hand-edit it.
- **`@note-taker/contracts` resolves from its `dist`, never from `src`** (PR-05): no `paths` mapping, no Vitest alias, no
  `development` export condition, so dev, CI, tests and the production image all resolve it the same way. Delete
  `packages/contracts/dist` and both apps stop resolving it, which is the proof that the step is load-bearing rather than
  a no-op: `pnpm build:packages` runs before `pnpm typecheck`, `pnpm test` and `pnpm coverage` (the root scripts do not
  prefix it themselves; CI's jobs run it as their first step, plan §14). While iterating on contracts, run
  `pnpm --filter @note-taker/contracts build -- --watch` in a fourth terminal. A
  contract test imports its own module side by side (`./names.js`), because a package cannot be the thing it tests.
- **The server's error plumbing exists once** (PR-05): `apps/server/src/domain/errors.ts` and
  `apps/server/src/plugins/error-handler.ts`, registered inside `buildApp()`. A route PR that needs a new mapping adds a
  case to `mapError()`; it never registers its own handler, and never throws a bare `Error` at the transport.
- **`docs/API.md` and `docs/NAME-RULES.md` are the prose half of the same contract** as `packages/contracts` (PR-05):
  change a payload, a code, or a name rule and change the doc in the same PR.
- **Dev knobs** (all optional, none of them a mode): `HOST` (default `0.0.0.0`, the container needs the wildcard),
  `PORT` (default `3000`), and `VITE_API_TARGET` when `:3000` is already taken on the machine, e.g.
  `HOST=127.0.0.1 PORT=3111 VITE_API_TARGET=http://127.0.0.1:3111 pnpm dev`.
- **Biome formats code, not prose or markup**: Markdown and YAML are excluded from `pnpm lint`/`pnpm format` on purpose
  (plan §6.4 keeps prose reformatting out of every later PR's diff), so `AGENTS.md`, `docs/plans/**` and any
  `*.yml` stay byte-for-byte as written.
- **Route guards live in the root route, once** (PR-08): `apps/web/src/routes/__root.tsx`'s `beforeLoad` awaits
  `guardNavigation(pathname)` in `src/features/auth/session.tsx`, which reads the auth snapshot out of the
  **`queryClient` singleton** under `queryKeys.authStatus` / `queryKeys.authSession` and applies the §4 table
  (`decideNavigation` is that table as a pure function — add a row there, never a per-page check). A page
  component never redirects: **PR-12 deleted `routes/welcome.tsx`**, PR-08's placeholder home, so every signed-in
  landing and redirect is `/app` and a bookmark to `/welcome` is just another unknown path that lands there. The
  guard failing is not an error — a dead API reads "signed out, nothing installed", which lands on `/login`,
  the one page that can then explain the dead network by trying.
- **`/app` is guarded as a subtree, and its layout is `routes/app/route.tsx`** (PR-12): the guard matches the
  prefix plus `/` (`isAppPath`), so `/app/settings`, `/app/search` and `/app/note/$noteId` need no route of their
  own to be let through — a per-page check for each child is what that rule exists to prevent. `routes/app/route.tsx`
  is TanStack Router's directory layout route (`__layout.tsx` is the Next.js habit the router does not read); it
  renders `AppShell` + `Sidebar` and every child renders `<Outlet/>` inside it. The `*` route must stay last in
  `routeTree.gen.ts` and `/apple` is asserted not to match `/app`.
- **`__root.tsx` owns no furniture** (PR-12 review, round two): the root layout is providers and a bare
  `<Outlet/>`. The centered column, wordmark and theme toggle that the three credential pages want live in the
  **pathless** `routes/_auth.tsx`, and `login/setup/signup` are its children (`routes/_auth/*.tsx`, paths still
  `/login` etc.). Root chrome over the shell squeezed `AppShell`'s full-viewport grid into a `max-w-2xl` column
  under a second header with a second `ThemeToggle` and a `<main>` inside a `<main>`; the fix is a sibling
  layout route, not a `pathname.startsWith('/app')` in the root, because that file's whole job is to make
  route-shaped decisions happen once. `routes/chrome.test.tsx` pins the count (one chrome wrapper, one header,
  one knob, one `<main>`, on both doors) because jsdom cannot see a width.
- **The API process serves the built SPA, and only when there is a build to serve** (PR-12):
  `apps/server/src/plugins/static-spa.ts` registers `@fastify/static` at `defaultWebDistRoot()` (or the
  `buildApp({ webDist })` override) **only if `<root>/index.html` exists**, and reports `{ served, root }` either
  way, so "no build yet" is an observable state rather than a crash. Three things are load-bearing there: it is
  registered **last** in `buildApp()` so route-shape conflicts fail loudly against the API's own routes; the
  fallback is `wildcard: false` (because `@fastify/static`'s default `prefixMatching: true` swallows every
  non-GET request whose path starts with a served path, `POST /api/notes` included) over
  **`SPA_SHELL_ROUTES`** — `/app` plus its subtree, and the top-level auth pages `/login`, `/setup`, `/signup`.
  That list is the server-side copy of the SPA's route surface and must match `apps/web/src/routes/`: a new
  *child* of `/app` needs nothing here, a new **top-level** route is added to the list or its reload answers a
  JSON envelope in a browser tab. It is a list rather than "any non-`/api` GET that accepts `text/html`"
  because everything outside it must keep answering the §9.1 envelope (a crawler and a mistyped `/app.ssh` both
  accept HTML), and `static-spa.test.ts` asserts both edges — every listed path serves the shell, and
  `/login/deep/child` is still a 404; and the fallback handler is `async` with an `await`ed `reply.send(readFileSync(index.html))`,
  because `send(createReadStream(file))` commits `200 text/html` before the file is opened, so an `index.html`
  that vanishes under a running process would arrive as an empty document *called* the app instead of the error
  envelope the handler still owns. A production host with no web build still boots and still answers `/api/*` —
  that is the self-host story PR-18 inherits.
- **The tree's rules live in selectors, not in components** (PR-12): `features/tree/tree.selectors.ts` owns the
  comparator (folders before notes, case-insensitive `name`, `id` tiebreak — the same three keys as
  `GET /api/tree`'s `ORDER BY`), the nesting (orphans are hoisted, never dropped; a cycle is a row that is not a
  folder), the visible flatten with its indent arithmetic (one `INDENT_REM` of padding per level, and the level
  is the server's `depth`: a 100-level chain costs 100 indents, which is the §9.2 #13 cap's problem, not the
  sidebar's, and nothing here re-derives it), the descendant set (legal-move pruning and the count a delete
  warning owes), the
  breadcrumbs and `recentNotes` (recency read from `GET /api/tree`'s `contentUpdatedAt` — PR-11 shipped no
  `/api/search/recent`, so the shell has one source for "which note is newest" and never re-derives it).
  `tree.mutations.ts` imports `moveIsBlocked` from that same module, so **an illegal move is refused before
  `fetch`** — the server stays the authority and still answers 409. Optimistic writes are
  `react-query`'s `onMutate` on `['tree', userId]`; each of `applyRename`/`applyMove`/`applyDelete` returns the
  *same object* when the id is not in the cache, which is what lets a mutation over live data stay a no-op
  rollback rather than inventing a row from the dialog's stale snapshot. A row is named by `<row>-<field>` and
  the field's problem by `<field>-error`, inline, always. A row is the only tab stop and the only key target,
  which is why the chevron inside a folder row calls `preventDefault()` on its **mousedown**: a `<button>` that
  takes focus on a click would park the keyboard on a `tabindex={-1}` control that answers nothing, and ↓/`F2`/
  `Delete` go silent until another row is clicked. `opensDeletedNote` is in the same module because the
  shell, not the tree, holds the opened note: a note delete clears it **only** when it names that note, and a
  folder delete clears it when the note sits in that folder or anywhere under it — the same closed set the
  cascade request destroys.
- **A 500-node sidebar has a render budget, and the tree pays for it in DOM nodes** (PR-12): §6's number is
  "500 nodes in < 150 ms", and `FolderTree.test.tsx` measures it honestly — the mount of the sidebar alone
  (`act`/`fireEvent`, never `userEvent`'s pointer polling or a `waitFor` tick), three cycles, **fastest** wins,
  beside a 50-row mount of the same component in the same process. Two things are asserted: the scaling of
  mount and of `flattenTree` against their 50-row figures (every environment, since instrumentation multiplies
  both sides of those divisions equally), and §6's absolute 150 ms on an **uninstrumented** run only — the
  `unit` CI job runs this file through `pnpm coverage`, where v8 instrumentation charges every function a row
  calls and the same tree reads ~1.9× slower (CI measured 191.7 ms of what this machine calls ~100 ms). Under
  coverage the absolute number is still logged with its verdict, so it is reported and never asserted falsely.
  `VITEST_COVERAGE=1` is set by `apps/web`'s own `coverage` script — a switch this repo owns, not a runner
  environment to sniff. 500 rows is ~100 ms in jsdom with three rules kept: a row is a plain `<div>` (`TreeRow`
  is not a component boundary), a **closed** row menu is `rowMenuTrigger(...)` — a called function, not a mounted
  Radix root — and a note row passes `leading={null}` instead of a spacer span per row. Adding a per-row
  component, context or wrapper node costs 500 of whatever it is; measure before adding one.
- **Tree UI tests drive a stateful fake, not a stub table** (PR-12): `src/test/treeApi.ts` is a folder/note model
  that enforces the server's rules — sibling uniqueness (409), the cycle block (409), the emptiness gate (409
  `that folder is not empty` unless `?cascade=true`), the generated `new-file-…` name — and exposes
  `tree()/set()/failOnce()/hold()/created()`. `bootAuth(path, { user, tree })` installs it as the **`fallback`**
  of `fakeApi`, so a test fails loudly when the client asks for a route that does not exist (a `null` stub would
  hang instead), and `hold()` is what lets a test watch the optimistic paint before the failure arrives. A plain
  route stub is still correct for the auth forms: the fake is for the one surface whose rules are worth failing
  over.
- **Web tests boot the whole app against a stubbed `fetch`** (PR-08): `src/test/{setup.ts,fakeApi.ts,authHarness.tsx,renderApp.tsx}`
  — `renderApp(path)` is `main.tsx` with a memory history, `bootAuth(path, install)` adds the auth routes with a
  *mutable* session (so a sign-out really ends it), and `noReply: ['login']` is how a test says "nobody answers
  that". The install stubs answer the way a server does, not the way the client hopes: a successful `setup` makes
  `GET /api/auth/status` report `needsSetup: false` **only on the next read**, so a form that keeps its cached
  answer for `staleTime` fails a test instead of shipping. Assert on `callsTo(fake, path)` when the *request* is
  the point. Default env is `node`, so every DOM file needs
  `// @vitest-environment jsdom` on line 1; `@testing-library/jest-dom` is deliberately **not** a dependency —
  assert on `textContent`/`getAttribute`/`.value`. Server state is TanStack Query, routing is the router, and
  `src/lib/uiStore.ts` is the tiny persisted-UI box (`nt.`-prefixed `localStorage`); there is no global client
  store, and PR-12 added its keys there (`theme`, `sidebarCollapsed`, `treeCollapsed` — the last a **sparse**
  `Set<folderId>` where a collapsed folder is a member and the root is always expanded, so a new folder is open
  and no empty folder costs a stored id) rather than inventing a fifth.
- **Autosave is one pure machine, and its in-flight snapshot is the contract** (PR-14): `apps/web/src/lib/autosave.ts`
  owns the note buffer (the editor renders `snapshot().buffer`) so a `VERSION_CONFLICT` can only ever be compared with
  **the exact request that went on the wire** — a retry re-sends those bytes and that `baseVersion`, never a fresh
  capture of the buffer, and an equal payload means "the write landed and the reply was lost": adopt the returned
  `version`, go `clean` or `dirty`, show no banner. Plain `CONFLICT` (a sibling-name clash, same 409) is never reacted
  to. **Nothing leaves while a reply is owed:** any flush arriving during a backoff — the debounce, the 10 s cap,
  `blur`, a note switch, an unmount, `Ctrl/Cmd+S` — re-sends that same request rather than capturing the buffer again,
  because newer text written against the abandoned `baseVersion` comes back as a `VERSION_CONFLICT` carrying *our own*
  earlier write (the phantom conflict this file exists to prevent) and would hand the spent retry budget back; such a
  flush only moves the replay earlier; a `Ctrl/Cmd+S` or `Retry` from the spent-budget `error` state is the
  one exception, because that row of §4 *is* a person deciding to try again — it re-funds the schedule and
  drops the stale failure, while a `blur` that lands there gets one more try and nothing else, and either
  way the message goes, since `saveStatusText` reads `failure` before `state` and would otherwise keep
  saying "Not saved — …" over a request that is on its way out. `adopt`/`keepMine`/`useServer` drop the owed replay, since each has just
  answered what the row holds. No second debounce window and no 10 s deadline is armed beside a scheduled replay,
  either, or §4's `1s,2s,4s,8s,30s` schedule stops being exact. And because `snapshot()` is cached with `notify()` the
  only thing that republishes it, **every** path that changes the buffer publishes — including the `stopped` and
  `conflict` paths, where an editor bound to `snapshot().buffer` would otherwise swallow the keystroke that woke it —
  while `dirty` keeps meaning "newer than the row", so undoing back to the saved text lands on `clean` instead of a
  pill reading `Unsaved changes` over a write that will never start.
  `features/notes/useAutosave.ts` is the only DOM-touching half — one machine per note id in a ref-`Map`, so a
  note switch runs the *outgoing* machine's cleanup and flushes the right buffer — and it installs `blur`,
  `visibilitychange`, `pagehide`, `beforeunload` and `Ctrl/Cmd+S`; `saveNow()` (the flag is a preference, not a
  disable-switch for saving) writes even with `settings.autosave === false`. The unload flush is
  `fetch(…, { keepalive: true })` with the ordinary CSRF header, and **`visibilitychange → hidden` uses that
  transport too** whenever the body fits **and nothing is owed** (a hidden trigger whose page survives the
  tab switch must not be the one that pre-empts a replay: the newest buffer on the old `baseVersion` comes
  back as a conflict about our own lost reply, on a page that is still open to show it). A closing tab hides
  *before* `pagehide`, so an ordinary `PUT` started on `hidden` would occupy rule 1, get aborted by the
  unload, and leave `pagehide` with nothing it may start — the keepalive path would then never run on a
  normal close, which is why the transport exists at all. §6's 60 KiB is a budget on the **request body**, measured
  with `contentWriteBytes` (`JSON.stringify({content, baseVersion})`), because escaping turns a 58 KiB buffer of
  quotes into a ~116 KiB body that `fetch` rejects before it leaves; `note.mutations.test.ts` pins the two-key shape
  that measure assumes. Over the budget nothing is attempted and the `beforeunload` guard — armed by exactly the
  negation of `unloadCarriesBuffer()`: clean, or the buffer leaving on `keepalive`, or `pagehide` still able to start
  it — is what protects the text, and an **ordinary** in-flight `PUT` never counts as carried, because the unload
  aborts it. **Never add `navigator.sendBeacon`:** it cannot set `X-CSRF-Token` (§6). The crash mirror is
  `lib/draft.ts` under `localStorage['note-draft:<id>']` — deliberately *not* a `uiStore` key, since it is a note body
  rather than a preference — and it is cleared only when it still holds the text being discarded, because the key is
  per-browser and tabs share it. That rule covers the *discard* button and the `404` "save as a new note" path too:
  the prompt does not lock the editor, so by the time either acts the mirror may hold a newer paragraph than the one
  being discarded or saved, and clearing it unconditionally would delete a crash fallback nobody has saved. `SaveStatus`/`ConflictBanner`/`DraftPrompt` in `components/editor` are allowed to say
  only what the machine knows: never `Saved` for a buffer that could not be flushed, and never a silent overwrite.
- **A note name is only ever as long as `lib/name.ts`** (PR-15): every name rule — the character set, the 120-char
  cap, `stripMd`/`withMd`, `uniquify`, the `new-file-<msepoch>.md` format — stays in `@note-taker/contracts`
  `names.ts`, and `apps/web/src/lib/name.ts` is the app's single import site for them (it re-exports the contract API
  and adds exactly three compositions: the field's error sentence, the prefill, and the request body's name). A
  component that restates a rule is the second authority PR-05 exists to prevent. In the new-note dialog the `.md`
  is a **sibling element, never a character**: the input's value is the editable name, so "the suffix cannot be
  edited or deleted" needs no `keydown` guard enumerating every way a character leaves a field — and the submitted
  name is `stripMd`'d anyway, because a pasted `report.md` is the one thing that can still get an extension into the
  value (`notes.name` is extension-free). Uniqueness is a **debounced read of `['tree', userId]`, with no extra
  endpoint**: a tab that has not fetched the tree simply has no opinion, which is why the `409 CONFLICT` — dialog
  stays open, text intact, the server's own sentence inline — is part of the feature. The created row enters the tree
  cache **on confirmation**, not on submit: `POST /api/notes` mints the UUIDv7, and an optimistic row with a
  client-invented id would put a `/app/note/<id>` link in the sidebar that 404s until the response lands.
  `NewNoteDialog.tsx` is driven by `useNewNoteDialog()` (`{ openFor, close, dialog }`), which is what PR-12's
  `TopBar`/`StatusBar`/tree-context-menu buttons call — those files are PR-12's, so PR-15 shipped the affordance and
  the three trigger shapes in `src/test/new-note-harness.tsx` rather than an app shell.
- **`Ctrl/Cmd+N` is bound by nothing, and a test proves it** (PR-15): Chromium opens a window/tab before any page
  handler sees the chord (Firefox/Edge reserve it likewise), so binding it would ship a shortcut that works in
  Firefox and silently does nothing in Chrome. `new-note-dialog.test.tsx` greps every non-test `.ts`/`.tsx` under
  `apps/web/src` for the chord and drives the key combination to show it opens, closes, and submits nothing.
  Keyboard users reach the dialog through its focusable buttons; a chord for it belongs with the palette backlog.
- **The caret after a create crosses the router through the cache** (PR-15): `openNoteInEditor()` marks
  `queryKeys.editorFocus` (`['editor-focus']`, holding the id this tab just created) and navigates, and
  PR-13's `routes/app/note/$noteId.tsx` asks `takesEditorFocus(client, noteId)` on mount. It is a **read, not a
  consume** — a one-shot take is eaten by the first pass of `main.tsx`'s `StrictMode` double mount, and a caret that
  only appears in production is the worse bug — and it is not a query parameter, because "created seconds ago" is a
  fact about the visit rather than about the note. Until PR-13's route exists the navigation is
  `navigate({ href: noteEditorHref(id) })`, because `to` is typed against a generated tree with no `/app/*` in it;
  `NOTE_EDITOR_PATH` is exported for the one-line swap when that file lands.
- **Search is two passes, and one documented asymmetry** (PR-11): `GET /api/search` answers metadata hits from SQL,
  which tests the *whole* corpus — `notes.repo.ts`'s `searchNotesByMetadata`, `ILIKE` on `lower(name)` and on every
  folder-name **segment** of the breadcrumb (not the joined path: `/` is a forbidden name character, so `a/b` should
  match nothing rather than every note under `a`), with `%`, `_` and `\` escaped by `likeContainsPattern()` so a
  search for `100%` means the discount — and body hits from `listRecentNotesForSearch`, which hands
  `services/search.service.ts` up to **500** of the caller's most recently updated notes *with their envelopes* so
  it can decrypt and match name, path and body. Both statements scope by `user_id`, so cross-user results are
  structurally impossible rather than filtered out, and the breadcrumb both of them join is
  `folders.repo.ts`'s `folderPathCte` — one walk, one definition of "this note's path", shared with `listFolderTree`.
  The window is the **scan bound**, not a page: `limit` cannot raise it (the contract caps results at 25, and the
  service re-bounds for a caller that reached it past the schema). The metadata statement has its own **row bound**
  too — at most 500 *matching* rows come back — and the only reason that can be said out loud is that the statement
  `order by name_matched DESC` **before** `content_updated_at DESC`: every name hit precedes every folder hit, so the
  cut lands on rows the endpoint would have ranked below the ones it kept, and the ≤25 it returns are the same 25
  whatever the bound allowed. Remove that tier term from the `ORDER BY` and 500 folder matches push an older name hit
  out before scoring ever sees it, which `notes.repo.int.test.ts` (statement level) and `search.service.int.test.ts`
  (a folder of 600 notes beside one old `work plan`) exist to catch. NFD accent folding (`foldKey`) runs **only in the
  in-process pass**, so `cafe` finds an in-window `café` and misses an out-of-window one; `docs/API.md` #21 states
  the rule, `search.service.int.test.ts` pins both halves (including the miss, so the gap cannot be "fixed" by a
  quiet `unaccent` — that is backlog PR-29's folded column). `score` is a **tier** (`name 2 > body-or-path 1`), with
  ties falling to `content_updated_at DESC` then `id`; a snippet is ≤120 **code points** of plaintext around the
  match — never a UTF-16 slice, which is how an emoji gets cut in half — and `''` when the match was not in a body.
  A note whose envelope will not open is **skipped from both passes**, its ids logged on the request's logger (the
  line the envelope's `x-request-id` points at), and the request still answers `200`: never `500`, never blank or
  garbage text standing in for an unreadable body. The one honest exception is an *out-of-window* corrupt body,
  which the metadata pass can name without ever decrypting it — that is the same fact as "search needs no key for
  names", and `search.service.int.test.ts` asserts the in-window half.
