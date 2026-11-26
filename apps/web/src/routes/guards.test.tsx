// @vitest-environment jsdom
/**
 * The guards, through the router (docs/plans/mvp/MVP-08.md §4, §7).
 *
 * `session.test.ts` proves the table; this proves the table is what the app actually runs. Everything
 * here goes through the same objects the browser would use — the generated route tree, the root route's
 * `beforeLoad`, the `QueryClient` singleton the guard reads, and the contract schemas on the way in — and
 * the assertions are about where the visitor ended up, which is the only thing a user can observe.
 *
 * Each test names the state of the install it is written in, because that is the whole difficulty of
 * §4: the same URL is legal or illegal depending on two booleans the server owns.
 */
import { ROUTES } from '@note-taker/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_PENDING_LABEL, AppPending } from '../components/layout/AppPending';
import { fakeApi, sessionReply, sessionUser, statusReply } from '../test/fakeApi';
import { renderApp } from '../test/renderApp';
import { makeTreeServer } from '../test/treeApi';

afterEach(() => vi.unstubAllGlobals());

/**
 * A tree for the guard tests, which are not about the tree.
 *
 * PR-12 made `/app` the signed-in home page, so a guard test that lands a signed-in visitor anywhere now
 * renders the sidebar, and the sidebar asks for a tree. Answering that with the fake's default `500` would
 * put a "could not load" panel in a test about passwords; these tests get an empty model, and the tree's own
 * behaviour is tested in `components/tree/`.
 */
function treeStubFor(initial: Parameters<typeof makeTreeServer>[0] = {}) {
  return makeTreeServer(initial).stub;
}

/** The two facts `GET /api/auth/status` reports, plus whatever the cookie says about this visitor. */
interface Install {
  readonly needsSetup: boolean;
  readonly registrationOpen: boolean;
  readonly user?: ReturnType<typeof sessionUser> | null;
}

/**
 * Boots the app at `path` against an install state and waits for the guard's verdict.
 *
 * The verdict is a *second* navigation — `beforeLoad` throws `redirect()` — so waiting on the location
 * rather than on a render is what makes this deterministic instead of racy. `waitFor` retries until the
 * router stops where it was supposed to, which means a wrong table entry fails this test by timing out
 * with the actual path in the diff, instead of passing because nothing had loaded yet.
 */
async function arriveAt(path: string, install: Install, landed: string) {
  const fake = fakeApi(
    {
      [`GET ${ROUTES.auth.status}`]: () => statusReply(install.needsSetup, install.registrationOpen),
      [`GET ${ROUTES.auth.session}`]: () => sessionReply(install.user ?? null),
    },
    { fallback: treeStubFor() },
  );
  vi.stubGlobal('fetch', fake.fetch);

  const app = renderApp(path);
  await waitFor(() => expect(app.router.state.location.pathname).toBe(landed), { timeout: 3000 });
  // …and it stayed: a page that rendered and was then redirected away would pass the check above.
  await waitFor(() => expect(app.router.state.isLoading).toBe(false), { timeout: 3000 });
  expect(app.router.state.location.pathname).toBe(landed);

  return { app, calls: fake.calls };
}

describe('an installed instance with registration closed (the default single-user box)', () => {
  it.each([
    ['/', '/login'],
    ['/welcome', '/login'],
    ['/app', '/login'],
    ['/setup', '/login'],
    ['/signup', '/login'],
    ['/notes/37', '/login'],
  ])('sends a stranger from %s to %s', async (from, to) => {
    await arriveAt(from, { needsSetup: false, registrationOpen: false }, to);
  });

  it('lets the sign-in page through', async () => {
    await arriveAt('/login', { needsSetup: false, registrationOpen: false }, '/login');
    // `queryBy*` rather than `getBy*`: the assertion is "it is there", and a query that throws would make
    // the failure message a stack trace instead of a null.
    expect(screen.queryByTestId('login-form')).not.toBeNull();
  });

  it('offers no sign-up link, because /signup can only answer 403', async () => {
    await arriveAt('/login', { needsSetup: false, registrationOpen: false }, '/login');
    expect(screen.queryByTestId('signup-link')).toBeNull();
  });
});

