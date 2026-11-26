/**
 * Every row of §4's table, with fake timers (docs/plans/mvp/MVP-14.md §8).
 *
 * The suite is written against the machine alone: `save` is a scripted queue of answers, the draft
 * mirror is two arrays, and `Date.now` is Vitest's, so nothing here needs a DOM, a fetch, or a
 * server. That is the point of `lib/autosave.ts` being a closure over plain values — a state table this
 * load-bearing has to be asserted row by row, and the three lost-response cases in particular cannot
 * be produced by any honest HTTP test, because the whole case is "the server did X and the reply did
 * not arrive".
 *
 * Three helper shapes carry the whole file:
 *
 * * `start({...})` builds a machine plus the recorder it writes into;
 * * `ok(v)` / `err(x)` / `hang()` are the scripted answers, popped in order, and a call with nothing
 *   left in the queue throws — so "exactly one `PUT`" is a fact about the queue, not a hope;
 * * `tick(ms)` moves the fake clock and `flush()` drains the microtasks a settled promise needs.
 */
import { API_ERROR_MESSAGES, type ApiErrorCode } from '@note-taker/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import type { DraftMirror } from './autosave';
import {
  AUTOSAVE_BACKOFF_MS,
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_UNFLUSHED_MS,
  AUTOSAVE_UNLOAD_BUDGET_BYTES,
  type AutosaveSettings,
  classifyWriteFailure,
  createAutosaver,
  type SaveCall,
  type SavedNote,
} from './autosave';

// --- the scripted transport ----------------------------------------------------------------------

/** One scripted answer to one `save`. `hang` is a response that never comes, until a test sends one. */
type Reply =
  | { readonly kind: 'ok'; readonly version: number }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'hang' };

interface Hang {
  readonly resolve: (note: SavedNote) => void;
  readonly reject: (error: unknown) => void;
}

const ok = (version: number): Reply => ({ kind: 'ok', version });
const err = (error: unknown): Reply => ({ kind: 'error', error });
const hang = (): Reply => ({ kind: 'hang' });

/** An `ApiError` exactly as `lib/api.ts` builds one from an envelope. */
function apiError(status: number, code: ApiErrorCode, data?: Record<string, unknown>): ApiError {
  return new ApiError({
    status,
    code,
    message: API_ERROR_MESSAGES[code],
    ...(data === undefined ? {} : { data }),
  });
}

/** The `409 VERSION_CONFLICT` of §9.2 #18, carrying the pair §5 compares. */
const versionConflict = (content: string, version: number): Reply =>
  err(apiError(409, 'VERSION_CONFLICT', { content, version }));

/** A connection reset: from the client's seat, indistinguishable from "never reached the server". */
const dropped = (): Reply => err(new TypeError('Failed to fetch'));
/** A `5xx`, i.e. the other half of §4's `retrying` row. */
const serverError = (): Reply => err(apiError(500, 'INTERNAL'));

interface MirrorEntry {
  readonly op: 'write' | 'clear';
  readonly content: string;
}

interface StartOptions {
  readonly content?: string;
  readonly version?: number;
  readonly autosave?: boolean;
  readonly debounceMs?: number;
  readonly maxUnflushedMs?: number;
  readonly backoffMs?: readonly number[];
  readonly unloadBudgetBytes?: number;
  readonly onUnauthorized?: () => void;
}

/**
 * The machine plus everything it was made to remember.
 *
 * `autosave` is a live variable rather than a fixed boolean because §6's flag is read through a
 * getter: a test must be able to flip it mid-run the way PR-16's toggle will.
 */
