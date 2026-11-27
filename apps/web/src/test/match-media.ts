/**
 * A `matchMedia` the tests can drive.
 *
 * jsdom has no `matchMedia` at all, and the theme rule under test — `system` follows the operating
 * system — is about what happens when the OS preference *changes*, which cannot be produced by
 * pretending the query matched at mount. This installs a stand-in on `globalThis` (which is what
 * `features/settings/theme.ts` reads, so no prop is threaded anywhere) and hands back a `set` that
 * fires the `change` listeners the way a real media query list would.
 */
import { DARK_SCHEME_QUERY } from '../features/settings/theme.js';

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: unknown) => void): void;
  removeEventListener(type: 'change', listener: (event: unknown) => void): void;
}

export interface FakeMatchMedia {
  /** Flips the preference and notifies subscribers, i.e. the user opened system settings. */
  set(prefersDark: boolean): void;
  dispose(): void;
}

export function installMatchMedia(prefersDark: boolean): FakeMatchMedia {
  const listeners = new Set<(event: unknown) => void>();
  const list: FakeMediaQueryList = {
    matches: prefersDark,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  const previous = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => {
    // Anything but the dark query is answered honestly and left unsubscribed: the settings screen
    // asks for one thing, and pretending otherwise would hide a wrong query string.
    if (query !== DARK_SCHEME_QUERY)
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    return list;
  }) as typeof globalThis.matchMedia;

  return {
    set(next: boolean): void {
      list.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
    dispose(): void {
      listeners.clear();
      if (previous === undefined) {
        delete (globalThis as { matchMedia?: unknown }).matchMedia;
        return;
      }
      globalThis.matchMedia = previous;
    },
  };
}
