/**
 * The in-memory sliding window behind the login rate limit (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * **10 failures per 15 minutes per `lower(username)` + IP**, counted in the process. The brief pairs
 * this with durable `auth_attempts` rows, and the pair is deliberate rather than redundant:
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
  /** Failures still left in this window before it closes — for a log line, never for a response. */
  readonly remaining: number;
}

/** The window, as the auth service uses it. */
export interface RateLimiter {
  /** Does the caller still get to try? Records nothing, so it is safe to call on every request. */
  readonly check: (key: string) => RateLimitDecision;
  /**
   * Records one failure. Only failures belong here: counting a success would lock a user out for the
   * wrong reasons, and the success path calls {@link RateLimiter.reset} instead.
   */
  readonly recordFailure: (key: string) => void;
  /**
   * Forgets a key — a successful login, so a shared address (one office, one family) is not punished
   * because someone else mistyped their password ten times.
   */
  readonly reset: (key: string) => void;
  /** How many keys are currently tracked. For a test and for a future metric, never for logic. */
  readonly trackedKeys: () => number;
}

export interface RateLimiterOptions {
  /** Failures allowed per window before the check starts answering `false` (`LOGIN_RATE_LIMIT_MAX`). */
  readonly max: number;
  /** Window length; defaults to the 15 minutes plan §10 names. */
  readonly windowMs?: number;
  /** The clock. Injectable so the window edges are testable without sleeping. */
  readonly now?: () => number;
  /** Above this many keys, expired ones are swept. Memory is the only resource at risk here. */
  readonly maxTrackedKeys?: number;
}

/** Above this many keys, every record sweeps the map (see `recordFailure`). */
const DEFAULT_MAX_TRACKED_KEYS = 4096;

/**
 * The key one window is counted under: `lower(username)` and the client IP, joined by a character
 * neither can contain.
 *
 * Both halves matter. Username alone would let one attacker lock an account out from a thousand borrowed
 * hosts; IP alone would let one mistyping person lock out every account behind their office NAT while the
 * real target stayed wide open. `lower()` because the account itself is compared case-insensitively
 * (`users_username_lower_uidx`) — counting `Bob` and `bob` apart would hand the window twice its budget.
 */
export function loginRateLimitKey(username: string, ip: string): string {
  return `${username.toLowerCase()}|${ip}`;
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

  /** key → the timestamps of its failures, oldest first, because they are appended in order. */
  const failures = new Map<string, number[]>();

  /** Drops the attempts that have aged out, and the key with them when nothing is left. */
  function prune(key: string, at: number): number[] {
    const kept = (failures.get(key) ?? []).filter((seen) => at - seen < windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  function sweep(at: number): void {
    for (const key of failures.keys()) prune(key, at);
  }

  return {
    check: (key) => {
      const at = now();
      const seen = prune(key, at);
      if (seen.length < max) {
        return { allowed: true, retryAfterSeconds: 0, remaining: max - seen.length };
      }
      // The window is full, so the wait is until its oldest entry leaves — which is exactly the
      // sliding window's promise, restated as a header a client can trust.
      const oldest = seen[0] ?? at;
      const waitMs = Math.max(1, oldest + windowMs - at);
      return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000), remaining: 0 };
    },

    recordFailure: (key) => {
      const at = now();
      // The sweep is what stops a hostile `username` field from growing this map without bound: an
      // attacker invents a new key per request, and on that path the limit that matters is the number
      // of keys, not the `max` per key.
      if (failures.size >= maxTrackedKeys) sweep(at);
      const kept = prune(key, at);
      kept.push(at);
      failures.set(key, kept);
    },

    reset: (key) => {
      failures.delete(key);
    },

    trackedKeys: () => failures.size,
  };
}
