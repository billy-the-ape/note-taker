/**
 * The two credential mutations this screen owns (docs/plans/mvp/MVP-16.md §5, `docs/API.md` #9 and #7).
 *
 * They look alike — both are `POST`, both answer `204`, both are about passwords — and their
 * consequences are opposites, so each gets its own hook and its own tests.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiClient } from '../../lib/api-client-context.js';
import { goToLogin } from './go-to-login.js';
import { type ChangePasswordRequest, changePassword, signOutEverywhere } from './settings.api.js';

/**
 * `POST /api/auth/password` (§9.2 #9) → `204`.
 *
 * There is deliberately **nothing** in `onSuccess`. That is the acceptance criterion, not an
 * omission: the server rotates the acting session and keeps it (the response carries the rotated
 * `note_session` cookie, which the browser installs without help) while deleting every *other*
 * session of the user. So there is no session to revalidate, no cache to clear, and no route to
 * send the person to — the correct client behavior after a password change is to leave them exactly
 * where they are standing, with a message that says what just happened to their other devices.
 *
 * One thing about this route is easy to get backwards, so it is recorded where the call is made: its
 * `401` is **ambiguous**. `UNAUTHORIZED` is what a wrong `currentPassword` answers, and it is also what
 * the auth guard in front of the route answers when the session has gone — same code, and the only
 * difference is PR-07's message prose (`docs/API.md` #9). `lib/api.ts` therefore does not guess on this
 * route: it asks `GET /api/auth/session` and fires the app-wide expiry hook only when that says the
 * session is gone, which is what keeps a mistyped current password from signing anybody out while a
 * genuinely dead session still reaches `/login`. Both halves are asserted in `change-password.test.tsx`.
 * The decision belongs to the transport, not to this hook — do not "helpfully" catch the `401` here.
 *
 * The absence of `onSuccess` in the hook below is not slack: `change-password.test.tsx` fails the
 * moment anything here clears the cache or navigates, which is the mutation that a "session hygiene"
 * refactor would make. There is no options bag to keep empty — `mutationFn` is the whole config, and
 * the test is what stops one being added back.
 */
export function useChangePassword() {
  const client = useApiClient();
  return useMutation<void, Error, ChangePasswordRequest>({
    mutationFn: (body) => changePassword(client, body),
  });
}

/** What happens after the server has deleted every session: forget everything, then sign in again. */
export interface SignOutEverywhereOptions {
  /** Overrides the navigation, which is what makes "lands on `/login`" assertable. */
  readonly onSignedOut?: () => void;
}

/**
 * `POST /api/auth/logout-all` (§9.2 #7) → `204`: every session row of this user, this tab's included,
 * so the caller is signed out too. `queryClient.clear()` is the client half of the sentence — the
 * row this screen was showing belongs to a session that no longer exists — and then
 * {@link goToLogin} puts the browser on the sign-in screen.
 *
 * The other tabs are not invalidated by any of this: they are invalidated by the *server* having no
 * rows left, which is why the acceptance check for them is "its next request answers `401`" rather
 * than anything the tab that signed out could do.
 */
export function useSignOutEverywhere(options: SignOutEverywhereOptions = {}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const onSignedOut = options.onSignedOut;

  return useMutation<void, Error, void>({
    mutationFn: () => signOutEverywhere(client),
    onSuccess: () => {
      queryClient.clear();
      if (onSignedOut === undefined) {
        goToLogin();
        return;
      }
      onSignedOut();
    },
  });
}