describe('a brand-new instance', () => {
  it.each([
    ['/', '/setup'],
    ['/welcome', '/setup'],
    ['/signup', '/setup'],
    ['/whatever', '/setup'],
  ])('sends a stranger from %s to %s', async (from, to) => {
    await arriveAt(from, { needsSetup: true, registrationOpen: false }, to);
  });

  it('leaves /login alone, because that page has one guard and they are not signed in', async () => {
    // The row that reads like a hole in §4: `/login` is guarded against being *authed*, not against a
    // fresh install. Somebody who bookmarked `/login` on day zero gets the form, presses the button, and
    // hears from the server what is actually missing — which beats a page they are not allowed to see.
    await arriveAt('/login', { needsSetup: true, registrationOpen: false }, '/login');
    expect(screen.queryByTestId('login-form')).not.toBeNull();
  });

  it('puts the first-run form on /setup', async () => {
    await arriveAt('/setup', { needsSetup: true, registrationOpen: false }, '/setup');
    expect(screen.queryByTestId('setup-form')).not.toBeNull();
  });

  it('still sends /signup to /setup when the operator turned the flag on early', async () => {
    // `ALLOW_REGISTRATION=true` on an empty instance is the case PR-07 warns about: `registrationOpen`
    // is true, and `POST /api/auth/register` would answer `403 SETUP_FIRST`.
    await arriveAt('/signup', { needsSetup: true, registrationOpen: true }, '/setup');
  });
});

describe('an installed instance with registration open (PR-07 closes this loop)', () => {
  it('lets a stranger stay on /signup, which is the point of the flag', async () => {
    await arriveAt('/signup', { needsSetup: false, registrationOpen: true }, '/signup');
    expect(screen.queryByTestId('signup-form')).not.toBeNull();
  });

  it('links to it from /login', async () => {
    await arriveAt('/login', { needsSetup: false, registrationOpen: true }, '/login');
    expect(screen.queryByTestId('signup-link')).not.toBeNull();
  });
});

describe('a signed-in visitor', () => {
  const ada = sessionUser({ username: 'ada.lovelace', role: 'owner' });

  it.each([
    ['/login', '/app'],
    ['/setup', '/app'],
    ['/signup', '/app'],
    ['/', '/app'],
    // PR-08 sent an authed visitor who typed `/app` to the placeholder; PR-12 deleted the placeholder, so this
    // row now answers "the bookmark of a page that no longer exists", and the answer is the app itself.
    ['/welcome', '/app'],
  ])('is not allowed to stay on %s', async (from, to) => {
    await arriveAt(from, { needsSetup: false, registrationOpen: true, user: ada }, to);
  });

  it('lets a signed-in visitor stay on /app, which is the row PR-12 inverted', async () => {
    // The table above cannot express this one: `arriveAt` asserts a *redirect* happened, and the verdict here
    // is that nothing happens. A guard whose `/app` row had been left pointing at `homePathFor` would answer
    // `/app` with a redirect to `/app`, which hangs the router rather than erroring — so it is worth a test
    // that fails loudly instead of a table row that never runs.
    const { app } = await arriveAt('/app', { needsSetup: false, registrationOpen: false, user: ada }, '/app');
    expect(app.router.state.location.pathname).toBe('/app');
    expect(screen.queryByTestId('app-shell')).not.toBeNull();
    expect(screen.queryByTestId('login-form')).toBeNull();
  });

  it('keeps the session across a refresh, which is a cookie and one GET', async () => {
    // The whole of "boot rehydration": what a refresh carries is the URL and an HttpOnly cookie, and
    // `GET /api/auth/session` is what turns the second back into the first. Nothing is stored in
    // `localStorage` to make this work, so a second tab or a fresh profile is the same story.
    const { app } = await arriveAt('/app', { needsSetup: false, registrationOpen: false, user: ada }, '/app');
    expect(await screen.findByTestId('app-shell')).not.toBeNull();
    expect(app.router.state.location.pathname).toBe('/app');
  });

  it('does not send a deep link it cannot render to the sign-in page', async () => {
    // The `/app` prefix is guarded as a unit (see `session.ts`), and PR-13 has not given a note its route yet.
    // So the honest answer to a bookmarked `/app/note/<id>` today is the not-found placeholder — and the row
    // that matters is that the guard let it through at all rather than bouncing a signed-in visitor to a form.
    const deep = '/app/note/019a3b4c-5d6e-7f80-9123-456789abcdef';
    const { app } = await arriveAt(deep, { needsSetup: false, registrationOpen: false, user: ada }, deep);
    expect(app.router.state.location.pathname).toBe(deep);
    expect(screen.queryByTestId('login-form')).toBeNull();
  });

  it('puts the signed-in person in the app, not on a page about being signed in', async () => {
    // The placeholder used to say "Welcome, ada.lovelace / signed in as the owner", and PR-12 deleted the
    // file. What the landing page says now is the app: the tree it loaded, the shell around it, and the name
    // in the top bar rather than in a heading.
    await arriveAt('/app', { needsSetup: false, registrationOpen: false, user: ada }, '/app');
    expect(await screen.findByTestId('tree')).not.toBeNull();
    expect(screen.getByTestId('topbar-user').textContent).toContain('ada.lovelace');
    expect(screen.queryByTestId('welcome')).toBeNull();
  });
});