function start(options: StartOptions = {}) {
  const queue: Reply[] = [];
  const calls: SaveCall[] = [];
  const mirror: MirrorEntry[] = [];
  const hangs: Hang[] = [];
  let autosave = options.autosave ?? true;
  let inFlight = 0;
  let maxInFlight = 0;

  const draft: DraftMirror = {
    write: (content) => {
      mirror.push({ op: 'write', content });
    },
    clear: (content) => {
      mirror.push({ op: 'clear', content });
    },
  };

  const machine = createAutosaver({
    settings: (): AutosaveSettings => ({ autosave }),
    draft,
    content: options.content ?? 'server text',
    version: options.version ?? 1,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.maxUnflushedMs === undefined ? {} : { maxUnflushedMs: options.maxUnflushedMs }),
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    ...(options.unloadBudgetBytes === undefined ? {} : { unloadBudgetBytes: options.unloadBudgetBytes }),
    ...(options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized }),
    save: async (call) => {
      calls.push(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const reply = queue.shift();
      if (reply === undefined) throw new Error(`no scripted answer left for ${call.content}`);
      try {
        if (reply.kind === 'hang') {
          return await new Promise<SavedNote>((resolve, reject) => {
            hangs.push({ resolve, reject });
          });
        }
        if (reply.kind === 'error') throw reply.error;
        return { version: reply.version };
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    machine,
    calls,
    mirror,
    /** Script the next answers, in order. */
    reply: (...replies: readonly Reply[]) => {
      queue.push(...replies);
    },
    /** Settle the Nth hung request, oldest first. */
    settle: (index: number, ...replies: readonly Reply[]) => {
      const entry = hangs[index];
      const reply = replies[0];
      if (entry === undefined || reply === undefined) throw new Error(`no hung request #${index}`);
      hangs.splice(index, 1);
      if (reply.kind === 'ok') entry.resolve({ version: reply.version });
      else if (reply.kind === 'error') entry.reject(reply.error);
      else throw new Error('settle needs an answer, not another hang');
    },
    setAutosave: (value: boolean) => {
      autosave = value;
    },
    get autosave(): boolean {
      return autosave;
    },
    /** The peak of overlapping requests, which must never exceed 1 (§4's rule 1). */
    peak: () => maxInFlight,
  };
}

const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** Drain the microtasks a settled `save` needs before the machine has reacted. */
async function flushed(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

/** A buffer of `bytes` bytes, ASCII, so the byte maths is the same maths the code does. */
const textOf = (bytes: number): string => 'a'.repeat(bytes);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:03:11.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the debounce (§6)', () => {
  it('writes 5 keystrokes typed in 200 ms exactly once, and then stays quiet for 2 s', async () => {
    const h = start({ content: 'body', version: 7 });
    h.reply(ok(8));

    h.machine.onEdit('a');
    for (const text of ['ab', 'abc', 'abcd', 'abcde']) {
      await tick(40);
      h.machine.onEdit(text);
    }

    // 160 ms in: the window is still open, so nothing has left.
    expect(h.calls).toEqual([]);

    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.calls).toEqual([{ content: 'abcde', baseVersion: 7, via: 'put' }]);
    expect(h.machine.snapshot().state).toBe('clean');
    expect(h.machine.snapshot().version).toBe(8);
    expect(h.machine.snapshot().dirty).toBe(false);

    // The quiet part of the criterion: an idle note costs nothing.
    await tick(2_000);
    await flushed();
    expect(h.calls).toHaveLength(1);
  });

  it('never writes a note nobody edited, however long the tab stays open', async () => {
    const h = start({ content: 'body', version: 4 });
    await tick(60_000);
    expect(h.calls).toEqual([]);
    expect(h.machine.snapshot().state).toBe('clean');
  });

  it('re-opens the window on every keystroke instead of writing on the first one', async () => {
    const h = start({ content: '', version: 1 });
    h.reply(ok(2), ok(3));

    h.machine.onEdit('one');
    await tick(AUTOSAVE_DEBOUNCE_MS - 1);
    h.machine.onEdit('two');
    await tick(AUTOSAVE_DEBOUNCE_MS - 1);
    h.machine.onEdit('three');
    expect(h.calls).toEqual([]);

    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toEqual([{ content: 'three', baseVersion: 1, via: 'put' }]);
  });
});

