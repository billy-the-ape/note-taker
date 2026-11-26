# syntax=docker/dockerfile:1

# Note Taker — the production image (docs/plans/mvp/MVP-18.md).
#
# Four stages, and their shape is a list of constraints rather than a style preference:
#
#   * **The build happens inside the image.** `deps` installs the workspace from the lockfile with dev
#     dependencies included — the apps need Vite, TypeScript and `tsc` — and `build` runs the *root*
#     `pnpm build`, which is `pnpm build:packages && pnpm -r build`: nothing may compile an app before
#     `packages/contracts` has a `dist/`, because both apps import it through its `exports` field and
#     nothing aliases it to `src` (AGENTS.md). A developer's `dist` is deleted before that build runs, so a
#     stale host artifact can never ship by accident.
#   * **The runtime layer is production by construction.** `ENV NODE_ENV=production` is baked into the last
#     stage, so nobody has to remember it and the boot guard in `apps/server/src/env.ts` is always armed.
#     `docker/compose.yml` repeats it in the app service, and an operator never writes it in `.env` —
#     `pnpm check:env` fails a file that does.
#   * **The runtime dependency tree is pruned, and the pruning is asserted rather than trusted.** `prune`
#     hands pnpm one production project, and then the stage proves it: Node's own resolver imports
#     `@note-taker/contracts` from inside the pruned tree, no `.ts` **source** file exists in what the runtime
#     copies (the `*.d.ts` declarations `tsc` emitted beside the JavaScript are the only `.ts`-shaped thing
#     that belongs there), none of the build toolchain is there, and the native argon2 binding the auth routes need is.
#     A Dockerfile that only *hopes* `--prod` worked is how an image ends up needing `tsx` at 3 a.m.
#   * **Only `node` runs.** `ENTRYPOINT` is `docker/entrypoint.sh`, whose whole job is
#     `exec node apps/server/dist/index.js`: no pnpm, no tsx, no TypeScript, and no shell pipeline worth the
#     name — `set -eu`, a `cd`, and that `exec` (which is why SIGTERM from `docker stop` still reaches the
#     app's graceful shutdown). Env checking and migrations happen *inside* that compiled process
#     (`env.ts`, then `db/migrate.ts`, both before `listen()`), so the container needs no toolchain and no
#     second command; `pnpm check:env` is the operator's pre-flight over the repo-root `.env`, not a boot
#     path. The operator scripts ride along for the same reason as the build: `pnpm build` emits
#     `apps/server/dist/scripts/`, which is how `rotate-note-key.js` (PR-06) and `reset-password.js` (PR-07)
#     are reachable inside the container. If one of them ever wants pnpm, a `.ts` entry point or a published
#     database port, the fix is to move it under `apps/server/src/scripts/` and rebuild — never to add
#     tooling to the runtime layer.
#
# Build it from the **repo root** (the context is the whole workspace) and run it with
# `docker compose --env-file .env -f docker/compose.yml` — see `docs/DEPLOY.md` §1: those two flags are not
# optional, and neither is the directory they are typed in. Nothing here pushes anything anywhere; the MVP
# has no registry (docs/plans/mvp/MVP-18.md §8) and CI only builds.

# ── stage 1: the dependency graph, from the lockfile alone ──────────────────────────────────────────
FROM node:22-slim AS deps

# Corepack takes the pnpm version from `packageManager` in the root manifest, so the image installs with
# exactly the pnpm this repository pins — the same rule the CI jobs follow via `pnpm/action-setup`.
RUN corepack enable

WORKDIR /app

# The manifests and lockfile pnpm needs in order to resolve the workspace, and nothing else: Compose plays no
# part in this `COPY`, the dependency install stays its own layer, and editing a `.ts` file never re-downloads
# the world.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/

# `--frozen-lockfile` is CI's rule too (docs/plans/mvp/MVP-03.md): this image installs exactly this tree and
# resolves nothing new. A lockfile this workspace cannot honour is a build failure, not a surprise at 3 a.m.
#
RUN pnpm install --frozen-lockfile

# ── stage 2: build every workspace, with the toolchain this image is allowed to have ────────────────
FROM deps AS build

# The rest of the tree. `.dockerignore` is what keeps it small and, importantly, keeps the host's
# `node_modules`, its `dist`s and any real `.env` out of the build context entirely — which needs `**/`
# prefixes, since Docker anchors every pattern at the context root and the host's `node_modules` are under
# `apps/*/`, not at the root.
COPY . .

# The deletes are load-bearing, not tidiness: `tsc` does not remove output whose source has gone away, so a
# `dist/` copied from a developer's machine could ship a file no source file produces any more. `.dockerignore`
# now excludes `**/dist`, so this is the second line of defence rather than the only one.
RUN rm -rf apps/server/dist apps/web/dist packages/contracts/dist && pnpm build

# ── stage 3: the production tree, and the assertions that it is one ─────────────────────────────────
FROM deps AS prune

COPY --from=build /app /app