describe('the boot pair', () => {
  it('asks each question once, whoever asked first', async () => {
    // The guard asks via `ensureQueryData` and the provider via `useQuery`. Without the shared cache
    // key this is four requests on every page load, which is the kind of thing nobody notices until
    // PR-12 doubles it again.
    const { calls } = await arriveAt('/login', { needsSetup: false, registrationOpen: false }, '/login');
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual([
      `GET ${ROUTES.auth.session}`,
      `GET ${ROUTES.auth.status}`,
    ]);
  });

  it('names the wait instead of leaving the shell blank while the pair is in flight', () => {
    // `main.tsx` wires `AppPending` as the router's `defaultPendingComponent`, and `renderApp` mirrors
    // that wiring. Asserted on its own, because the guard awaits in `beforeLoad`: during a cold boot the
    // router has no match to render yet, which is exactly the moment the shell has to say something.
    render(<AppPending />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(APP_PENDING_LABEL);
  });

  it('renders no page at all until the boot pair has answered', async () => {
    // The stub never settles, so this is the waiting itself rather than a fast failure wearing its
    // clothes: no form, no card, and a router that has not initialised.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    // `/app` is the guarded page now: PR-08 used `/welcome` to mean "a page a signed-in visitor would want",
    // and the app shell is that page, with the same `beforeLoad` awaiting the same pair.
    const app = renderApp('/app');
    await waitFor(() => expect(app.router.state.isLoading).toBe(true));

    // "Not initialised yet" in the vocabulary this router actually has: a pending transaction and an
    // empty match list, which is what leaves the shell nothing to draw but the pending component.
    expect(app.router.state.status).toBe('pending');
    expect(app.router.state.matches).toHaveLength(0);
    expect(screen.queryByTestId('login-form')).toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('lands on /login rather than lying about the install when the API is not there', async () => {
    // Not a swallowed bug: `readAuthSnapshot` falls back to "signed out, needs no setup", and `/login`
    // is the one page whose form can then explain a dead network by trying. No stubs at all, so every
    // route answers `500 INTERNAL`, which is as close to "nothing is listening" as a table gets.
    const fake = fakeApi({});
    vi.stubGlobal('fetch', fake.fetch);

    // `/app` again: the guard must answer from the fallback snapshot and redirect *before* the shell renders,
    // which is the moment PR-12 put a sidebar behind that guard.
    const app = renderApp('/app');
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'), { timeout: 5000 });
    // The notice is not instant, and the wait is the application's, not the test's: PR-05's client retries
    // a failed GET once with a second of backoff, so the pair is genuinely still being asked for a while
    // before `useSession` is allowed to call it a failure. Timing that out at the default second would
    // fail on the retry, which is the behaviour worth keeping.
    // The third argument is the wait; the second belongs to the query itself.
    expect(await screen.findByTestId('login-boot-failed', undefined, { timeout: 8000 })).not.toBeNull();
  });
});
