/**
 * The auth rules the browser enforces, and the four calls that reach the server
 * (docs/plans/mvp/MVP-08.md §7). No DOM: `lib/api.ts` works without one and so does everything here.
 *
 * The point of the `validateCredentials` cases is the *shared schema* claim: every expectation below is
 * `registerSchema`'s answer, read from `@note-taker/contracts`, not a number this file invented. A test
 * that restated "10" by hand would still pass on the day the contract moved and the form did not.
 */
import {
  API_ERROR_MESSAGES,
  PASSWORD_EQUALS_USERNAME_MESSAGE,
  ROUTES,
  registerSchema,
} from '@note-taker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { authReply, errorBody, fakeApi, sessionReply, sessionUser, statusReply } from '../../test/fakeApi';
import {
  CONFIRM_MISMATCH_MESSAGE,
  failureMessage,
  fetchAuthStatus,
  fetchSession,
  fieldErrorsFromDetails,
  isRateLimited,
  login,
  REQUIRED_PASSWORD_MESSAGE,
  REQUIRED_USERNAME_MESSAGE,
  registerAccount,
  retryAfterNotice,
  setupAccount,
  signOut,
  UNREACHABLE_MESSAGE,
  validateCredentials,
  validateLogin,
} from './auth.api';

/** A password long enough to clear `passwordSchema`, so a failure means what it says. */
const GOOD_PASSWORD = 'correct horse battery';

describe('validateCredentials (the shared registerSchema)', () => {
  it('accepts a valid pair with no message at all', () => {
    expect(validateCredentials({ username: 'ada.lovelace', password: GOOD_PASSWORD })).toEqual({});
  });

  it('asks for the two values instead of describing their rules when they are empty', () => {
    expect(validateCredentials({ username: '', password: '' })).toEqual({
      username: REQUIRED_USERNAME_MESSAGE,
      password: REQUIRED_PASSWORD_MESSAGE,
    });
  });

  it('reports a username the shared schema rejects, in the schema’s own words', () => {
    // Each bad name is parsed on its own and compared with the message that parse produced: `min`,
    // `max` and the pattern are three different sentences, and pinning one string here would make this
    // test a copy of the contract instead of a check against it.
    const shortest = registerSchema.safeParse({ username: 'ad', password: GOOD_PASSWORD });
    expect(shortest.success).toBe(false);

    const cases = [
      ['ad', shortest],
      ['Ada Lovelace', registerSchema.safeParse({ username: 'Ada Lovelace', password: GOOD_PASSWORD })],
      ['a'.repeat(33), registerSchema.safeParse({ username: 'a'.repeat(33), password: GOOD_PASSWORD })],
    ] as const;

    for (const [username, parsed] of cases) {
      expect(parsed.success).toBe(false);
      expect(validateCredentials({ username, password: GOOD_PASSWORD }).username).toBe(
        parsed.error?.issues[0]?.message,
      );
    }
  });

  it('reports a password the shared schema rejects', () => {
    const tooShort = registerSchema.safeParse({ username: 'ada', password: 'short1234' });
    expect(validateCredentials({ username: 'ada', password: 'short1234' }).password).toBe(
      tooShort.error?.issues[0]?.message,
    );
  });

  it('refuses a password that is the username, whichever way it is capitalised', () => {
    // 12 characters, so only the plan §10 rule can be the one objecting.
    expect(validateCredentials({ username: 'ada.lovelace', password: 'ADA.LOVELACE' }).password).toBe(
      PASSWORD_EQUALS_USERNAME_MESSAGE,
    );
  });

  it('trims the username before deciding, because the server does', () => {
    expect(validateCredentials({ username: '  ada.lovelace  ', password: GOOD_PASSWORD })).toEqual({});
    expect(validateCredentials({ username: '   ', password: GOOD_PASSWORD }).username).toBe(
      REQUIRED_USERNAME_MESSAGE,
    );
  });

  it('only compares the confirmation when the form has one', () => {
    const draft = { username: 'ada.lovelace', password: GOOD_PASSWORD, confirmPassword: 'typo' };
    expect(validateCredentials(draft)).toEqual({ confirmPassword: CONFIRM_MISMATCH_MESSAGE });
    expect(validateCredentials({ ...draft, confirmPassword: GOOD_PASSWORD })).toEqual({});
    // `/login` sends no confirmation box, so it can never report one.
    expect(validateCredentials({ username: 'ada.lovelace', password: GOOD_PASSWORD })).not.toHaveProperty(
      'confirmPassword',
    );
  });

  it('compares the confirmation against the password verbatim, spaces included', () => {
    expect(
      validateCredentials({
        username: 'ada.lovelace',
        password: ' trailing space',
        confirmPassword: 'trailing space',
      }).confirmPassword,
    ).toBe(CONFIRM_MISMATCH_MESSAGE);
  });
});

describe('validateLogin', () => {
  it('asks only that both halves are there', () => {
    // `loginSchema` is permissive on purpose (§9.2 #5), so the form must not be stricter: an unknown
    // name and a wrong password answer 401 with the same words.
    expect(validateLogin({ username: 'Ada Lovelace', password: 'short' })).toEqual({});
    expect(validateLogin({ username: '  ', password: '' })).toEqual({
      username: REQUIRED_USERNAME_MESSAGE,
      password: REQUIRED_PASSWORD_MESSAGE,
    });
  });
});

