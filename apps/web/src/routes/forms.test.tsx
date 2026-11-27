// @vitest-environment jsdom
/**
 * The three credential pages and the way out (docs/plans/mvp/MVP-08.md §6, §7).
 *
 * These are the acceptance criteria the brief names, run through the real router: the first-run form
 * creates the owner and lands on `/app`; `/signup` only exists when the server says it may; a wrong
 * password costs a click and not the password; `429` says when to come back; a `400` puts each complaint
 * under the input it came from; and signing out really ends the session.
 *
 * Everything is queried by label or `data-testid` — the same handles PR-19's Playwright specs will use —
 * and every failure assertion is about the server's own words rather than a paraphrase of them. The
 * harness that boots the app against a stubbed API is `test/authHarness.tsx`, shared with the guard tests.
 */
import { PASSWORD_EQUALS_USERNAME_MESSAGE, ROUTES, registerSchema } from '@note-taker/contracts';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIRM_MISMATCH_MESSAGE,
  REQUIRED_PASSWORD_MESSAGE,
  REQUIRED_USERNAME_MESSAGE,
} from '../features/auth/auth.api';
import { bootAuth, callsTo, failure, submitForm, TEST_PASSWORD, TEST_USERNAME } from '../test/authHarness';
import { sessionUser } from '../test/fakeApi';

/**
 * Three tiny readers, because this suite does not install `@testing-library/jest-dom` (it is not a
 * dependency of `apps/web`, and PR-05's tests set the house style of plain assertions). Everything below
 * is still about the attribute a reader uses, not about a class list somebody has to notice.
 */
function attributeOf(testId: string, name: string): string | null {
  return screen.getByTestId(testId).getAttribute(name);
}

function typedValue(testId: string): string {
  return (screen.getByTestId(testId) as HTMLInputElement).value;
}

function textOf(element: Element | null): string {
  return element?.textContent ?? '';
}

// `bootAuth` stubs `globalThis.fetch`; leaving it stubbed would let one test answer another's questions.
afterEach(() => vi.unstubAllGlobals());