# One project (`--filter`, with the `=` this pnpm's parser wants), its own production dependencies, and
# nothing that built them: the deployed tree is nine entries — fastify, drizzle-orm, postgres, argon2, pino,
# uuid, zod and two scoped groups — where `node_modules` is otherwise full of Vite, TypeScript, Vitest,
# drizzle-kit and tsx. `deploy` also copies the project's own files (`src/`, the tsconfigs, the vitest
# configs); stage 4 deliberately copies only `node_modules` from here, and takes the app's own artifacts from
# `build`, which is the layer that just compiled them.
RUN pnpm deploy --filter=@note-taker/server --prod /opt/deploy

# Replace the copied workspace package with the *published shape* of the compiled one, then make the tree
# prove four things, in the order an operator would want to hear them:
#
#   1. Node's own resolver, run from inside the pruned tree — the same import the container will do. This is
#      AGENTS.md's rule ("contracts resolves from its `dist`, never from `src`") asserted at build time
#      rather than discovered by a container that cannot start.
#   2. No `.ts` **source** file in what the runtime copies, i.e. no source leaked into the layer that serves
#      notes. `*.d.ts` is excluded because it is output rather than source: `packages/contracts` builds with
#      `declaration: true` and its `exports.types` points at `./dist/index.d.ts`, so a clean tree legitimately
#      contains declaration files and an unqualified `-name '*.ts'` would fail it. The `if` on that line is
#      load-bearing too: under `set -eu` a command whose status is inverted with `!` is exempt from errexit, so
#      `! { find … | grep -q .; }` would be a no-op that a green build cannot tell apart from a clean tree.
#   3. None of the build toolchain is in the tree: pruning is asserted, not assumed. The deployed manifest
#      is also checked for the one thing `--config-dependencies` cannot guarantee on its own — a
#      devDependency that reappears as a dependency.
#   4. The native argon2 binding exists, or the app would die on the first login rather than the first boot.
#
# The directory written here is deliberately only what `packages/contracts`' `exports` field points at:
# `package.json` and `dist/`. `cp -L`/`cp -rL` dereference, so what lands is content and never a pointer
# into a source tree the runtime image does not have.
# Why the directory has to be rewritten at all: `deploy` links the workspace package out of its own store
# entry, and that entry is a copy of the *package as published from source*, which for a manifest with no
# `files` field means `dist/` **and** `src/*.ts` **and** the vitest configs. That is the exact shape AGENTS.md
# forbids in the runtime — so both the link at `node_modules/@note-taker/contracts` and the store directory it
# pointed at are deleted, and the path is recreated as a real directory holding only `package.json` and
# `dist/`, which is all the `exports` field can reach.
RUN set -eu; \
  contracts=/opt/deploy/node_modules/@note-taker/contracts; \
  rm -rf "$contracts" /opt/deploy/node_modules/.pnpm/@note-taker+contracts@*; \
  mkdir -p "$contracts"; \
  cp -L /app/packages/contracts/package.json "$contracts/package.json"; \
  cp -rL /app/packages/contracts/dist "$contracts/dist"; \
  test -f "$contracts/dist/index.js"; test ! -e "$contracts/src"; \
  cd /opt/deploy; \
  node --input-type=module -e 'const m = await import("@note-taker/contracts"); if (m.ROUTES?.healthz !== "/api/healthz" || typeof m.noteSchema?.parse !== "function") { console.error("@note-taker/contracts did not resolve to the compiled dist"); process.exit(1) }'; \
  node -e 'const src = require("/app/packages/contracts/package.json"), dst = require("/opt/deploy/node_modules/@note-taker/contracts/package.json"); const deps = Object.keys(dst.dependencies || {}); const leaked = Object.keys(src.devDependencies || {}).filter((k) => deps.includes(k)); if (leaked.length) { console.error("devDependencies in the production tree: " + leaked.join(", ")); process.exit(1) } if (deps.some((k) => String(dst.dependencies[k]).includes("workspace:"))) { console.error("a workspace: protocol survived into the runtime tree"); process.exit(1) }'; \
  for dev in typescript tsx vitest vite drizzle-kit @vitest @biomejs; do \
    if [ -e "/opt/deploy/node_modules/$dev" ]; then echo "$dev is in the production tree"; exit 1; fi; \
  done; \
  if find /app/apps/server/dist "$contracts" -type f -name '*.ts' ! -name '*.d.ts' | grep -q .; then \
    echo 'a source .ts file is in the runtime tree'; exit 1; \
  fi; \
  node --input-type=module -e 'const a = await import("@node-rs/argon2"); if (typeof a.hash !== "function") process.exit(1)'

# ── stage 4: the runtime ────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# The image is production by construction — the line `docs/DEPLOY.md` §2 points at, because an operator
# never hand-sets a mode. `PORT` is deliberately *not* set here: `docker/compose.yml` pins it to 3000, so
# `EXPOSE` and the healthcheck below stay true while `HOST_PORT` moves the host side of the mapping.
ENV NODE_ENV=production

WORKDIR /app

