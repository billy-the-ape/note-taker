/**
 * Password hashing (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * argon2id with the parameters the plan pins — `memoryCost 65536` (64 MiB, the unit is KiB),
 * `timeCost 3`, `parallelism 1` — a fresh random salt per password, and the **encoded PHC string**
 * (`$argon2id$v=19$m=65536,t=3,p=1$…`) as the value of `users.password_hash`. The salt is inside that
 * string, so `verify()` never needs to be told what it was, and changing the parameters later is what
 * `parseOptions()` is for (rehash-on-login is backlog, not MVP).
 *
 * Two things this file is also responsible for, both of them timing rather than crypto:
 *
 * * **A password is never logged or returned.** The encoded string is a credential: it leaves this
 *   module only into `users.password_hash`.
 * * **An unknown username costs the same as a known one.** `verifyDummy()` verifies against a hash the
 *   module made for a password nobody will ever type, which is what lets the service answer the same
 *   `401` for "no such user" and "wrong password" without the response time announcing which one it
 *   was. Skipping it is the classic user-enumeration oracle: the missing-account path returns in
 *   microseconds while the real verify takes ~100 ms.
 *
 * `PasswordHasher` is an interface rather than a direct call to `@node-rs/argon2` for one reason:
 * the integration suite logs a user in dozens of times, and 64 MiB × 3 passes per login would turn a
 * second-long suite into a minute-long one. `buildApp()` injects the production hasher;
 * `test/helpers/passwords.ts` builds the same object at the cheapest defensible cost, so a test
 * exercises the real algorithm — with real encoded strings — without paying for real strength.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { hash, type Options, verify } from '@node-rs/argon2';

/** The parameters plan §10 pins. `memoryCost` is in kibibytes, like the `m=` field of the PHC string. */
export const ARGON2_PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * The hashing policy of one process. `verifyDummy` is part of the interface rather than a free
 * function because the dummy hash belongs to the parameters: verifying a 64 MiB hash costs 64 MiB, so
 * a cheap hasher has to be equalised against a cheap dummy or the timing guard would be a lie.
 */
export interface PasswordHasher {
  /** A fresh encoded argon2id string, with its own random salt. */
  readonly hash: (password: string) => Promise<string>;
  /** `true` when `password` matches the encoded string; every failure — malformed, expired parameters,
   *  wrong password — is `false`, never a throw. */
  readonly verify: (encoded: string, password: string) => Promise<boolean>;
  /** Spends the same work as {@link verify} on a password no account has, for the unknown-user path. */
  readonly verifyDummy: (password: string) => Promise<void>;
}

/**
 * Builds a hasher over `@node-rs/argon2`.
 *
 * The algorithm and version are deliberately not passed: the bindings' defaults are argon2id and v19,
 * and `passwords.test.ts` asserts that from the string that comes back (`$argon2id$v=19$…`) rather
 * than trusting a flag that could be dropped by a refactor. `Algorithm` is a TypeScript `const enum`
 * in those bindings, i.e. a value that does not exist at runtime, so passing it would be a runtime
 * `undefined` dressed up as a type-safe choice.
 */
export function createArgon2Hasher(params: Argon2Params = ARGON2_PARAMS): PasswordHasher {
  const options: Options = {
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  };

  /** Built once per hasher, on the first unknown-user login, and never for a real account. */
  let dummy: Promise<string> | undefined;

  return {
    hash: (password) => hash(password, options),
    verify: async (encoded, password) => {
      try {
        return await verify(encoded, password, options);
      } catch {
        // A stored string this build cannot parse (a foreign KDF, a truncated column) is a wrong
        // password as far as the API is concerned: it must not become a 500 with a library message.
        return false;
      }
    },
    verifyDummy: async (password) => {
      dummy ??= hash(randomBytes(32).toString('hex'), options);
      await verify(await dummy, password, options);
    },
  };
}

// There is deliberately no module-level "production hasher" instance here. `buildApp()` calls
// `createArgon2Hasher()` once per app, so an instance's memoised dummy hash belongs to the app that made it
// (see the note in `app.ts`), and a singleton would silently share one across every app in a test process.

/** UTF-8 byte length — the unit plan §10's "≤ 512 bytes" is written in, which is not `.length`. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Does the constant-time string comparison that a CSRF check needs.
 *
 * Both sides are compared as UTF-8 bytes, and unequal lengths answer `false` *before*
 * `timingSafeEqual` (which throws on a length mismatch). The comparison itself is not the only guard
 * a CSRF check has — the `Origin`/`Sec-Fetch-Site` check is the other half — but a leaking `===`
 * would turn a guessable token into a gradually-recoverable one.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqualBytes(left, right);
}

/** Kept apart so the `length` short circuit above cannot be "simplified" into the call. */
function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  // `timingSafeEqual` takes any `ArrayBufferView`, and `TextEncoder` hands one back, so no `Buffer`
  // copy is needed — but the lengths must match first, because a mismatch throws rather than returns.
  return timingSafeEqual(left, right);
}