describe('the force-flush at 10 s (§6)', () => {
  it('writes at the cap when the keystrokes keep the debounce window open', async () => {
    const h = start({ content: 'x', version: 1 });
    h.reply(ok(2));

    h.machine.onEdit('e1');
    for (let index = 2; index <= 10; index += 1) {
      await tick(1_000); // one keystroke a second: the 1200 ms window never closes…
      h.machine.onEdit(`e${index}`);
    }
    expect(h.calls).toEqual([]); // …and 9 s of typing has not written anything

    await tick(1_000); // …so the cap does, at 10 s from the moment the buffer became dirty
    await flushed();

    expect(h.calls).toEqual([{ content: 'e10', baseVersion: 1, via: 'put' }]);
    expect(AUTOSAVE_MAX_UNFLUSHED_MS).toBe(10_000);
  });

  it('does not fire while a retry backoff is running, which would break the schedule', async () => {
    const h = start({ content: 'a', version: 1 });
    for (let index = 0; index < 6; index += 1) h.reply(serverError());

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    // Straight over the 10 s cap: the only writes are the ones the backoff scheduled.
    await tick(40_000);
    await flushed();
    expect(h.calls).toHaveLength(5); // 1.2 s, 2.2 s, 4.2 s, 8.2 s, 16.2 s — and nothing at 10 s
    expect(h.machine.snapshot().state).toBe('retrying');
  });
});

describe('the backoff schedule (§4, §6)', () => {
  it('is exactly 1 s, 2 s, 4 s, 8 s, 30 s and then a terminal error', async () => {
    expect(AUTOSAVE_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 30_000]);

    const h = start({ content: 'a', version: 1 });
    for (let index = 0; index < 6; index += 1) h.reply(serverError());

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toHaveLength(1);
    expect(h.machine.snapshot()).toMatchObject({ state: 'retrying', attempt: 1 });

    const schedule = [1_000, 2_000, 4_000, 8_000, 30_000];
    for (const [index, delay] of schedule.entries()) {
      await tick(delay - 1);
      expect(h.calls).toHaveLength(index + 1); // nothing early
      await tick(1);
      await flushed();
      expect(h.calls).toHaveLength(index + 2); // the attempt fires on the dot
      expect(h.machine.snapshot().state).toBe(index + 2 <= 5 ? 'retrying' : 'error');
    }

    // Six attempts (the write plus five retries) and no seventh: the budget is spent.
    await tick(120_000);
    await flushed();
    expect(h.calls).toHaveLength(6);
    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      failure: { kind: 'unavailable', code: 'INTERNAL', status: 500, recoverable: true },
    });
  });

  it('treats a transport failure the way §4 does: the same row as a 5xx', async () => {
    const h = start({ content: 'a', version: 1 });
    h.reply(dropped(), ok(2));

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.machine.snapshot()).toMatchObject({ state: 'retrying', attempt: 1 });

    await tick(1_000);
    await flushed();
    expect(h.calls).toHaveLength(2);
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 2 });
  });

  it('re-sends the request that failed, and a manual retry starts a fresh budget', async () => {
    const h = start({ content: 'a', version: 1 });
    for (let index = 0; index < 6; index += 1) h.reply(serverError());
    h.reply(ok(9));

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 30_000]) {
      await tick(delay);
      await flushed();
    }

    expect(h.machine.snapshot().state).toBe('error');
    // Every retry carried the same bytes and the same `baseVersion` it started with (§5's premise: the
    // payload the conflict is compared against has to be the one that went on the wire).
    expect(h.calls).toHaveLength(6);
    for (const call of h.calls) {
      expect(call).toEqual({ content: 'b', baseVersion: 1, via: 'put' });
    }

    expect(h.machine.retry()).toBe('written');
    expect(h.machine.snapshot().attempt).toBe(0);
    expect(h.machine.snapshot().failure).toBeUndefined();

    await flushed();
    expect(h.calls).toHaveLength(7);
    expect(h.calls[6]).toEqual({ content: 'b', baseVersion: 1, via: 'put' });
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 9 });
  });
});

