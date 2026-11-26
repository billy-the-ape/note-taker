/**
 * The redirect table, as data (docs/plans/mvp/MVP-08.md §4, §7).
 *
 * This file is the cheap half of the guard tests and the reason the suite can claim to have tested the
 * matrix at all: four paths × signed-out/signed-in × needsSetup × registrationOpen is sixteen rows, and
 * rendering a router sixteen times to check what is, at bottom, a lookup would be slower to read and no
 * more convincing. `routes/guards.test.tsx` proves the table is *wired* to the router; this proves the
 * table says what the brief says — including the two rows that are easy to get wrong and are named in
 * their own tests below.
 *
 * Runs with no DOM: `decideNavigation` is a function of two arguments, and that is why it was written as
 * one.
 */

import { ROUTES } from '@note-taker/contracts';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, sessionReply, sessionUser, statusReply } from '../../test/fakeApi';
import {
  AUTH_PATHS,
  authSnapshot,
  decideNavigation,
  homePathFor,
  loadAuthSnapshot,
  readAuthSnapshot,
  SIGNED_OUT_SNAPSHOT,
} from './session';

const ANONYMOUS = { user: null, needsSetup: false, registrationOpen: false };
const ADA = {
  user: sessionUser({ username: 'ada.lovelace', role: 'owner' }),
  needsSetup: false,
  registrationOpen: false,
};

/** The four states a page can be judged in — the whole input space of §4's table. */
const fresh = authSnapshot({ ...ANONYMOUS, needsSetup: true });
const secondRun = authSnapshot(ANONYMOUS);
const openSignUp = authSnapshot({ ...ANONYMOUS, registrationOpen: true });
const signedIn = authSnapshot(ADA);

describe('authSnapshot (the derived flag)', () => {
  it('offers /signup only when registration is open *and* somebody is installed', () => {
    expect(fresh.signupVisible).toBe(false);
    expect(openSignUp.signupVisible).toBe(true);
    expect(secondRun.signupVisible).toBe(false);
    // A flag the operator turned on is not the same as a form that can answer: `POST
    // /api/auth/register` refuses with `403 SETUP_FIRST` while there is no owner.
    expect(authSnapshot({ ...ANONYMOUS, needsSetup: true, registrationOpen: true }).signupVisible).toBe(
      false,
    );
  });
});

describe('decideNavigation — signed out, second run', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['/', AUTH_PATHS.login],
    ['/login', 'allow'],
    ['/setup', AUTH_PATHS.login],
    ['/signup', AUTH_PATHS.login],
    // PR-12's criterion, in table form: `/app` is guarded, and a stranger who types it gets the sign-in page
    // rather than an empty shell. `/welcome` is here too now that the file is deleted — it is on the `*` row,
    // and the bookmark of a removed page should still find its way to a form.
    ['/welcome', AUTH_PATHS.login],
    ['/app', AUTH_PATHS.login],
    ['/app/note/019a3b4c-5d6e-7f80-9123-456789abcdef', AUTH_PATHS.login],
    ['/notes/whatever', AUTH_PATHS.login],
  ] as const;

  it.each(cases)('%s → %s', (path, expected) => {
    expect(decideNavigation(path, secondRun)).toEqual(
      expected === 'allow' ? { kind: 'allow' } : { kind: 'redirect', to: expected },
    );
  });
});

describe('decideNavigation — signed out, fresh install', () => {
  it.each([
    ['/', AUTH_PATHS.setup],
    ['/setup', 'allow'],
    // The row that reads like a hole: §4 gives `/login` one guard, "redirect away when authed", and
    // *not* "only when `!needsSetup`". A fresh install whose cookie is empty therefore keeps the form,
    // presses the button, and learns from the server what is actually missing — whereas `/` and every
    // other path send them to the first-run page. Being strict here would mean a page nobody may see.
    ['/login', 'allow'],
    // A fresh install gets the first-run page from `/app` too, not the app's own guard: `homePathFor` is the
    // one place that knows `/setup` and `/login` are the two answers.
    ['/welcome', AUTH_PATHS.setup],
    ['/app', AUTH_PATHS.setup],
    ['/app/settings', AUTH_PATHS.setup],
  ] as const)('%s → %s', (path, expected) => {
    expect(decideNavigation(path, fresh)).toEqual(
      expected === 'allow' ? { kind: 'allow' } : { kind: 'redirect', to: expected },
    );
  });

  it('sends a fresh install to /setup even when the flag has registration open', () => {
    // The row PR-07 warns about: `ALLOW_REGISTRATION=true` alone makes `registrationOpen` true on a
    // brand-new instance, and a sign-up form there can only answer 403 SETUP_FIRST.
    const flagOnButEmpty = authSnapshot({
      ...ANONYMOUS,
      needsSetup: true,
      registrationOpen: true,
    });
    expect(decideNavigation('/signup', flagOnButEmpty)).toEqual({
      kind: 'redirect',
      to: AUTH_PATHS.setup,
    });
  });
});

describe('decideNavigation — registration open, one account installed', () => {
  it('lets /signup through, which is the whole loop PR-07 opens', () => {
    expect(decideNavigation('/signup', openSignUp)).toEqual({ kind: 'allow' });
  });

  it('sends a signed-in visitor home, even though the two booleans say the page is legal', () => {
    // §4 writes this row as a condition on the install, not on the visitor. Both are respected by
    // sending anybody who already has a session to `/app`: the form would create a second account
    // and the response would replace the session they are using.
    const alsoSignedIn = authSnapshot({ ...openSignUp, user: sessionUser() });
    expect(alsoSignedIn.signupVisible).toBe(true);
    expect(decideNavigation('/signup', alsoSignedIn)).toEqual({
      kind: 'redirect',
      to: AUTH_PATHS.app,
    });
  });
});

