/**
 * A `window.location` that records instead of navigating.
 *
 * PR-16's "lands on `/login`" criterion is about an instruction, not about arriving: after
 * `POST /api/auth/logout-all` the screen has to tell the browser to go to the sign-in screen (see
 * `features/settings/go-to-login.ts` for why that is a navigation and not a router call). jsdom
 * implements `location.assign` as a "not implemented: navigation" error on the virtual console, so a
 * test that let it run would neither fail nor assert anything useful.
 *
 * jsdom defines `window.location` as a configurable own property, so replacing it outright works and
 * restores cleanly — no `delete`, no partial `href` spoofing.
 */
import { vi } from 'vitest';

export interface SpiedLocation {
  /** What the screen asked the browser to load, if anything. */
  readonly assign: ReturnType<typeof vi.fn<(href: string) => void>>;
  restore(): void;
}

export function spyOnLocation(): SpiedLocation {
  const original = window.location;
  const assign = vi.fn<(href: string) => void>();

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, assign, href: original.href },
  });

  return {
    assign,
    restore(): void {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    },
  };
}
