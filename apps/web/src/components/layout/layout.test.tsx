// @vitest-environment jsdom
/**
 * The two layout pieces (docs/plans/mvp/MVP-08.md §5).
 *
 * The theme is the interesting one, and the interesting part of it is not the menu — it is the pair of
 * effects the menu has outside React: an attribute on `<html>` that the stylesheet keys every colour
 * token off, and a `localStorage` write that has to survive a refresh. Neither is assertable through CSS
 * in jsdom, so the assertions are about the attribute and the stored word, which is exactly what
 * `globals.css` and the next page load read.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyThemeChoice,
  isThemeChoice,
  prefersDark,
  readThemeChoice,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  ThemeToggle,
  writeThemeChoice,
} from './ThemeToggle';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the theme choice', () => {
  it('is one of three words, and nothing else', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark']);
    for (const choice of THEME_CHOICES) expect(isThemeChoice(choice)).toBe(true);

    // Case, an empty string, a fifth value from a future build, and a hand edit are all "no choice":
    // trusting the stored word would let any of them paint a `data-theme` no stylesheet answers.
    for (const junk of ['DARK', '', 'sepia', 'null', undefined, null, 3]) {
      expect(isThemeChoice(junk)).toBe(false);
    }
  });

  it('round-trips through the ui store under the namespaced key', () => {
    expect(THEME_STORAGE_KEY).toBe('nt.theme');
    expect(readThemeChoice()).toBe('system');

    writeThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readThemeChoice()).toBe('dark');
  });

  it('reads junk on disk as the default rather than as an instruction', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'oc221b');
    expect(readThemeChoice()).toBe('system');
  });

  it('paints dark and light onto the document, and takes the attribute away for system', () => {
    applyThemeChoice('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    applyThemeChoice('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // `system` removes the attribute instead of writing the word, so the media query in the stylesheet —
    // not a boolean this file evaluated once — is what decides.
    applyThemeChoice('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('asks the operating system, and reports what it was told', () => {
    // The first honest thing this test says is that jsdom has no `matchMedia` at all: with no way to ask,
    // `prefersDark` answers "no" and the stylesheet's media query decides, which is the right way round
    // for a preference this component does not own.
    expect(prefersDark()).toBe(false);

    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: true, media: query }) as unknown as MediaQueryList),
    );
    expect(prefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });
});

describe('ThemeToggle', () => {
  it('says which of the three it is, in the accessible name', () => {
    render(<ThemeToggle />);
    // A button labelled "Theme" tells a screen-reader user nothing about which of the three is live, and
    // the tick in the menu is only visible once the menu is open.
    expect(screen.getByRole('button', { name: 'Theme: System' })).not.toBeNull();
  });

  it('paints and persists the pick, and marks it next time', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: 'Theme: System' }));
    await user.click(await screen.findByRole('menuitem', { name: /Dark/ }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    // The button now says what it is, so the state survives a re-read as well as a reload.
    expect(screen.getByRole('button', { name: 'Theme: Dark' })).not.toBeNull();
  });
});