describe('the VERSION_CONFLICT fork (§5)', () => {
  /**
   * The case that makes retry safe. The stub committed and then the reply died, so the retry replays
   * the same `baseVersion`, the conditional update matches nothing, and the payload comes back saying
   * "this is already the row". A client that treats every conflict as a collision would show a banner
   * over a note that is already saved.
   */
  it('adopts the version and stays clean when the payload equals the in-flight snapshot', async () => {
    const h = start({ content: 'server', version: 7 });
    h.reply(dropped(), versionConflict('final text', 8), ok(9));

    h.machine.onEdit('final text');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls[0]).toEqual({ content: 'final text', baseVersion: 7, via: 'put' });
    expect(h.machine.snapshot().state).toBe('retrying');

    await tick(1_000);
    await flushed();

    // The replay: the same bytes, the same `baseVersion` (§5's premise).
    expect(h.calls[1]).toEqual({ content: 'final text', baseVersion: 7, via: 'put' });
    expect(h.machine.snapshot()).toMatchObject({
      state: 'clean',
      version: 8,
      dirty: false,
      attempt: 0,
    });
    expect(h.machine.snapshot().conflict).toBeUndefined();

    // …and autosave is still autosave: the next edit writes against the adopted version.
    h.machine.onEdit('final text, continued');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls[2]).toEqual({ content: 'final text, continued', baseVersion: 8, via: 'put' });
  });

  it('enters conflict with the buffer retained when the payload differs — the fork is not a blanket suppress', async () => {
    const h = start({ content: 'server', version: 7 });
    h.reply(dropped(), versionConflict('what the other tab wrote', 8));

    h.machine.onEdit('my text');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await tick(1_000);
    await flushed();

    expect(h.machine.snapshot()).toMatchObject({
      state: 'conflict',
      version: 7, // not adopted: the server's row is not ours
    });
    expect(h.machine.snapshot().conflict).toEqual({
      serverContent: 'what the other tab wrote',
      serverVersion: 8,
    });
    expect(h.machine.getBuffer()).toBe('my text');
    expect(h.machine.isDirty()).toBe(true);

    // Autosave is paused while the banner is up: nothing else leaves on its own.
    await tick(120_000);
    await flushed();
    expect(h.calls).toHaveLength(2);
  });

  /**
   * The case that proves the comparison runs against the in-flight snapshot and not the live buffer:
   * a keystroke lands after the reply was lost, so the replayed payload still matches the snapshot,
   * the version is adopted, and the machine lands in `dirty` — then writes the newer text. Never a
   * conflict, and nothing typed is lost.
   */
  it('lands in dirty and re-writes when an edit lands after the lost response', async () => {
    const h = start({ content: 'base', version: 3 });
    h.reply(dropped(), versionConflict('v1', 4), ok(5));

    h.machine.onEdit('v1');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.machine.snapshot().state).toBe('retrying');

    // The edit that makes the naive comparison wrong: by the time the replay is answered, the buffer
    // is not the payload any more.
    h.machine.onEdit('v1 edited during the backoff');

    await tick(1_000);
    await flushed();

    expect(h.calls[1]).toEqual({ content: 'v1', baseVersion: 3, via: 'put' });
    expect(h.machine.snapshot().conflict).toBeUndefined();
    expect(h.machine.snapshot()).toMatchObject({ state: 'dirty', version: 4, dirty: true });

    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls[2]).toEqual({
      content: 'v1 edited during the backoff',
      baseVersion: 4,
      via: 'put',
    });

    await tick(60_000);
    await flushed();
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 5 });
    expect(h.machine.getBuffer()).toBe('v1 edited during the backoff');
  });

  it('does not treat a payload it cannot compare as permission to keep quiet', async () => {
    // A proxy that ate the `data` half of the envelope: no comparison is possible, so this is a
    // stranger's refusal, and the honest answer is an error rather than a retry loop.
    const h = start({ content: 'a', version: 1 });
    h.reply(err(apiError(409, 'VERSION_CONFLICT')));

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      failure: { kind: 'rejected', code: 'VERSION_CONFLICT' },
    });
  });

  it('never reacts to plain CONFLICT, which is a sibling-name clash and nothing else', async () => {
    const h = start({ content: 'a', version: 1 });
    h.reply(err(apiError(409, 'CONFLICT', { id: '0198-other-row' })), ok(2));

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.snapshot().state).toBe('error');
    expect(h.machine.snapshot().conflict).toBeUndefined();
    expect(h.machine.snapshot()).toMatchObject({ failure: { kind: 'rejected', code: 'CONFLICT' } });

    // §4's `error` row for a recoverable failure: the next keystroke is a fresh attempt.
    h.machine.onEdit('c');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toHaveLength(2);
    expect(h.machine.snapshot().state).toBe('clean');
  });
});

