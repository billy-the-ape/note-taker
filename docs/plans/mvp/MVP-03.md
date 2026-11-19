# MVP-03 · PR-03 — Real CI (replaces the placeholder workflow)

> **Task ID:** `PR-03` · **Branch:** `ci/pr-03-real-ci` · **Size:** M (1–2 days) · **Depends on:** PR-01 (merged)
> **Track:** A Foundation · **Review gate:** M0 ("repo clonable, CI real, `pnpm dev` serves something")
> **Note:** PR-04 may merge with the placeholder still in place; PR-04 then adds the `integration` job itself.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~14k tokens** | this brief (1.8k as written) + the two existing workflow YAMLs + PR-01's root `package.json` scripts + GitHub Actions/pnpm action docs + reading failing job logs across 2–3 push iterations |
| **Output** | **~3k tokens** | one rewritten `.github/workflows/CI.yml` (~60 lines) + a throwaway red-test branch + PR body |
| **Session total** | **~17k tokens** | ≈ one engineer-day (`M`) — dominated by CI iteration latency, not by code volume |

> 1 token ≈ 4 chars; ±30%. Most tokens go into reading CI logs of successive pushes, so keep fix commits small.

---

## 1. Goal

Replace the placeholder `CI.yml` job with real gates — **quality, unit, build** — while preserving the workflow name and
triggers that another workflow depends on.

## 2. Repo state you can assume (PR-01 merged)

Root scripts exist: `dev`, `build`, `build:packages` (`pnpm -r --filter './packages/**' build` — a **no-op today**,
because `packages/` does not exist until PR-05), `lint`, `format`, `typecheck`, `test`, `coverage`. `pnpm-lock.yaml` is
committed. No `packages/`, no DB code, no `test:integration` config, no `docker/Dockerfile`.

Existing workflows:

```yaml
# .github/workflows/CI.yml
name: CI
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }
jobs:
  placeholder: { runs-on: ubuntu-24.04, steps: [run: true] }

# .github/workflows/claude-review.yml
on:
  workflow_run:
    workflows: ["CI"]        # ⚠ this is why the name must not change
    types: [completed]
```

## 3. The hard constraint

**Delete the `placeholder` job but keep `name: CI` and the same triggers.** `claude-review.yml` runs
`on: workflow_run: workflows: ["CI"]`; renaming the workflow silently disables Claude reviews (risk R6 in the plan).
Do not touch `claude-review.yml`.

## 4. Jobs shipped by this PR

```yaml
name: CI                      # ⚠ do not rename — claude-review.yml depends on this exact name
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
permissions: { contents: read }
concurrency: { group: "ci-${{ github.workflow }}-${{ github.ref }}", cancel-in-progress: true }
jobs:
  quality:   # checkout → pnpm/action-setup v6 (no `version:` input — it installs the pnpm pinned by
             #   `packageManager`; the action has no v12, only pnpm does) → actions/setup-node (cache: pnpm)
             # → pnpm install --frozen-lockfile → pnpm build:packages → pnpm lint && pnpm typecheck
  unit:      # pnpm build:packages → pnpm coverage  (unit configs only, NO Postgres service) + upload coverage-unit/
  build:     # pnpm build only — NO docker build yet (docker/Dockerfile does not exist until PR-18)
```

Rules encoded here:

- `pnpm install --frozen-lockfile` only; lockfile committed; `cache: pnpm` in `actions/setup-node`.
- **`pnpm build:packages` runs in every job that typechecks or tests app code.** Today it is a no-op; from PR-05 on it is
  load-bearing, because `@note-taker/contracts` declares `exports`/`main`/`types` → `./dist` only, and a fresh checkout
  has no `dist/`. Add the step now (while harmless) so PR-05 does not have to edit every job.
- **Unit and integration files never share a glob.** DB-backed tests will be named `*.int.test.ts` and PR-01's unit
  Vitest configs already `exclude: ['**/*.int.test.ts']`; keep `unit` free of any Postgres service.
- **Coverage thresholds live in the Vitest config that produces the number — never in CI flags** — so local runs match
  CI. `pnpm coverage` measures only the pure scopes (no DB): `packages/contracts` 90/90/85/90,
  `apps/server/src/{crypto,domain}` 80/80/75/80, `apps/web/src/lib` 80/80/75/80, `apps/web/src` 55/55/50/55
  (each row armed by the PR that first has tests in that scope — PR-05 arms the `contracts` and `web/src/lib` rows,
  PR-08 arms `web/src` overall). The `{services,db,routes}` row (80/80/75/80) is **not** measurable here: it is enforced
  by the `integration` job's `pnpm coverage:integration`, added in PR-04.
- Thresholds only ratchet upward.

## 5. Jobs added later (same file, additive edits — do not add them now)

| Job | Added by | Why not now |
| --- | --- | --- |
| `integration` (`services: postgres:16` → `pnpm build:packages && pnpm test:integration`, plus the `pnpm coverage:integration` step) | **PR-04** | needs the integration Vitest config + first DB tests |
| `docker build` **step** inside `build` (never pushes an image — no registry in the MVP) | **PR-18** | `docker/Dockerfile` does not exist |
| `e2e` (Playwright: `pnpm exec playwright install --with-deps chromium`, `apps/web/dist` + API in one job, `retries: 1`) | **PR-19** | needs the Playwright config + specs |

**A job never enters `CI.yml` before the files it runs exist.**

Integration/e2e jobs will get a throwaway DB (`POSTGRES_PASSWORD: test` service env, a `DATABASE_URL` pointing at it) —
test-only credentials only, never real ones. Those jobs also need no `NODE_ENV` of their own: the value comes from the
inline assignment inside each root script (`NODE_ENV=test vitest run --config …`).

## 6. Acceptance criteria

- [ ] The three jobs introduced here pass on a PR that touches nothing but the workflow.
- [ ] `pnpm install --frozen-lockfile` succeeds in CI (lockfile committed).
- [ ] A deliberately failing test on a throwaway branch is proven **red** (paste the red job, then delete the branch).
- [ ] `concurrency` and `permissions: contents: read` retained; `name: CI` unchanged; triggers unchanged.
- [ ] `claude-review.yml` untouched, and the Claude review workflow still triggers — verify via the `workflow_run`
      listing after merge and state it in the PR.
- [ ] `unit` uploads `coverage-unit/` as an artifact and runs with no Postgres service.
- [ ] No `integration`, no `docker build`, no `e2e` job in this PR.

## 7. Out of scope

Deployment/publishing, pushing images to any registry, branch protection settings, caching beyond
`actions/setup-node`'s `cache: pnpm`, matrix runs.

## 8. PR body template

```
Task: PR-03

## What
CI.yml: quality (build:packages + lint + typecheck), unit (pnpm coverage, coverage-unit artifact), build (pnpm build).
Placeholder job deleted; `name: CI` and triggers preserved for claude-review.yml.

## Acceptance evidence
- green run on a docs-only change to the workflow
- red run on the throwaway branch (link) + branch deleted
- claude-review workflow_run still fires (link to the run listing after merge)
```
