import { describe, expect, it, vi } from 'vitest';

import {
  applyThemeClass,
  DARK_CLASS,
  DARK_SCHEME_QUERY,
  LIGHT_CLASS,
  type MatchMediaLike,
  type MediaQueryListLike,
  prefersDarkScheme,
  resolveTheme,
  subscribeDarkScheme,
} from './theme.js';

/**
 * The pure half of the theme rule (docs/plans/mvp/MVP-16.md §5): what the stored value means, what
 * class it turns into, and how the operating system is asked. The DOM part — `<html>` actually
 * carrying the class through a reload and an OS flip — is `theme-sync.test.tsx`, which renders the
 * screen instead of calling these.
 */

/** A media query list that records what was subscribed, and can be told to change. */
export type FakeList = Omit<MediaQueryListLike, 'matches'> & {
  /** Re-declared mutable on purpose: the browser's is read-only, a test's has to be drivable. */
  matches: boolean;
  emit(prefersDark: boolean): void;
};

/**
 * `shape` picks the API generation: `addEventListener` (current), `addListener` (older), or neither
 * (an environment that can be read once and never watched). All three have to keep working, because
 * only the first is what a test can be written against.
 */
export function fakeList(matches: boolean, shape: 'modern' | 'legacy' | 'none' = 'modern'): FakeList {
  const listeners = new Set<(event: unknown) => void>();
  const list = {
    matches,
    emit(prefersDark: boolean): void {
      list.matches = prefersDark;
      for (const listener of listeners) listener({ matches: prefersDark });
    },
  } as FakeList;

  if (shape === 'modern') {
    list.addEventListener = (_type, listener) => {
      listeners.add(listener);
    };
    list.removeEventListener = (_type, listener) => {
      listeners.delete(listener);
    };
  }
  if (shape === 'legacy') {
    list.addListener = (listener) => {
      listeners.add(listener);
    };
    list.removeListener = (listener) => {
      listeners.delete(listener);
    };
  }
  return list;
}

/** A `matchMedia` that hands out one list and records every query it was asked about. */
export function fakeMatchMedia(list: MediaQueryListLike): MatchMediaLike & { asked: string[] } {
  const asked: string[] = [];
  const impl = ((query: string) => {
    asked.push(query);
    return list;
  }) as MatchMediaLike & { asked: string[] };
  impl.asked = asked;
  return impl;
}

describe('resolveTheme', () => {
  it('asks the operating system only for `system`', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('takes an explicit choice over the operating system', () => {
    // The two lines that make the select worth having: choosing light and having the OS go dark must
    // not move the page, and neither may a `PATCH` (the stored value stays `light`).
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('applyThemeClass', () => {
  function fakeRoot(initial: readonly string[] = []) {
    const classes = new Set(initial);
    return {
      classList: {
        add: (name: string) => {
          classes.add(name);
        },
        remove: (name: string) => {
          classes.delete(name);
        },
      },
      has: (name: string) => classes.has(name),
    };
  }

  it('writes exactly one theme class, and the *other* one for the opposite resolution', () => {
    const root = fakeRoot();
    applyThemeClass(root, 'dark');
    expect(root.has(DARK_CLASS)).toBe(true);
    expect(root.has(LIGHT_CLASS)).toBe(false);

    applyThemeClass(root, 'light');
    expect(root.has(DARK_CLASS)).toBe(false);
    expect(root.has(LIGHT_CLASS)).toBe(true);
  });

  it('writes light rather than merely removing dark, because the stylesheet needs the opt-out', () => {
    // `styles/globals.css` paints dark under `prefers-color-scheme: dark` unless the root carries
    // `data-theme="light"` (PR-08's per-browser knob) or `.light` (this file's account value). A
    // stored `light` that only removed `dark` therefore lost to a dark operating system, which is
    // what these two lines are worth: an empty class list is not light, it is "ask the OS".
    const root = fakeRoot();
    applyThemeClass(root, 'light');
    expect(root.has(LIGHT_CLASS)).toBe(true);
    expect(root.has(DARK_CLASS)).toBe(false);
  });

  it('leaves every other class on the element alone', () => {
    const root = fakeRoot(['scroll-smooth']);
    applyThemeClass(root, 'light');
    expect(root.has('scroll-smooth')).toBe(true);
  });

  it('is a no-op where there is no document', () => {
    expect(() => {
      applyThemeClass(undefined, 'dark');
    }).not.toThrow();
  });
});

describe('prefersDarkScheme', () => {
  it('reads the one query it is allowed to read', () => {
    const matchMedia = fakeMatchMedia(fakeList(true));
    expect(prefersDarkScheme(matchMedia)).toBe(true);
    // A wrong query string is a theme bug that looks like a working page, so it is asserted here.
    expect(matchMedia.asked).toEqual([DARK_SCHEME_QUERY]);
    expect(DARK_SCHEME_QUERY).toBe('(prefers-color-scheme: dark)');
  });
});

describe('subscribeDarkScheme', () => {
  it('follows the operating system while subscribed, and stops when unsubscribed', () => {
    const list = fakeList(false);
    const onChange = vi.fn();

    const unsubscribe = subscribeDarkScheme(onChange, fakeMatchMedia(list));
    list.emit(true);
    expect(onChange).toHaveBeenLastCalledWith(true);

    unsubscribe();
    list.emit(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('falls back to the pre-`addEventListener` API', () => {
    const list = fakeList(false, 'legacy');
    const onChange = vi.fn();

    subscribeDarkScheme(onChange, fakeMatchMedia(list));
    list.emit(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('survives an implementation that cannot notify at all', () => {
    const list = fakeList(true, 'none');
    const onChange = vi.fn();

    const unsubscribe = subscribeDarkScheme(onChange, fakeMatchMedia(list));
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    // Sampled, not subscribed: "follows the OS at load" rather than "ignores the theme".
    expect(prefersDarkScheme(fakeMatchMedia(list))).toBe(true);
  });
});
