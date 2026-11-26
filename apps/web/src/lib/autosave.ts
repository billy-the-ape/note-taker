/**
 * The autosave state machine (docs/plans/mvp/MVP-14.md §4–§6).
 *
 * **Pure on purpose.** No `document`, no `localStorage`, no `fetch`, no React. §4's table is the
 * whole product risk of this feature and every row of it is asserted with fake timers in
 * `autosave.test.ts`, which is only possible while the machine is a closure over plain values. The
 * React layer (`features/notes/useAutosave.ts`) subscribes to {@link Autosaver#snapshot} and owns
 * nothing but DOM listeners; the transport lives in `features/notes/note.mutations.ts`.
 *
 * ## The buffer lives here
 *
 * `onEdit(content)` hands over the whole new buffer and the machine keeps it, rather than the
 * machine asking a component for "the current text" at write time. That is not a style preference:
 * §5's conflict fork compares the payload the server returns against **the exact string that went
 * on the wire**, so the machine has to hold that string as a value. A reference to a live buffer
 * would be mutated by the next keystroke and would silently turn a lost response into a phantom
 * conflict — which is the one bug this file exists to prevent.
 *
 * ## Five rules that make the table safe (§4)
 *
 * 1. **At most one request in flight.** Every write path goes through `beginWrite`, which refuses
 *    when `inFlight` is set.
 * 2. **An edit during `saving` is never dropped.** It parks the machine in `dirty`; the next
 *    debounce window opens when the in-flight request settles, and always sends the newest buffer
 *    against the newest known `version`.
 * 3. **`VERSION_CONFLICT` is only a conflict after the comparison.** `equal` snapshot ⇒ adopt the
 *    server's `version` and carry on, to `clean` or to `dirty`; `different` ⇒ `conflict`. See §5.
 * 4. **Nothing leaves while a reply is still owed.** A request that went out and never came back has
 *    an answer we have not read, so `writeNow` sends *that* request and not the newest buffer —
 *    whichever way it was asked (debounce, the 10 s cap, `blur`, a note switch, Ctrl+S). Newer text
 *    follows in the window after that request settles, which is rule 2 in a different coat.
 * 5. **Every state change is published.** `snapshot()` is cached, and `notify()` is the only thing
 *    that clears the cache — so a path that changes the buffer without notifying makes a controlled
 *    editor eat the keystroke it was called for. `onEdit` therefore publishes in the states where it
 *    refuses to *schedule* (`stopped`, `conflict`) exactly as in the ones where it does.
 *
 * ## Why the machine reports a snapshot
 *
 * §4 sketches the return as `{ onEdit(), flush(), state, conflict, error }`. Here the three read-only
 * members are one immutable `snapshot()` object (`state`, `conflict`, `failure` — "failure" because
 * `error` is also the *name of a state* in the table, and a pill that cannot tell the two apart will
 * eventually report the wrong one). `subscribe` completes the pair, because a React tree has to be
 * told. A machine exposing three independently mutable fields cannot promise a reader saw them in the
 * same moment; a snapshot can, and that is what makes every row of the table assertable without a DOM.
 *
 * Plain `CONFLICT` (the sibling-name clash, same 409) is never reacted to; the code that classifies
 * errors in {@link classifyWriteFailure} is the only place the two are told apart.
 *
 * ## Timers
 *
 * Three, and only three: a debounce (1200 ms), a force-flush deadline (10 s from the moment the
 * buffer became dirty), and a retry backoff (1 s, 2 s, 4 s, 8 s, 30 s). All are `setTimeout` on the
 * globals, which is what lets a test drive a whole day of editing in one `await`.
 */
import { type ApiErrorCode, isVersionConflictErrorData, utf8ByteLength } from '@note-taker/contracts';

import { ApiError } from './api';

/** §6's debounce. Long enough that a sentence is one write, short enough that "Saving…" is visible. */
export const AUTOSAVE_DEBOUNCE_MS = 1200;
/** §6's force-flush: a buffer that has been dirty this long is written whatever the keystrokes do. */
export const AUTOSAVE_MAX_UNFLUSHED_MS = 10_000;
/**
 * §4's backoff. The last step is deliberately patient: after 8 s of failures the honest reading is
 * "the server is down or the connection is gone", and a client that keeps poking it is the thing
 * that turns a deploy into an outage.
 */
export const AUTOSAVE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 30_000];
/**
 * §6's unload budget: **60 KiB of request body**, a margin under the ~64 KiB cap a browser puts on a
 * `keepalive` body. Over it the unload path attempts nothing — the force-flush, the dirty-guard prompt
 * and the `localStorage` draft mirror are the data plan, and the pill never says `Saved`. It is a body
 * budget and not a text budget, which is {@link contentWriteBytes}'s business.
 */
