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
 * One thing the next PR must know, recorded here because this is the file that would break: the
 * `401` this route answers when `currentPassword` is wrong is a **credential** error, not a session
 * error (`docs/API.md` #9). `lib/api.ts` fires `onUnauthorized` for every `401`, so whoever wires
 * that hook (PR-08's composition root, via `ApiClientProvider`) has to exclude
 * `ROUTES.auth.password`, or a mistyped current password would sign the person out of a session that
 * PR-07 has just proved is still alive.
 *
 * The empty options bag below is not slack: `change-password.test.tsx` fails the moment anything here
 * clears the cache or navigates, which is the mutation that a "session hygiene" refactor would make.
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
