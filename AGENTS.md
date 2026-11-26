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
| `pnpm coverage`     | The same with v8 coverage — this is what the `unit` CI job (PR-03) runs, so keep its thresholds in the Vitest configs, not in CI flags. PR-06 armed its `apps/server/src/{crypto,domain}` glob thresholds at plan §14's 80/80/75/80. |
| `pnpm test:integration` | The `*.int.test.ts` suite (`apps/server/vitest.integration.config.ts`, PR-04) — the only suite that touches a database, so `make db-up` first. `src/test/setup.ts` applies the committed migration, then `resetDb()` truncates between tests, and the files run one at a time. It boots the app under test, which imports `@note-taker/contracts` from its `dist`, so `pnpm build:packages` (PR-05) has to have run. |
| `pnpm coverage:integration` | The same with `--coverage`. This is what the `integration` CI job (PR-04) runs, and the `apps/server/src/{db,services,routes}` thresholds (plan §14's 80/80/75/80 — `db` armed by PR-04, `services`/`routes` by PR-09) live in that config too, never in a CI flag. |
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
- **Scripts that do not exist yet stay that way**: `test:e2e` (PR-19). Adding one before the files it runs is
  a plan violation (`check:env` arrived with PR-18, and `db:seed` with PR-09).
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
- **The API process serves the built SPA, and only when there is a build to serve** (PR-12):
  `apps/server/src/plugins/static-spa.ts` registers `@fastify/static` at `defaultWebDistRoot()` (or the
  `buildApp({ webDist })` override) **only if `<root>/index.html` exists**, and reports `{ served, root }` either
  way, so "no build yet" is an observable state rather than a crash. Three things are load-bearing there: it is
  registered **last** in `buildApp()` so route-shape conflicts fail loudly against the API's own routes; the
  fallback is two `wildcard: false` wildcards (`/app`, `/app/*`) because `@fastify/static`'s default
  `prefixMatching: true` swallows every non-GET request whose path starts with a served path, `POST /api/notes`
  included; and `send()` is awaited inside a try, because the plugin's 404 is asynchronous and a synchronous
  `try`/`catch` around it answers `500 ENOENT` for a perfectly good deep link. A production host with no web
  build still boots and still answers `/api/*` — that is the self-host story PR-18 inherits.
- **The tree's rules live in selectors, not in components** (PR-12): `features/tree/tree.selectors.ts` owns the
  comparator (folders before notes, case-insensitive `name`, `id` tiebreak — the same three keys as
  `GET /api/tree`'s `ORDER BY`), the nesting (orphans are hoisted, never dropped; a cycle is a row that is not a
  folder), the visible flatten with its indent arithmetic (a folder's single-child chain is hoisted, so a `b/…/z/n`
  drawer costs one column), the descendant set (legal-move pruning and the count a delete warning owes), the
  breadcrumbs and `recentNotes` (PR-11's `/api/search/recent` mirror, so the shell does not re-derive recency).
  `tree.mutations.ts` imports `moveIsBlocked` from that same module, so **an illegal move is refused before
  `fetch`** — the server stays the authority and still answers 409. Optimistic writes are
  `react-query`'s `onMutate` on `['tree', userId]`; each of `applyRename`/`applyMove`/`applyDelete` returns the
  *same object* when the id is not in the cache, which is what lets a mutation over live data stay a no-op
  rollback rather than inventing a row from the dialog's stale snapshot. A row is named by `<row>-<field>` and
  the field's problem by `<field>-error`, inline, always.
- **A 500-node sidebar has a render budget, and the tree pays for it in DOM nodes** (PR-12): §6's check is
  "renders in under a second", and `FolderTree.test.tsx` measures the honest number (`flattenTree` + the React
  commit, via `act`/`fireEvent`, never `userEvent`'s pointer polling or a `waitFor` tick) and logs it. 500 rows is
  100 ms in jsdom with three rules kept: a row is a plain `<div>` (`TreeRow` is not a component boundary), a
  **closed** row menu is `rowMenuTrigger(...)` — a called function, not a mounted Radix root — and a note row
  passes `leading={null}` instead of a spacer span per row. Adding a per-row component, context or wrapper node
  costs 500 of whatever it is; measure before adding one.
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
  store, and PR-12/13 add their keys to that store rather than inventing a fifth.
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