export const AUTOSAVE_UNLOAD_BUDGET_BYTES = 60 * 1024;

/**
 * The bytes a content write costs on the wire, which is **more than the bytes of the buffer**.
 *
 * `features/notes/note.mutations.ts` sends `JSON.stringify({content, baseVersion})`, and JSON escaping
 * is not free: every `\n` and every `"` costs two bytes, and a control character costs six (`\u0001`).
 * So a 58 KiB body of indented prose is over the `keepalive` cap while `utf8ByteLength(buffer)` is
 * under it, and the browser rejects the request with a `TypeError` before it leaves — after
 * `canFlushOnUnload()` had already promised the dirty-guard prompt it did not need.
 *
 * The shape is duplicated on purpose: the machine does not know `lib/api.ts` exists, so it measures the
 * body the client is documented to send. `note.mutations.test.ts` asserts that documentation — the body
 * has exactly these two keys, and no more — so the measure cannot quietly drift out of date.
 */
export function contentWriteBytes(content: string, baseVersion: number): number {
  return utf8ByteLength(JSON.stringify({ content, baseVersion }));
}

/** §4's six states. */
export type AutosaveState = 'clean' | 'dirty' | 'saving' | 'retrying' | 'conflict' | 'error';

/** How a write left this process. `keepalive` is the unload path (§6) and nothing else. */
export type SaveVia = 'put' | 'keepalive';

/** The outcome handed to `save`: the row the server now has, enough of it to adopt its `version`. */
export interface SavedNote {
  readonly version: number;
}

/** One `PUT /api/notes/:id/content`, exactly as §9.2 #18 wants it. */
export interface SaveCall {
  readonly content: string;
  readonly baseVersion: number;
  readonly via: SaveVia;
}

/** The injected transport. Rejects with `ApiError` (or a raw `TypeError` from `fetch`). */
export type SaveFn = (call: SaveCall) => Promise<SavedNote>;

/** §6's flag. A getter is accepted so a settings change is noticed without remounting anything. */
export interface AutosaveSettings {
  readonly autosave: boolean;
}
export type AutosaveSettingsSource = AutosaveSettings | (() => AutosaveSettings);

/** A `VERSION_CONFLICT` narrowed to the two fields the fork needs (PR-05 pinned this payload). */
export interface AutosaveConflict {
  readonly serverContent: string;
  readonly serverVersion: number;
}

/**
 * Why the machine is in `error`.
 *
 * `recoverable` is §4's distinction, not a decoration: a `403` whose CSRF replay failed, or a retry
 * budget that ran out, is a bump the next keystroke walks away from, while `401` (session gone) and
 * `404` (note deleted elsewhere) end autosave for this note. The `404` half matters most: writing on
 * would `INSERT` a row under a name the user may no longer own, so it is a `NOT_FOUND` on a row the
 * user can no longer see and a silent re-create — the escape hatch is "save as a new note", offered
 * explicitly, never done automatically.
 */
export type AutosaveFailureKind = 'unauthorized' | 'deleted' | 'forbidden' | 'unavailable' | 'rejected';

export interface AutosaveFailure {
  readonly kind: AutosaveFailureKind;
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly message: string;
  readonly recoverable: boolean;
}

/** What a listener (the hook, and therefore React) sees. Immutable and referentially stable. */
export interface AutosaveSnapshot {
  readonly state: AutosaveState;
  /** The buffer this machine holds — the editor renders from here, so there is one owner. */
  readonly buffer: string;
  /** True while the buffer differs from what the last confirmed write carried. */
  readonly dirty: boolean;
  /** Retries already scheduled for the current failure: drives `Retrying (2)…` (§6). */
  readonly attempt: number;
  /** Epoch ms of the last confirmed write; `undefined` until this machine has saved anything. */
  readonly savedAt?: number;
  /** Last known server `version`, i.e. the next request's `baseVersion` (§6). */
  readonly version: number;
  readonly conflict?: AutosaveConflict;
  readonly failure?: AutosaveFailure;
  /** `true` after a `401`/`404`: autosave is over for this note, and the mirror still holds the text. */
  readonly stopped: boolean;
  /** What the last `pagehide` attempted, so a UI can explain why nothing was sent. */
  readonly lastUnload?: UnloadOutcome;
}

/** One of the machine's decisions, returned to the caller so it can decide whether to prompt. */
export type UnloadOutcome =
  | 'sent'
  /** Autosave is paused by an unresolved conflict, so nothing may be written on the way out. */
  | 'conflict'
  /** Autosave is off, so no automatic write may happen on the way out. */
  | 'autosave-off'
  /** Nothing to write. */
  | 'clean'
  /** Over {@link AUTOSAVE_UNLOAD_BUDGET_BYTES}: no unload write is attempted (§6). */
  | 'too-large'
  /** Rule 1: a `PUT` is already in flight and the browser will not queue a second one. */
  | 'in-flight'
  /** §4's terminal half: autosave ended for this note. */
  | 'stopped';