describe('the conflict resolutions (§4, §6)', () => {
  /** Get into `conflict` with a second writer, with the machine settled and the queue empty. */
  async function inConflict() {
    const h = start({ content: 'server', version: 7 });
    h.reply(versionConflict('theirs', 8));
    h.machine.onEdit('mine');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.machine.snapshot().state).toBe('conflict');
    return h;
  }

  it('"Keep mine" writes the retained buffer against the fresh server version', async () => {
    const h = await inConflict();
    h.reply(ok(9));

    expect(h.machine.keepMine()).toBe('written');
    await flushed();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({ content: 'mine', baseVersion: 8, via: 'put' });
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 9 });
    expect(h.machine.snapshot().conflict).toBeUndefined();
  });

  it('"Use server" replaces the buffer and clears the draft mirror with the text it discards', async () => {
    const h = await inConflict();
    h.mirror.splice(0, h.mirror.length);

    h.machine.useServer();

    expect(h.machine.getBuffer()).toBe('theirs');
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 8, dirty: false });
    // The mirror held "mine"; that is the entry it may remove, and the only one it may remove.
    expect(h.mirror).toEqual([{ op: 'clear', content: 'mine' }]);
    expect(h.machine.snapshot().conflict).toBeUndefined();

    await tick(60_000);
    expect(h.calls).toHaveLength(1); // adopting the server copy writes nothing
  });

  it('ignores a resolution nobody asked for, which is what a stale banner click looks like', () => {
    const h = start({ content: 'server', version: 7 });

    expect(h.machine.keepMine()).toBe('nothing-to-write');
    expect(() => h.machine.useServer()).not.toThrow();
    expect(h.machine.getBuffer()).toBe('server');
    expect(h.calls).toEqual([]);
  });

  it('keeps the conflict, and stays paused, when the person types while it is up', async () => {
    const h = await inConflict();
    h.machine.onEdit('mine, and then some');

    expect(h.machine.snapshot().state).toBe('conflict');
    expect(h.machine.getBuffer()).toBe('mine, and then some');

    await tick(120_000);
    expect(h.calls).toHaveLength(1);
    // The new text is not lost: the mirror holds it.
    expect(h.mirror.at(-1)).toEqual({ op: 'write', content: 'mine, and then some' });
  });
});

describe('the one request in flight (§4 rule 1 and rule 2)', () => {
  it('parks an edit made during a write, then sends the newest buffer with the newest version', async () => {
    const h = start({ content: 'body', version: 4 });
    h.reply(hang(), ok(6));

    h.machine.onEdit('a');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toHaveLength(1);
    expect(h.machine.snapshot().state).toBe('saving');

    h.machine.onEdit('ab'); // the keystroke that must not start a second request
    expect(h.machine.snapshot().state).toBe('dirty');
    expect(h.calls).toHaveLength(1);
    expect(h.peak()).toBe(1);

    h.settle(0, ok(5));
    await flushed();

    // The write landed, and the buffer is newer: dirty, with a window that opens now (§4 rule 2).
    expect(h.machine.snapshot()).toMatchObject({ state: 'dirty', version: 5, dirty: true });
    expect(h.calls).toHaveLength(1);

    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls[1]).toEqual({ content: 'ab', baseVersion: 5, via: 'put' });

    await tick(60_000);
    await flushed();
    expect(h.calls).toHaveLength(2);
    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 6 });
    expect(h.peak()).toBe(1); // never two at once, at any point in the run
  });

  it('refuses a manual flush while a request is in flight rather than racing it', async () => {
    const h = start({ content: 'body', version: 4 });
    h.reply(hang());

    h.machine.onEdit('a');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.flush()).toBe('in-flight');
    expect(h.machine.flushAutomatic()).toBe('in-flight');
    expect(h.calls).toHaveLength(1);
  });

  it('says so when there is nothing to write', () => {
    const h = start({ content: 'body', version: 4 });
    expect(h.machine.flush()).toBe('nothing-to-write');
    expect(h.machine.flushAutomatic()).toBe('nothing-to-write');
    expect(h.calls).toEqual([]);
  });
});

