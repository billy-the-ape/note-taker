// @vitest-environment jsdom
/**
 * The save-status pill (§6 of docs/plans/mvp/MVP-14.md).
 *
 * Split in two on purpose: {@link saveStatusText} is asserted as a plain function over the machine's
 * snapshot — every line of §6's pill list, in an environment with no DOM in it — and the component is
 * asserted for the two things only a component is responsible for: the text lands in the element
 * PR-19 reads (`data-testid="save-status"`), and it is announced as a status rather than as a
 * decoration. The precedence rules live in the function, so they cannot be tested any other way; the
 * markup is what a screen reader and an e2e test can actually see.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AutosaveFailure, AutosaveSnapshot } from '../../lib/autosave';
import {
  AUTOSAVE_OFF_COPY,
  formatSavedAt,
  SAVE_STATUS_TEST_ID,
  SaveStatus,
  saveStatusData,
  saveStatusText,
} from './SaveStatus';

/** The epoch for a wall-clock `12:03:11`, built from a local-time string so no TZ assumption is made. */
const SAVED_AT = new Date('2026-01-01T12:03:11').getTime();

function snap(overrides: Partial<AutosaveSnapshot> = {}): AutosaveSnapshot {
  return {
    state: 'clean',
    buffer: 'text',
    dirty: false,
    attempt: 0,
    version: 3,
    stopped: false,
    ...overrides,
  };
}

describe('the pill’s words (§6)', () => {
  it('reads Saved with the moment the last write came back', () => {
    expect(formatSavedAt(SAVED_AT)).toBe('12:03:11');
    expect(saveStatusText(snap({ savedAt: SAVED_AT }), true)).toBe('Saved 12:03:11');
    expect(saveStatusText(snap({ savedAt: SAVED_AT }), true)).toMatch(/^Saved \d{2}:\d{2}:\d{2}$/);
  });

  it('says Saving while the write is in flight', () => {
    expect(saveStatusText(snap({ state: 'saving' }), true)).toBe('Saving…');
  });

  it('says Unsaved changes for a dirty buffer, and never “Saved” for one the unload path could not write', () => {
    expect(saveStatusText(snap({ state: 'dirty', dirty: true }), true)).toBe('Unsaved changes');
    // The over-budget unload leaves the machine exactly here: dirty, with the reason recorded.
    expect(saveStatusText(snap({ state: 'dirty', dirty: true, lastUnload: 'too-large' }), true)).toBe(
      'Unsaved changes',
    );
  });

  it('numbers the retries, which is the difference between “hanging” and “trying”', () => {
    expect(saveStatusText(snap({ state: 'retrying', attempt: 1, dirty: true }), true)).toBe('Retrying (1)…');
    expect(saveStatusText(snap({ state: 'retrying', attempt: 2, dirty: true }), true)).toBe('Retrying (2)…');
  });

  it('says Conflict, and says it louder than the spinner', () => {
    const conflict = snap({
      state: 'conflict',
      dirty: true,
      conflict: { serverContent: 'theirs', serverVersion: 4 },
    });
    expect(saveStatusText(conflict, true)).toBe('Conflict');
  });

  it('names the autosave-off state instead of nagging about unsaved changes', () => {
    expect(AUTOSAVE_OFF_COPY).toBe('Autosave off — Ctrl+S to save');
    expect(saveStatusText(snap({ state: 'dirty', dirty: true }), false)).toBe(AUTOSAVE_OFF_COPY);
    // A conflict or a failure is still louder than the preference.
    expect(
      saveStatusText(
        snap({ state: 'conflict', dirty: true, conflict: { serverContent: 'x', serverVersion: 2 } }),
        false,
      ),
    ).toBe('Conflict');
  });

  it('speaks for each of the failure rows in §4', () => {
    const failed = (kind: AutosaveFailure['kind'], message = 'the server’s words'): AutosaveSnapshot =>
      snap({
        state: 'error',
        dirty: true,
        failure: {
          kind,
          code: 'INTERNAL',
          status: 500,
          message,
          recoverable: kind !== 'unauthorized' && kind !== 'deleted',
        },
      });

    expect(saveStatusText(failed('unauthorized'), true)).toBe('Not saved — sign in again');
    expect(saveStatusText(failed('deleted'), true)).toBe('Note deleted elsewhere — not saved');
    expect(saveStatusText(failed('forbidden'), true)).toBe('Not saved — the server refused the write');
    expect(saveStatusText(failed('unavailable'), true)).toBe('Not saved — no answer from the server');
    // `rejected` quotes the envelope: “that note is too large to save” needs no translation.
    expect(saveStatusText(failed('rejected', 'that note is too large to save'), true)).toBe(
      'Not saved — that note is too large to save',
    );
  });

  it('says just Saved for a note this session has never touched', () => {
    expect(saveStatusText(snap(), true)).toBe('Saved');
  });
});

