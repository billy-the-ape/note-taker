// @vitest-environment jsdom
/**
 * The tiny persisted UI store (docs/plans/mvp/MVP-08.md §6).
 *
 * Three things are worth a test here, and they are the three the components that use it will not be able
 * to see for themselves: which key a name lands on (a stray `theme` without the prefix would be a silent
 * collision with anything else on the origin), that a caller's fallback survives an unwritten key, and
 * that a browser with no storage at all is a shrug rather than a stack trace — the last one is the
 * behaviour that only ever shows up on somebody's iPad.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearUi, readUi, UI_STORAGE_PREFIX, uiStorageKey, writeUi } from './uiStore';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('ui store', () => {
  it('namespaces the key it writes', () => {
    writeUi('theme', 'dark');

    expect(uiStorageKey('theme')).toBe(`${UI_STORAGE_PREFIX}theme`);
    expect(uiStorageKey('theme')).toBe('nt.theme');
    expect(localStorage.getItem('nt.theme')).toBe('dark');
    // Not stored as JSON: a quoted `"dark"` is a worse thing to read in a debugging console.
    expect(localStorage.getItem('nt.theme')).not.toContain('"');
  });

  it('answers the fallback rather than an empty string when nobody has written the key', () => {
    expect(readUi('theme', 'system')).toBe('system');

    writeUi('theme', 'light');
    expect(readUi('theme', 'system')).toBe('light');
  });

  it('clears its own keys and leaves anybody else alone', () => {
    // `localhost` is shared by every project on the machine, so this must not be a `clear()`.
    localStorage.setItem('nt.theme', 'dark');
    localStorage.setItem('other-app', 'keep me');

    clearUi();

    expect(localStorage.getItem('nt.theme')).toBeNull();
    expect(localStorage.getItem('other-app')).toBe('keep me');
  });

  it('shrugs when the browser has no storage at all', () => {
    // A `localStorage` getter that throws is what Safari's private mode and a cookies-blocked profile
    // actually do; the app still has a theme for this visit, it just cannot remember it.
    vi.stubGlobal('localStorage', undefined);

    expect(readUi('theme', 'system')).toBe('system');
    expect(() => writeUi('theme', 'dark')).not.toThrow();
    expect(() => clearUi()).not.toThrow();
  });

  it('shrugs when reaching for storage throws', () => {
    // Not the same as having no storage: here the *accessor* explodes, which is what an iframe with an
    // opaque origin does. The descriptor is put back afterwards, because the four tests above and every
    // file after this one expect a working `localStorage`.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get(): Storage {
        throw new Error('SecurityError: the document is in a sandbox');
      },
    });

    try {
      expect(readUi('theme', 'system')).toBe('system');
      expect(() => writeUi('theme', 'dark')).not.toThrow();
      expect(() => clearUi()).not.toThrow();
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
