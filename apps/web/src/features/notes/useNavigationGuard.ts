/**
 * The dirty navigation guard (§5 of docs/plans/mvp/MVP-13.md): "navigating away with an unsaved buffer
 * prompts (the autosave-off dirty guard 'Save / Discard / Stay' that PR-14 will share)".
 *
 * ## The decision is a function; the blocker is wiring
 *
 * `decideNavigation` is the whole rule and has no router in it: a clean buffer never blocks, and a dirty one
 * always asks. The interesting part is *why* the buffer being dirty is the only input. It is not "an autosave
 * is pending", because PR-14's machine is dirty in several distinct ways — a debounce window open, a backoff
 * owed, autosave switched off in settings, the machine `stopped` after a spent retry budget — and every one of
 * them means the same thing to a person about to click another note: **the text is newer than the row**. A
 * guard that tried to distinguish them would be a second model of the machine's state, and would be wrong the
 * first time the machine grew a state it did not know.
 *
 * ## Two unload prompts are one bug, so there is one
 *
 * `useBlocker` hands `enableBeforeUnload` straight to `history.block`, and the default is **on** — left at
 * its default, this hook would install a second `beforeunload` handler next to PR-14's, and the tab-close
 * prompt would then be decided twice: once by the router ("is the buffer dirty?") and once by
 * `unloadCarriesBuffer()` ("is the buffer on its way out on `keepalive`?"), which are not the same question
 * and only one of which is right. So `enableBeforeUnload: false`, and the unload path stays exactly where
 * PR-14 put it. The blocker does client-side navigation, and nothing else.
 *
 * ## What the three buttons do
 *
 * **Save** flushes through `useAutosave().saveNow()` and proceeds — a client-side navigation does not abort
 * the in-flight `fetch`, so the write goes out whether or not the editor is still on screen.
 * **Discard** is `adopt(rowContent, rowVersion)`: the machine is told the row's truth, goes `clean`, and the
 * unmount flush that follows has nothing to write. Clearing the draft mirror is the half of "discard" the
 * machine cannot see, and it is conditional (`clearDraftIf`) for PR-14's reason: another tab may have written
 * a newer paragraph into that key, and a discard that deletes it is data loss with a nicer name.
 * **Stay** cancels the navigation and leaves the buffer exactly where it was — including its caret, which is
 * the reason the prompt is an overlay over the editor rather than a route.
 */

import { useBlocker } from '@tanstack/react-router';
import { useCallback } from 'react';

/** §5's three answers, as data, so the prompt and this hook cannot disagree about their labels. */
export const NAVIGATION_GUARD_ACTIONS = ['save', 'discard', 'stay'] as const;
export type NavigationGuardAction = (typeof NAVIGATION_GUARD_ACTIONS)[number];

export function navigationGuardActionTestId(action: NavigationGuardAction): string {
  return `unsaved-prompt-${action}`;
}

export const NAVIGATION_GUARD_TEST_ID = 'unsaved-prompt';

/**
 * The rule, alone.
 *
 * `dirty` is `useAutosave().snapshot.dirty` — "the buffer is newer than the row", which is the only
 * condition under which navigating away loses anything.
 */
export function decideNavigation(input: { readonly dirty: boolean }): boolean {
  return input.dirty;
}

export interface NavigationGuardOptions {
  /** `useAutosave().snapshot.dirty`. */
  readonly dirty: boolean;
  /** Flush now (`saveNow()`), and let the navigation continue. */
  readonly onSave: () => void;
  /** Make the buffer the row's truth, then continue — see the Discard paragraph above. */
  readonly onDiscard: () => void;
}

export interface NavigationGuard {
  /** An overlay the page renders while this is `'blocked'`. */
  readonly blocked: boolean;
  readonly stay: () => void;
  readonly save: () => void;
  readonly discard: () => void;
}

/**
 * The blocker. Registered by the page, always — a blocker behind a conditional hook would mean the guard
 * exists only on the render where the buffer happened to be dirty, which is a guard that is not installed the
 * first time it is needed.
 */
export function useNavigationGuard({ dirty, onSave, onDiscard }: NavigationGuardOptions): NavigationGuard {
  const blocker = useBlocker({
    withResolver: true,
    // Not registered while the buffer matches the row: the guard's whole job is the dirty case, and
    // `useBlocker` does not attach a blocker at all when this is true, so a clean editor costs no listener.
    disabled: !dirty,
    // PR-14 owns the unload prompt. See the file header.
    enableBeforeUnload: false,
    // `dirty` is read from the closure, and the identity is the blocker's dependency, so a render that does
    // not change dirtiness does not re-register the navigation blocker underneath an in-flight decision.
    shouldBlockFn: useCallback(() => decideNavigation({ dirty }), [dirty]),
  });

  // `withResolver` hands control to us for exactly one navigation at a time, and the visible state *is* the
  // blocker's status: a navigation that resolves some other way cannot leave the overlay on screen, because
  // there is no second copy of the fact to go stale.
  const blocked = blocker.status === 'blocked';

  const stay = useCallback(() => {
    if (blocker.status !== 'blocked') return;
    blocker.reset?.();
  }, [blocker]);

  const save = useCallback(() => {
    if (blocker.status !== 'blocked') return;
    onSave();
    blocker.proceed?.();
  }, [blocker, onSave]);

  const discard = useCallback(() => {
    if (blocker.status !== 'blocked') return;
    onDiscard();
    blocker.proceed?.();
  }, [blocker, onDiscard]);

  return { blocked, stay, save, discard };
}
