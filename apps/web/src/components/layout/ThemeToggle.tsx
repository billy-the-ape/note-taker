import { useEffect, useState } from 'react';

import { readUi, uiStorageKey, writeUi } from '../../lib/uiStore';
import { Button } from '../ui/Button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../ui/Menu';

/**
 * The interim theme knob: system (default), light, or dark, for this browser only
 * (docs/plans/mvp/MVP-08.md §5).
 *
 * It is a `data-theme` attribute on `<html>`, and that is the whole mechanism — `styles/globals.css`
 * re-points the colour tokens when it reads `dark`, and *omits* the media query when it reads `light`,
 * which is the case a `dark:` utility cannot express ("the OS says dark and the person says otherwise").
 *
 * **Why `localStorage` and not `/api/settings`.** The settings row is PR-09's endpoint and PR-16 owns
 * the autosave/theme select; it will write `class="dark"` on `<html>` and delete this file. Until then a
 * PR-08 user who picks dark at 23:00 should not be told to come back in five PRs, and a preference that
 * is stored on the server is the wrong shape anyway: it is a fact about *this screen*, not about the
 * user, and the two disagree (plan §11.2 keeps transient UI client-side for exactly this reason).
 *
 * Pure helpers are exported because they are the testable half — the CSS cannot be asserted in jsdom,
 * but the attribute it keys off can.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The only three states; PR-16's select renders the same three words. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const CHOICE_LABELS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * The key this choice lands on: `nt.theme`, namespaced by the `ui` store rather than by this file
 * (plan §11.2), so PR-12's sidebar width and PR-13's sort order cannot wander into it.
 */
export const THEME_STORAGE_KEY = uiStorageKey('theme');

/** `true` when the operating system currently asks for a dark canvas. */
export function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** Anything other than the three words (a typo, a future fifth value, a hostile edit) is "no choice". */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Reads the stored choice through the `ui` store (§6). A value that is none of the three — a typo, a key
 * left behind by an older build, a hand edit — is treated as no choice at all rather than trusted.
 */
export function readThemeChoice(): ThemeChoice {
  const stored = readUi('theme', 'system');
  return isThemeChoice(stored) ? stored : 'system';
}

/** A write that fails (private mode, storage disabled) is not worth a toast: the choice still applies now. */
export function writeThemeChoice(choice: ThemeChoice): void {
  writeUi('theme', choice);
}

/**
 * Paints the choice onto the document. `system` removes the attribute rather than writing the word, so
 * the media query in `globals.css` — not a JS-evaluated boolean — stays the thing that decides, and the
 * OS can change mid-session without this component noticing.
 */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  if (choice === 'system') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.setAttribute('data-theme', choice);
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());

  useEffect(() => {
    applyThemeChoice(choice);
    writeThemeChoice(choice);
  }, [choice]);

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="theme-toggle">
          {/* The current state is in the accessible name, because a button labelled "Theme" tells a
              screen-reader user nothing about which of the three it is. */}
          <span aria-hidden>{CHOICE_LABELS[choice]}</span>
          <span className="sr-only">Theme: {CHOICE_LABELS[choice]}</span>
        </Button>
      </MenuTrigger>
      <MenuContent data-testid="theme-menu">
        <MenuLabel>Theme</MenuLabel>
        {THEME_CHOICES.map((option) => (
          <MenuItem
            key={option}
            data-state={option === choice ? 'checked' : undefined}
            onSelect={() => setChoice(option)}
          >
            {/* A tick plus the word: colour alone cannot carry "this one is active". */}
            <span aria-hidden className="w-3">
              {option === choice ? '✓' : ''}
            </span>
            {CHOICE_LABELS[option]}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
