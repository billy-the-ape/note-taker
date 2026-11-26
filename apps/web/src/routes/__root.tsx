import { createRootRoute, type ErrorComponentProps, Outlet } from '@tanstack/react-router';

import { ToastProvider } from '../components/ui/Toast';
import { guardNavigation, SessionProvider } from '../features/auth/session';
import { ApiError } from '../lib/api';

/**
 * The root route: the shell every other route renders into, and the one place the guards live
 * (docs/plans/mvp/MVP-08.md §4 — "never per page").
 *
 * A `beforeLoad` on the root runs before *any* match is loaded, including for a path nothing matches,
 * so the four rules of §4 cannot be bypassed by arriving at a URL the tree has never heard of. It is
 * also the reason `/` needs no route file: `*` is a redirect, not a page.
 *
 * PR-12 adds `routes/app/route.tsx` and takes the authed half of the table over from here; what stays
 * is this: nobody who is not signed in gets past the sign-in pages, whatever the path.
 *
 * **This layout owns no furniture** (PR-12 review, round two). It renders the providers and a bare
 * `<Outlet/>`: the chrome the auth pages want is in the pathless `routes/_auth.tsx`, and the authed shell is
 * `routes/app/route.tsx`'s. Root chrome over the shell was a real defect — `AppShell`'s full-viewport grid
 * inside a `max-w-2xl` column, under a second header with a second theme toggle, `<main>` nested in `<main>` —
 * and the fix is a sibling layout route rather than a path test here, because a path test is a second
 * route-shaped decision in the file whose whole job is to make route-shaped decisions happen once.
 */
export const Route = createRootRoute({
  beforeLoad: ({ location }) => guardNavigation(location.pathname),
  component: RootLayout,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
});

/**
 * The providers, mounted here rather than in `main.tsx` on purpose: `SessionProvider` calls
 * `useNavigate()`, and that hook needs the router context which `RouterProvider` has not created yet at
 * the point `main.tsx` renders. The root route is the highest place that is *inside* the router, so it
 * is also the highest place a session can live — and `QueryClientProvider`, which has no such
 * dependency, stays outside in `main.tsx` so the guards can keep using the same singleton.
 *
 * `ToastProvider` wraps the session one because a session transition is a thing worth announcing, and
 * the ordering is cheaper to keep true than to discover later.
 */
function RootLayout() {
  return (
    <ToastProvider>
      <SessionProvider>
        <Outlet />
      </SessionProvider>
    </ToastProvider>
  );
}

/**
 * The global error boundary: the last line of defence for an error nothing else claimed.
 *
 * It prints the same three things every failure in this app has — what the server said, its code, and
 * the `requestId` worth pasting into a support note (docs/API.md) — and nothing else. No stack: a
 * person using their own notes cannot act on a minified frame, and PR-19's e2e reporter is where a
 * stack belongs.
 *
 * `error` arrives as `unknown`, which is why the fields are read through `instanceof`: an `ApiError`
 * (PR-05's client) has all three, any other `Error` has a message, and anything a component threw by
 * accident — a string, a proxy, a promise — still has to be answerable.
 */
export function RootError({ error, reset }: ErrorComponentProps) {
  const failure = error instanceof ApiError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return (
    <section className="flex flex-col gap-3" data-testid="route-error">
      <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
      <p className="text-ink-muted">{message}</p>
      <p className="text-sm text-ink-muted">
        {failure === undefined ? null : (
          <>
            <code className="text-danger">{failure.code}</code>
            {failure.requestId === undefined ? null : (
              <span>
                {' · '}request {failure.requestId}
              </span>
            )}
          </>
        )}
      </p>
      <div>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-paper-2"
        >
          Try again
        </button>
      </div>
    </section>
  );
}

/**
 * The global not-found boundary.
 *
 * With the `*` row of §4 redirecting every unknown path, this is only reachable when a route itself
 * says "no such thing" (PR-12's `/app/note/$id` will, for an id that is not in the tree). It is not a
 * redirect in disguise: arriving here means the *user* asked for something specific, and the honest
 * answer is that it is not here — a redirect to a page they did not ask for is how an app teaches
 * people not to trust its URLs.
 */
export function RootNotFound() {
  return (
    <section className="flex flex-col gap-3" data-testid="route-not-found">
      <h1 className="text-xl font-semibold text-ink">No such page</h1>
      <p className="text-ink-muted">
        Nothing in this instance answers that address. The notes are still where they were.
      </p>
    </section>
  );
}
