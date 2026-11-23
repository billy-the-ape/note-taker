// @vitest-environment jsdom
/**
 * PR-16's headline criterion (docs/plans/mvp/MVP-16.md §4): **autosave round-trips.**
 *
 * > toggle it off and the open editor stops writing immediately (pill text, zero debounce writes);
 * > back on and debouncing resumes; `Ctrl/Cmd+S` and the explicit Save button still work.
 *
 * The point of the test is the *open editor*: the settings screen and the editor are mounted
 * together, sharing one `QueryClient`, and nothing is remounted, refetched or re-navigated between
 * the click and the effect. What the harness (`src/test/editor-harness.tsx`) is is stated there — a
 * stand-in for PR-14's engine that reads the flag through `useAutosaveEnabled()` and implements only
 * PR-14 §6's `settings.autosave === false` rule — so what this file proves is PR-16's half: the flag
 * reaches a consumer through the cache, synchronously, without a round trip.
 *
 * The debounce waits are real. That is deliberate: PR-14 §6's engine is a debounce, and a fake timer
 * here would make the test prove that a `setTimeout` was *registered* rather than that a write did
 * or did not arrive about a second after the last keystroke.
 */
import { cleanup, type RenderResult, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_OFF_COPY } from '../../test/editor-harness.js';
import { createFakeServer } from '../../test/fake-api.js';
import { renderSettings } from '../../test/render-settings.js';

function pill(container: HTMLElement): string {
  const node = container.querySelector('[data-testid="save-status"]');
  if (node === null) throw new Error('the editor harness rendered no pill');
  return node.textContent ?? '';
}

function autosaveState(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="settings-autosave-toggle"]')?.getAttribute('aria-checked') as
    | string
    | null;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const node = container.querySelector('[data-testid="editor-buffer"]');
  if (!(node instanceof HTMLTextAreaElement)) throw new Error('no editor buffer on the page');
  return node;
}

/**
 * Focuses the buffer, pastes into it, and fails if the buffer does not say what it should.
 *
 * The assertion is the point. `user.paste` writes into whatever is focused, so a paste issued right
 * after clicking a switch is a paste into a `<button>`, which does nothing at all — and a test that
 * then asserts "no write happened" would pass while nobody typed anything. Every "the person kept
 * typing" step in this file goes through here, so the keystrokes are on the record.
 */
async function type(
  view: RenderResult,
  user: UserEvent,
  text: string,
  expectedBuffer: string,
): Promise<void> {
  await user.click(textarea(view.container));
  await user.paste(text);
  expect(textarea(view.container).value).toBe(expectedBuffer);
}

/** Longer than the debounce, so "it never fired" means something. */
function afterDebounce(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 300);
  });
}

/**
 * `waitFor`'s own default is a second, which is *shorter* than the debounce being waited for. Every
 * "the write arrived" assertion therefore states its budget, and does so in terms of the harness's
 * own number rather than a magic one.
 */
const WRITES = { timeout: AUTOSAVE_DEBOUNCE_MS + 600 };

describe('/app/settings — autosave round-trip', () => {
  afterEach(() => {
    cleanup();
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('stops the open editor the moment the switch flips, and resumes when it flips back', async () => {
    const server = createFakeServer();
    const save = vi.fn();
    const { view } = renderSettings({ server, withEditor: true, save });
    const user = userEvent.setup();

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    // 1. With autosave on, the editor writes about a second after typing stops.
    await type(view, user, 'the first thought', 'the first thought');
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('the first thought');
    }, WRITES);
    expect(pill(view.container)).toContain('Saved');

    // 2. Flip it off with the PATCH deliberately still in flight. `AUTOSAVE_OFF_COPY` is PR-14 §6's
    //    exact pill text, and it is already here — before the server answered, before any refetch,
    //    with the same editor component instance that was typing a moment ago. "Immediately" is only
    //    assertable against a request that has not finished, which is why the fake holds it.
    const gate = server.holdNextPatch();
    await user.click(view.getByTestId('settings-autosave-toggle'));

    await waitFor(() => {
      expect(pill(view.container)).toBe(AUTOSAVE_OFF_COPY);
    });
    expect(autosaveState(view.container)).toBe('false');
    expect(server.requests().filter((line) => line.startsWith('PATCH'))).toHaveLength(0);

    // 3. Typing continues — into the same editor, which is the whole point — and nothing is written.
    await type(view, user, ' and then some', 'the first thought and then some');
    await afterDebounce();
    expect(save).toHaveBeenCalledTimes(1);
    expect(pill(view.container)).toBe(AUTOSAVE_OFF_COPY);

    gate.release();
    await waitFor(() => {
      expect(server.settings()?.autosave).toBe(false);
    });
    // The server agreeing does not change what the editor already decided: the optimistic write was
    // not a guess that got corrected, it was the value.
    expect(pill(view.container)).toBe(AUTOSAVE_OFF_COPY);
    expect(save).toHaveBeenCalledTimes(1);

    // 4. Back on, and the same mounted editor debounces again.
    await user.click(view.getByTestId('settings-autosave-toggle'));
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });
    expect(pill(view.container)).not.toBe(AUTOSAVE_OFF_COPY);

    await type(view, user, ' final line', 'the first thought and then some final line');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    }, WRITES);
    expect(save).toHaveBeenLastCalledWith('the first thought and then some final line');
    // The PATCH that proved the flag round-tripped: exactly one field, twice.
    expect(
      server.requests().filter((line) => line === 'PATCH /api/settings {"autosave":false}'),
    ).toHaveLength(1);
  });

  it('leaves Ctrl/Cmd+S and the Save button working while autosave is off', async () => {
    const server = createFakeServer();
    const save = vi.fn();
    const { view } = renderSettings({ server, withEditor: true, save });
    const user = userEvent.setup();

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });
    await user.click(view.getByTestId('settings-autosave-toggle'));
    await waitFor(() => {
      expect(pill(view.container)).toBe(AUTOSAVE_OFF_COPY);
    });

    await type(view, user, 'unsaved work', 'unsaved work');
    await afterDebounce();
    // The premise for the rest of the test: nothing has been written by itself.
    expect(save).not.toHaveBeenCalled();

    // 5. `Ctrl/Cmd+S` (MVP-13 owns the chord; PR-14 §6 requires it to keep working while off).
    await user.keyboard('{Control>}s');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save).toHaveBeenCalledWith('unsaved work');

    // 6. And the explicit Save button.
    await user.click(view.getByTestId('editor-save-button'));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
    // A forced save is not a re-armed debounce: with the flag off there is nothing left to schedule.
    await afterDebounce();
    expect(save).toHaveBeenCalledTimes(2);
    // The only request this test makes against the settings row is the one toggle.
    expect(server.requests().filter((line) => line.startsWith('PATCH'))).toHaveLength(1);
  });
});
