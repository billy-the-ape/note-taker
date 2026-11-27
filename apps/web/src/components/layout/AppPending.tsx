import { LoadingBlock } from '../ui/Spinner';

/**
 * What the app shows while the boot pair is in flight (docs/plans/mvp/MVP-08.md §4).
 *
 * The first navigation awaits `GET /api/auth/status` and `GET /api/auth/session` before any route can
 * render, because the guard cannot decide anything until it knows who is signed in and whether anybody
 * is installed. That is a few milliseconds on a laptop and a noticeable pause behind a starting
 * container, and a page that is merely blank for a moment is indistinguishable from a page that
 * crashed — which is the whole reason this file exists.
 *
 * It lives here rather than inline in `main.tsx` so that `test/renderApp.tsx` can mount *the same*
 * component: the harness that proves the guards work should not be a place where the pending state is
 * quietly different from the one a user sees.
 */
export const APP_PENDING_LABEL = 'Checking whether you are still signed in…';

export function AppPending() {
  return <LoadingBlock label={APP_PENDING_LABEL} />;
}
