/**
 * The TanStack Query client and the cache-key conventions (docs/plans/mvp/MVP-05.md §5).
 *
 * PR-01 built a placeholder client inside `main.tsx`; moving it here is what makes the cache shared by
 * every route, testable without a DOM, and configurable once against the error type PR-05 introduced.
 *
 * The key shape is the contract later PRs build against, and it is one object with one spelling per
 * resource rather than strings scattered through the components:
 *
 * * `['tree', userId]` — the tree is per-user (§9.2 #12), and signing in as someone else must never
 *   render the previous member's folder names from cache.
 * * `['note', id]` — a note's content is the one thing in the app with a version, so it is the one
 *   entry PR-14's autosave engine invalidates and re-reads.
 * * `['settings']` — global, not per-user-per-device, so it carries no id (§9.2 #22).
 *
 * Invalidating `['tree', userId]` after a mutation is enough to refresh the sidebar, which is why the
 * tree key holds the user id rather than being nested under something broader.
 */
import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api.js';

/** Every cache key the SPA uses. Add a resource here, never inline at the call site. */
export const queryKeys = {
  /** `GET /api/auth/status` (§9.2 #2) — `{needsSetup, registrationOpen}`, what every guard reads. */
  authStatus: ['auth', 'status'] as const,
  /**
   * `GET /api/auth/session` (§9.2 #8) — `{user|null}`. Keyed by nothing, because it *is* the cookie:
   * a second user behind the same browser has a different cookie, and a cache entry that outlived the
   * session would be the one bug that shows somebody else's name on `/app`.
   */
  authSession: ['auth', 'session'] as const,
  /** The folder/note tree of one user (§9.2 #12). */
  tree: (userId: string): readonly ['tree', string] => ['tree', userId],
  /** One note, with its decrypted content and version (§9.2 #17). */
  note: (id: string): readonly ['note', string] => ['note', id],
  /** The single settings row of the signed-in user (§9.2 #22). */
  settings: ['settings'] as const,
} as const;

/** The prefix a rename or move invalidates, whatever id it touched. */
export const TREE_KEY_PREFIX = ['tree'] as const;
/** The prefix a versioned write invalidates. */
export const NOTE_KEY_PREFIX = ['note'] as const;

/**
 * A `4xx` from the API will still be true on the second attempt: the session is gone, the name is
 * taken, the version is stale. Retrying it multiplies the failure (and, for a stale `baseVersion`,
 * turns a detectable conflict into the last-write-wins bug §3.6 rules out). Everything else — a
 * dropped connection, a `500` while the container is restarting — is worth exactly one more try.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  // At most one retry of anything, whatever it was; the client-error half is the important one.
  if (failureCount >= 1) return false;
  if (error instanceof ApiError) return error.status >= 500;
  return true;
}

/**
 * The client every provider in the app should be handed. Its defaults are the two rules §5 and §9.3
 * care about: queries retry at most once and never on a `4xx`, mutations never at all.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The tree changes only through this tab, so 30 s of "fresh" costs nothing and keeps a click
        // from re-fetching the whole sidebar.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
      mutations: {
        // A mutation the user can see the result of is never silently re-sent: a second
        // `POST /api/notes` is a second note, which is the exact double-click §9.3 rules out.
        retry: false,
      },
    },
  });
}

/** The application-wide instance. Tests create their own with `createQueryClient()`. */
export const queryClient = createQueryClient();
