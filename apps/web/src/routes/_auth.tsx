/**
 * The furniture the three auth pages share, and nothing else
 * (docs/plans/mvp/MVP-12.md §4; PR-12 review, round two).
 *
 * It is a **pathless** layout route: `_auth/login.tsx`, `_auth/setup.tsx` and `_auth/signup.tsx` are its
 * children, so the URL stays exactly `/login` while the column that holds the form lives here. `/app` is a
 * sibling of this route, not a child of it — which is the whole point. Before this file existed, that narrow
 * column, its wordmark and its theme knob lived in `__root.tsx` and therefore wrapped *every* route, so the
 * authed shell rendered inside a 672 px column under a second header with a second theme toggle, and
 * `<main>` was nested in `<main>`.
 *
 * The fix could have been `pathname.startsWith('/app')` in `RootLayout`. It is not, twice over: the root is
 * where the §4 table's single-copy rule lives (PR-08), and a chrome decision written two lines below that is
 * how a third route-level decision turns into a fourth copy of the same table; and "these pages share
 * furniture" is a fact the router already has a shape for. A layout route also makes the next auth page free:
 * a file in this directory gets the column without being told about it.
 *
 * The knob is the reason to be pedantic about the duplication: PR-16 moves the theme control into settings,
 * and it should not have to notice that `/app`'s own `TopBar` grew a second one.
 */
import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ThemeToggle } from '../components/layout/ThemeToggle';

export const Route = createFileRoute('/_auth')({
  component: AuthChrome,
});

/**
 * The centered column, the wordmark, and the theme knob — PR-08's chrome, moved rather than redesigned.
 *
 * `data-testid="auth-chrome"` exists so a test can say the honest thing about it: *present* on the three
 * pages below and *absent* on `/app`. Which is the one part of this defect jsdom can actually see; the width
 * of the column it no longer imposes on the shell it cannot.
 */
function AuthChrome() {
  return (
    <div className="min-h-dvh antialiased" data-testid="auth-chrome">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-6 pt-6">
        <span className="text-sm font-semibold tracking-wide text-ink">Note Taker</span>
        {/* The theme is a preference about this screen, so it belongs to the chrome rather than to a page —
            and PR-16 moves the control into settings without touching this line. */}
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