/**
 * What a flush attempt did. Every flush path answers with one of these — `blur`, the 10 s deadline, a
 * note switch and an unmount as well as §4's "manual retry" (Retry, Ctrl+S), which is only the caller
 * a person can hear.
 */
export type FlushOutcome =
  | 'written'
  | 'nothing-to-write'
  | 'in-flight'
  | 'conflict'
  | 'autosave-off'
  | 'stopped';

/** The `localStorage` mirror (§6). `clear` is conditional: the key is per-note, and tabs share it. */
export interface DraftMirror {
  readonly write: (content: string) => void;
  /** Drop the mirror only while it still holds exactly `content` — another tab may own that key. */
  readonly clear: (content: string) => void;
}

export interface AutosaverOptions {
  readonly save: SaveFn;
  /** The flag from `GET /api/settings` (§9.2 #22), injected. Never fetched here. */
  readonly settings: AutosaveSettingsSource;
  readonly debounceMs?: number;
  readonly maxUnflushedMs?: number;
  readonly backoffMs?: readonly number[];
  readonly unloadBudgetBytes?: number;
  /** The note's content and version as loaded, i.e. the state the machine starts in. */
  readonly content?: string;
  readonly version?: number;
  readonly draft?: DraftMirror;
  /** Called on the `401` only, after the machine stopped. The app routes; the hook wires this. */
  readonly onUnauthorized?: () => void;
  /** Injectable clock, so `savedAt` is assertable under fake timers. */
  readonly now?: () => number;
}

/** How a write failed, told apart once and in one place. See {@link classifyWriteFailure}. */
export type WriteFailure =
  | { readonly kind: 'version-conflict'; readonly serverContent: string; readonly serverVersion: number }
  | { readonly kind: 'retry' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'forbidden' }
  | {
      readonly kind: 'rejected';
      readonly code: ApiErrorCode;
      readonly status: number;
      readonly message: string;
    };

/**
 * The one error-to-meaning table in the app.
 *
 * `409` splits in two: `VERSION_CONFLICT` with the pinned `{content, version}` payload is §5's fork;
 * `VERSION_CONFLICT` **without** that payload is a proxy that ate the body, and since the comparison
 * cannot be made the honest answer is "a stranger refused this write", not a retry loop against a
 * version the row no longer has. Plain `CONFLICT` lands in the same bucket, which is the brief's
 * "the machine never reacts to plain `CONFLICT`" made true by absence.
 *
 * Retry means exactly §4's words, "5xx or transport error". A `429` deliberately does not join it:
 * this route has no rate-limit window today, and if it ever grows one, five fast retries is the
 * behaviour to be fined for. `PAYLOAD_TOO_LARGE` and `VALIDATION` are recoverable in the §4 sense —
 * the next edit can shrink the body or fix the body — so they surface and wait for a keystroke.
 */
export function classifyWriteFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError) {
    if (error.code === 'VERSION_CONFLICT') {
      if (isVersionConflictErrorData(error.data)) {
        return {
          kind: 'version-conflict',
          serverContent: error.data.content,
          serverVersion: error.data.version,
        };
      }
      return { kind: 'rejected', code: error.code, status: error.status, message: error.message };
    }
    if (error.code === 'UNAUTHORIZED') return { kind: 'unauthorized' };
    if (error.code === 'NOT_FOUND') return { kind: 'deleted' };
    if (error.code === 'FORBIDDEN') return { kind: 'forbidden' };
    if (error.status >= 500) return { kind: 'retry' };
    return { kind: 'rejected', code: error.code, status: error.status, message: error.message };
  }
  // A `fetch` that never produced a response: `TypeError: Failed to fetch` after a connection reset,
  // a proxy that hung up, or a laptop that slept mid-request. §4 puts it in the same row as a 5xx.
  return { kind: 'retry' };
}

