// @vitest-environment jsdom
/**
 * The two preference controls on `/app/settings` (docs/plans/mvp/MVP-16.md §4 and §5): keyboard
 * operable, one `PATCH` per change, optimistic *and* honest about failing, and never an error screen
 * for an account the server has not written a settings row for yet (§6) — nor for a refresh that
 * failed while a perfectly good row was on screen, which is a different failure and gets a note.
 */
import { cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeServer } from '../../test/fake-api.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderSettings } from '../../test/render-settings.js';

function autosaveState(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="settings-autosave-toggle"]')?.getAttribute('aria-checked') as
    | string
    | null;
}

describe('/app/settings — preferences', () => {
  afterEach(() => {
    cleanup();
    // Belt and braces: an assertion that throws inside a test skips that test's `dispose()`, and a
    // leftover `matchMedia` would follow the next test around.
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('renders the defaults for a fresh account instead of an error state', async () => {
    // No settings row at all: `GET /api/settings` is get-or-create (PR-09), so a fresh account is the
    // boring case, not the sad one. A "no settings found" screen here would be PR-16 failing §6.
    const media = installMatchMedia(false);
    const server = createFakeServer();
    expect(server.settings()).toBeUndefined();

    const { view } = renderSettings({ server });

    expect(view.queryByTestId('settings-error')).toBeNull();
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });
    expect(view.queryByTestId('settings-error')).toBeNull();
    // The read happened, and the row it returns is the default row — the same `{autosave: true,
    // theme: 'system'}` the screen was already showing, which is why showing it first is honest.
    expect(server.settings()).toEqual(expect.objectContaining({ autosave: true, theme: 'system' }));

    media.dispose();
  });

  it('patches one field at a time and the switch reflects the stored answer', async () => {
    const media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    await userEvent.setup().click(view.getByTestId('settings-autosave-toggle'));

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('false');
    });
    expect(server.requests()).toContain('PATCH /api/settings {"autosave":false}');
    expect(server.settings()?.autosave).toBe(false);
    // Not two patches, and not the whole row: `patchSettingsSchema` refuses an empty body and the
    // server only ever moves the key that changed.
    expect(server.requests().filter((line) => line.startsWith('PATCH'))).toHaveLength(1);

    media.dispose();
  });

  it('rolls the switch back when the PATCH fails, and says so', async () => {
    const media = installMatchMedia(false);
    const server = createFakeServer();
    server.failNextPatch({ status: 500, message: 'the settings service is offline' });
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    // Both halves of an optimistic control, in the order they happen. The request is held so the flip
    // can be observed *before* the answer exists — otherwise "it rolled back" is also true of a switch
    // that never moved.
    const gate = server.holdNextPatch();
    await userEvent.setup().click(view.getByTestId('settings-autosave-toggle'));

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('false');
    });
    expect(view.queryByTestId('settings-autosave-error')).toBeNull();

    gate.release();

    // And the rollback is what makes the flip safe. A screen that showed "off" while the server said
    // "on" would leave the editor autosaving behind the person's back — the failure mode §5 refuses.
    await waitFor(() => {
      expect(view.getByTestId('settings-autosave-error').textContent).toContain(
        'the settings service is offline',
      );
    });
    expect(autosaveState(view.container)).toBe('true');
    expect(server.settings()?.autosave).toBe(true);

    media.dispose();
  });

  it('keeps the screen when the refetch behind a failed patch fails too', async () => {
    // The realistic version of "the settings are unreachable": the patch fails, the rollback puts
    // back the row that *is* stored, and `onSettled`'s invalidation then refetches — and that fails
    // as well. React Query v5 reports this as `isError` **with `data`**, and treating it as
    // "nothing loaded" would swap four working controls (and a half-typed password) for an error
    // screen that also hides the patch failure the person is trying to read.
    const media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    const user = userEvent.setup();
    const current = view.getByTestId('change-password-current') as HTMLInputElement;
    await user.type(current, 'a-password-half-typed');

    server.failNextPatch({ status: 500, message: 'the settings service is offline' });
    // A `401`, because that is the failure that follows an expired session, and `shouldRetryQuery`
    // refuses to retry a `4xx` — so this really is a terminal read failure, not one attempt of two.
    server.failNextSettingsRead({ status: 401, message: 'the session went away' });
    await user.click(view.getByTestId('settings-autosave-toggle'));

    // The patch failure is shown where the change was made...
    await waitFor(() => {
      expect(view.getByTestId('settings-autosave-error').textContent).toContain(
        'the settings service is offline',
      );
    });
    // ...and the failed refresh is a note above the controls rather than a new page.
    await waitFor(() => {
      expect(view.getByTestId('settings-refresh-error').textContent).toContain('the session went away');
    });
    expect(view.queryByTestId('settings-error')).toBeNull();
    expect(autosaveState(view.container)).toBe('true');
    // The forms were not unmounted to display a message, so what was typed is still there.
    expect(current.value).toBe('a-password-half-typed');
    expect(server.settings()?.autosave).toBe(true);

    // The note is actionable: the next read succeeds, and it goes away on its own terms.
    await user.click(view.getByTestId('settings-refresh-retry'));
    await waitFor(() => {
      expect(view.queryByTestId('settings-refresh-error')).toBeNull();
    });
    expect(view.queryByTestId('settings-error')).toBeNull();
    expect(autosaveState(view.container)).toBe('true');

    media.dispose();
  });

  it('offers a retry when the read itself fails, and recovers on click', async () => {
    const media = installMatchMedia(false);
    const server = createFakeServer();
    // A `403`, so `lib/api.ts`'s retry rule ("never on a `4xx`") is part of what is being tested: the
    // screen has to reach its error state rather than sit on a spinner forever.
    server.failNextSettingsRead({ status: 403, message: 'the session went away' });
    const { view } = renderSettings({ server });

    await waitFor(() => {
      expect(view.getByTestId('settings-error').textContent).toContain('the session went away');
    });
    // The controls are not rendered against a row that failed to arrive; the error replaces them, and
    // the only affordance is the retry.
    expect(view.queryByTestId('settings-autosave-toggle')).toBeNull();

    await userEvent.setup().click(view.getByTestId('settings-retry'));

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });
    expect(view.queryByTestId('settings-error')).toBeNull();

    media.dispose();
  });

  it('operates the switch from the keyboard, with no mouse in sight', async () => {
    // §4: "Every control is keyboard-operable and labelled, with a visible focus ring — no mouse-only
    // control." A real `<button role="switch">` and Enter is the whole mechanism; a `div` with a click
    // handler would fail this and look identical.
    const media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(view.getByTestId('settings-autosave-toggle'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Autosave');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('false');
    });
    expect(server.settings()?.autosave).toBe(false);

    media.dispose();
  });

  it('carries every `data-testid` PR-19 was promised', async () => {
    // MVP-16 §4 is a contract with the e2e suite that has not been written yet: these ids are what
    // PR-19's Playwright files will query by. A rename here breaks a suite that cannot fail loudly
    // today, so the list is written down once, in the PR that owns the ids.
    const media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(autosaveState(view.container)).toBe('true');
    });

    for (const id of [
      'settings-autosave-toggle',
      'settings-theme-select',
      'settings-theme-light',
      'settings-theme-dark',
      'settings-theme-system',
      'change-password-form',
      'sign-out-everywhere',
    ]) {
      expect(view.getByTestId(id)).toBeDefined();
    }

    media.dispose();
  });
});
