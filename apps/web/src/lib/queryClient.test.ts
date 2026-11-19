/**
 * The cache-key conventions and the retry policy (docs/plans/mvp/MVP-05.md §5).
 *
 * The keys are the part later PRs depend on most, so they are tested against a real `QueryClient`
 * rather than eyeballed: a prefix that stopped matching its keys would silently leave a stale tree on
 * screen after every rename.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  createQueryClient,
  NOTE_KEY_PREFIX,
  queryKeys,
  shouldRetryQuery,
  TREE_KEY_PREFIX,
} from './queryClient';

describe('the cache keys of §5', () => {
  it('scopes the tree by user, so signing in as someone else cannot render the previous member', () => {
    expect(queryKeys.tree('user-1')).toEqual(['tree', 'user-1']);
    expect(queryKeys.tree('user-2')).toEqual(['tree', 'user-2']);
  });

  it('keys a note by id and the settings row by nothing at all', () => {
    expect(queryKeys.note('note-1')).toEqual(['note', 'note-1']);
    expect(queryKeys.settings).toEqual(['settings']);
  });

  it('round-trips through a real client, and the prefixes match what they claim to match', async () => {
    const client = createQueryClient();
    const tree = { folders: [], notes: [] };
    client.setQueryData(queryKeys.tree('user-1'), tree);
    client.setQueryData(queryKeys.tree('user-2'), tree);
    client.setQueryData(queryKeys.note('note-1'), { id: 'note-1', content: '', version: 1 });
    client.setQueryData(queryKeys.settings, { autosave: true, theme: 'system' });

    expect(client.getQueryData(queryKeys.tree('user-1'))).toEqual(tree);
    // A rename invalidates the whole tree of everyone, and nothing else (§5, §9.3).
    await client.removeQueries({ queryKey: TREE_KEY_PREFIX });
    await client.removeQueries({ queryKey: NOTE_KEY_PREFIX });

    expect(client.getQueryData(queryKeys.tree('user-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.tree('user-2'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.note('note-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.settings)).toEqual({ autosave: true, theme: 'system' });
  });

  it('serves a second read of the same key from the cache', async () => {
    const client = createQueryClient();
    let calls = 0;
    const queryFn = async () => {
      calls += 1;
      return { id: 'note-1', content: 'text', version: 3 };
    };

    // `staleTime` comes from the client's defaults, so a fresh entry is not re-fetched.
    await client.fetchQuery({ queryKey: queryKeys.note('note-1'), queryFn });
    await client.fetchQuery({ queryKey: queryKeys.note('note-1'), queryFn });
    expect(calls).toBe(1);

    // …and a different note is a different entry.
    await client.fetchQuery({ queryKey: queryKeys.note('note-2'), queryFn: async () => ({ id: 'note-2' }) });
    expect(calls).toBe(1);
  });
});

describe('shouldRetryQuery', () => {
  const apiError = (status: number) =>
    new ApiError({ status, code: status === 409 ? 'VERSION_CONFLICT' : 'INTERNAL', message: 'x' });

  it('never retries a client error, because it is still true the second time', () => {
    // The version-conflict case is the one that matters: a re-sent stale write is the
    // last-write-wins bug §3.6 rules out, not a transient failure.
    expect(shouldRetryQuery(0, apiError(409))).toBe(false);
    expect(shouldRetryQuery(0, apiError(401))).toBe(false);
    expect(shouldRetryQuery(0, apiError(403))).toBe(false);
    expect(shouldRetryQuery(0, apiError(400))).toBe(false);
  });

  it('retries a server error once, and gives up on the second', () => {
    expect(shouldRetryQuery(0, apiError(500))).toBe(true);
    expect(shouldRetryQuery(1, apiError(500))).toBe(false);
  });

  it('retries a network failure once, which is all a dead container justifies', () => {
    expect(shouldRetryQuery(0, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError('fetch failed'))).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('does not retry mutations, so a double-clicked create stays one row (§9.3)', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('does not refetch on focus, which is what keeps a returning tab from stampeding the API', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
  });
});
