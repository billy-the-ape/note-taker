/**
 * Renders the real app at a chosen URL (docs/plans/mvp/MVP-08.md §7).
 *
 * "Real" is the point. This is `main.tsx` with a memory history: the generated route tree, the root
 * route with its guard, the `QueryClient` singleton the guards read directly (so a test that passed its
 * own client would watch two caches disagree), and the contract schemas on the way in. A test that
 * mounted `<LoginForm>` on its own could not fail when the redirect table is wrong, and the redirect
 * table is most of what this PR is.
 *
 * The provider stack therefore mirrors `main.tsx` line for line, including the pending component.
 * `SessionProvider` and `ToastProvider` are *not* repeated here: `routes/__root.tsx` mounts them, which
 * is where the application puts them too — a harness that wrapped them a second time would hide a
 * missing provider rather than reveal one.
 */
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';

import { AppPending } from '../components/layout/AppPending';
import { queryClient } from '../lib/queryClient';
import { routeTree } from '../routeTree.gen';

/**
 * The app at `path`. `queryClient` defaults to the application's own — the one `guardNavigation`
 * consults — and a test that needs a cold cache clears it in `beforeEach` rather than swapping it.
 */
export function renderApp(path: string, options: { readonly client?: QueryClient } = {}) {
  const client = options.client ?? queryClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history, defaultPendingComponent: AppPending });

  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { router, client, ...view };
}