describe('decideNavigation — signed in', () => {
  it.each([
    // PR-12 deleted `/welcome` and `/app` became the home, so the two rows swapped places from PR-08's:
    // the app's own URL is now stay-able and the placeholder's is a bookmark of nothing.
    ['/app', 'allow'],
    ['/login', AUTH_PATHS.app],
    ['/setup', AUTH_PATHS.app],
    ['/signup', AUTH_PATHS.app],
    ['/', AUTH_PATHS.app],
    ['/welcome', AUTH_PATHS.app],
  ] as const)('%s → %s', (path, expected) => {
    expect(decideNavigation(path, signedIn)).toEqual(
      expected === 'allow' ? { kind: 'allow' } : { kind: 'redirect', to: expected },
    );
  });

  it.each([
    '/app/',
    '/app/note/019a3b4c-5d6e-7f80-9123-456789abcdef',
    '/app/settings',
    '/app/search',
  ] as const)('lets the %s subtree through, because the guard is a prefix and not a page', (path) => {
    // PR-13 adds `/app/note/$id`, PR-16 `settings`, PR-17 `search`. A table that matched `/app` exactly
    // would put each of them on the `*` row and send a signed-in visitor out of the app they were in — and
    // it would do it only for the children, so the test that visits `/app` would pass.
    expect(decideNavigation(path, signedIn)).toEqual({ kind: 'allow' });
  });

  it('does not mistake /apple for /app', () => {
    // The other half of the prefix row: a match on the *string* `/app` inside a path would let the guard
    // wave through URLs that are not under the app at all.
    expect(decideNavigation('/apple', signedIn)).toEqual({ kind: 'redirect', to: AUTH_PATHS.app });
    expect(decideNavigation('/apple', secondRun)).toEqual({ kind: 'redirect', to: AUTH_PATHS.login });
  });
});

describe('decideNavigation — the small print', () => {
  it('treats /login/ and /login as the same page', () => {
    expect(decideNavigation('/login/', secondRun)).toEqual({ kind: 'allow' });
    expect(decideNavigation('/welcome/', secondRun)).toEqual({
      kind: 'redirect',
      to: AUTH_PATHS.login,
    });
  });

  it('never redirects to a path it has not named', () => {
    // `to` is a union of four literals, so this is a type-level guarantee too; it is written down
    // because a table that grew a fifth destination would otherwise be a 404 with extra steps.
    const destinations = [
      '/',
      '/x',
      '/setup',
      '/login',
      '/signup',
      '/welcome',
      '/app',
      '/app/settings',
      '//',
    ] as const;
    for (const snapshot of [fresh, secondRun, openSignUp, signedIn]) {
      for (const path of destinations) {
        const decision = decideNavigation(path, snapshot);
        if (decision.kind === 'redirect') {
          expect(Object.values(AUTH_PATHS)).toContain(decision.to);
        }
      }
    }
  });

  it('a bare slash is not a path that can be stayed on', () => {
    expect(decideNavigation('/', signedIn)).toEqual({ kind: 'redirect', to: AUTH_PATHS.app });
    expect(homePathFor(fresh)).toBe(AUTH_PATHS.setup);
    // PR-12: home for a signed-in visitor is the app, and that is the one place this assertion is the whole
    // answer — every redirect in the app goes through this helper.
    expect(homePathFor(signedIn)).toBe(AUTH_PATHS.app);
  });
});

describe('loadAuthSnapshot / readAuthSnapshot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads both boot facts and assembles one snapshot', async () => {
    const fake = fakeApi({
      [`GET ${ROUTES.auth.status}`]: () => statusReply(false, true),
      [`GET ${ROUTES.auth.session}`]: () => sessionReply(sessionUser()),
    });
    vi.stubGlobal('fetch', fake.fetch);

    const client = new QueryClient();
    await expect(loadAuthSnapshot(client)).resolves.toEqual({
      user: expect.objectContaining({ username: 'ada.lovelace' }),
      needsSetup: false,
      registrationOpen: true,
      signupVisible: true,
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('shares one pair of requests between concurrent callers', async () => {
    // The guard and the provider both ask on boot, and `StrictMode` mounts the provider twice. Without
    // `ensureQueryData` this is four requests for two facts.
    const fake = fakeApi({
      [`GET ${ROUTES.auth.status}`]: () => statusReply(false, false),
      [`GET ${ROUTES.auth.session}`]: () => sessionReply(null),
    });
    vi.stubGlobal('fetch', fake.fetch);

    const client = new QueryClient();
    await Promise.all([loadAuthSnapshot(client), loadAuthSnapshot(client)]);
    expect(fake.calls).toHaveLength(2);
  });

  it('answers "nobody is signed in, nothing is known" when the API is not there', async () => {
    // Not a swallowed bug: the guard still has to land the visitor somewhere, and `/login` is the only
    // page whose form can explain a dead network by trying.
    const client = new QueryClient();
    await expect(readAuthSnapshot(client)).resolves.toEqual(SIGNED_OUT_SNAPSHOT);
  });

  it('lets the caller who wants the reason have the reason', async () => {
    const client = new QueryClient();
    await expect(loadAuthSnapshot(client)).rejects.toBeDefined();
  });
});
