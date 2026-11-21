/**
 * Prints one fresh note-encryption key to stdout (docs/plans/mvp/MVP-06.md §6.5) — **dev/CI only**.
 *
 * This is the convenience version of the same thing an operator does on a production host with the
 * `docker run --rm node:22-slim node -e '…randomBytes(32).toString("base64")'` one-liner PR-18 documents; the
 * key itself never comes from a machine that has the repository checked out on it. Nothing here is shipped:
 * `scripts/` is dev/CI-only by design, which is why operator-facing code lives under `apps/server/src/`
 * instead (see `apps/server/src/scripts/rotate-note-key.ts`).
 *
 * ```
 * pnpm generate:key                                   # paste into .env as NOTE_ENCRYPTION_KEY=…
 * pnpm generate:key 2>/dev/null | tee /run/secrets/note_key   # the mounted-file form instead
 * ```
 *
 * Run it with `openssl rand -base64 32` if you would rather not trust this file with your entropy: both
 * produce base64 of 32 random bytes, which is all `NOTE_ENCRYPTION_KEY` accepts. stdout carries the key and
 * nothing else, so it is safe to redirect; the explanation goes to stderr.
 *
 * `scripts/` is outside every workspace, so this file has no dependencies of its own and is run through the
 * server workspace's `tsx` (`generate:key` is that one line) rather than `node`, which would need Node's
 * type-stripping flag on a directory that is not `"type": "module"`.
 */
import { createHash, randomBytes } from 'node:crypto';

/** `NOTE_ENCRYPTION_KEY`'s width, the same constant `apps/server/src/env.ts` validates against. */
const KEY_BYTES = 32;

const bytes = randomBytes(KEY_BYTES);
const fingerprint = createHash('sha256').update(bytes).digest().subarray(0, 4).toString('hex');

process.stderr.write(
  `generated a ${KEY_BYTES}-byte key; fingerprint ${fingerprint} (the same 8 hex ` +
    '`crypto/keys.ts` logs at boot, so you can confirm the app picked this one up).\n' +
    'Put it in .env as NOTE_ENCRYPTION_KEY, single-quoted. Losing it makes every note body unrecoverable.\n',
);
process.stdout.write(`${bytes.toString('base64')}\n`);
