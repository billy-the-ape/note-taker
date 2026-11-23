/**
 * The session context, the boot read, and the one rule set every route guard shares
 * (docs/plans/mvp/MVP-08.md §5).
 *
 * **Where the state lives.** Server state stays in TanStack Query (plan §11.2): `authStatus` and
 * `authSession` are ordinary queries under the keys in `lib/queryClient.ts`, and the context below is
 * a *view* over them rather than a second copy of them. That is also what makes the route guards
 * possible: a `beforeLoad` is not a React render, so it cannot read a context — but it can ask the
 * same `QueryClient` for the same two entries, and `ensureQueryData` is how the provider and the guard
 * share one request each on boot. No bespoke session store and no module-level mutable session, which
 * is exactly what plan §11.2 rules out.
 *
 * **Boot rehydration.** A hard refresh of `/welcome` leaves a browser holding two facts: the URL and
 * an `HttpOnly` cookie. `GET /api/auth/session` (§9.2 #8) turns the second into the first, which is
 * why "refresh keeps the session" is an acceptance criterion for this file rather than for the login
 * form.
 *
 * **The guards.** `decideNavigation` is the pure table of the brief's §4; `guardNavigation` is the
 * three-line effect that awaits the boot and throws `redirect()`. Both are exported: the table is
 * unit-testable without a DOM, and PR-12 replaces the catch-all row with `routes/app/route.tsx` while
 * keeping the table.
 */
import type { AuthStatusResponse, SessionResponse, SessionUser } from '@note-taker/contracts';
import { type QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { redirect, useNavigate } from '@tanstack/react-router';
import { createContext, type ReactNode, useCallback, useEffect, useMemo } from 'react';

import { setUnauthorizedHandler } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/queryClient';
import { fetchAuthStatus, fetchSession, signOut as postLogout } from './auth.api';

/** Everything a guard needs: a name or nobody, and the two booleans that decide which page is legal. */
export interface AuthSnapshot {
  readonly user: SessionUser | null;
  readonly needsSetup: boolean;
  readonly registrationOpen: boolean;
  /**
   * `registrationOpen && !needsSetup` — the exact condition under which `/signup` is legal (§4), stated
   * once so the guard, the `/login` footer and PR-16's settings page cannot each derive it slightly
   * differently. Derived rather than fetched: the endpoint reports the two facts, never this conclusion.
   */
  readonly signupVisible: boolean;
}

/** Builds a snapshot from the three facts the API reports, deriving the fourth. */
export function authSnapshot(input: {
  readonly user: SessionUser | null;
  readonly needsSetup: boolean;
  readonly registrationOpen: boolean;
}): AuthSnapshot {
  return {
    user: input.user,
    needsSetup: input.needsSetup,
    registrationOpen: input.registrationOpen,
    signupVisible: input.registrationOpen && !input.needsSetup,
  };
}

/** What the status endpoint has not answered yet, and what an unreachable API is reported as.
 *
 * `needsSetup: false` is the safe reading of "no answer": guessing `true` would send a person with a
 * dead network to a first-run page, while `false` lands them on `/login`, where pressing the button
 * tells them what is actually wrong.
 */
export const UNKNOWN_STATUS: AuthStatusResponse = { needsSetup: false, registrationOpen: false };

/** The same idea for the session half of the boot. */
export const NO_SESSION: SessionResponse = { user: null };

/**
 * The snapshot a failed boot is read as: nobody signed in, nothing known about the install. Built from the
 * two fallbacks above rather than from the queries themselves — {@link UNKNOWN_STATUS} says why "nothing
 * known" reads as `needsSetup: false` and not `true`.
 */
export const SIGNED_OUT_SNAPSHOT: AuthSnapshot = authSnapshot({
  user: null,
  needsSetup: false,
  registrationOpen: false,
});

/** The four paths this PR owns, in one place, so the table and the route files cannot disagree. */
export const AUTH_PATHS = {
  setup: '/setup',
  login: '/login',
  signup: '/signup',
  welcome: '/welcome',
} as const;

export type AuthPath = (typeof AUTH_PATHS)[keyof typeof AUTH_PATHS];

/** Where "home" is right now: signed in means `/welcome`; a fresh install means `/setup`. */
export function homePathFor(snapshot: AuthSnapshot): AuthPath {
  if (snapshot.user !== null) return AUTH_PATHS.welcome;
  return snapshot.needsSetup ? AUTH_PATHS.setup : AUTH_PATHS.login;
}

export type NavigationDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'redirect'; readonly to: AuthPath };