describe('/setup — the first-run bootstrap', () => {
  it('creates the owner and lands on /app', async () => {
    const { fake, app, user } = await bootAuth('/setup', { needsSetup: true });

    // The confirmation is part of the form even though the server never sees it (§6): leave it out and
    // the page refuses to submit, which is the right answer but not the one this test is describing.
    await submitForm(user, 'setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    const request = callsTo(fake, ROUTES.auth.setup)[0];
    expect(request?.method).toBe('POST');
    // The body is exactly `registerSchema`: no confirm field, no display name, nothing the server has to
    // forgive. A stray `confirmPassword` here would be a `400` the moment it is rejected strictly.
    expect(request?.body).toEqual({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(screen.queryByTestId('app-shell')).not.toBeNull();

    // The install moved, and only asking again learns that: `needsSetup` is held for `staleTime` and
    // `guardNavigation` reads it through `ensureQueryData`, which answers a fresh entry rather than
    // re-asking. The boot pair made the first read; a form that never made the second one would keep
    // sending its own owner back to `/setup`.
    expect(callsTo(fake, ROUTES.auth.status).length).toBeGreaterThanOrEqual(2);
  });

  it('trims the username on the way out without touching the box', async () => {
    const { fake, app, user } = await bootAuth('/setup', { needsSetup: true });

    await submitForm(user, 'setup', {
      username: `  ${TEST_USERNAME}  `,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    const body = callsTo(fake, ROUTES.auth.setup)[0]?.body as { username: string };
    expect(body.username).toBe(TEST_USERNAME);
  });

  it('closes /setup behind itself, rather than staying open for 30 seconds', async () => {
    // The install moved, and this is the consequence: §4's `/setup` row is `needsSetup ? ALLOW : home`, so
    // an app still holding the pre-setup answer lets its own owner sit on a form whose every submit is now
    // `409 SETUP_ALREADY_DONE`. The fake keeps answering `needsSetup: true` until the client asks again, so
    // this navigation is only honest if the form re-read the status on the way out.
    const { app, user } = await bootAuth('/setup', { needsSetup: true });

    await submitForm(user, 'setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    await app.router.navigate({ to: '/setup', replace: true });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'), { timeout: 3000 });
    expect(screen.queryByTestId('setup-form')).toBeNull();
  });

  it('does not send an expired session to /setup once the owner exists', async () => {
    // The other half of the same stale flag: `SessionProvider`'s 401 handler routes by
    // `status?.needsSetup`, so a cache that still says "nothing installed here" answers a session that
    // went away with the one page that cannot help — and it does so for 30 seconds, without a reload.
    const { app, user } = await bootAuth('/setup', {
      needsSetup: true,
      // The session is gone by the time the sign-out arrives, which is how a `401` happens for real.
      logoutReply: () => failure(401, 'UNAUTHORIZED', 'the session row is gone'),
    });

    await submitForm(user, 'setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    await user.click(screen.getByTestId('sign-out'));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'), { timeout: 3000 });
    expect(screen.queryByTestId('setup-form')).toBeNull();
  });

  it('asks for a confirmation the server never sees, and refuses a mismatch before sending', async () => {
    const { fake, user } = await bootAuth('/setup', { needsSetup: true });

    await submitForm(user, 'setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      confirmPassword: 'typo horse battery',
    });

    expect(await screen.findByText(CONFIRM_MISMATCH_MESSAGE)).not.toBeNull();
    expect(attributeOf('setup-confirm', 'aria-invalid')).toBe('true');
    // Nothing left the page: this is the one rule with no schema behind it, because the field is never sent.
    expect(callsTo(fake, ROUTES.auth.setup)).toHaveLength(0);
  });

  it('runs the shared schema before sending, so the browser refuses what the server would', async () => {
    const { fake, user } = await bootAuth('/setup', { needsSetup: true });

    await submitForm(user, 'setup', { username: 'ad', password: 'short1234' });

    // The expected message is read out of `registerSchema` rather than typed here, so this test still
    // means something on the day the contract moves.
    const parsed = registerSchema.safeParse({ username: 'ad', password: 'short1234' });
    const expected = parsed.error?.issues.find((issue) => issue.path[0] === 'username')?.message;
    expect(expected).toBeDefined();
    expect(await screen.findByText(expected ?? '')).not.toBeNull();
    expect(callsTo(fake, ROUTES.auth.setup)).toHaveLength(0);
  });

  it('names the password manager the right hint for a secret being chosen', async () => {
    await bootAuth('/setup', { needsSetup: true });
    // `new-password` on both boxes: the confirmation is the second half of one secret, and a manager that
    // fills only one of them manufactures the mismatch above.
    expect(attributeOf('setup-username', 'autocomplete')).toBe('username');
    expect(attributeOf('setup-password', 'autocomplete')).toBe('new-password');
    expect(attributeOf('setup-confirm', 'autocomplete')).toBe('new-password');
  });
});

describe('/signup — self-sign-up, when it is open', () => {
  it('creates a member and lands on /app', async () => {
    const { fake, app, user } = await bootAuth('/signup', { registrationOpen: true });

    await submitForm(user, 'signup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    expect(callsTo(fake, ROUTES.auth.register)).toHaveLength(1);
    // A `member` is all this page can create, and there is deliberately no control here that looks like a
    // role picker (docs/plans/mvp/MVP-07.md: promotion is an operator act).
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('refuses a password that is too short, or is the username, without asking the server', async () => {
    const { fake, user } = await bootAuth('/signup', { registrationOpen: true });

    const clear = async () => {
      for (const testId of ['signup-username', 'signup-password', 'signup-confirm']) {
        await user.clear(screen.getByTestId(testId));
      }
    };

    await submitForm(user, 'signup', {
      username: TEST_USERNAME,
      password: 'short1234',
      confirmPassword: 'short1234',
    });
    // Read out of the schema rather than typed, so the assertion still means something when the contract
    // moves — and `password` specifically, because a two-issue form would otherwise pass on either.
    const tooShort = registerSchema.safeParse({ username: TEST_USERNAME, password: 'short1234' });
    const expected = tooShort.error?.issues.find((issue) => issue.path[0] === 'password')?.message;
    expect(expected).toBeDefined();
    expect(await screen.findByText(expected ?? '')).not.toBeNull();
    expect(callsTo(fake, ROUTES.auth.register)).toHaveLength(0);

    await clear();
    await submitForm(user, 'signup', {
      username: TEST_USERNAME,
      password: TEST_USERNAME,
      confirmPassword: TEST_USERNAME,
    });
    // The equality rule is PR-07's server-side refinement mirrored here: the message is the app's, so it
    // can be shown a keystroke before the request that would have been refused.
    expect(await screen.findByText(PASSWORD_EQUALS_USERNAME_MESSAGE)).not.toBeNull();
    expect(callsTo(fake, ROUTES.auth.register)).toHaveLength(0);
  });

  it('links back to /login', async () => {
    await bootAuth('/signup', { registrationOpen: true });
    expect(screen.queryByTestId('login-link')).not.toBeNull();
  });
});

describe('/login', () => {
  it('signs an existing user in', async () => {
    // Nobody is signed in to start with — that is the state `/login` is legal in — and the credential
    // route is what hands the session over.
    const { fake, app, user } = await bootAuth('/login', {
      credentialReply: () => ({ status: 200, body: { user: sessionUser() } }),
    });

    await submitForm(user, 'login', { username: TEST_USERNAME, password: TEST_PASSWORD });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app'));

    expect(callsTo(fake, ROUTES.auth.login)[0]?.body).toEqual({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
  });

  it('offers the password manager the hint for a secret being used', async () => {
    await bootAuth('/login');
    // `current-password` on the way in, `new-password` on the way out. Backwards, and the sign-in page
    // fights the user's own tooling instead of helping it (docs/plans/mvp/MVP-08.md §6).
    expect(attributeOf('login-username', 'autocomplete')).toBe('username');
    expect(attributeOf('login-password', 'autocomplete')).toBe('current-password');
    // The other half of the same criterion: a placeholder is not a label, and a password box whose label
    // is only in the CSS cannot be reached by a password manager or a screen reader.
    expect(screen.getByLabelText('Password')).toBe(screen.getByTestId('login-password'));
    // A sign-in page with a third box would be a bug: the confirmation is never sent.
    expect(screen.queryByTestId('login-confirm')).toBeNull();
  });

  it('keeps what was typed when the answer is no', async () => {
    const { fake, user } = await bootAuth('/login', {
      credentialReply: () => failure(401, 'UNAUTHORIZED', 'wrong username or password'),
    });

    await submitForm(user, 'login', { username: TEST_USERNAME, password: 'wrong but memorable' });

    // The server's own sentence, inline: "invalid credentials" would be a paraphrase of a decision
    // somebody else made, and a person cannot act on a paraphrase.
    expect(textOf(await screen.findByTestId('login-error'))).toContain('wrong username or password');
    expect(typedValue('login-password')).toBe('wrong but memorable');
    expect(typedValue('login-username')).toBe(TEST_USERNAME);
    // …and as a toast, because a form scrolled out of view is not an announcement.
    expect(textOf(await screen.findByTestId('toast-error'))).toContain('Sign in failed');
    expect(callsTo(fake, ROUTES.auth.login)).toHaveLength(1);
  });

  it('says when to come back once the window is full', async () => {
    const { user } = await bootAuth('/login', {
      credentialReply: () =>
        failure(429, 'RATE_LIMITED', 'too many attempts, slow down', {
          headers: { 'retry-after': '45' },
        }),
    });

    await submitForm(user, 'login', { username: TEST_USERNAME, password: TEST_PASSWORD });

    // `Retry-After` is the one number in the error contract that arrives as a header, and without it
    // "try again later" is a guess about when later is.
    const message = await screen.findByTestId('login-error');
    expect(textOf(message)).toContain('too many attempts, slow down');
    expect(textOf(message)).toContain('try again in 45s');
  });

  it('puts a server-side complaint under the input it came from', async () => {
    const { user } = await bootAuth('/login', {
      credentialReply: () =>
        failure(400, 'VALIDATION', 'the form is not valid', {
          details: [{ path: 'username', message: 'must be at least 3 characters' }],
        }),
    });

    await submitForm(user, 'login', { username: 'ad', password: TEST_PASSWORD });

    // The client only asks for both halves (§9.2 #5 is permissive on purpose), so this one arrived from
    // the server and has to be rendered as such — under the box, in the server's words.
    expect(await screen.findByText('must be at least 3 characters')).not.toBeNull();
    expect(attributeOf('login-username', 'aria-invalid')).toBe('true');
  });

  it('refuses to send an empty form, in words a person can act on', async () => {
    const { fake, user } = await bootAuth('/login');

    await user.click(screen.getByTestId('login-submit'));

    expect(await screen.findByText(REQUIRED_USERNAME_MESSAGE)).not.toBeNull();
    expect(screen.getByText(REQUIRED_PASSWORD_MESSAGE)).not.toBeNull();
    expect(callsTo(fake, ROUTES.auth.login)).toHaveLength(0);
  });

  it('says so when the API cannot answer, rather than blaming the password', async () => {
    // `noReply` leaves `POST /api/auth/login` out of the table, so the fake answers its default `500`
    // envelope — as close as a stub gets to a server that is up and unhappy. `lib/api.ts` still throws an
    // `ApiError`, so the page shows what came back instead of a spinner that never ends, and it does not
    // say anything about the password, which is the difference between a clue and a lie.
    const { user } = await bootAuth('/login', { noReply: ['login'] });
    await submitForm(user, 'login', { username: TEST_USERNAME, password: TEST_PASSWORD });

    expect(textOf(await screen.findByTestId('login-error'))).toContain('no stub for POST /api/auth/login');
  });
});

describe('signing out', () => {
  it('ends the session rather than hiding the form', async () => {
    const { fake, app, user } = await bootAuth('/app', { user: sessionUser() });

    await user.click(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'));

    expect(callsTo(fake, ROUTES.auth.logout)).toHaveLength(1);
    // The proof this was a sign-out and not a repaint: the same fake now answers `GET /api/auth/session`
    // with nobody home, so the guard would send `/app` back here for as long as that lasts.
    expect(screen.queryByTestId('login-form')).not.toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('stays signed in when the logout call fails', async () => {
    const { app, user } = await bootAuth('/app', {
      user: sessionUser(),
      logoutReply: () => failure(500, 'INTERNAL', 'the session row is stuck'),
    });

    await user.click(await screen.findByTestId('sign-out'));

    // Clearing the cache and routing to `/login` before the server agreed would leave a person who is
    // still authenticated looking at a signed-out app — the worse of the two failures.
    expect(textOf(await screen.findByTestId('sign-out-error'))).toContain('the session row is stuck');
    expect(app.router.state.location.pathname).toBe('/app');
    expect(screen.queryByTestId('app-shell')).not.toBeNull();
  });
});