describe('the pill, rendered', () => {
  it('lands in the element PR-19 asserts on, and announces itself politely', () => {
    const { container } = render(<SaveStatus snapshot={snap({ savedAt: SAVED_AT })} autosave={true} />);

    const pill = screen.getByTestId(SAVE_STATUS_TEST_ID);
    expect(pill.textContent).toBe('Saved 12:03:11');
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.getAttribute('aria-live')).toBe('polite');
    expect(pill.getAttribute('data-state')).toBe('clean');
    expect(container.querySelector(`[data-testid="${SAVE_STATUS_TEST_ID}"]`)).toBe(pill);
  });

  it('carries the machine’s state for CSS, including the flag being what a reader needs to see', () => {
    const cases: readonly [AutosaveSnapshot, boolean, string][] = [
      [snap({ savedAt: SAVED_AT }), true, 'clean'],
      [snap({ state: 'dirty', dirty: true }), true, 'dirty'],
      [snap({ state: 'dirty', dirty: true }), false, 'autosave-off'],
      [snap({ state: 'saving' }), true, 'saving'],
      [snap({ state: 'retrying', attempt: 3, dirty: true }), true, 'retrying'],
      [
        snap({ state: 'conflict', dirty: true, conflict: { serverContent: 'x', serverVersion: 1 } }),
        true,
        'conflict',
      ],
      [
        snap({
          state: 'error',
          dirty: true,
          failure: {
            kind: 'deleted',
            code: 'NOT_FOUND',
            status: 404,
            message: 'note not found',
            recoverable: false,
          },
        }),
        true,
        'error',
      ],
    ];

    for (const [snapshot, autosave, expected] of cases) {
      expect(saveStatusData(snapshot, autosave)).toBe(expected);
      const { unmount } = render(<SaveStatus snapshot={snapshot} autosave={autosave} />);
      expect(screen.getByTestId(SAVE_STATUS_TEST_ID).getAttribute('data-state')).toBe(expected);
      // This file renders in a loop, and Testing Library only cleans up between tests.
      unmount();
    }
  });

  it('keeps the server’s own words reachable in the title, so a short line never loses the reason', () => {
    const snapshot = snap({
      state: 'error',
      dirty: true,
      failure: {
        kind: 'unavailable',
        code: 'INTERNAL',
        status: 500,
        message: 'internal error',
        recoverable: true,
      },
    });
    render(<SaveStatus snapshot={snapshot} autosave={true} />);
    expect(screen.getByTestId(SAVE_STATUS_TEST_ID).getAttribute('title')).toBe('internal error');
  });

  it('reports the retry count as data, for a rule that wants the number and not the sentence', () => {
    render(<SaveStatus snapshot={snap({ state: 'retrying', attempt: 2, dirty: true })} autosave={true} />);
    const pill = screen.getByTestId(SAVE_STATUS_TEST_ID);
    expect(pill.textContent).toBe('Retrying (2)…');
    expect(pill.getAttribute('data-attempt')).toBe('2');
  });
});