const ALLOW: NavigationDecision = { kind: 'allow' };

/**
 * The route table of docs/plans/mvp/MVP-08.md §4, as a function of the snapshot alone.
 *
 * Two rows are worth the comment:
 *
 * * `/signup` needs **both** `registrationOpen` and `!needsSetup`. PR-07 answers `403` at
 *   `POST /api/auth/register` in either case, and this is the same rule one moment earlier. The
 *   *combination* that matters is flag-on-and-nobody-installed-yet — it is what
 *   `ALLOW_REGISTRATION=true` in a compose file produces — and without `!needsSetup` the UI would
 *   offer a link whose form can only ever answer 403, because `setup` has not run.
 * * `/setup` is open **only** while `needsSetup`: `POST /api/auth/setup` answers `409` once an owner
 *   exists, so a reachable second-run `/setup` is a form whose every outcome is an error.
 *
 * Stripping trailing slashes is the whole path normalisation — these four are the entire vocabulary,
 * and `/login/` is the same page as `/login`.
 */
export function decideNavigation(pathname: string, snapshot: AuthSnapshot): NavigationDecision {
  const path = pathname.replace(/\/+$/, '') || '/';

  switch (path) {
    case AUTH_PATHS.setup:
      // Second run: an authed visitor goes home, everybody else goes to the sign-in page.
      return snapshot.needsSetup ? ALLOW : { kind: 'redirect', to: homePathFor(snapshot) };

    case AUTH_PATHS.login:
      // Never a page you stay on once you are signed in — the criterion PR-08 is named for.
      return snapshot.user === null ? ALLOW : { kind: 'redirect', to: AUTH_PATHS.welcome };

    case AUTH_PATHS.signup:
      // An authed visitor is not who this page is for. §4's row is about the two booleans, and a
      // signed-in person on a "create a member" form satisfies them both on an open instance — but the
      // form creates a *second* account and the response would replace the session they already have,
      // so the honest destination is the home they were on. §4's `*` row says the same thing for every
      // other path.
      if (snapshot.user !== null) return { kind: 'redirect', to: AUTH_PATHS.welcome };
      // …then the derived flag, so the link and this guard cannot disagree about what "open" means.
      if (snapshot.signupVisible) return ALLOW;
      return { kind: 'redirect', to: snapshot.needsSetup ? AUTH_PATHS.setup : AUTH_PATHS.login };

    case AUTH_PATHS.welcome:
      return snapshot.user === null ? { kind: 'redirect', to: homePathFor(snapshot) } : ALLOW;

    default:
      // The `*` row, and the only redirect not obvious from the path: `/`, a typo, the remains of a
      // deleted route. PR-12 replaces this row for `/app/...` with `routes/app/route.tsx`.
      return { kind: 'redirect', to: homePathFor(snapshot) };
  }
}

/** The two boot queries, shared by the provider (`useQuery`) and the guards (`ensureQueryData`). */
export function authStatusOptions() {
  return queryOptions({ queryKey: queryKeys.authStatus, queryFn: fetchAuthStatus });
}

export function authSessionOptions() {
  return queryOptions({ queryKey: queryKeys.authSession, queryFn: fetchSession });
}

/**
 * Reads both boot facts, priming the cache on the way.
 *
 * Concurrent callers share one pair of requests, which matters in `StrictMode` (where effects mount
 * twice) and on a refresh, where the guard and the provider would otherwise each fetch. Throws with
 * whatever `fetch`/`ApiError` said — see {@link readAuthSnapshot} for the guard's fallback.
 */
export async function loadAuthSnapshot(client: QueryClient): Promise<AuthSnapshot> {
  const [status, session] = await Promise.all([
    client.ensureQueryData(authStatusOptions()),
    client.ensureQueryData(authSessionOptions()),
  ]);
  return snapshotOf(status, session);
}

/** As {@link loadAuthSnapshot}, but a failure is answered rather than thrown. */
export async function readAuthSnapshot(client: QueryClient): Promise<AuthSnapshot> {
  try {
    return await loadAuthSnapshot(client);
  } catch {
    return SIGNED_OUT_SNAPSHOT;
  }
}