describe('the four error rows (§4)', () => {
  it('401: stops autosaving, says the session is gone, and leaves the text in the mirror', async () => {
    let routed = 0;
    const h = start({
      content: 'body',
      version: 3,
      onUnauthorized: () => {
        routed += 1;
      },
    });
    h.reply(err(apiError(401, 'UNAUTHORIZED')));

    h.machine.onEdit('typed after signing in');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      stopped: true,
      failure: { kind: 'unauthorized', code: 'UNAUTHORIZED', status: 401, recoverable: false },
    });
    expect(routed).toBe(1); // the hook's routing to /login hangs off this one call

    // Typing on does not resurrect the machine; the mirror is what makes that survivable.
    h.machine.onEdit('typed after signing in, still going');
    await tick(120_000);
    await flushed();
    expect(h.calls).toHaveLength(1);
    expect(h.machine.isDirty()).toBe(true);
    expect(h.mirror.at(-1)).toEqual({
      op: 'write',
      content: 'typed after signing in, still going',
    });
    expect(h.mirror.some((entry) => entry.op === 'clear')).toBe(false);
  });

  it('403: surfaces the one answer the CSRF replay already failed to fix, then lets a keystroke retry', async () => {
    const h = start({ content: 'body', version: 3 });
    // Exactly one scripted answer: `lib/api.ts` has already done its refresh-and-replay inside this
    // call, so a machine that retried here would be replaying the request a second time more.
    h.reply(err(apiError(403, 'FORBIDDEN')), ok(4));

    h.machine.onEdit('a');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.calls).toHaveLength(1);
    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      stopped: false,
      failure: { kind: 'forbidden', recoverable: true },
    });

    h.machine.onEdit('b');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toHaveLength(2);
    expect(h.machine.snapshot().state).toBe('clean');
  });

  it('404: stops for good, and never re-creates the note that was deleted elsewhere', async () => {
    const h = start({ content: 'body', version: 3 });
    h.reply(err(apiError(404, 'NOT_FOUND')));

    h.machine.onEdit('a');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      stopped: true,
      failure: { kind: 'deleted', code: 'NOT_FOUND', status: 404, recoverable: false },
    });

    for (const text of ['a', 'ab', 'abc']) {
      h.machine.onEdit(text);
      await tick(60_000);
      await flushed();
    }
    // The escape hatch is a `POST` and a person pressing a button; it is never this machine writing an
    // `INSERT` under a name somebody else may have claimed.
    expect(h.calls).toHaveLength(1);
    expect(h.machine.getBuffer()).toBe('abc');
  });

  it('413: quotes the server, and shrinks back to dirty when the next edit fixes the size', async () => {
    const h = start({ content: 'body', version: 3 });
    h.reply(err(apiError(413, 'PAYLOAD_TOO_LARGE')));

    h.machine.onEdit(textOf(2 * 1024 * 1024));
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.machine.snapshot()).toMatchObject({
      state: 'error',
      failure: { kind: 'rejected', code: 'PAYLOAD_TOO_LARGE' },
    });

    h.machine.onEdit('short again');
    expect(h.machine.snapshot().state).toBe('dirty');
  });
});