# The pruned dependency tree first: the application's own files are written last, so a code change never
# invalidates this layer. `/app/apps/server/node_modules` is where Node's resolution walk from
# `/app/apps/server/dist/**` lands, and it is the only `node_modules` in the image.
#
# No `--chown` anywhere below, and that is the assertion rather than an oversight: everything copied here
# arrives root-owned and world-readable (the build stages run as root with a 022 umask), so `USER node` can
# read the code it runs and cannot rewrite it — a compromised request handler gets no write on `dist/`,
# `migrations/`, `node_modules/` or the SPA bundle, and nothing under `/app` needs writing because the notes
# live in Postgres. `--chown=node:node` on these five COPYs is exactly what an earlier version of this file
# did, which made the claim below it false for the whole runtime layer; DEPLOY.md §2 step 5 proves the
# invariant with `find /app -user node`, which must print nothing.
COPY --from=prune /opt/deploy/node_modules ./apps/server/node_modules

# `main` in this manifest is what `serverVersion()` reads beside the compiled `app.js`, and `dist/scripts/`
# is how the operator scripts reach the container (see the header).
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
# The committed migration history: `db/migrate.ts` finds this directory by walking up from the compiled
# file and applies it before `listen()`, which is why `up -d` is the whole upgrade (docs/DEPLOY.md §8).
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
# The SPA, staged at the same workspace-relative path PR-12's `plugins/static-spa.ts` is written against
# (`apps/web/dist`), so the API process serves it from the one published port and the image needs no second
# server. Until that plugin lands this is inert payload and `GET /` stays the API's own 404 envelope.
COPY --from=build /app/apps/web/dist ./apps/web/dist

# `exec` is the point of the file: env validation and migrations are the compiled bootstrap's job, inside the
# process, so what is left here is to start one Node process as PID 1's child.
#
# Application code stays root-owned and world-readable (these COPYs run before `USER node`), so the process
# that serves notes cannot rewrite the code it is running; and nothing in this image is writable by the app,
# because the data lives in Postgres.
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# The runtime layer, asserted rather than assumed — and asserted *here*, where CI's `docker build` step runs it,
# because `docs/DEPLOY.md` §2 step 5 is the same three checks and needs a human with a daemon to execute them.
# Each line is the twin of a claim made elsewhere in this file and in AGENTS.md:
#
#   * no build tool, and no download tool, anywhere in `/app` — by name, as a file or as a `node_modules`
#     package. The prune stage checks the tree before it is copied; this one checks the layer the app runs in,
#     which is where a stray `COPY` or a dependency that grew a tool would show up.
#   * no `.ts` source (`.d.ts` excepted, as in stage 3: declaration files are output, not source).
#   * nothing under `/app` owned by the app user — the ownership rule this stage used to violate with
#     `--chown=node:node` on all five COPYs while its comment claimed the opposite. It runs as root, before
#     `USER node`, so it can see every file: a hit means `USER node` could rewrite the code it executes.
#
# Written with `find` and no `$PATH` reasoning on purpose: `command -v` searches `$PATH`, this image puts nothing
# under `/app` there, so a loop built on it is a check that prints "clean" whatever the image contains.
RUN set -eu; \
  for tool in tsx tsc vite vitest biome eslint prettier nodemon drizzle-kit playwright typescript curl wget pnpm; do \
    hit=$(find /app -type f -name "$tool" -print -o -type d -name "$tool" -path '*/node_modules/*' -print | head -n1); \
    if [ -n "$hit" ]; then echo "$tool is in the runtime layer: $hit"; exit 1; fi; \
  done; \
  if find /app -name '*.ts' ! -name '*.d.ts' -print | grep -q .; then \
    echo 'a source .ts file is in the runtime layer'; exit 1; \
  fi; \
  owned=$(find /app -user node -print | head -n5); \
  if [ -n "$owned" ]; then echo "the app user owns files it runs from: $owned"; exit 1; fi; \
  test -f /app/apps/server/dist/index.js; \
  echo 'runtime layer: no toolchain, no .ts source, nothing app-owned'

# The base image's unprivileged user. The *name* is what this file asserts, never the uid: recent
# `node:22-slim` tags ship `node` as 65532, and pinning a number the base image owns is how an image ends up
# writing files nobody can read after a base refresh. `docker compose … exec app id -u` is the assertion an
# operator runs.
USER node

EXPOSE 3000

# No `curl` in *this* image: the healthcheck below uses Node's own `fetch`, and no layer of ours installs a
# download tool to ask one question (out of scope for the runtime, docs/plans/mvp/MVP-18.md §5). Whether the
# base keeps a `curl` is the base's business and cannot be read off `docker history` — the layer *commands* of
# `node:22-slim`'s ancestors mention curl either way — so DEPLOY.md §2 step 5 asks a container of the finished
# image about the tools this image adds, which is the claim that can be checked. The path is the
# `ROUTES.healthz` value stage 3 asserted resolves, and `127.0.0.1` is deliberate over
# `localhost`: a healthcheck whose result depends on DNS resolution fails for reasons that have nothing to do
# with the app. A 503 (the database probe failing) is a *failing* healthcheck, which is the intended meaning:
# `healthy` means the app answers, not that a process exists.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
