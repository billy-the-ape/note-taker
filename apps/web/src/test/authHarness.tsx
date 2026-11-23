/**
 * The auth-shaped half of the test harness (docs/plans/mvp/MVP-08.md §7).
 *
 * `bootAuth` is `renderApp` plus a stubbed auth API, because five files need the same eight routes and a
 * sixth that forgets two of them would fail for a reason that has nothing to do with what it is testing.
 * Out of the test files and in here for the same reason `renderApp` exists: the alternative is the same
 * table pasted until one copy drifts.
 *
 * The stub keeps a mutable `user`, so `POST /api/auth/logout` can genuinely end the session the way
 * §9.2 #6 does: after it answers, `GET /api/auth/session` says nobody is home. A harness whose session
 * stub never changed could not tell a real sign-out from one that only hid the form.
 */
import { ROUTES } from '@note-taker/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { expect, vi } from 'vitest';

import type { Reply, Stub } from './fakeApi';
import { fakeApi, sessionReply, sessionUser, statusReply } from './fakeApi';
import { renderApp } from './renderApp';

export const TEST_USERNAME = 'ada.lovelace';
/** Long enough to clear `passwordSchema`, so a failure means what it says. */
export const TEST_PASSWORD = 'correct horse battery';

export interface Installation {
  readonly needsSetup?: boolean;
  readonly registrationOpen?: boolean;
  readonly user?: ReturnType<typeof sessionUser> | null;
  /** What a credential call answers. Defaults to "yes, and here is your session". */
  readonly credentialReply?: () => Reply;
  /** What `POST /api/auth/logout` answers. */
  readonly logoutReply?: () => Reply;
  /**
   * Routes this boot deliberately does **not** answer, so `fakeApi`'s default `500 INTERNAL` fires. That
   * default is the closest a stubbed table gets to a server that is up and unhappy, which is what the
   * "the API could not answer" tests are about — leaving a route out silently would instead answer the
   * success case and make the test pass for the wrong reason.
   */
  readonly noReply?: readonly ('setup' | 'register' | 'login' | 'logout')[];
}

export interface BootedApp {
  readonly fake: ReturnType<typeof fakeApi>;
  readonly app: ReturnType<typeof renderApp>;
  readonly user: UserEvent;
}

/**
 * Stubs the auth endpoints and boots the app at `path`.
 *
 * `GET /api/auth/session` is served from the same mutable `user` the credential routes write, which is
 * what makes a sign-out test honest rather than optimistic: whatever the next navigation asks, the stub
 * answers with the truth this table has been told.
 */
export async function bootAuth(path: string, install: Installation = {}): Promise<BootedApp> {
  let user: ReturnType<typeof sessionUser> | null = install.user ?? null;
  let needsSetup = install.needsSetup ?? false;
  // An honest answer is not the same as an *available* answer: `setup` changes the install, and the
  // client only finds out by asking `GET /api/auth/status` again. The latch is consumed on the read, not
  // on the POST, so a client that keeps its 30-second cached answer (`staleTime`, and `ensureQueryData`
  // does not re-ask a fresh entry) keeps seeing `needsSetup: true` here exactly as it would in a browser.
  // Flipping the flag inside the credential reply instead — which the first version of this harness did
  // — is how that bug passed review once already.
  let mustReaskStatus = false;

  const credential: Stub = ({ path }) => {
    if (install.credentialReply !== undefined) return install.credentialReply();
    user = sessionUser({ username: TEST_USERNAME, role: needsSetup ? 'owner' : 'member' });
    // Only `setup` moves a status boolean: `login` cannot run before an owner exists, and `register`
    // requires one. The other two leave the install exactly as it was.
    if (path === ROUTES.auth.setup) mustReaskStatus = true;
    return { status: 200, body: { user } };
  };

  const answered = (name: 'setup' | 'register' | 'login' | 'logout'): boolean =>
    !(install.noReply ?? []).includes(name);

  const routes: Record<string, Stub> = {
    [`GET ${ROUTES.auth.status}`]: () => {
      // The read is what earns the new answer, and only the first read after the install moved.
      if (mustReaskStatus) {
        needsSetup = false;
        mustReaskStatus = false;
      }
      return statusReply(needsSetup, install.registrationOpen ?? false);
    },
    [`GET ${ROUTES.auth.session}`]: () => sessionReply(user),
  };
  if (answered('setup')) routes[`POST ${ROUTES.auth.setup}`] = credential;
  if (answered('register')) routes[`POST ${ROUTES.auth.register}`] = credential;
  if (answered('login')) routes[`POST ${ROUTES.auth.login}`] = credential;
  if (answered('logout')) {
    routes[`POST ${ROUTES.auth.logout}`] =
      install.logoutReply ??
      (() => {
        user = null;
        return { status: 204 };
      });
  }

  const fake = fakeApi(routes);
  // `lib/api.ts` reads `globalThis.fetch` at call time, so the module-level client the guards use goes
  // through this stub too — no injection, no `vi.mock`, and the real wrapper still runs.
  vi.stubGlobal('fetch', fake.fetch);

  const app = renderApp(path);
  // The guard awaits the boot pair in the root route's `beforeLoad`, so until that pair has answered the
  // router has nothing to render and every query in the calling test would fail against an empty `<div>`.
  // Waiting here rather than in each test is the point: a helper that hands back a half-booted app is a
  // helper that gets misused, and the assertion says which half of "booted" has to be true.
  await waitFor(() => expect(app.router.state.isLoading).toBe(false), { timeout: 3000 });

  return { fake, app, user: userEvent.setup() };
}

/** Fills the shared credential form's boxes and presses its button. */
export async function submitForm(
  user: UserEvent,
  mode: 'login' | 'setup' | 'signup',
  values: {
    readonly username?: string;
    readonly password?: string;
    readonly confirmPassword?: string;
  } = {},
) {
  if (values.username !== undefined) {
    await user.type(screen.getByTestId(`${mode}-username`), values.username);
  }
  if (values.password !== undefined) {
    await user.type(screen.getByTestId(`${mode}-password`), values.password);
  }
  if (values.confirmPassword !== undefined) {
    await user.type(screen.getByTestId(`${mode}-confirm`), values.confirmPassword);
  }
  await user.click(screen.getByTestId(`${mode}-submit`));
}

/** A failure in the envelope PR-05 defined, so a failure test fails the way the server fails. */
export function failure(
  status: number,
  code: string,
  message: string,
  extra: { readonly headers?: Readonly<Record<string, string>>; readonly details?: readonly unknown[] } = {},
): Reply {
  return {
    status,
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
    body: {
      error: {
        code,
        message,
        ...(extra.details === undefined ? {} : { details: extra.details }),
        requestId: 'req_test_0123456789abcdef0123456789abcd',
      },
    },
  };
}

/** The requests the fake recorded for one route, oldest first. */
export function callsTo(fake: ReturnType<typeof fakeApi>, path: string) {
  return fake.calls.filter((call) => call.path === path);
}
