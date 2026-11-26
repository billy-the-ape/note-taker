/**
 * The tree as server state (docs/plans/mvp/MVP-12.md §5, plan §11.2).
 *
 * One query, keyed `['tree', userId]` (`lib/queryClient.ts`), holding the raw `TreeResponse` — the two flat
 * lists exactly as `GET /api/tree` answered them. That is deliberate: the cache entry stays the *server's*
 * payload rather than becoming a view of it, so `tree.selectors.ts` can be a pure function of the cache and
 * a mutation's optimistic rewrite can be a pure function too (see `tree.mutations.ts`). Nesting, sorting and
 * collapsing happen per render, over a few hundred objects, which is cheaper than a second cached
 * representation that could disagree with the first.
 *
 * **Why the key carries the user id.** It is the only cache in this app that must not survive a switch of
 * account: `signOut()` clears the whole client, but a key that named nobody would let a second member's
 * folder names be painted from the first one's cache during the moment between two navigations.
 *
 * **Why `enabled`.** An anonymous visitor has no tree to ask for, and `GET /api/tree` answers `401 UNAUTHORIZED`
 * (§9.2 #12). The `/app` guard should mean that request is never made; `enabled` is the belt under it, because a
 * `401` from a component that renders for a signed-out visitor would fire PR-05's app-wide unauthorised handler
 * while the guard is already on its way to `/login`.
 */
import { queryOptions, useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../lib/queryClient';
import { useSession } from '../auth/useSession';
import { fetchTree } from './tree.api';

/**
 * The no-user id. It is a real string so the key type never becomes `['tree', string | undefined]` and a
 * cache entry nobody can name; `enabled` below is what keeps it from ever being fetched.
 */
const NO_USER = 'anonymous';

/**
 * `['tree', userId]` for a user id this app may not have yet.
 *
 * Exported because a mutation has to write the same entry the query reads: two callers spelling the key by
 * hand is how an optimistic update lands on an entry nobody renders and the tree appears to ignore every
 * click.
 */
export function treeQueryKey(userId: string) {
  return queryKeys.tree(userId === '' ? NO_USER : userId);
}

/** `['tree', userId]` plus its fetcher, in the one shape `useQuery` and `ensureQueryData` agree on. */
export function treeOptions(userId: string) {
  return queryOptions({
    queryKey: treeQueryKey(userId),
    queryFn: fetchTree,
    enabled: userId !== '' && userId !== NO_USER,
  });
}

/**
 * The signed-in user's tree.
 *
 * The `enabled` half is why this is a hook rather than a call site writing `treeOptions(user.id)`: the only
 * honest way to know the id is to ask the session, and every component that shows part of the tree should
 * read the same cache entry rather than fetch its own copy.
 */
export function useUserTree() {
  const { user } = useSession();
  return useQuery(treeOptions(user?.id ?? ''));
}
