# MVP-06 · PR-06 — Envelope encryption module + key management + rotation script

> **Task ID:** `PR-06` · **Branch:** `feat/pr-06-encryption` · **Size:** M (1–2 days) · **Depends on:** PR-04, PR-05 (merged)
> **Track:** B Data & contracts · **Unblocks:** PR-09 (its `POST /api/notes` must seal content), PR-10
> **ADR:** ADR-0002 (encryption at rest) is written by **PR-20** — here you only leave a `// ADR-0002` comment in
> `crypto/envelope.ts` pointing at where it will land.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~25k tokens** | this brief (3.4k as written) + PR-04's `db/schema.ts`, `notes.repo.ts`, `test/helpers/db.ts` + PR-05's `domain/errors.ts` + `node:crypto` GCM semantics + the env/config rows below + reading integration-test output from the rotation race |
| **Output** | **~10k tokens** | `crypto/{envelope.ts,keys.ts}`, `crypto/envelope.test.ts` (+ a keys test), the `rotate-note-key.ts` operator script, `scripts/generate-keys.ts`, a `notes.repo.ts` refactor, `.env.example` additions, the rotation-race `.int.test.ts` |
| **Session total** | **~35k tokens** | ≈ one `M` engineer-day; the rotation-concurrency test is the token-heavy part (budget ~48k) |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

Authenticated encryption of note bodies at rest: AES-256-GCM envelope with per-write IV, a versioned keyring, and an
operator rotation script that ships inside the production image. **There is no plaintext mode anywhere** — not in dev,
not in test.

## 2. Repo state you can assume (PR-04 + PR-05 merged)

- `notes` table: `content_cipher bytea NOT NULL`, `content_iv bytea NOT NULL`, `key_version integer NOT NULL DEFAULT 1`,
  `content_format text DEFAULT 'markdown'`, `content_bytes integer`, `word_count integer`, `version integer DEFAULT 1`.
- `apps/server/src/db/repositories/notes.repo.ts` currently stores **opaque triples supplied by its caller** and its
  tests insert fixed blobs; you plug the real crypto in behind that same interface.
- `apps/server/src/env.ts` parses env (add the key vars here), `databaseUrl()` resolves the DSN,
  `loadDevEnvFile()` loads the repo-root `.env` in dev/test.