describe('fieldErrorsFromDetails (the 400 envelope, §9.1)', () => {
  it('lifts a known field into the input it belongs to', () => {
    expect(
      fieldErrorsFromDetails([
        { path: 'username', message: 'must be 3 characters at least' },
        { path: 'password', message: 'must be 10 characters at least' },
      ]),
    ).toEqual({
      username: 'must be 3 characters at least',
      password: 'must be 10 characters at least',
    });
  });

  it('drops a path this form has no box for rather than guessing where it goes', () => {
    expect(
      fieldErrorsFromDetails([
        { path: 'body.username', message: 'unrelated' },
        { path: 'notes.title', message: 'also unrelated' },
      ]),
    ).toEqual({});
  });

  it('survives the failures that have no details at all', () => {
    expect(fieldErrorsFromDetails(undefined)).toEqual({});
    expect(fieldErrorsFromDetails([])).toEqual({});
  });
});

describe('failureMessage / retryAfterNotice / isRateLimited', () => {
  const apiError = (overrides: { readonly status?: number; readonly message?: string } = {}) =>
    new ApiError({
      status: overrides.status ?? 500,
      code: 'INTERNAL',
      message: overrides.message ?? API_ERROR_MESSAGES.INTERNAL,
      requestId: 'req_0123456789abcdef0123456789abcdef',
    });

  it('shows the server its own words', () => {
    expect(failureMessage(apiError({ status: 401, message: 'wrong username or password' }))).toBe(
      'wrong username or password',
    );
  });

  it('says the truth when there is no envelope to quote', () => {
    // A `fetch` that rejects (server down, dev proxy not up yet) is a TypeError, not an ApiError.
    expect(failureMessage(new TypeError('fetch failed'))).toBe(UNREACHABLE_MESSAGE);
    expect(failureMessage('a string thrown by mistake')).toBe(UNREACHABLE_MESSAGE);
  });

  it('renders Retry-After in the unit a person reads', () => {
    const withRetry = (seconds: number | undefined) =>
      new ApiError({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'too many attempts',
        requestId: 'req_0123456789abcdef0123456789abcdef',
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
      });

    expect(retryAfterNotice(withRetry(45))).toBe('try again in 45s');
    expect(retryAfterNotice(withRetry(60))).toBe('try again in 1 minute');
    expect(retryAfterNotice(withRetry(900))).toBe('try again in 15 minutes');
    expect(retryAfterNotice(withRetry(undefined))).toBeUndefined();
    expect(retryAfterNotice(new Error('no header'))).toBeUndefined();
  });

  it('knows the rate limit when it sees one', () => {
    const limited = new ApiError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'too many attempts',
      requestId: 'req_0123456789abcdef0123456789abcdef',
    });
    expect(isRateLimited(limited)).toBe(true);
    expect(isRateLimited(apiError({ status: 401 }))).toBe(false);
  });
});

describe('the auth calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Points the module-level `api` singleton at a table of answers. */
  function stub(routes: Parameters<typeof fakeApi>[0]) {
    const fake = fakeApi(routes);
    vi.stubGlobal('fetch', fake.fetch);
    return fake;
  }

  it('reads the two boot facts from the two documented routes', async () => {
    const fake = stub({
      [`GET ${ROUTES.auth.status}`]: () => statusReply(true, false),
      [`GET ${ROUTES.auth.session}`]: () => sessionReply(null),
    });

    await expect(fetchAuthStatus()).resolves.toEqual({ needsSetup: true, registrationOpen: false });
    await expect(fetchSession()).resolves.toEqual({ user: null });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${ROUTES.auth.status}`,
      `GET ${ROUTES.auth.session}`,
    ]);
  });

  it('sends the username and the password, and hands back the user', async () => {
    const user = sessionUser({ username: 'ada.lovelace', role: 'owner' });
    const fake = stub({
      [`POST ${ROUTES.auth.setup}`]: () => authReply(user),
      [`POST ${ROUTES.auth.register}`]: () => authReply(user),
      [`POST ${ROUTES.auth.login}`]: () => authReply(user),
    });

    await expect(setupAccount({ username: 'ada.lovelace', password: GOOD_PASSWORD })).resolves.toEqual(user);
    await expect(registerAccount({ username: 'ada.lovelace', password: GOOD_PASSWORD })).resolves.toEqual(
      user,
    );
    await expect(login({ username: 'ada.lovelace', password: GOOD_PASSWORD })).resolves.toEqual(user);

    expect(fake.calls.map((call) => call.path)).toEqual([
      ROUTES.auth.setup,
      ROUTES.auth.register,
      ROUTES.auth.login,
    ]);
    // No confirmation field, no display name: the body is exactly what `registerSchema` accepts.
    expect(fake.calls[0]?.body).toEqual({ username: 'ada.lovelace', password: GOOD_PASSWORD });
  });

  it('signs out through the route that deletes the session row', async () => {
    const fake = stub({ [`POST ${ROUTES.auth.logout}`]: () => ({ status: 204 }) });
    await expect(signOut()).resolves.toBeUndefined();
    expect(fake.calls).toEqual([
      { method: 'POST', path: ROUTES.auth.logout, url: ROUTES.auth.logout, body: undefined },
    ]);
  });

  it('turns a rejected answer into the ApiError the form knows how to read', async () => {
    stub({
      [`POST ${ROUTES.auth.login}`]: () => ({
        status: 401,
        body: errorBody('UNAUTHORIZED', 'wrong username or password'),
      }),
    });

    await expect(login({ username: 'ada.lovelace', password: 'nope nope nope' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'wrong username or password',
    });
  });
});
