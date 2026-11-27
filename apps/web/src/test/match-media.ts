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
import { WIDE_VIEWPORT_QUERY } from '../lib/editorMode.js';

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: unknown) => void): void;
  removeEventListener(type: 'change', listener: (event: unknown) => void): void;
}

export interface FakeMatchMedia {
  /** Flips the preference and notifies subscribers, i.e. the user opened system settings. */
  set(prefersDark: boolean): void;
  /**
   * Answers the width query, i.e. the window was resized (or the test is about the mode a first-time
   * editor would open in). Subscribers are not notified: PR-13 reads the width **once**, when the pane
   * mounts, and a resize is deliberately not a reason to overrule a stored mode — so the honest stand-in
   * has no listener to call, and a test that wanted one would be testing a feature that does not exist.
   */
  setWide(matches: boolean): void;
  dispose(): void;
}

export function installMatchMedia(
  prefersDark: boolean,
  options: { readonly wide?: boolean } = {},
): FakeMatchMedia {
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

  // Live rather than a snapshot: `matches` is read every time the query is asked, which is what "the
  // window is this wide now" means to a caller that looks once per mount.
  const wide = {
    matches: options.wide ?? true,
    addEventListener() {},
    removeEventListener() {},
  };

  const previous = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => {
    // Anything but the dark query is answered honestly and left unsubscribed: the settings screen
    // asks for one thing, and pretending otherwise would hide a wrong query string.
    if (query === DARK_SCHEME_QUERY) return list;
    if (query === WIDE_VIEWPORT_QUERY) return wide;
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  }) as typeof globalThis.matchMedia;

  return {
    set(next: boolean): void {
      list.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
    setWide(next: boolean): void {
      wide.matches = next;
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
