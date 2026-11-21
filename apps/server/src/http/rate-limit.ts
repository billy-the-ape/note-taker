/**
 * The in-memory sliding window behind the login rate limit (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * **10 attempts per 15 minutes**, counted in the process — per `lower(username)` + IP for login, per address
 * for self-sign-up (see {@link loginRateLimitKey} and {@link registerRateLimitKey}). The brief pairs this with
 * durable `auth_attempts` rows, and the pair is deliberate rather than redundant:
 *
 * * the window has to be fast, per-request, and able to say *how long* to wait (`Retry-After`), which
 *   a SQL count on every login would not give cheaply;
 * * the rows have to survive a restart, which this map does not. A process that forgets its lockout on
 *   boot is a process an attacker can restart for them by crashing something else, and the audit
 *   question "did anyone try to get in?" cannot be answered from a map that only holds the last 15
 *   minutes of one process's memory.
 *
 * A **sliding** window rather than a fixed one: with fixed buckets, 10 attempts at 11:59 and 10 more at
 * 12:00 are 20 failures in 60 seconds while neither bucket complains. Sliding costs one array per key,
 * which at self-hosted scale is a rounding error.
 *
 * An attempt is charged **when it arrives, not when its outcome is known**. {@link RateLimiter.take} is
 * synchronous and adds the timestamp before the caller has opened a connection or run argon2, so eleven
 * simultaneous logins are eleven attempts of which ten are answered. A window that counted only *recorded
 * failures* would answer "the eleventh" only once the first ten had finished, which on an endpoint whose verify
 * costs 64 MiB is the difference between a rate limit and a suggestion. In-flight attempts, failed attempts and
 * attempts that died mid-request therefore all cost a slot, and only a success gives the budget back.
 *
 * Nothing here is shared between processes (a Redis store is backlog). On a single-instance MVP — which
 * is what the whole plan is — one process *is* the whole service, and saying so is more honest than
 * pretending an in-memory map is distributed.
 */

/** The window plan §10 names — 15 minutes — in the seconds a `Retry-After` header carries. */
export const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

/** The same window in the milliseconds this module counts in. */
export const LOGIN_RATE_LIMIT_WINDOW_MS = LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;

/** The answer to "may this caller try again, and if not, for how long?". */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until the oldest attempt in the window ages out; `0` when the call is allowed. */
  readonly retryAfterSeconds: number;
  /** Slots still free in this window *after* the one just taken — for a log line, never for a response. */
  readonly remaining: number;
}

/** The window, as the auth service uses it. */
export interface RateLimiter {
  /**
   * Takes a slot in the window and answers whether the caller still gets to try.
   *
   * **It takes the slot synchronously, and that is the whole point.** The alternative — ask, then do the work,
   * then record the failure — lets N simultaneous requests all see an empty window and all reach argon2, which
   * turns "the eleventh attempt is a 429" into "ten failures plus everything already in flight". So the
   * timestamp is written here, before the caller has read a row or verified a hash, and:
   *
   * * a refused call takes **no** slot (it never attempted anything, and a refused client must not be able to
   *   keep itself locked out forever by hammering);
   * * a successful login gives the whole window back via {@link RateLimiter.reset};
   * * an attempt that failed, or died mid-request with a `500`, has already cost the one slot it took.
   */
  readonly take: (key: string) => RateLimitDecision;
  /**
   * Forgets a key — a successful login, so a shared address (one office, one family) is not punished
   * because someone else mistyped their password ten times.
   */
  readonly reset: (key: string) => void;
  /** How many keys are currently tracked. For a test and for a future metric, never for logic. */
  readonly trackedKeys: () => number;
}

export interface RateLimiterOptions {
  /** Attempts allowed per window before a take starts answering `false` (`LOGIN_RATE_LIMIT_MAX`). */
  readonly max: number;
  /** Window length; defaults to the 15 minutes plan §10 names. */
  readonly windowMs?: number;
  /** The clock. Injectable so the window edges are testable without sleeping. */
  readonly now?: () => number;
  /** Above this many keys, expired ones are swept. Memory is the only resource at risk here. */
  readonly maxTrackedKeys?: number;
}