- `test/helpers/db.ts` gives a real DB for `*.int.test.ts`; the `integration` CI job runs
  `pnpm build:packages && pnpm test:integration` — **it never builds `apps/server/dist`, so integration tests must not
  assume `dist/scripts/*.js` exists** (drive scripts as `tsx` subprocesses there; the compiled form is asserted in the
  `build` job and in PR-18's image).
- No HTTP routes for notes exist yet, and none may be assumed.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-06`; CI green; never lower a coverage threshold (this PR arms the
`apps/server/src/{crypto,domain}` row: 80/80/75/80); every new DB column ships with a generated migration here
(you add none — the columns exist); docs updated in the same PR (`.env.example` + a note in `docs/DATA-MODEL.md` if the
encryption columns' meaning changes).

## 4. Design rules (non-negotiable)

- AES-256-GCM; 256-bit master key from `NOTE_ENCRYPTION_KEY` (base64, 32 bytes) **or** read from
  `NOTE_ENCRYPTION_KEY_FILE` when set (so a mounted secret file works without shell interpolation).
- AAD = `note:<uuid>` ⇒ ciphertexts are not portable between rows (an AAD mismatch must make `decrypt()` throw).
- Fresh **12-byte IV per write**; `key_version` per row.
- Envelope layout: `content_cipher = ciphertext || 16-byte auth tag` (the tag is appended by `seal()` from
  `cipher.getAuthTag()`; `node:crypto` never appends it itself). `open()` splits the trailing 16 bytes as the tag; any
  GCM failure **throws** — the API must never return blank content.
- Keyring = `{ current: { version, key }, previous: Map<version, key> }`, from `NOTE_ENCRYPTION_KEY` +
  `NOTE_ENCRYPTION_KEY_PREVIOUS` (JSON map `{"1": "<base64>"}`, decrypt-only) + **`NOTE_ENCRYPTION_KEY_VERSION`**
  (integer, default `1`).
  **The current key's version is its own variable, never derived from the `_PREVIOUS` map** — deriving it as
  `max(previous)+1` collapses back to 1 the moment the map is emptied, silently orphaning every row tagged 2.
- `crypto/keys.ts` logs a **key fingerprint** (first 8 hex of sha256 of the key) at startup so operators can verify which
  key a database was written with.
- **Not encrypted (accepted MVP limitation, recorded later in ADR-0002):** usernames, folder/note names, timestamps,
  sizes — they must stay queryable.
- **Data-loss caveat:** losing `NOTE_ENCRYPTION_KEY` makes note bodies unrecoverable (PR-18 documents the backup/restore
  drill).

### Dev/test key path (there is still no plaintext mode)

Only when `NODE_ENV` is `development`/`test` **and** neither key variable is set: generate one key on first boot and
**persist** it to `.dev/note-key` (mode `0600`, directory created on demand, add it to `.gitignore`, comment in
`.env.example`), log the path + fingerprint, reuse it on later boots — so dev rows survive restarts. Production never
takes this path and fails hard.

### Boot guard (production)

The compiled `env.ts` refuses to start in `production` when neither `NOTE_ENCRYPTION_KEY` nor a readable
`NOTE_ENCRYPTION_KEY_FILE` yields 32 bytes.

## 5. Sketch to follow (Appendix A.3 of the plan)

```ts
export function seal(plain: string, noteId: string, keyring: Keyring) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.current.key, iv);
  cipher.setAAD(Buffer.from(`note:${noteId}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { contentCipher: body, contentIv: iv, keyVersion: keyring.current.version };
}
// open() splits the trailing 16 bytes as the auth tag; any GCM failure throws → API returns INTERNAL, never blank content
```

Expose `encrypt(plain, {keyVersion, aad}) → {cipher, iv, keyVersion}`, `decrypt(…)`, and the domain-shaped helpers
`sealNoteContent(content, noteId, keyring)` / `openNoteContent(row, keyring)` used by the repository/service.

## 6. Files to create / modify

1. `apps/server/src/crypto/keys.ts` — parse the key variables, build the keyring, validate 32 bytes, fingerprint log,
   dev/test generated-and-persisted key.
2. `apps/server/src/crypto/envelope.ts` — seal/open + `sealNoteContent()`/`openNoteContent()` + `// ADR-0002` comment.
3. `apps/server/src/crypto/envelope.test.ts` (+ `keys.test.ts`) — unit tests, no DB.
4. `apps/server/src/db/repositories/notes.repo.ts` — refactor to store
   `content_cipher/content_iv/key_version/content_bytes/word_count`; keep it plaintext-agnostic (the service passes the
   sealed triple).
5. `scripts/generate-keys.ts` — **dev/CI only**: prints a fresh base64 key to stdout. (Operators get the
   `docker run --rm node:22-slim node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`
   one-liner instead; that path belongs to PR-18's docs.)
6. **`apps/server/src/scripts/rotate-note-key.ts`** — the operator rotation script. It lives under `apps/server/src/`
   **on purpose**: it is TypeScript inside the server workspace, so `pnpm build` (`tsc`) emits
   `apps/server/dist/scripts/rotate-note-key.js`, which PR-18's image copies. It must have **no dev-only dependency**
   (only `db/client.ts`, `crypto/*`, `env.ts`), stream rows, re-encrypt, batch in transactions, be **idempotent**, and
   support `--dry-run` and `--verify`. In production it is run with
   `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js`
   (same DB connection, same keyring, no extra network exposure — the prod `db` publishes no port).
7. `.env.example` — add `NOTE_ENCRYPTION_KEY`, `NOTE_ENCRYPTION_KEY_FILE`, `NOTE_ENCRYPTION_KEY_PREVIOUS`
   (with the single-quote warning: the runbook sources the file in a shell and Compose strips one quote layer), and
   `NOTE_ENCRYPTION_KEY_VERSION=1`.
8. `.gitignore` — add `.dev/`.

## 7. Rotation must not lose concurrent edits (the hard part)

The script runs against a **live** app: autosave is writing the whole time (debounce 1.2 s), and the runbook puts the app
back into service *before* the rewrite runs. Per batch, in **one transaction**:

```sql
SELECT id, version, key_version, content_cipher, content_iv
  FROM notes WHERE key_version < $current ORDER BY id LIMIT $batch FOR UPDATE
```

—the row lock is what makes read-and-reseal atomic. Then the write is conditional (the A.2 shape):

```sql
UPDATE notes SET content_cipher=…, content_iv=…, key_version=$current, updated_at=now()
 WHERE id=$1 AND version=$2 AND key_version=$old_version
```

If that `UPDATE` matches 0 rows, the row changed under the script: **re-read it and re-seal the freshly read ciphertext**
(never write a previously buffered one), or skip it and let the next run pick it up. `--verify` then reports any row
still on an old version, so the operator re-runs until it exits 0.
The script **never touches `notes.version`** — rotation is not a content edit, and bumping it would spuriously trip every
open tab's autosave into a 409.

Operator sequence (documented by PR-18, driven by you only through env in tests): append the old key to
`_PREVIOUS` as `{"<old version>": "<old base64>"}`, set the new `NOTE_ENCRYPTION_KEY`, bump
`NOTE_ENCRYPTION_KEY_VERSION` to `<old>+1`, restart the app, run the script, then `--verify`.

## 8. Acceptance criteria — assert at the layer this PR owns

Everything here is measured in `crypto/*`, `notes.repo.ts`, and the script, because **no route exists yet**: the routes
that would exercise this code belong to PR-09/PR-10, and any HTTP-level assertion here would be unmeetable at merge time.

- [ ] Round-trip test (UTF-8, unicode, empty string).
- [ ] Tamper test: flip a ciphertext byte ⇒ `decrypt()` throws. (The route-level mapping — `INTERNAL`, logged note id,
      never blank content — is asserted in **PR-09**.)
- [ ] Wrong-key test; AAD mismatch across two note ids ⇒ `decrypt()` fails (≥ 12 unit assertions total).
- [ ] Key-version rules: the current key's version comes from `NOTE_ENCRYPTION_KEY_VERSION` (default `1`) and is written
      into every new row; the **script** re-encrypts rows and stamps them with the current version. Version/key edits in
      `.env` and the restart are **operator steps** (a script cannot change its own container's environment), so drive
      the script with an env that already carries `NOTE_ENCRYPTION_KEY_VERSION=2` + the old key in `_PREVIOUS`, run it,
      then assert every row carries version 2 (row counts per `key_version` before/after — none keeps the old tag) and
      that rows written under version 1 still decrypt while that entry stays in `_PREVIOUS`.
- [ ] Removing a still-referenced `_PREVIOUS` entry makes exactly those rows unreadable — the lossy case the explicit
      version prevents.
- [ ] Production boot fails when neither `NOTE_ENCRYPTION_KEY` nor a readable `NOTE_ENCRYPTION_KEY_FILE` yields 32 bytes.
- [ ] `sealNoteContent('')` / `openNoteContent()` round-trip the **empty string** into a valid envelope: always a
      12-byte IV + 16-byte tag; the schema never holds a NULL/empty cipher or iv (a 0-byte IV makes GCM throw and
      surface as `INTERNAL`).
- [ ] Dev-key path: with `NODE_ENV=development` and no key configured, `.dev/note-key` is created with mode `0600`, the
      logged fingerprint is identical on the next boot (rows survive a restart), and with `NODE_ENV=production` the same
      setup still exits non-zero instead of writing `.dev/`; a note written with a generated key is unreadable after the
      key file is deleted (the documented dev caveat).
- [ ] **Rotation-concurrency integration test** (`*.int.test.ts`, real DB): `rotate-note-key.ts` runs as a **tsx
      subprocess — not `dist/scripts/rotate-note-key.js`** (the `integration` job runs `pnpm build:packages` only, so the
      compiled form is not on disk there; the `.js` is asserted where a real build exists, i.e. the `build` job and
      PR-18's image). A second writer calls the **repository's conditional update** (the A.2 shape
      `UPDATE notes SET … WHERE id=$1 AND version=$2` — the very statement PR-10's route will wrap) on the same row while
      the rotation runs. Assert: the note's final content is the **writer's** (not the script's stale buffer), sealed at
      the current `key_version`; `notes.version` incremented **exactly once**; `--verify` exits 0 afterwards. Without the
      row lock / conditional write this test fails — which is the point. PR-10 re-tests the same guarantee one layer up.
- [ ] `apps/server/src/{crypto,domain}` coverage ≥ 80/80/75/80 in the `unit` job config.

## 9. Out of scope

Per-user keys, KMS integration, HTTP routes, search.

## 10. PR body template

```
Task: PR-06

## What
AES-256-GCM envelope (AAD=note:<uuid>, 12-byte IV, tag appended in seal()), versioned keyring with explicit
NOTE_ENCRYPTION_KEY_VERSION + _PREVIOUS, dev/test persisted .dev/note-key, prod boot guard, notes.repo refactor,
scripts/generate-keys.ts (dev/CI), apps/server/src/scripts/rotate-note-key.ts (--dry-run/--verify, FOR UPDATE +
conditional write, never bumps version).

## Acceptance evidence
- unit run (≥12 assertions incl. AAD mismatch, tamper, empty-string envelope)
- rotation integration run: counts per key_version before/after + race result (writer wins, version +1 exactly once, --verify 0)
- prod boot refusal + dev .dev/note-key 0600 + fingerprint stable
```
