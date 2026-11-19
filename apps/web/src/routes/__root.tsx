import { createRootRoute, Outlet } from '@tanstack/react-router';

/**
 * The root route: the shell every other route renders into.
 *
 * PR-08 puts the session context and the route guards here, PR-12 replaces this plain wrapper with
 * the app shell (sidebar, top bar, status bar). Keeping it a bare `<Outlet />` in PR-01 is what lets
 * `/`, `/login`, `/setup` and `/app` share one tree without any of them existing yet.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-dvh antialiased">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <Outlet />
      </main>
    </div>
  );
}
