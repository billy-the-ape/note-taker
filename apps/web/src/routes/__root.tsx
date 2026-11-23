import { createRootRoute, Outlet } from '@tanstack/react-router';

import { SettingsEffects } from '../features/settings/settings-effects.js';

/**
 * The root route: the shell every other route renders into.
 *
 * PR-16 adds the one thing that has to be true on *every* page: `<html class="dark">` matching the
 * signed-in user's stored theme (and the operating system's while that preference is `system`),
 * which is what `SettingsEffects` does and why it is mounted here rather than on the screen that
 * edits the value. PR-12 replaces this plain wrapper with the app shell (sidebar, top bar, status
 * bar) and moves the effects into the `/app` layout; PR-08 puts the session context and the route
 * guards above it.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-dvh antialiased">
      <SettingsEffects />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <Outlet />
      </main>
    </div>
  );
}
