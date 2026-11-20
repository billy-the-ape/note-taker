/**
 * The sliding window, on a clock the test turns by hand (docs/plans/mvp/MVP-07.md §5, §7).
 *
 * Nothing here sleeps: `now` is injectable precisely so that "the eleventh attempt is refused" and "the window
 * has moved on" are two assertions in one run rather than a 15-minute test. The equivalent statements over a
 * real Postgres are in `routes/auth.routes.int.test.ts`, which is where the HTTP shape (`429`, `Retry-After`)
 * lives; this file is about the counting.
 */
import { describe, expect, it } from 'vitest';

import {
  createRateLimiter,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  loginRateLimitKey,
} from './rate-limit.js';

/** A clock the test winds, and the limiter built over it. */
function withClock(startMs = 1_700_000_000_000) {
  let at = startMs;
  const limiter = createRateLimiter({ max: 10, now: () => at });
  return {
    limiter,
    /** Fails `n` times in a row, at the current instant, then advances by `stepMs` after each. */
    fail(n: number, stepMs = 1000) {
      for (let i = 0; i < n; i += 1) {
        limiter.recordFailure(KEY);
        at += stepMs;
      }
    },
    advance(ms: number) {
      at += ms;
    },
  };
}

const KEY = loginRateLimitKey('owner', '203.0.113.7');

describe('the window of plan §10', () => {
  it('is fifteen minutes long, in both units a caller can need', () => {
    // 15 minutes is plan §10's number; the seconds form is what a `Retry-After` is bounded by, and the pair is
    // exported rather than one number in two units. `LOGIN_RATE_LIMIT_MAX` is the operator's knob over the
    // *count* (which `env.ts` defaults to 10); this is the window that count is a budget for.
    expect(LOGIN_RATE_LIMIT_WINDOW_SECONDS).toBe(15 * 60);
    expect(LOGIN_RATE_LIMIT_WINDOW_MS).toBe(LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000);
  });

  it('lets the tenth failure through and refuses the eleventh attempt', () => {
    const { limiter, fail } = withClock();

    // The tenth failure is still a *failure*; what it changes is the next attempt's answer.
    fail(10, 0);
    expect(limiter.check(KEY)).toMatchObject({ allowed: false, remaining: 0 });

    // And the check never records, so refusing is idempotent: a client that hammers gets the same answer.
    const refused = limiter.check(KEY);
    expect(limiter.check(KEY)).toEqual(refused);
  });

  it('counts down `remaining`, which is for a log line and never for a response body', () => {
    const { limiter, fail } = withClock();
    expect(limiter.check(KEY).remaining).toBe(10);
    fail(3, 0);
    expect(limiter.check(KEY).remaining).toBe(7);
  });

  it('answers with a `Retry-After` inside the window it is describing', () => {
    const { limiter, fail } = withClock();
    fail(10, 0);
    const { retryAfterSeconds } = limiter.check(KEY);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(LOGIN_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('slides: the refusal lifts when the oldest failure leaves, not when a bucket rolls over', () => {
    const { limiter, fail, advance } = withClock();
    // Ten failures at one instant, so they all leave the window at the same moment.
    fail(10, 0);
    expect(limiter.check(KEY).allowed).toBe(false);

    // One millisecond before the last of them ages out, it is still a refusal — the fixed-bucket bug this
    // design exists to avoid would have said "allowed" the instant a new bucket started.
    advance(LOGIN_RATE_LIMIT_WINDOW_MS - 1);
    expect(limiter.check(KEY).allowed).toBe(false);

    advance(1);
    expect(limiter.check(KEY)).toMatchObject({ allowed: true, remaining: 10 });
  });

  it('forgets a key on success, so one mistyping guest cannot lock out the household', () => {
    const { limiter, fail } = withClock();
    fail(10, 0);
    expect(limiter.check(KEY).allowed).toBe(false);

    limiter.reset(KEY);
    expect(limiter.check(KEY)).toMatchObject({ allowed: true, remaining: 10 });
  });

  it('counts `lower(username)`+IP as one key, so case never doubles the budget', () => {
    expect(loginRateLimitKey('Owner', '10.0.0.1')).toBe(loginRateLimitKey('owner', '10.0.0.1'));
    // …and so neither half can be dropped: the same name from another address is a different window, and
    // another name from the same address is one too.
    expect(loginRateLimitKey('owner', '10.0.0.2')).not.toBe(loginRateLimitKey('owner', '10.0.0.1'));
    expect(loginRateLimitKey('other', '10.0.0.1')).not.toBe(loginRateLimitKey('owner', '10.0.0.1'));

    const { limiter } = withClock();
    const a = loginRateLimitKey('owner', '10.0.0.1');
    for (let i = 0; i < 10; i += 1) limiter.recordFailure(a);
    limiter.recordFailure(loginRateLimitKey('OWNER', '10.0.0.2'));
    expect(limiter.check(loginRateLimitKey('Owner', '10.0.0.2')).allowed).toBe(true);
  });

  it('sweeps aged-out keys once the map is big, which is the only memory a hostile username can grow', () => {
    // A hostile `username` field invents a new key per request, so the limit that matters on that path is the
    // number of keys, not `max` per key. `maxTrackedKeys` is the threshold at which a record first sweeps.
    let at = 0;
    const limiter = createRateLimiter({ max: 2, now: () => at, windowMs: 1000, maxTrackedKeys: 3 });

    for (const name of ['a', 'b', 'c']) {
      limiter.recordFailure(loginRateLimitKey(name, 'ip'));
      at += 1;
    }
    expect(limiter.trackedKeys()).toBe(3);

    // The map is now at the threshold, so recording `d` prunes first — and a, b and c are all older than the
    // 1000 ms window by now, so the sweep leaves exactly the new key behind.
    at += 1000;
    limiter.recordFailure(loginRateLimitKey('d', 'ip'));
    expect(limiter.trackedKeys()).toBe(1);
    expect(limiter.check(loginRateLimitKey('a', 'ip')).allowed).toBe(true);

    // A key that is still *inside* its window survives the sweep, which is the other half: this is a memory
    // bound, not a way of forgiving an attacker who waits.
    const live = loginRateLimitKey('live', 'ip');
    limiter.recordFailure(live);
    limiter.recordFailure(live);
    at += 999;
    limiter.recordFailure(loginRateLimitKey('e', 'ip'));
    expect(limiter.check(live).allowed).toBe(false);
  });
});