/** The machine, as §4 spells it. Every method is safe to call in any state. */
export interface Autosaver {
  /** An edit landed. `content` is the whole new buffer (§4's `dirty` edge). */
  readonly onEdit: (content: string) => void;
  /** A write this machine will adopt without dirtying anything: the note was re-read (§9.2 #17). */
  readonly adopt: (content: string, version: number) => void;
  /** An explicit user save: `Ctrl/Cmd+S` or the Save button. Works with autosave off (§6). */
  readonly flush: () => FlushOutcome;
  /**
   * An automatic flush: debounce, deadline, `blur`, note switch, unmount. Honors the flag. The
   * `visibilitychange → hidden` trigger is {@link Autosaver#flushOnHide}, which picks a transport.
   */
  readonly flushAutomatic: () => FlushOutcome;
  /** The `pagehide` path: `fetch(…, {keepalive:true})`, and only inside the unload budget (§6). */
  readonly flushOnUnload: () => UnloadOutcome;
  /** Open a fresh debounce window for a buffer that is still dirty: used when the flag flips back on. */
  readonly resume: () => void;
  /** `conflict` → "Keep mine": adopt the server's version, write the retained buffer, become `saving`. */
  readonly keepMine: () => FlushOutcome;
  /** `conflict` → "Use server": the buffer becomes the server's, the mirror goes with it. */
  readonly useServer: () => void;
  /** `error` → §4's manual retry. */
  readonly retry: () => FlushOutcome;
  /** True when a `pagehide` would be able to write this buffer (§6's budget, rule 1, the flag). */
  readonly canFlushOnUnload: () => boolean;
  /**
   * True when the unload can be let to happen quietly: clean, or the buffer is leaving on `keepalive`,
   * or `pagehide` can still start it. The dirty-guard prompt is the exact negation of this (§6).
   */
  readonly unloadCarriesBuffer: () => boolean;
  /** The `visibilitychange → hidden` trigger, on the unload transport whenever the buffer fits (§6). */
  readonly flushOnHide: () => 'keepalive' | 'ordinary';
  readonly snapshot: () => AutosaveSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getBuffer: () => string;
  readonly isDirty: () => boolean;
  readonly getUnsavedBytes: () => number;
}

function readAutosave(source: AutosaveSettingsSource): boolean {
  const settings = typeof source === 'function' ? source() : source;
  return settings.autosave;
}

/**
 * Builds the machine. §4's signature (`createAutosaver({debounceMs, maxUnflushedMs, settings, save})`)
 * plus the injected extras the table needs a handle on: the draft mirror, the `401` notice, the clock.
 */
