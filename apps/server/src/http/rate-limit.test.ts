/**
 * The sliding window, on a clock the test turns by hand (docs/plans/mvp/MVP-07.md §5, §7).
 *
 * Nothing here sleeps: `now` is injectable precisely so that "the eleventh attempt is refused" and "the window
 * has moved on" are two assertions in one run rather than a 15-minute test. The equivalent statements over a
 * real Postgres are in `routes/auth.routes.int.test.ts`, which is where the HTTP shape (`429`, `Retry-After`)
 * and the *simultaneous* burst live; this file is about the counting.
 *
 * The one property worth reading twice is that an allowed `take` **spends** the slot it grants. Every
 * expectation of a refusal below is reached by taking slots, never by recording failures — which is the fix
 * for the bypass the review found, and it is what makes the refusal independent of whether any earlier attempt
 * has finished.
 */
import { describe, expect, it } from 'vitest';

import {
  createRateLimiter,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  loginRateLimitKey,
  type RateLimitDecision,
  registerRateLimitKey,
} from './rate-limit.js';

/** A clock the test winds, and the limiter built over it. */
function withClock(startMs = 1_700_000_000_000) {
  let at = startMs;
  const limiter = createRateLimiter({ max: 10, now: () => at });
  return {
    limiter,
    /** Takes `n` slots in a row at the current instant and hands back every answer, in order. */
    attempt(n: number, stepMs = 1000): RateLimitDecision[] {
      const decisions: RateLimitDecision[] = [];
      for (let i = 0; i < n; i += 1) {
        decisions.push(limiter.take(KEY));
        at += stepMs;
      }
      return decisions;
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

  it('lets the tenth attempt through and refuses the eleventh, with nothing recorded in between', () => {
    const { limiter, attempt } = withClock();

    // There is no "record the failure" step left anywhere in this file, and that is the point: the tenth allowed
    // `take` is what makes the eleventh a refusal. A request that never resolves — one still in flight, one that
    // died with a `500` — has already spent its slot, which is the only way eleven simultaneous logins can be ten
    // answers and one `429` rather than eleven argon2 verifications.
    const decisions = attempt(11, 0);
    expect(decisions.slice(0, 10).every((decision) => decision.allowed)).toBe(true);
    expect(decisions[10]).toMatchObject({ allowed: false, remaining: 0 });

    // …and a refusal takes no slot, so hammering a closed window is idempotent: the client cannot spend its way
    // deeper into the lockout, and `Retry-After` keeps pointing at the same instant.
    const refused = limiter.take(KEY);
    expect(limiter.take(KEY)).toEqual(refused);
  });

  it('counts down `remaining` from the slot it just granted', () => {
    const { limiter, attempt } = withClock();
    // Nine, not ten: `remaining` is what is left *after* the request being answered, because the number is for a
    // log line and a log line that overstates the budget by one is worse than one that understates it.
    expect(limiter.take(KEY).remaining).toBe(9);
    attempt(3, 0);
    expect(limiter.take(KEY).remaining).toBe(5);
  });

  it('answers with a `Retry-After` inside the window it is describing', () => {
    const { limiter, attempt } = withClock();
    attempt(10, 0);
    const { retryAfterSeconds } = limiter.take(KEY);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(LOGIN_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('slides: the refusal lifts when the oldest attempt leaves, not when a bucket rolls over', () => {
    const { limiter, attempt, advance } = withClock();
    // Ten attempts at one instant, so they all leave the window at the same moment.
    attempt(10, 0);
    expect(limiter.take(KEY).allowed).toBe(false);

    // One millisecond before the last of them ages out, it is still a refusal — the fixed-bucket bug this
    // design exists to avoid would have said "allowed" the instant a new bucket started.
    advance(LOGIN_RATE_LIMIT_WINDOW_MS - 1);
    expect(limiter.take(KEY).allowed).toBe(false);

    advance(1);
    expect(limiter.take(KEY)).toMatchObject({ allowed: true, remaining: 9 });
  });

  it('forgets a key on success, so one mistyping guest cannot lock out the household', () => {
    const { limiter, attempt } = withClock();
    attempt(10, 0);
    expect(limiter.take(KEY).allowed).toBe(false);

    limiter.reset(KEY);
    expect(limiter.take(KEY)).toMatchObject({ allowed: true, remaining: 9 });
  });

  it('counts `lower(username)`+IP as one key, so case never doubles the budget', () => {
    expect(loginRateLimitKey('Owner', '10.0.0.1')).toBe(loginRateLimitKey('owner', '10.0.0.1'));
    // …and so neither half can be dropped: the same name from another address is a different window, and
    // another name from the same address is one too.
    expect(loginRateLimitKey('owner', '10.0.0.2')).not.toBe(loginRateLimitKey('owner', '10.0.0.1'));
    expect(loginRateLimitKey('other', '10.0.0.1')).not.toBe(loginRateLimitKey('owner', '10.0.0.1'));

    const { limiter } = withClock();
    const a = loginRateLimitKey('owner', '10.0.0.1');
    for (let i = 0; i < 10; i += 1) limiter.take(a);
    limiter.take(loginRateLimitKey('OWNER', '10.0.0.2'));
    expect(limiter.take(loginRateLimitKey('Owner', '10.0.0.2')).allowed).toBe(true);
  });

  it('keeps the register window a different key from the login window of the same-looking name', () => {
    // `register` is a legal username (`[a-z0-9._-]`), so this is not a clash in the abstract: without the
    // namespaces, a flood of `POST /api/auth/register` bodies naming `register` could spend the login budget of
    // the account literally called `register`, or the two windows could share a map entry and silently halve
    // each other.
    const ip = '203.0.113.9';
    expect(loginRateLimitKey('register', ip)).not.toBe(registerRateLimitKey(ip));

    const { limiter } = withClock();
    for (let i = 0; i < 10; i += 1) limiter.take(loginRateLimitKey('register', ip));
    // Ten login attempts against that account, and self-sign-up from the same address is untouched.
    expect(limiter.take(loginRateLimitKey('register', ip)).allowed).toBe(false);
    expect(limiter.take(registerRateLimitKey(ip))).toMatchObject({ allowed: true, remaining: 9 });
  });

  it('sweeps aged-out keys once the map is big, which is the only memory a hostile username can grow', () => {
    // A hostile `username` field invents a new key per request, so the limit that matters on that path is the
    // number of keys, not `max` per key. `maxTrackedKeys` is the threshold at which a take first sweeps.
    let at = 0;
    const limiter = createRateLimiter({ max: 2, now: () => at, windowMs: 1000, maxTrackedKeys: 3 });

    for (const name of ['a', 'b', 'c']) {
      limiter.take(loginRateLimitKey(name, 'ip'));
      at += 1;
    }
    expect(limiter.trackedKeys()).toBe(3);

    // The map is now at the threshold, so taking `d` prunes first — and a, b and c are all older than the
    // 1000 ms window by now, so the sweep leaves exactly the new key behind.
    at += 1000;
    limiter.take(loginRateLimitKey('d', 'ip'));
    expect(limiter.trackedKeys()).toBe(1);
    expect(limiter.take(loginRateLimitKey('a', 'ip')).allowed).toBe(true);

    // A key that is still *inside* its window survives the sweep, which is the other half: this is a memory
    // bound, not a way of forgiving an attacker who waits.
    const live = loginRateLimitKey('live', 'ip');
    limiter.take(live);
    limiter.take(live);
    at += 999;
    limiter.take(loginRateLimitKey('e', 'ip'));
    expect(limiter.take(live).allowed).toBe(false);
  });
});
