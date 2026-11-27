// @vitest-environment jsdom
/**
 * "Sign out everywhere" (docs/plans/mvp/MVP-16.md §5, `docs/API.md` #7).
 *
 * The mirror image of the password change: `POST /api/auth/logout-all` deletes **this** session too,
 * so the correct client behaviour is to forget the cached row and put the browser on the sign-in
 * screen — and the acceptance criterion for the *other* tab is not that anything tells it, but that
 * its next request answers `401`, because PR-07's sessions are rows and the rows are gone.
 *
 * The redirect is asserted as an instruction (`location.assign('/login')`) rather than an arrival:
 * `/login` is PR-08's route file, and jsdom cannot navigate. See `test/location.ts` and
 * `features/settings/go-to-login.ts` for why that split is honest rather than a dodge.
 */
import { ROUTES, sessionResponseSchema } from '@note-taker/contracts';
import { cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { createFakeServer } from '../../test/fake-api.js';
import { spyOnLocation } from '../../test/location.js';
import { renderSettings } from '../../test/render-settings.js';

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('/app/settings — sign out everywhere', () => {
  afterEach(() => {
    cleanup();
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('deletes every session, clears this document, and lands on /login', async () => {
    const server = createFakeServer();
    const rendered = renderSettings({ server });
    const { view, tab, queryClient } = rendered;
    const other = rendered.otherTab();
    const location = spyOnLocation();
    expect(server.liveTokens()).toHaveLength(2);

    // Warm the cache first, so "cleared" below is a fact about the click rather than about a screen
    // that never had anything in it.
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.settings)).toBeDefined();
    });

    await userEvent.click(view.getByTestId('sign-out-everywhere'));

    await waitFor(() => {
      expect(server.requests()).toContain('POST /api/auth/logout-all');
    });
    // One call, and no error surface: the `204` is the whole job.
    expect(server.requests().filter((line) => line.startsWith('POST'))).toHaveLength(1);
    expect(view.queryByTestId('sign-out-everywhere-error')).toBeNull();

    // The browser was told to go to the sign-in screen.
    expect(location.assign).toHaveBeenCalledWith('/login');

    // This tab is signed out too — the `204`'s clearing `Set-Cookie` was honoured, so the jar is empty
    // and the row that was on screen is gone from the cache with it.
    expect(tab.token()).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.settings)).toBeUndefined();
    const guarded = await rejectionOf(tab.client.json(ROUTES.settings));
    expect(guarded).toBeInstanceOf(ApiError);
    expect((guarded as ApiError).status).toBe(401);

    // The other tab was not told anything, and finds out on its next request. `GET /api/auth/session`
    // still answers `200 {user: null}` rather than `401` (§9.2 #8), which is what keeps `lib/api.ts`'s
    // `401` handler from looping.
    const otherSession = await other.client.json(ROUTES.auth.session, {
      schema: sessionResponseSchema,
    });
    expect(otherSession.user).toBeNull();
    const otherGuarded = await rejectionOf(other.client.json(ROUTES.settings));
    expect((otherGuarded as ApiError).status).toBe(401);
    expect(server.liveTokens()).toHaveLength(0);

    location.restore();
  });
});
