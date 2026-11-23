/**
 * Where the SPA goes when there is no session left to sign with (docs/plans/mvp/MVP-16.md §5).
 *
 * A real navigation rather than `useNavigate({ to: '/login' })`, for two reasons that both hold in
 * the finished app:
 *
 * * After `POST /api/auth/logout-all` **this** tab has no session either, so the correct cleanup is
 *   to throw the document away and boot the SPA again, not to keep whatever a previous screen left
 *   in memory behind a route change. A `QueryClient` full of the old user's notes is exactly the
 *   thing `lib/queryClient.ts`'s per-user keys are designed to prevent.
 * * PR-08 owns the `/login` route. A typed `navigate()` call here would make this PR depend on a
 *   route file that is not this PR's to write; a plain href is the same instruction and does not
 *   compile against someone else's route tree.
 */
export const LOGIN_PATH = '/login';

/** How the browser is told. Injectable so the redirect is assertable without navigating anywhere. */
export type LocationAssigner = (href: string) => void;

/** The production assigner, and the only place this module touches a global. */
function assignLocation(href: string): void {
  if (typeof window === 'undefined') return;
  window.location.assign(href);
}

/** Sends the browser to the sign-in screen. */
export function goToLogin(assign: LocationAssigner = assignLocation): void {
  assign(LOGIN_PATH);
}