/** Above this many keys, every take sweeps the map (see {@link RateLimiter.take}). */
const DEFAULT_MAX_TRACKED_KEYS = 4096;

/**
 * The key one login window is counted under: `lower(username)` and the client IP, under a `login` namespace.
 *
 * Both halves matter. Username alone would let one attacker lock an account out from a thousand borrowed
 * hosts; IP alone would let one mistyping person lock out every account behind their office NAT while the
 * real target stayed wide open. `lower()` because the account itself is compared case-insensitively
 * (`users_username_lower_uidx`) — counting `Bob` and `bob` apart would hand the window twice its budget.
 *
 * The `login|` prefix is what keeps this key and {@link registerRateLimitKey} apart: `register` is a legal
 * username (`[a-z0-9._-]`, `contracts/auth.schemas.ts`), so an unprefixed pair could collide and let a
 * registration flood spend a login window. The separator cannot be forged by either half as long as the IP is
 * a socket address — with `TRUST_PROXY=true` the address comes from `X-Forwarded-For`, which is the operator's
 * trust decision and is already what makes the IP half whatever the client says.
 */
export function loginRateLimitKey(username: string, ip: string): string {
  return `login|${username.toLowerCase()}|${ip}`;
}

/**
 * The key one self-sign-up window is counted under: the address, and nothing else.
 *
 * Not the username, which is what plan §9.2 #4's "rate-limited like login" would suggest at a glance: the
 * failure this throttles is an enumeration of *usernames*, so a window keyed by the username is evaded by
 * typing a new one on every request. That trade is deliberate and it is a real one — a household or an office
 * whose whole team signs up from one address shares 10 attempts per 15 minutes — and it is acceptable because
 * `ALLOW_REGISTRATION` is off by default and the people it can inconvenience are the ones who turned it on.
 */
export function registerRateLimitKey(ip: string): string {
  return `register|${ip}`;
}

/**
 * Builds the window. Not a class and not a module-level `Map`: `buildApp()` owns one instance, so a test
 * gets a clean window with the app it built rather than with the process.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const windowMs = options.windowMs ?? LOGIN_RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const { max } = options;

  /** key → the timestamps of its attempts, oldest first, because they are appended in order. */
  const attempts = new Map<string, number[]>();

  /** Drops the attempts that have aged out, and the key with them when nothing is left. */
  function prune(key: string, at: number): number[] {
    const kept = (attempts.get(key) ?? []).filter((seen) => at - seen < windowMs);
    if (kept.length === 0) attempts.delete(key);
    else attempts.set(key, kept);
    return kept;
  }

  function sweep(at: number): void {
    for (const key of attempts.keys()) prune(key, at);
  }

  return {
    take: (key) => {
      const at = now();
      // The sweep is what stops a hostile `username` field from growing this map without bound: an
      // attacker invents a new key per request, and on that path the limit that matters is the number
      // of keys, not the `max` per key. It lives here because after this change nothing else writes.
      if (attempts.size >= maxTrackedKeys) sweep(at);

      const seen = prune(key, at);
      if (seen.length >= max) {
        // The window is full, so the wait is until its oldest entry leaves — which is exactly the
        // sliding window's promise, restated as a header a client can trust. No slot is taken: this
        // request never attempted anything, and a refused client may not spend its own way out.
        const oldest = seen[0] ?? at;
        const waitMs = Math.max(1, oldest + windowMs - at);
        return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000), remaining: 0 };
      }

      seen.push(at);
      attempts.set(key, seen);
      return { allowed: true, retryAfterSeconds: 0, remaining: max - seen.length };
    },

    reset: (key) => {
      attempts.delete(key);
    },

    trackedKeys: () => attempts.size,
  };
}