function snapshotOf(status: AuthStatusResponse, session: SessionResponse): AuthSnapshot {
  return authSnapshot({
    user: session.user,
    needsSetup: status.needsSetup,
    registrationOpen: status.registrationOpen,
  });
}

/**
 * The guard every route of this PR runs. It lives here rather than in each page so the four rules
 * cannot be applied by three of them and forgotten in the fourth.
 *
 * `redirect()` is *thrown*, which is how TanStack Router abandons this navigation and starts the other
 * one. The destination is one of four literals, so a wrong table entry is a type error here rather
 * than a redirect to a path that renders nothing at all.
 */
export async function guardNavigation(pathname: string): Promise<void> {
  const decision = decideNavigation(pathname, await readAuthSnapshot(queryClient));
  if (decision.kind === 'redirect') throw redirect({ to: decision.to, replace: true });
}

/** What `useSession()` hands a component. There are three ways to change anything, on purpose. */
export interface SessionContextValue {
  readonly snapshot: AuthSnapshot;
  readonly user: SessionUser | null;
  readonly isAuthed: boolean;
  /** Until the boot pair has answered: the routes render a spinner rather than a guess. */
  readonly isBooting: boolean;
  /** The boot could not be completed, so nothing about this install is known. */
  readonly bootFailed: boolean;
  /** Records a `setup`/`register`/`login` answer into the same cache entry the guards read. */
  readonly setUser: (user: SessionUser | null) => void;
  /**
   * Re-reads `GET /api/auth/status`, and waits for the answer. Called by `/setup` once its owner exists:
   * `needsSetup` is a fact about the install rather than about this tab, and the cache holds it for
   * `staleTime`, so the page that changed it is the one page that has to say so.
   */
  readonly refreshStatus: () => Promise<void>;
  /** `POST /api/auth/logout`, then forgets every cached query, then routes to `/login`. Rejects on failure. */
  readonly signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const client = useQueryClient();
  const navigateTo = useNavigate();

  const statusQuery = useQuery(authStatusOptions());
  const sessionQuery = useQuery(authSessionOptions());

  const snapshot = snapshotOf(statusQuery.data ?? UNKNOWN_STATUS, sessionQuery.data ?? NO_SESSION);
  const isBooting = statusQuery.isPending || sessionQuery.isPending;
  const bootFailed = statusQuery.isError || sessionQuery.isError;

  const setUser = useCallback(
    (user: SessionUser | null) => {
      // `setQueryData`, not a mutation's return value: this cache entry *is* the session now, so the
      // next guard run sees the signed-in user without a round-trip — while a refresh still re-reads
      // the row (§9.2 #8) instead of trusting this tab's memory.
      client.setQueryData<SessionResponse>(queryKeys.authSession, user === null ? NO_SESSION : { user });
    },
    [client],
  );

  const refreshStatus = useCallback(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.authStatus });
  }, [client]);

  const signOut = useCallback(async () => {
    // Throws on failure and the caller shows the server's words. Clearing local state *before* this
    // answered would leave a person who is still signed in looking at a signed-out app.
    await postLogout();
    // Everything cached belonged to this user (`tree`, `settings`, …), so all of it goes — the
    // `queryClient.ts` comment about per-user keys is about exactly this moment.
    client.clear();
    await navigateTo({ to: AUTH_PATHS.login, replace: true });
  }, [client, navigateTo]);

  const value = useMemo<SessionContextValue>(
    () => ({
      snapshot,
      user: snapshot.user,
      isAuthed: snapshot.user !== null,
      isBooting,
      bootFailed,
      setUser,
      refreshStatus,
      signOut,
    }),
    [snapshot, isBooting, bootFailed, setUser, refreshStatus, signOut],
  );

  // PR-05's 401 hook, wired once (docs/plans/mvp/MVP-08.md §5): any query or mutation that finds the
  // session gone is the same event whoever noticed it, and the answer is to stop pretending to be
  // signed in. `lib/api.ts` deliberately does not know what a route is, so the route lives here.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.setQueryData<SessionResponse>(queryKeys.authSession, NO_SESSION);
      const status = client.getQueryData<AuthStatusResponse>(queryKeys.authStatus);
      void navigateTo({ to: status?.needsSetup ? AUTH_PATHS.setup : AUTH_PATHS.login, replace: true });
    });
    return () => setUnauthorizedHandler(undefined);
  }, [client, navigateTo]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
