import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { queryClient } from './lib/queryClient';
import { routeTree } from './routeTree.gen';
import './styles/globals.css';

/**
 * The providers every later PR hangs off (plan §11.2): TanStack Router for file-based routes and
 * TanStack Query for server state. PR-05 moved the client to `lib/queryClient.ts`, where its defaults
 * stop being placeholders (a `4xx` is never retried) and its cache keys are shared with the tests —
 * which is why this file no longer constructs one.
 */
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

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
