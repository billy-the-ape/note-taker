import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppPending } from './components/layout/AppPending';
import { applyThemeChoice, readThemeChoice } from './components/layout/ThemeToggle';
import { queryClient } from './lib/queryClient';
import { routeTree } from './routeTree.gen';
import './styles/globals.css';

/**
 * The providers every later PR hangs off (plan §11.2): TanStack Router for file-based routes and
 * TanStack Query for server state. PR-05 moved the client to `lib/queryClient.ts`, where its defaults
 * stop being placeholders (a `4xx` is never retried) and its cache keys are shared with the tests —
 * which is why this file no longer constructs one.
 *
 * PR-08's session and toast providers are **not** here. `SessionProvider` calls `useNavigate()`, which
 * needs the router context that `RouterProvider` below only creates from this point down, so they mount
 * one level lower, in the root route (`routes/__root.tsx`). What stays here is the one thing with no
 * such dependency: the `QueryClient`, which the route guards also read directly, because a `beforeLoad`
 * is not a React render and cannot reach a context (docs/plans/mvp/MVP-08.md §5).
 */
const router = createRouter({
  routeTree,
  // The first navigation awaits the boot pair — `GET /api/auth/status` and `GET /api/auth/session` —
  // before any route renders, and this is what a refresh shows for those few milliseconds. A page that
  // is merely blank for a moment is indistinguishable from a page that crashed. `test/renderApp.tsx`
  // mounts the same component, so the harness cannot quietly differ from what a user is shown.
  defaultPendingComponent: AppPending,
});

// Turns the generated tree into checked `to`/`params` types. Without it every `Link` and `useNavigate`
// would accept any string, and PR-08 is entirely about which strings are legal.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Before the first paint, so a second visit in dark mode does not flash the light theme while React
// settles. `localStorage` is the whole store at this stage — see `components/layout/ThemeToggle.tsx`.
applyThemeChoice(readThemeChoice());

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing its #root mount point');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
