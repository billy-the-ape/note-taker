/**
 * Per-test cleanup for the DOM suites (docs/plans/mvp/MVP-08.md §7).
 *
 * Three resets, because all three leak across a file boundary in ways that make the *next* test lie:
 *
 * * `cleanup()` unmounts React trees. Testing Library only auto-cleans when `globals: true`, and this
 *   repo runs Vitest without globals (the imports are explicit everywhere else too), so a second
 *   `getByTestId('login-form')` in the same file would otherwise find two forms — the first one's, still
 *   mounted.
 * * `localStorage` holds the theme choice (PR-08) and is shared by the whole jsdom window.
 * * `queryClient` is the module singleton the guards use, so the session the previous test signed in
 *   with would answer the next test's boot without a request — which is precisely the behaviour a
 *   "the guard fetched on boot" test is supposed to fail on.
 *
 * The global `fetch` stub is installed per test by whoever needs it (`test/fakeApi.ts`) and is not
 * touched here, so the `src/lib/api.test.ts` suite keeps its own assertions about what the client does
 * to a request.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { setUnauthorizedHandler } from '../lib/api';
import { queryClient } from '../lib/queryClient';

/**
 * Two things jsdom does not implement, papered over here rather than in the components that trip on them.
 *
 * * Pointer capture (jsdom/jsdom#2786): Radix's toast asks the focus target whether it has capture while
 *   it moves focus inside the viewport, and jsdom has no such method — the resulting `TypeError` escaped
 *   React's event dispatch as an unhandled exception and was blamed on whichever test happened to be
 *   running. Answering "nothing has capture" is precisely what a browser with no pointer says.
 * * `window.scrollTo`: a Dialog scrolls its panel into view when it opens, and jsdom logs
 *   "Not implemented" through the virtual console every single time, which buries the output of the
 *   hundred-odd tests that have nothing to do with scrolling. A no-op is the honest answer here, since
 *   jsdom does not lay anything out anyway.
 */
interface PointerCapture {
  hasPointerCapture(pointerId: number): boolean;
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
}

if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Partial<PointerCapture>;
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => undefined;
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => undefined;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

afterEach(cleanup);

beforeEach(() => {
  // `localStorage` exists only where a DOM does, and half this suite runs in `node` on purpose
  // (`vitest.config.ts`) — so the reset is guarded rather than unconditional.
  if (typeof localStorage !== 'undefined') localStorage.clear();
  // A test that wired the 401 handler by mounting the app leaves it pointing at a dead router.
  setUnauthorizedHandler(undefined);
  queryClient.clear();
});