describe('the injected flag (§6)', () => {
  it('writes nothing automatically when autosave is off, and still writes when asked', async () => {
    const h = start({ content: 'body', version: 2, autosave: false });
    h.reply(ok(3), ok(4));

    h.machine.onEdit('typed with autosave off');
    await tick(120_000);
    await flushed();
    expect(h.calls).toEqual([]);
    expect(h.machine.isDirty()).toBe(true);

    // Ctrl/Cmd+S and the Save button are unaffected by the flag.
    expect(h.machine.flush()).toBe('written');
    await flushed();
    expect(h.calls).toEqual([{ content: 'typed with autosave off', baseVersion: 2, via: 'put' }]);

    // …and an automatic flush is still refused, so the flag cannot be worn down by waiting.
    h.machine.onEdit('edited again');
    expect(h.machine.flushAutomatic()).toBe('autosave-off');
    expect(h.calls).toHaveLength(1);
  });

  it('re-opens the window when the flag flips back on, without waiting for the next keystroke', async () => {
    const h = start({ content: 'body', version: 2, autosave: false });
    h.reply(ok(3));

    h.machine.onEdit('typed while off');
    await tick(60_000);
    expect(h.calls).toEqual([]);

    h.setAutosave(true);
    h.machine.resume();
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(h.calls).toEqual([{ content: 'typed while off', baseVersion: 2, via: 'put' }]);
  });

  it('never arms the 10 s cap while it is off', async () => {
    const h = start({ content: 'body', version: 2, autosave: false });
    h.machine.onEdit('typed while off');
    await tick(AUTOSAVE_MAX_UNFLUSHED_MS * 3);
    await flushed();
    expect(h.calls).toEqual([]);
  });
});

describe('the unload path (§6)', () => {
  const SMALL = 40 * 1024; // 40 KiB: inside the budget, and what §8's criterion types in as
  const LARGE = 200 * 1024; // 200 KiB: over it, so nothing may be attempted

  it('sends one keepalive write for a dirty buffer inside the budget', () => {
    const h = start({ content: 'body', version: 6 });
    h.reply(hang());
    expect(AUTOSAVE_UNLOAD_BUDGET_BYTES).toBe(60 * 1024);

    h.machine.onEdit(textOf(SMALL));
    expect(h.machine.canFlushOnUnload()).toBe(true);
    expect(h.machine.flushOnUnload()).toBe('sent');
    expect(h.calls).toEqual([{ content: textOf(SMALL), baseVersion: 6, via: 'keepalive' }]);
    // The machine stays honest about an answer it may never see: `saving`, not `clean`.
    expect(h.machine.snapshot().state).toBe('saving');
    expect(h.machine.snapshot().lastUnload).toBe('sent');
  });

  it('attempts nothing over the budget, and stays dirty', () => {
    const h = start({ content: 'body', version: 6 });

    h.machine.onEdit(textOf(LARGE));
    expect(h.machine.canFlushOnUnload()).toBe(false);
    expect(h.machine.flushOnUnload()).toBe('too-large');
    expect(h.calls).toEqual([]);
    expect(h.machine.isDirty()).toBe(true);
    expect(h.machine.snapshot().state).toBe('dirty'); // the pill says `Unsaved changes`
    expect(h.machine.getUnsavedBytes()).toBe(LARGE);
  });

  it('refuses on an unloaded page for every reason §6 gives', () => {
    const clean = start({ content: 'body', version: 1 });
    expect(clean.machine.flushOnUnload()).toBe('clean');

    const off = start({ content: 'body', version: 1, autosave: false });
    off.machine.onEdit('typed while off');
    expect(off.machine.flushOnUnload()).toBe('autosave-off');
    expect(off.calls).toEqual([]);
  });

  it('refuses on an unloaded page once a conflict or a stopped machine owns the buffer', async () => {
    const conflicted = start({ content: 'body', version: 1 });
    conflicted.reply(versionConflict('theirs', 2));
    conflicted.machine.onEdit('mine');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(conflicted.machine.flushOnUnload()).toBe('conflict');
    expect(conflicted.calls).toHaveLength(1);

    const stopped = start({ content: 'body', version: 1 });
    stopped.reply(err(apiError(401, 'UNAUTHORIZED')));
    stopped.machine.onEdit('typed');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    expect(stopped.machine.snapshot().stopped).toBe(true);

    stopped.machine.onEdit('typed after the session went');
    expect(stopped.machine.flushOnUnload()).toBe('stopped');
    expect(stopped.calls).toHaveLength(1);
  });

  it('will not queue a second write behind one already in flight', async () => {
    const h = start({ content: 'body', version: 1 });
    h.reply(hang(), hang());

    h.machine.onEdit('a');
    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();
    h.machine.onEdit('ab');

    expect(h.machine.flushOnUnload()).toBe('in-flight');
    expect(h.calls).toHaveLength(1);
    expect(h.peak()).toBe(1);
  });
});

