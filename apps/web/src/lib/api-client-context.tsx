/**
 * The React seam for {@link ApiClient} (PR-16).
 *
 * `lib/api.ts` (PR-05) exports the one client the app uses, and it deliberately takes its `fetch`
 * and its cookie reader as constructor options rather than reaching for globals — which is what let
 * that module be tested with no DOM at all. A component cannot pass options to a module singleton,
 * so a route PR that wants to drive a real request/response cycle through its components in a test
 * needs one provider and one hook, which is this file.
 *
 * The default is the application singleton, so production code never has to mount a provider:
 * `main.tsx` stays as PR-05 left it, and PR-08's composition root can wrap the tree once if it ever
 * wants a client with a different `onUnauthorized` handler. Tests wrap what they render.
 */
import { createContext, type ReactNode, useContext } from 'react';

import { type ApiClient, api } from './api.js';

const ApiClientContext = createContext<ApiClient>(api);

/** Replaces the client for the subtree — the test seam, and nothing else. */
export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): React.JSX.Element {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

/**
 * The client to call the API with. Never import the singleton directly from a component: a route
 * that does cannot be exercised against a fake server, and `lib/api.ts`'s CSRF and `ApiError`
 * behaviour is exactly what the route tests want to be real.
 */
export function useApiClient(): ApiClient {
  return useContext(ApiClientContext);
}
