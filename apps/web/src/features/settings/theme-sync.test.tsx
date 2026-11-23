// @vitest-environment jsdom
/**
 * The theme half of docs/plans/mvp/MVP-16.md §5, rendered: the stored value drives
 * `class="dark"` on `<html>`, an explicit choice beats the operating system, `system` follows it
 * (including when it changes), and the value comes back from the server after a reload rather than
 * from anything the component remembered.
 *
 * Every assertion here is a pair — the stored value *and* the applied class — because either one on
 * its own passes with half the feature broken: a select that writes to the server without touching
 * the DOM is a settings screen with no theme, and a class toggled locally is a theme that is gone on
 * refresh.
 */
import { cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeServer } from '../../test/fake-api.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderSettings } from '../../test/render-settings.js';
import { DARK_CLASS } from './theme.js';

function selectedTheme(container: HTMLElement): string {
  const select = container.querySelector('[data-testid="settings-theme-select"]');
  if (!(select instanceof HTMLSelectElement)) throw new Error('no theme select on the page');
  return select.value;
}

function dark(): boolean {
  return document.documentElement.classList.contains(DARK_CLASS);
}

function patchCalls(server: ReturnType<typeof createFakeServer>): number {
  return server.requests().filter((line) => line.startsWith('PATCH')).length;
}

describe('/app/settings — theme', () => {
  let media: ReturnType<typeof installMatchMedia> | undefined;

  beforeEach(() => {
    document.documentElement.className = '';
  });

  afterEach(() => {
    cleanup();
    media?.dispose();
    media = undefined;
  });

  it('stores the choice and applies it as class="dark" on <html>', async () => {
    media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });

    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('system');
    });
    // `system` with an operating system that prefers light is light: the class is only ever dark for
    // a reason, never left over from a previous page.
    expect(dark()).toBe(false);

    const user = userEvent.setup();
    await user.selectOptions(view.getByTestId('settings-theme-select'), 'dark');

    await waitFor(() => {
      expect(server.settings()?.theme).toBe('dark');
    });
    expect(dark()).toBe(true);
    // The control shows the *stored* value, so `system` stays selectable and the next OS flip still
    // follows, rather than the select being frozen at whatever the OS happened to say.
    expect(selectedTheme(view.container)).toBe('dark');

    await user.selectOptions(view.getByTestId('settings-theme-select'), 'light');
    await waitFor(() => {
      expect(server.settings()?.theme).toBe('light');
    });
    expect(dark()).toBe(false);
  });

  it('sends exactly the field it changed', async () => {
    media = installMatchMedia(false);
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('system');
    });

    await userEvent.setup().selectOptions(view.getByTestId('settings-theme-select'), 'dark');

    await waitFor(() => {
      expect(server.requests()).toContain('PATCH /api/settings {"theme":"dark"}');
    });
  });

  it('comes back from the server after a reload, class included', async () => {
    media = installMatchMedia(false);
    const server = createFakeServer();
    const first = renderSettings({ server });
    await waitFor(() => {
      expect(selectedTheme(first.view.container)).toBe('system');
    });

    await userEvent.setup().selectOptions(first.view.getByTestId('settings-theme-select'), 'dark');
    await waitFor(() => {
      expect(server.settings()?.theme).toBe('dark');
    });

    // A reload: a new document and a new cache, the same cookie jar and the same database. The class
    // cannot come from anywhere but the `GET /api/settings` this render is about to make.
    document.documentElement.className = '';
    const second = first.reload();

    await waitFor(() => {
      expect(selectedTheme(second.view.container)).toBe('dark');
      expect(dark()).toBe(true);
    });
  });

  it('follows the operating system while `system`, without asking the server', async () => {
    media = installMatchMedia(false);
    const server = createFakeServer({
      settings: { autosave: true, theme: 'system', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('system');
    });
    const patchesBefore = patchCalls(server);

    media.set(true);

    await waitFor(() => {
      expect(dark()).toBe(true);
    });
    // The note beside the select names the *resolved* value while the control itself still says
    // `system` (ThemeSelect renders the stored value on purpose), and this is the only place that
    // sentence is checked — PR-19 will click these options, so "says what it is following" is a
    // claim worth a test rather than a comment.
    expect(view.getByTestId('settings-theme-resolved').textContent).toBe('Following the system: dark');
    // The point of storing the preference rather than the answer: an OS flip is not a write, and the
    // stored value is still `system` so the next flip follows too.
    expect(patchCalls(server)).toBe(patchesBefore);
    expect(server.settings()?.theme).toBe('system');

    media.set(false);
    await waitFor(() => {
      expect(dark()).toBe(false);
    });
    expect(view.getByTestId('settings-theme-resolved').textContent).toBe('Following the system: light');
  });

  it('takes an explicit `light` over an operating system that went dark', async () => {
    media = installMatchMedia(false);
    const server = createFakeServer({
      settings: { autosave: true, theme: 'light', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { view } = renderSettings({ server });
    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('light');
    });

    media.set(true);

    // No debounce, no "eventually": the preference is explicit, so the OS has no say at all.
    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('light');
    });
    expect(dark()).toBe(false);
  });

  it('follows the operating system for an account with no settings row yet', async () => {
    // No `settings:` — the state PR-09's get-or-create is about. The page must not sit there with no
    // theme to show, and must not call the missing row an error (MVP-16 §6).
    media = installMatchMedia(true);
    const server = createFakeServer();
    const { view } = renderSettings({ server });

    expect(dark()).toBe(true);
    expect(view.queryByTestId('settings-error')).toBeNull();
    await waitFor(() => {
      expect(selectedTheme(view.container)).toBe('system');
    });
  });
});