describe('the snapshot (§4)', () => {
  it('is referentially stable between changes, which is what useSyncExternalStore needs', () => {
    const h = start({ content: 'body', version: 2 });
    const first = h.machine.snapshot();
    expect(h.machine.snapshot()).toBe(first);

    h.machine.onEdit('typed');
    const second = h.machine.snapshot();
    expect(second).not.toBe(first);
    expect(second.state).toBe('dirty');
    expect(second.buffer).toBe('typed');
  });

  it('follows a server re-read without dirtying anything (§9.2 #17)', () => {
    const h = start({ content: 'body', version: 2 });
    h.machine.adopt('what the server says now', 5);

    expect(h.machine.snapshot()).toMatchObject({ state: 'clean', version: 5, dirty: false });
    expect(h.machine.getBuffer()).toBe('what the server says now');
    expect(h.machine.getUnsavedBytes()).toBe(0); // nothing unsaved, so nothing to warn about
  });

  it('treats a manual retry outside an error as the flush it looks like', () => {
    const h = start({ content: 'body', version: 2 });
    h.reply(ok(3));

    h.machine.onEdit('typed');
    expect(h.machine.retry()).toBe('written');
    expect(h.calls).toEqual([{ content: 'typed', baseVersion: 2, via: 'put' }]);
  });

  it('drops the mirror when the server confirms the text it held', async () => {
    const h = start({ content: 'body', version: 2 });
    h.reply(ok(3));

    h.machine.onEdit('typed');
    expect(h.mirror.at(-1)).toEqual({ op: 'write', content: 'typed' });

    await tick(AUTOSAVE_DEBOUNCE_MS);
    await flushed();

    expect(h.mirror.at(-1)).toEqual({ op: 'clear', content: 'typed' });
    expect(h.machine.snapshot().state).toBe('clean');
  });
});

describe('classifyWriteFailure', () => {
  const cases: readonly [
    string,
    ApiErrorCode | undefined,
    'version-conflict' | 'retry' | 'unauthorized' | 'deleted' | 'forbidden' | 'rejected',
  ][] = [
    ['you are not signed in', 'UNAUTHORIZED', 'unauthorized'],
    ['note not found', 'NOT_FOUND', 'deleted'],
    ['you are not allowed to do that', 'FORBIDDEN', 'forbidden'],
    ['internal error', 'INTERNAL', 'retry'],
    ['that conflicts with the current state', 'CONFLICT', 'rejected'],
    ['that note is too large to save', 'PAYLOAD_TOO_LARGE', 'rejected'],
    ['too many attempts, try again later', 'RATE_LIMITED', 'rejected'],
    ['the request body is not valid', 'VALIDATION', 'rejected'],
  ];

  it.each(cases)('%s', (_message, code, expected) => {
    const status = code === 'INTERNAL' ? 500 : 400;
    const error = apiError(status, code ?? 'VALIDATION');
    expect(classifyWriteFailure(error).kind).toBe(expected);
  });

  it('calls anything that is not an ApiError a transport failure, which is §4’s retrying row', () => {
    expect(classifyWriteFailure(new TypeError('Failed to fetch')).kind).toBe('retry');
    expect(classifyWriteFailure(new Error('the proxy hung up')).kind).toBe('retry');
    expect(classifyWriteFailure(undefined).kind).toBe('retry');
  });

  it('reads the version-conflict payload through the contract’s own guard', () => {
    const withPayload = apiError(409, 'VERSION_CONFLICT', { content: 'server', version: 9 });
    expect(classifyWriteFailure(withPayload)).toEqual({
      kind: 'version-conflict',
      serverContent: 'server',
      serverVersion: 9,
    });

    // A `version` of `"9"` is not the pinned payload either: a string would compare unequal to every
    // snapshot and turn every lost response into a phantom conflict.
    const lying = apiError(409, 'VERSION_CONFLICT', { content: 'server', version: '9' });
    expect(classifyWriteFailure(lying).kind).toBe('rejected');
  });
});
