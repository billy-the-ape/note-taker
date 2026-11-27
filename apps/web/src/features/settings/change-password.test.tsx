// @vitest-environment jsdom
/**
 * The change-password form (docs/plans/mvp/MVP-16.md §5, `docs/API.md` #9).
 *
 * The criterion this file exists to fail loudly is the subtle one: after the password changes,
 * **the session that made the call survives**. PR-07 rotates the acting session inside the same
 * transaction that deletes every other one and answers `204` with the rotated `note_session` cookie,
 * so a client that "cleans up" after a credential change — clearing the cache, bouncing the person to
 * `/login`, or ignoring `Set-Cookie` and keeping the dead token in the jar — looks like it works until
 * the next request answers `401`. The assertions below are therefore about what the *transport* still
 * believes afterwards, not about the copy on screen.
 */
import { ROUTES, sessionResponseSchema } from '@note-taker/contracts';
import { cleanup, type RenderResult, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { createFakeServer, FAKE_NEW_PASSWORD, FAKE_PASSWORD, type FakeTab } from '../../test/fake-api.js';
import { spyOnLocation } from '../../test/location.js';
import { renderSettings } from '../../test/render-settings.js';

async function submit(
  view: RenderResult,
  user: UserEvent,
  { current, next }: { current: string; next: string },
): Promise<void> {
  // Cleared first, because the form keeps what was typed: a second submit that appended to the first
  // would submit a current password of `correct-horse-batterycorrect-horse-battery` and prove a
  // different failure than the one being tested.
  await user.clear(view.getByTestId('change-password-current'));
  await user.type(view.getByTestId('change-password-current'), current);
  await user.clear(view.getByTestId('change-password-new'));
  await user.type(view.getByTestId('change-password-new'), next);
  await user.click(view.getByTestId('change-password-submit'));
}

/** A rejected guarded request is the observable form of "that session is gone". */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('/app/settings — change password', () => {
  afterEach(() => {
    cleanup();
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('renders the server\'s "not right" answer inline and changes nothing', async () => {
    const server = createFakeServer();
    const rendered = renderSettings({ server });
    const { view, tab, queryClient } = rendered;
    const other = rendered.otherTab();
    const location = spyOnLocation();
    const tokensBefore = server.liveTokens();
    expect(tokensBefore).toHaveLength(2);
    const user = userEvent.setup();

    // A wrong current password is answered `401 UNAUTHORIZED` with no `details` (§9.2 #9), so this is
    // the whole error surface: one line under the form, in the form, not a redirect and not a field.
    await submit(view, user, { current: 'what I thought it was', next: FAKE_NEW_PASSWORD });

    await waitFor(() => {
      expect(view.getByTestId('change-password-error').textContent).toContain(
        'the current password is not right',
      );
    });

    // Nothing changed: not the password, not the sessions, not the route, not the cache.
    expect(server.password()).toBe(FAKE_PASSWORD);
    expect(server.liveTokens()).toEqual(tokensBefore);
    expect(location.assign).not.toHaveBeenCalled();
    expect(view.getByTestId('settings-page')).toBeDefined();
    expect(queryClient.getQueryData(queryKeys.settings)).toBeDefined();
    // And the acting session is still a session: the `401` was about the password, not about it. The
    // transport is the one place that decides, and this tab's client is wired with the same 401 hook
    // `features/auth/session.tsx` installs in production — so an empty list here means the hook was
    // *offered* this error and declined it (`lib/api.ts`'s `isCredentialOnly401`), which is the whole
    // difference between "the current password is not right" and a trip to `/login`.
    expect(rendered.expiryEvents()).toEqual([]);
    const session = await tab.client.json(ROUTES.auth.session, { schema: sessionResponseSchema });
    expect(session.user?.username).toBe('ada.lovelace');
    // The other tab is untouched, which is what "every *other* session is deleted" means on a failure.
    const otherSession = await other.client.json(ROUTES.auth.session, {
      schema: sessionResponseSchema,
    });
    expect(otherSession.user?.username).toBe('ada.lovelace');

    location.restore();
  });

  /**
   * The control the wrong-password case above needs: with a client wired like production, a `401`
   * from a route that is *not* `POST /api/auth/password` has to reach the app-wide hook, or
   * `expiryEvents()` would read `0` for a tab that simply has nobody listening.
   */
  it('hands a 401 from any other route to the expiry hook', async () => {
    const server = createFakeServer();
    server.failNextSettingsRead({ status: 401, message: 'your session has expired' });
    const rendered = renderSettings({ server });

    await waitFor(() => {
      expect(rendered.expiryEvents()).toEqual(['401 UNAUTHORIZED']);
    });
    // And the screen said so rather than bouncing anyone: `/login` is PR-08's route, and this harness
    // records the instruction instead of performing it.
    expect(rendered.view.getByTestId('settings-error')).toBeDefined();
  });

  it('refuses a weak new password locally, without spending a request', async () => {
    const server = createFakeServer();
    const { view } = renderSettings({ server });
    const user = userEvent.setup();

    await submit(view, user, { current: FAKE_PASSWORD, next: 'short' });

    await waitFor(() => {
      expect(view.getByTestId('change-password-new-error').textContent).toContain(
        'must be at least 10 characters',
      );
    });
    expect(server.requests().filter((line) => line.startsWith('POST'))).toHaveLength(0);
    expect(server.password()).toBe(FAKE_PASSWORD);

    // `changePasswordSchema`'s own refinement, caught client-side: submitting the current password as
    // the new one would rotate the password to what it already is and delete every other device for
    // nothing.
    await submit(view, user, { current: FAKE_PASSWORD, next: FAKE_PASSWORD });
    await waitFor(() => {
      expect(view.getByTestId('change-password-new-error').textContent).toContain(
        'must differ from the current password',
      );
    });
    expect(server.requests().filter((line) => line.startsWith('POST'))).toHaveLength(0);
  });

  it('keeps this session, obeys the rotated cookie, and kills every other one', async () => {
    const server = createFakeServer();
    const rendered = renderSettings({ server });
    const { view, tab, queryClient } = rendered;
    const other: FakeTab = rendered.otherTab();
    const location = spyOnLocation();
    const tokenBefore = tab.token();
    expect(server.liveTokens()).toEqual([tokenBefore, other.token()]);

    await submit(view, userEvent.setup(), { current: FAKE_PASSWORD, next: FAKE_NEW_PASSWORD });

    await waitFor(() => {
      expect(view.getByTestId('change-password-success').textContent).toContain('Password updated');
    });

    // 1. The password really moved.
    expect(server.password()).toBe(FAKE_NEW_PASSWORD);

    // 2. This session survived — as a *new* token, which the tab can only be carrying because it
    //    installed the response's `Set-Cookie`. `GET /api/auth/session` is the criterion's own
    //    evidence: the acting session still answers with a user.
    expect(tab.token()).not.toBe(tokenBefore);
    const session = await tab.client.json(ROUTES.auth.session, { schema: sessionResponseSchema });
    expect(session.user?.username).toBe('ada.lovelace');
    // A guarded route still answers, which it cannot without the rotated cookie.
    await expect(tab.client.json(ROUTES.settings)).resolves.toMatchObject({ theme: 'system' });

    // 3. Every other session is gone, and finds out the way a real tab does: on its next request.
    const guarded = await rejectionOf(other.client.json(ROUTES.settings));
    expect(guarded).toBeInstanceOf(ApiError);
    expect((guarded as ApiError).status).toBe(401);
    const otherSession = await other.client.json(ROUTES.auth.session, {
      schema: sessionResponseSchema,
    });
    expect(otherSession.user).toBeNull();
    expect(server.liveTokens()).toEqual([tab.token()]);

    // 4. The screen did not treat a successful password change as a sign-out: no navigation, the
    //    cached row is where it was, and the app-wide expiry hook was never offered this tab's
    //    business. This device is still signed in to the same account.
    expect(rendered.expiryEvents()).toEqual([]);
    expect(location.assign).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.settings)).toBeDefined();
    expect(view.getByTestId('settings-page')).toBeDefined();

    location.restore();
  });
});
