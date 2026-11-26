#!/bin/sh
# Note Taker — the container's entrypoint (docs/plans/mvp/MVP-18.md §5).
#
# It is one `exec`, on purpose. Everything an operator might expect an entrypoint script to do is already
# the compiled bootstrap's job, inside the process:
#
#   * **env checking** — `apps/server/src/env.ts` is the boot guard, and it runs before the port is bound,
#     so a broken configuration is a non-zero exit with the port still unbound (that is what makes the
#     container's `healthy` status mean something). `pnpm check:env` is the operator's *pre-flight* over the
#     repo-root `.env`; it is a linter, and nothing here calls it.
#   * **migrations** — `db/migrate.ts` applies the committed history in `apps/server/migrations/` before
#     `listen()`, so `up -d` is the whole upgrade and there is no `db:migrate` step to forget.
#   * **the mode** — `ENV NODE_ENV=production` is baked into the image's runtime stage, and this script does
#     not set it: `NODE_ENV` is required and never defaulted (AGENTS.md), so a mode that appeared in a shell
#     script would be indistinguishable from a defaulted one.
#
# Which is why there is no `pnpm`, no `tsx` and no `.ts` execution here: the runtime layer has no toolchain
# (a container walking `/app` can show that; `docker history` cannot — docs/DEPLOY.md §2 step 5). `exec` keeps
# the Node process as PID 1's child, so SIGTERM
# from `docker stop` reaches the graceful shutdown handler in `index.ts` instead of killing the shell.

set -eu

# WORKDIR in the image is /app, and every operator-facing path in docs/DEPLOY.md is spelled relative to it
# (`node apps/server/dist/scripts/rotate-note-key.js`), so the same command works from `exec` and from `sh`.
cd /app

exec node apps/server/dist/index.js
