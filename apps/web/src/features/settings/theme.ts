/**
 * Theme application (docs/plans/mvp/MVP-16.md §4 and §5): the stored `system | light | dark` value
 * becomes `class="dark"` on `<html>`, and `system` resolves through
 * `matchMedia('(prefers-color-scheme: dark)')`.
 *
 * Three deliberate shapes:
 *
 * * **The media query is injected.** `matchMedia` does not exist in the plain Node environment the
 *   server tests use and always answers `false` under jsdom, so both the reader and the subscription
 *   take an implementation, and the pure half (`resolveTheme`) takes a boolean. That is also what lets
 *   a test prove the thing a screenshot cannot: that changing the *operating system's* preference
 *   moves a `system` page to `dark` with no request and no re-render of the settings row.
 * * **`system` is resolved, never stored.** `PATCH /api/settings` receives `system` and the resolved
 *   value never travels to the server — the stored value is the *preference*, which is why the OS
 *   flip needs no write.
 * * **The class is the contract.** `styles/globals.css` declares Tailwind's `dark` variant as
 *   class-based (`@custom-variant`), so `.dark` on the root element is what the whole stylesheet
 *   reads. This file writes exactly one class and nothing else about `<html>`.
 */

import type { SettingsTheme } from '@note-taker/contracts';
import { useEffect, useState } from 'react';

import { useSettingsTheme } from './use-settings.js';

/** The class Tailwind's `dark:` variant keys off (see the `@custom-variant` in `globals.css`). */
export const DARK_CLASS = 'dark';
/** The query PR-08's `prefers-color-scheme` default used, kept as the single source for `system`. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export type ResolvedTheme = 'light' | 'dark';

/** The part of `window.matchMedia` this module uses; a test hands its own object instead. */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'change', listener: (event: unknown) => void): void;
  /** The pre-`addEventListener` API, which some environments (and jsdom versions) still expose. */
  addListener?(listener: (event: unknown) => void): void;
  removeListener?(listener: (event: unknown) => void): void;
}

export type MatchMediaLike = (query: string) => MediaQueryListLike;

/** The element the class lands on — `document.documentElement` in the browser, a stub in a test. */
export interface ClassTarget {
  readonly classList: { add(className: string): void; remove(className: string): void };
}

/** `system` asks the OS; `light` and `dark` ignore it. Nothing else needs to know they differ. */
export function resolveTheme(theme: SettingsTheme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/**
 * Makes `root` match `resolved`, and only ever that: adding `dark` and removing the other classes a
 * page might own would fight with whatever else writes `<html class>`.
 */
export function applyThemeClass(root: ClassTarget | undefined, resolved: ResolvedTheme): void {
  if (root === undefined) return;
  if (resolved === 'dark') {
    root.classList.add(DARK_CLASS);
    return;
  }
  root.classList.remove(DARK_CLASS);
}

/** The implementation the hook uses: the browser's own, or nothing outside a browser. */
function browserMatchMedia(query: string): MediaQueryListLike {
  const impl = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia : undefined;
  if (impl === undefined) {
    return { matches: false };
  }
  return impl.call(globalThis, query) as MediaQueryListLike;
}

/** Reads the current OS preference once. */
export function prefersDarkScheme(matchMedia: MatchMediaLike = browserMatchMedia): boolean {
  return matchMedia(DARK_SCHEME_QUERY).matches;
}

/**
 * Subscribes to the OS preference and returns the unsubscribe.
 *
 * `addEventListener` is the current API, `addListener` is what older environments expose, and an
 * implementation with neither is still read once — a preference that is only sampled at mount
 * degrades to "follows the OS at load", never to "ignores the theme".
 */
export function subscribeDarkScheme(
  onChange: (prefersDark: boolean) => void,
  matchMedia: MatchMediaLike = browserMatchMedia,
): () => void {
  const list = matchMedia(DARK_SCHEME_QUERY);
  const listener = (): void => {
    // Read from the list rather than the event: `MediaQueryListEvent.matches` and
    // `event.media` agree, but the list is the same object the next call would read anyway.
    onChange(list.matches);
  };
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', listener);
    return () => list.removeEventListener?.('change', listener);
  }
  if (typeof list.addListener === 'function') {
    list.addListener(listener);
    return () => list.removeListener?.(listener);
  }
  return () => {};
}

/** The options a test needs; production calls these with nothing. */
export interface ThemeSyncOptions {
  readonly matchMedia?: MatchMediaLike;
  readonly root?: ClassTarget;
}

/**
 * The OS preference, kept live. `matchMedia` is resolved per render and defaults to the module-level
 * `browserMatchMedia`, so a test that installs its own `globalThis.matchMedia` is read without any
 * prop being threaded through the tree — which is how the page test renders "following the system:
 * dark" in a jsdom that has no `matchMedia` at all.
 */
export function usePrefersDarkScheme(matchMedia: MatchMediaLike = browserMatchMedia): boolean {
  const [prefersDark, setPrefersDark] = useState<boolean>(() => prefersDarkScheme(matchMedia));

  useEffect(
    () =>
      subscribeDarkScheme((next) => {
        setPrefersDark(next);
      }, matchMedia),
    [matchMedia],
  );

  return prefersDark;
}

/**
 * What the theme resolves to right now: the stored preference, with `system` answered by the
 * operating system. Read-only — this is the hook the copy next to the select uses.
 */
export function useResolvedTheme(options: ThemeSyncOptions = {}): ResolvedTheme {
  const matchMedia = options.matchMedia ?? browserMatchMedia;
  return resolveTheme(useSettingsTheme(), usePrefersDarkScheme(matchMedia));
}

/**
 * Applies the stored theme to `<html>` and keeps it applied: re-runs when the settings row changes
 * (a `PATCH`, or another tab's invalidation) and, while the preference is `system`, whenever the OS
 * flips. Returns the class it resolved to, which is what the "you are in dark mode" copy reads.
 *
 * On a cold load the class lands when the settings response lands, since the value is a server
 * value and not a cookie: a reload can show the default theme for the length of one request. Making
 * that instantaneous is an inline script in `index.html` reading a mirrored value, which PR-18 owns
 * with the rest of the production shell.
 */
export function useThemeSync(options: ThemeSyncOptions = {}): ResolvedTheme {
  const resolved = useResolvedTheme(options);
  const root = options.root ?? (typeof document === 'undefined' ? undefined : document.documentElement);

  useEffect(() => {
    applyThemeClass(root, resolved);
  }, [root, resolved]);

  return resolved;
}
