/**
 * The password policy of the process (docs/plans/mvp/MVP-07.md §5).
 *
 * argon2 costs real time — that is the feature — so these tests are few and each one is about a *claim*, not a
 * round trip: the parameters, the shape of the encoded string, the fact that a failure to verify is a `false`
 * rather than an exception, and the dummy path that keeps "no such user" indistinguishable from "wrong
 * password". The end-to-end version of the last two is the uniform-`401` assertion in
 * `routes/auth.routes.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { ARGON2_PARAMS, constantTimeEqual, createArgon2Hasher, utf8ByteLength } from './passwords.js';

describe('the parameters of plan §10', () => {
  it('are 64 MiB, 3 iterations, 1 lane — the OWASP-ish trio the brief names', () => {
    // Written out rather than compared to itself: these three numbers are the entire cost model of a login, and
    // a "performance improvement" that drops `memoryCost` to 1024 would pass every other test in the repository.
    expect(ARGON2_PARAMS).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  });

  it('are the parameters that end up in the stored string, algorithm and version included', async () => {
    // `$argon2id$v=19$m=65536,t=3,p=1$…` — the string is self-describing, which is what lets this app verify a
    // hash created by a previous parameter set. Asserting it from the output rather than from a flag is the
    // point: the bindings' `Algorithm` enum is a `const enum`, i.e. erased at runtime, so a flag here would be
    // a type-safe-looking `undefined`.
    return createArgon2Hasher()
      .hash('a-password-long-enough')
      .then((encoded) => expect(encoded.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true));
  });

  it('salt every hash, so two accounts with the same password do not share a row an attacker can batch', async () => {
    const hasher = createArgon2Hasher();
    const first = await hasher.hash('the-same-password');
    const second = await hasher.hash('the-same-password');
    expect(second).not.toBe(first);
    // …and both verify, which is the assertion that keeps the salt from being merely different.
    await expect(hasher.verify(first, 'the-same-password')).resolves.toBe(true);
    await expect(hasher.verify(second, 'the-same-password')).resolves.toBe(true);
  });
});

describe('verify', () => {
  const hasher = createArgon2Hasher({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });

  it('says false for a wrong password', async () => {
    const encoded = await hasher.hash('correct-horse-battery');
    await expect(hasher.verify(encoded, 'close-but-wrong')).resolves.toBe(false);
  });

  it('says false for a stored string this build cannot parse, instead of answering 500 with a library message', async () => {
    // A truncated column, a hash copied in from another KDF, an empty string left by a bad migration: all of
    // them are "the password did not match", because the alternative is an endpoint that leaks a stack trace to
    // anybody who can write to a database column.
    for (const encoded of ['', 'not-a-hash', '$argon2id$v=19$m=8192,t=1,p=1$AAAA$AAAA', '  ']) {
      await expect(hasher.verify(encoded, 'anything')).resolves.toBe(false);
    }
  });
});

describe('verifyDummy', () => {
  it('resolves whatever it is given, which is what makes the unknown-user path a normal failure', async () => {
    // Called on the "no such user" branch so that branch costs the same as verifying a real hash. It is
    // deliberately not asserted to be *timings-equal* — a CI box cannot measure that honestly — only that it
    // does the work and never throws, which is what keeps the service's failure path single.
    const hasher = createArgon2Hasher({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });
    await expect(hasher.verifyDummy('a-guess')).resolves.toBeUndefined();
    await expect(hasher.verifyDummy('a-different-guess')).resolves.toBeUndefined();
    await expect(hasher.verifyDummy('')).resolves.toBeUndefined();
  });
});

describe('utf8ByteLength', () => {
  it('counts bytes, not characters, which is the unit the 512-byte cap is written in', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('𝓐')).toBe(4);
    // The distinction is load-bearing: `passwordSchema` bounds characters, and 128 of these is 512 bytes while
    // 129 is not. `routes/auth.schemas.test.ts` is where that boundary is enforced.
    expect(utf8ByteLength('𝓐'.repeat(128))).toBe(512);
  });
});

describe('constantTimeEqual', () => {
  it('compares equal strings, and unequal ones of the same length', () => {
    expect(constantTimeEqual('token-value', 'token-value')).toBe(true);
    expect(constantTimeEqual('token-value', 'token-value'.replace('-', '='))).toBe(false);
  });

  it('answers false for different lengths without throwing, which `timingSafeEqual` would', () => {
    // This is the CSRF comparison. `timingSafeEqual` throws on a length mismatch, and a throw here would surface
    // as a 500 on a request whose only crime was a short header.
    expect(constantTimeEqual('a', '')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a-token', 'a-token-that-is-longer')).toBe(false);
  });

  it('compares bytes, so a multi-byte value is not equal to the text that looks like it', () => {
    expect(constantTimeEqual('café', 'cafe')).toBe(false);
    expect(constantTimeEqual('café', 'café')).toBe(true);
  });
});
