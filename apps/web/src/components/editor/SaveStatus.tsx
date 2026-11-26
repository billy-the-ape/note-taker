/**
 * The save-status pill (§6 of docs/plans/mvp/MVP-14.md), and the one place its copy is written.
 *
 * A pill is a promise, so the six strings below are the whole contract and every one of them is a
 * sentence about **this buffer**: `Saved 12:03:11` may only appear when a write has come back for the
 * text that is on screen, and a buffer the unload path could not flush (§6's 60 KiB budget) keeps
 * saying `Unsaved changes` for as long as that is true. A status component that inferred anything —
 * "quiet, so it must be saved" — is how a note tells a person to trust a lie.
 *
 * Precedence is deliberate and total: a conflict or a failure beats a spinner, a spinner beats a
 * dirty note, and the autosave-off line yields to both because a person who has lost a write wants to
 * know that, not what their preference is set to. {@link saveStatusText} is exported as the pure
 * decision so it can be asserted in the plain Node environment, with no DOM anywhere near it.
 */
import type { AutosaveSnapshot } from '../../lib/autosave';

/** The `data-testid` PR-19 asserts on, named once. */
export const SAVE_STATUS_TEST_ID = 'save-status';
/** §6's line for the injected-off state. Pinned as a constant because two PRs must say it identically. */
export const AUTOSAVE_OFF_COPY = 'Autosave off — Ctrl+S to save';

/** The machine's state, passed through to `data-state` so CSS and PR-19 can both read it. */
export type SaveStatusData =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'retrying'
  | 'conflict'
  | 'error'
  | 'autosave-off';

export interface SaveStatusProps {
  readonly snapshot: AutosaveSnapshot;
  /** The flag in force — from `useAutosave().autosave`, so the pill and the writer agree. */
  readonly autosave: boolean;
  readonly className?: string;
}

/**
 * §6's failure lines. `rejected` quotes the server's own words on purpose: `that note is too large to
 * save` explains itself, and a generic "something went wrong" for a 1 MiB note wastes the one place a
 * message can be honest.
 */
function failureText(snapshot: AutosaveSnapshot): string {
  const failure = snapshot.failure;
  if (failure === undefined) return 'Not saved';
  switch (failure.kind) {
    case 'unauthorized':
      return 'Not saved — sign in again';
    case 'deleted':
      return 'Note deleted elsewhere — not saved';
    case 'forbidden':
      return 'Not saved — the server refused the write';
    case 'unavailable':
      return 'Not saved — no answer from the server';
    case 'rejected':
      return `Not saved — ${failure.message}`;
  }
  return 'Not saved';
}

/** `12:03:11`, local, zero-padded. `Intl` is not used because a pill that changes shape with the
 * locale cannot be asserted against, and seconds-only is what §6 asks for. */
export function formatSavedAt(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The decision, with nothing React in it. */
export function saveStatusText(snapshot: AutosaveSnapshot, autosave: boolean): string {
  if (snapshot.conflict !== undefined) return 'Conflict';
  if (snapshot.failure !== undefined) return failureText(snapshot);
  switch (snapshot.state) {
    case 'saving':
      return 'Saving…';
    case 'retrying':
      return `Retrying (${snapshot.attempt})…`;
    case 'conflict':
      return 'Conflict';
    case 'error':
      return failureText(snapshot);
    case 'dirty':
      // The flag wins over "unsaved": with autosave off, `Unsaved changes` would be a nag about a
      // feature that is switched off, and the person has to reach for Ctrl+S either way.
      return autosave ? 'Unsaved changes' : AUTOSAVE_OFF_COPY;
    case 'clean':
      return snapshot.savedAt === undefined ? 'Saved' : `Saved ${formatSavedAt(snapshot.savedAt)}`;
  }
  return 'Saved';
}

/** What `data-state` says. Distinct from the state when the flag is what a reader needs to see. */
export function saveStatusData(snapshot: AutosaveSnapshot, autosave: boolean): SaveStatusData {
  if (snapshot.conflict !== undefined) return 'conflict';
  if (snapshot.failure !== undefined) return 'error';
  if (snapshot.state === 'dirty' && !autosave) return 'autosave-off';
  return snapshot.state;
}

/**
 * The pill. `role="status"` with `aria-live="polite"` because it changes on its own — a debounce
 * firing is exactly the kind of thing a screen reader should hear and not too important to interrupt
 * for. `title` carries the machine's own message, so a shortened pill never loses the reason.
 */
export function SaveStatus({ snapshot, autosave, className = '' }: SaveStatusProps) {
  const text = saveStatusText(snapshot, autosave);
  const data = saveStatusData(snapshot, autosave);
  const title = snapshot.failure?.message ?? (autosave ? undefined : AUTOSAVE_OFF_COPY);

  return (
    <span
      data-testid={SAVE_STATUS_TEST_ID}
      data-state={data}
      data-attempt={snapshot.attempt > 0 ? snapshot.attempt : undefined}
      role="status"
      aria-live="polite"
      title={title}
      className={`inline-flex items-center gap-1 text-sm text-ink-muted ${className}`}
    >
      {text}
    </span>
  );
}
