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
    ['/welcome', AUTH_PATHS.login],
    ['/app', AUTH_PATHS.login],
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
    ['/welcome', AUTH_PATHS.setup],
    ['/app', AUTH_PATHS.setup],
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
    // sending anybody who already has a session to `/welcome`: the form would create a second account
    // and the response would replace the session they are using.
    const alsoSignedIn = authSnapshot({ ...openSignUp, user: sessionUser() });
    expect(alsoSignedIn.signupVisible).toBe(true);
    expect(decideNavigation('/signup', alsoSignedIn)).toEqual({
      kind: 'redirect',
      to: AUTH_PATHS.welcome,
    });
  });
});

describe('decideNavigation — signed in', () => {
  it.each([
    ['/welcome', 'allow'],
    ['/login', AUTH_PATHS.welcome],
    ['/setup', AUTH_PATHS.welcome],
    ['/signup', AUTH_PATHS.welcome],
    ['/', AUTH_PATHS.welcome],
    // PR-08 has no `/app` route, so an authed visitor who types it is on the `*` row and goes home —
    // which is the honest answer to a URL that does not exist yet. PR-12 gives `/app` its own layout
    // guard and this row stops applying to it.
    ['/app', AUTH_PATHS.welcome],
  ] as const)('%s → %s', (path, expected) => {
    expect(decideNavigation(path, signedIn)).toEqual(
      expected === 'allow' ? { kind: 'allow' } : { kind: 'redirect', to: expected },
    );
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
    const destinations = ['/', '/x', '/setup', '/login', '/signup', '/welcome', '/app', '//'] as const;
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
    expect(decideNavigation('/', signedIn)).toEqual({ kind: 'redirect', to: AUTH_PATHS.welcome });
    expect(homePathFor(fresh)).toBe(AUTH_PATHS.setup);
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