export function createAutosaver(options: AutosaverOptions): Autosaver {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxUnflushedMs = options.maxUnflushedMs ?? AUTOSAVE_MAX_UNFLUSHED_MS;
  const backoffMs = options.backoffMs ?? AUTOSAVE_BACKOFF_MS;
  const unloadBudgetBytes = options.unloadBudgetBytes ?? AUTOSAVE_UNLOAD_BUDGET_BYTES;
  const now = options.now ?? Date.now;

  // --- the state, exactly §4's rows -------------------------------------------------------------
  let current: AutosaveState = 'clean';
  let buffer = options.content ?? '';
  let savedContent = buffer;
  let lastVersion = options.version ?? 1;
  let attempt = 0;
  let savedAt: number | undefined;
  let conflict: AutosaveConflict | undefined;
  let failure: AutosaveFailure | undefined;
  let stopped = false;
  let lastUnload: UnloadOutcome | undefined;
  /** The request in flight: the exact bytes on the wire and the version they were written against. */
  interface InFlight {
    readonly content: string;
    readonly baseVersion: number;
  }

  /** The request a scheduled retry will re-send, and the §5 comparison's other side. */
  let pendingReplay: InFlight | undefined;

  /** The request in flight, plus which transport carried it. */
  let inFlight: (InFlight & { readonly via: SaveVia }) | undefined;

  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  let snapshotCache: AutosaveSnapshot | undefined;
  const listeners = new Set<() => void>();

  function notify(): void {
    snapshotCache = undefined;
    for (const listener of listeners) listener();
  }

  function clearTimer(which: 'edit' | 'deadline' | 'retry'): void {
    if (which === 'edit' && editTimer !== undefined) clearTimeout(editTimer);
    if (which === 'deadline' && deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (which === 'retry' && retryTimer !== undefined) clearTimeout(retryTimer);
    if (which === 'edit') editTimer = undefined;
    if (which === 'deadline') deadlineTimer = undefined;
    if (which === 'retry') retryTimer = undefined;
  }

  function clearAllTimers(): void {
    clearTimer('edit');
    clearTimer('deadline');
    clearTimer('retry');
  }

  function armDebounce(): void {
    clearTimer('edit');
    if (!readAutosave(options.settings)) return;
    editTimer = setTimeout(() => {
      editTimer = undefined;
      flushAutomatic();
    }, debounceMs);
  }

  function armDeadline(): void {
    if (deadlineTimer !== undefined) return; // the window opened at the first keystroke; keep it
    if (!readAutosave(options.settings)) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      const outcome = flushAutomatic();
      // Nothing started but the buffer is still newer than the server (a write was in flight, or a
      // `clean` answer has not arrived yet): keep the deadline alive so the 10 s cap is a promise.
      if (outcome !== 'written' && current === 'dirty' && readAutosave(options.settings)) armDeadline();
    }, maxUnflushedMs);
  }

  /**
   * Send the request the backoff owes: the exact bytes that failed, against the `baseVersion` they
   * carried. `attempt` deliberately survives — the schedule belongs to this failure — and a request
   * started by a person from `error` is the fresh cycle instead (see {@link writeNow}).
   */
  function replayNow(): boolean {
    const replay = pendingReplay;
    if (replay === undefined) return false;
    // What was owed is owed no longer. If this request comes back with an answer the next one is a
    // fresh capture, and a `pendingReplay` left behind would hold every later write hostage.
    pendingReplay = undefined;
    clearTimer('retry');
    return beginWrite('put', replay);
  }

  function armRetry(delayMs: number): void {
    clearTimer('retry');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // Rule 1 still holds here: `inFlight` was cleared when the failed request settled. The schedule
      // and the replayed bytes are {@link replayNow}'s business, and the same replay answers a flush
      // that arrives before this timer does.
      replayNow();
      notify();
    }, delayMs);
  }

  /** §6's mirror. A confirmed write takes the mirror with it, because the server has the text now. */
  function mirror(text: string): void {
    options.draft?.write(text);
  }

  function dropMirror(text: string): void {
    options.draft?.clear(text);
  }

  function dirty(): boolean {
    return buffer !== savedContent;
  }

  /**
   * The buffer is the server's text again: §4's `clean`, with the mirror, the failure message and the
   * two write timers to match. A replay still owed is left alone on purpose — the ambiguity that
   * request exists to resolve does not go away because the user deleted a character.
   */
  function normaliseClean(): void {
    current = 'clean';
    failure = undefined;
    attempt = 0;
    clearTimer('edit');
    clearTimer('deadline');
    dropMirror(buffer);
  }

  // --- the one write path -----------------------------------------------------------------------

  /**
   * Rule 1 in code. Everything that wants to write comes through here, and `inFlight` is the gate —
   * which is why the preconditions live with the callers that have an outcome vocabulary
   * ({@link writeNow}) and not in here.
   *
   * `snapshot` is captured by value: `buffer` is a string, and the fork in §5 needs the bytes that
   * left, not the bytes the editor holds now.
   *
   * `replay` is §5's other half. A retried request re-sends **the request that failed**, with the
   * content and the `baseVersion` it carried, and not a fresh capture of the buffer: that replay is
   * what the `VERSION_CONFLICT` it comes back with is compared against, and if the retry quietly
   * picked up the newest text instead, the comparison would compare a stranger's payload with the
   * server's row and every lost response would become a phantom conflict. Keystrokes that arrive while
   * a backoff is waiting stay in the buffer, and the window after this request settles writes them.
   */
  function beginWrite(via: SaveVia, replay?: InFlight): boolean {
    if (inFlight !== undefined) return false;
    const snapshot = replay?.content ?? buffer;
    const baseVersion = replay?.baseVersion ?? lastVersion;
    if (snapshot === savedContent) return false;

    clearTimer('edit');
    inFlight = { content: snapshot, baseVersion, via };
    current = 'saving';
    void runWrite({ content: snapshot, baseVersion, via });
    return true;
  }

  /** Whether the answer on the table belongs to the request still in flight. */
  function isCurrent(call: SaveCall): boolean {
    return (
      inFlight !== undefined && inFlight.content === call.content && inFlight.baseVersion === call.baseVersion
    );
  }

  async function runWrite(call: SaveCall): Promise<void> {
    let result: SavedNote;
    try {
      result = await options.save(call);
    } catch (error) {
      // An answer for a request this machine no longer has is not an event: acting on it would let a
      // late reply adopt a version it did not write.
      if (!isCurrent(call)) return;
      onWriteFailure(error);
      return;
    }
    if (!isCurrent(call)) return;
    onWriteSuccess(call, result);
  }

  function onWriteSuccess(call: SaveCall, result: SavedNote): void {
    const snapshot = call.content;
    inFlight = undefined;
    pendingReplay = undefined;
    lastVersion = result.version;
    savedContent = snapshot;
    savedAt = now();
    failure = undefined;
    conflict = undefined;
    attempt = 0;
    if (buffer === savedContent) {
      current = 'clean';
      clearAllTimers();
      dropMirror(savedContent);
    } else {
      // Rule 2: an edit landed while this was in flight. The next debounce window opens now.
      current = 'dirty';
      armDeadline();
      armDebounce();
    }
    notify();
  }

  function onWriteFailure(error: unknown): void {
    // The snapshot the failed request carried. §5's comparison reads `request.content`, never `buffer`.
    const request = inFlight;
    if (request === undefined) return;
    inFlight = undefined;
    // Whatever was scheduled to be re-sent belongs to the request that just answered.
    pendingReplay = undefined;
    const classified = classifyWriteFailure(error);
    const code = error instanceof ApiError ? error.code : 'INTERNAL';
    const status = error instanceof ApiError ? error.status : 0;
    const message = error instanceof ApiError ? error.message : 'the request never reached the server';

    switch (classified.kind) {
      case 'version-conflict': {
        // §5, the fork. Equal ⇒ the write landed and only the reply was lost.
        if (classified.serverContent === request.content) {
          lastVersion = classified.serverVersion;
          savedContent = request.content;
          savedAt = now();
          failure = undefined;
          conflict = undefined;
          attempt = 0;
          if (buffer === savedContent) {
            current = 'clean';
            clearAllTimers();
          } else {
            current = 'dirty';
            armDeadline();
            armDebounce();
          }
          dropMirror(savedContent);
          break;
        }
        // Different ⇒ a real second writer. Buffer retained, autosave paused, and the server's copy
        // is what the banner offers to show.
        current = 'conflict';
        conflict = { serverContent: classified.serverContent, serverVersion: classified.serverVersion };
        clearAllTimers();
        failure = undefined;
        attempt = 0;
        break;
      }

      case 'retry': {
        attempt += 1;
        if (attempt <= backoffMs.length) {
          current = 'retrying';
          failure = undefined;
          // Keep the buffer dirty underneath: the pill says `Retrying (n)…`, and the next attempt
          // re-sends these exact bytes (§5) while anything typed meanwhile waits for the window after.
          pendingReplay = { content: request.content, baseVersion: request.baseVersion };
          // The cap is superseded by the schedule: a write that cannot get through is not waiting for
          // permission, and arming it again here would put a 10 s deadline next to a 30 s backoff.
          clearTimer('deadline');
          armRetry(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 30_000);
        } else {
          // The budget is spent, but the ambiguity is not: one of those five requests may be sitting
          // in the row right now. The owed replay outlives the schedule so a manual Retry re-sends
          // those bytes rather than writing newer text against a version we have not read back — the
          // same reason {@link writeNow} puts the replay first mid-backoff.
          pendingReplay = { content: request.content, baseVersion: request.baseVersion };
          current = 'error';
          failure = { kind: 'unavailable', code, status, message, recoverable: true };
          clearAllTimers();
        }
        break;
      }

      case 'unauthorized': {
        // §4: session gone ⇒ stop autosaving. The draft mirror already holds the text (every edit
        // mirrored it), which is the only reason a sign-in mid-edit is an inconvenience and not a loss.
        stopped = true;
        current = 'error';
        clearAllTimers();
        conflict = undefined;
        failure = { kind: 'unauthorized', code: 'UNAUTHORIZED', status: 401, message, recoverable: false };
        options.onUnauthorized?.();
        break;
      }

      case 'deleted': {
        // §4: the row is gone. Writing it back is an `INSERT` under a name somebody else may now own,
        // so autosave stops and the UI offers "save as a new note" rather than doing it silently.
        stopped = true;
        current = 'error';
        clearAllTimers();
        conflict = undefined;
        failure = { kind: 'deleted', code: 'NOT_FOUND', status: 404, message, recoverable: false };
        break;
      }

      case 'forbidden': {
        // `lib/api.ts` has already refreshed the CSRF cookie and replayed once by the time this
        // arrives, so a `403` here is the real answer. Surface it; the next keystroke re-arms (§4).
        current = 'error';
        clearAllTimers();
        conflict = undefined;
        failure = { kind: 'forbidden', code: 'FORBIDDEN', status: 403, message, recoverable: true };
        break;
      }

      case 'rejected': {
        current = 'error';
        clearAllTimers();
        conflict = undefined;
        failure = {
          kind: 'rejected',
          code: classified.code,
          status: classified.status,
          message: classified.message,
          recoverable: true,
        };
        break;
      }
    }
    notify();
  }

  // --- the public surface -----------------------------------------------------------------------

  function onEdit(content: string): void {
    buffer = content;
    // The crash fallback is not a network write, so it is not debounced: if the tab dies on the next
    // keystroke, the mirror has to hold this keystroke.
    mirror(content);

    // The screen reads the machine through `snapshot()`, and `snapshot()` is only republished by
    // `notify()`. Both early returns below are states where the user most needs to see the text they
    // are typing — a conflict they have to read, a note that is gone — and an editor bound to
    // `snapshot().buffer` would swallow the very character that woke this function, while "keep mine"
    // and "save as a new note" quietly acted on it. Same for `dirty`: the pill describes this buffer.
    if (stopped) {
      // §4: 401/404 keep the text, and nothing else.
      notify();
      return;
    }
    if (conflict !== undefined) {
      // autosave is paused until the banner is answered
      notify();
      return;
    }

    if (inFlight !== undefined) {
      // Rule 2 — park it dirty; the window opens when the request settles.
      current = 'dirty';
      armDeadline();
      notify();
      return;
    }

    if (retryTimer !== undefined) {
      // A backoff is already running for this buffer. The state stays `retrying` (the pill keeps
      // saying so), no second window is opened next to the scheduled replay, and no 10 s cap is armed
      // beside it — §4's schedule is exact, and a deadline firing mid-backoff would break it.
      notify();
      return;
    }

    // An undo back to the server's text is not a write, whatever the flag or the schedule is doing.
    // Normalising here is what keeps `dirty` meaning "this buffer is newer than the row".
    if (!dirty()) {
      normaliseClean();
      notify();
      return;
    }

    current = 'dirty';
    failure = undefined; // a stale error must not outlive the buffer that caused it
    attempt = 0;
    if (readAutosave(options.settings)) {
      armDebounce();
      armDeadline();
    }
    notify();
  }

  function adopt(content: string, version: number): void {
    buffer = content;
    savedContent = content;
    lastVersion = version;
    current = 'clean';
    conflict = undefined;
    failure = undefined;
    attempt = 0;
    // The re-read is the answer to the question a owed replay exists to ask, so the replay is spent.
    pendingReplay = undefined;
    clearAllTimers();
    notify();
  }

  function writeNow(): FlushOutcome {
    if (stopped) return 'stopped';
    if (conflict !== undefined) return 'conflict';
    if (inFlight !== undefined) return 'in-flight';
    if (pendingReplay !== undefined) {
      // One of these bytes left and never came back. Newer text sent now, against the same
      // `baseVersion`, would be answered by a `VERSION_CONFLICT` carrying **our own** earlier write —
      // and §5 would read that as a second writer, which is the phantom conflict this file exists to
      // prevent. So the owed request goes first, and a flush arriving mid-backoff (a `blur`, a note
      // switch, an unmount, the 10 s deadline, Ctrl+S) only moves that replay earlier: the spent
      // budget stays spent, and anything typed since goes out in the window after it settles.
      const started = replayNow();
      notify(); // the pill is describing a request again, so the stale `attempt`/message must go
      return started ? 'written' : 'nothing-to-write';
    }
    if (!dirty()) {
      // Nothing this buffer owes the row. `dirty` has to mean "newer than the server", so a machine
      // that arrives here with an undirty buffer goes back to `clean` instead of lighting
      // "Unsaved changes" at a write that will never start.
      normaliseClean();
      notify();
      return 'nothing-to-write';
    }
    // A user-initiated write with nothing owed: a fresh failure cycle, so the spent budget and any
    // stale message are dropped with it.
    attempt = 0;
    failure = undefined;
    clearTimer('retry');
    const started = beginWrite('put');
    notify();
    return started ? 'written' : 'nothing-to-write';
  }

  function flush(): FlushOutcome {
    // Explicit intent: `Ctrl/Cmd+S` and the Save button work with autosave off (§6), which is the
    // only reason the flag is a preference rather than an on/off switch for saving itself.
    return writeNow();
  }

  function flushAutomatic(): FlushOutcome {
    if (stopped) return 'stopped';
    if (conflict !== undefined) return 'conflict';
    if (!readAutosave(options.settings)) return 'autosave-off';
    return writeNow();
  }

  /**
   * Whether a `pagehide` would be able to **start** an unload write for the current buffer. A `keepalive`
   * request already in flight counts as "not able", because pagehide will not queue a second one behind
   * it — which is why {@link unloadCarriesBuffer} exists next to this, and is what the prompt reads.
   */
  function canFlushOnUnload(): boolean {
    if (stopped || conflict !== undefined) return false;
    if (!readAutosave(options.settings)) return false;
    if (inFlight !== undefined) return false;
    if (!dirty()) return false;
    return contentWriteBytes(buffer, lastVersion) <= unloadBudgetBytes;
  }

  /**
   * Whether the unload may safely be let to happen quietly: either there is nothing to carry (clean), or
   * the buffer is on its way out on the one transport that survives an unload, or `pagehide` will be able
   * to start it. §6's dirty-guard prompt is armed by exactly the negation of this.
   *
   * An **ordinary** in-flight `PUT` is deliberately not enough to answer true while the buffer is dirty:
   * the unload aborts that request, so a buffer riding on one still needs the prompt. Before this
   * predicate existed the prompt's rule was "the negation of the budget" alone, which is right about the
   * size and silent about the transport.
   */
  function unloadCarriesBuffer(): boolean {
    if (!dirty()) return true; // nothing to lose, so nothing to warn about
    if (inFlight !== undefined && inFlight.via === 'keepalive' && inFlight.content === buffer) return true;
    return canFlushOnUnload();
  }

  /**
   * The `visibilitychange → hidden` trigger (§6, §11.4).
   *
   * A closing tab hides **first**: the unload steps are hide → `beforeunload` → `pagehide`. An ordinary
   * `PUT` started here is therefore the quiet way to lose the unload write — it occupies rule 1, the
   * unload aborts it, and `pagehide` then has nothing it is allowed to start, so the keepalive path is
   * never reached on the ordinary close sequence at all. When the buffer fits the unload budget the
   * hidden flush goes out on the keepalive transport instead, which is also a correct choice for a mere
   * tab switch: the page survives, and a `keepalive` request answers normally while it is alive.
   */
  function flushOnHide(): 'keepalive' | 'ordinary' {
    if (canFlushOnUnload()) {
      flushOnUnload();
      return 'keepalive';
    }
    // Over budget, autosave off, a conflict or a stopped machine, or a request already on the wire:
    // none of those is an unload problem, so this is the same flush any other trigger would ask for.
    flushAutomatic();
    return 'ordinary';
  }

  function flushOnUnload(): UnloadOutcome {
    const outcome: UnloadOutcome = (() => {
      if (stopped) return 'stopped';
      if (conflict !== undefined) return 'conflict';
      if (!readAutosave(options.settings)) return 'autosave-off';
      if (buffer === savedContent) return 'clean';
      if (inFlight !== undefined) return 'in-flight';
      if (contentWriteBytes(buffer, lastVersion) > unloadBudgetBytes) return 'too-large';
      return 'sent';
    })();

    lastUnload = outcome;
    if (outcome === 'sent') {
      // The page is going away, so this is fire-and-forget: `keepalive` is the only transport with a
      // chance of outliving it, and `X-CSRF-Token` is why it is `fetch` and not `sendBeacon` (§6).
      // It is also the one place that writes newer text while a reply is still owed: only one request
      // can leave, and losing this buffer would be the worse loss. On the next load the row and the
      // draft mirror disagree, which is what the restore prompt is for.
      attempt = 0;
      failure = undefined;
      pendingReplay = undefined;
      clearAllTimers();
      beginWrite('keepalive');
    }
    notify();
    return outcome;
  }

  function resume(): void {
    if (stopped || conflict !== undefined) return;
    if (!readAutosave(options.settings)) return;
    if (!dirty()) return;
    if (inFlight !== undefined) return; // rule 1; the settle will open the window
    // A replay is owed: it owns this buffer, and a window beside it would only fire `flushAutomatic`
    // (whose honest answer is that same request) while pretending to be a fresh debounce.
    if (retryTimer !== undefined || pendingReplay !== undefined) return;
    armDebounce();
    armDeadline();
  }

  function keepMine(): FlushOutcome {
    if (conflict === undefined) return 'nothing-to-write';
    // The server's `version` becomes the known one, so the write that follows is against the row the
    // other tab left behind — which is what §4 means by "retry with the fresh server version".
    lastVersion = conflict.serverVersion;
    conflict = undefined;
    failure = undefined;
    attempt = 0;
    // The banner just told us what the row holds and which version it holds; a replay of the bytes
    // whose reply went missing would overwrite the stranger this resolution is choosing to step over.
    pendingReplay = undefined;
    notify();
    return writeNow();
  }

  function useServer(): void {
    if (conflict === undefined) return;
    const serverContent = conflict.serverContent;
    // "Use server replaces the buffer and clears the draft mirror": the buffer we are discarding is
    // the one the mirror holds, so `clear` matches and the key goes empty.
    dropMirror(buffer);
    buffer = serverContent;
    savedContent = serverContent;
    lastVersion = conflict.serverVersion;
    conflict = undefined;
    failure = undefined;
    attempt = 0;
    savedAt = now();
    current = 'clean';
    pendingReplay = undefined; // as in `adopt`: the row's own answer supersedes the owed replay
    clearAllTimers();
    notify();
  }

  function retry(): FlushOutcome {
    // §4's "manual retry". From `error` it is also the way back: the budget and the message both
    // belong to the failed cycle, so both are dropped before the write starts.
    if (current === 'error') {
      attempt = 0;
      failure = undefined;
      clearAllTimers();
    }
    return writeNow();
  }

  function snapshot(): AutosaveSnapshot {
    if (snapshotCache !== undefined) return snapshotCache;
    const value: AutosaveSnapshot = {
      state: current,
      buffer,
      dirty: dirty(),
      attempt,
      version: lastVersion,
      ...(savedAt === undefined ? {} : { savedAt }),
      ...(conflict === undefined ? {} : { conflict }),
      ...(failure === undefined ? {} : { failure }),
      ...(lastUnload === undefined ? {} : { lastUnload }),
      stopped,
    };
    snapshotCache = value;
    return value;
  }

  return {
    onEdit,
    adopt,
    flush,
    flushAutomatic,
    flushOnUnload,
    unloadCarriesBuffer,
    flushOnHide,
    resume,
    keepMine,
    useServer,
    retry,
    canFlushOnUnload,
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBuffer: () => buffer,
    isDirty: dirty,
    getUnsavedBytes: () => (dirty() ? utf8ByteLength(buffer) : 0),
  };
}
