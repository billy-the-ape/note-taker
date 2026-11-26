/**
 * The optimistic cache rewrites, and the two rules that decide when they are allowed
 * (docs/plans/mvp/MVP-12.md §5, §6: "optimistic update, then rollback …" / "move into own descendant blocked
 * client-side").
 *
 * A mutation in this app is `snapshot → rewrite the cache → send → restore the snapshot on failure`, and the
 * rewrite is a pure `TreeResponse → TreeResponse`. Testing the rewrites directly is not a shortcut around the
 * component tests (`components/tree/FolderTree.test.tsx` drives the same code through a real `QueryClient`, a
 * real `fetch` and a click): it is the only way to ask the questions a click cannot pin down. *Which* rows
 * disappear when a folder is deleted? Does a rewrite for a row this cache has never heard of add it? Does the
 * cache come back as the *same object* it was, or as a copy with the optimistic name still in it?
 *
 * The identity assertions (`toBe`) are the interesting ones. `hasNode` is what turns a stale cache into a
 * no-op instead of a lie, and a rewrite that returned a fresh-but-equal object in the no-op case would keep
 * every subscriber rendering a tree that never existed as far as the server is concerned.
 */

import type { TreeResponse } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { folderNode, noteNode, testId } from '../../test/treeApi';
import {
  applyDelete,
  applyMove,
  applyRename,
  MoveBlockedError,
  moveIsBlocked,
  mutationFailureMessage,
  treeCacheKey,
} from './tree.mutations';
import { descendantFolderIds } from './tree.selectors';

const F_WORK = testId('folder', 1);
const F_PROJECTS = testId('folder', 2);
const F_DEEP = testId('folder', 3);
const F_ARCHIVE = testId('folder', 4);
const N_PLAN = testId('note', 1);
const N_DRAFT = testId('note', 2);
const N_IDEAS = testId('note', 3);

/**
 * ```text
 * Work/
 *   Projects/
 *     Deep/
 *   plan.md
 * Archive/
 * ideas.md      (root)
 * ```
 *
 * `draft` is filed under nothing so a delete can be seen leaving the root alone.
 */
const TREE: TreeResponse = {
  folders: [
    folderNode(F_WORK, 'Work', null),
    folderNode(F_PROJECTS, 'Projects', F_WORK),
    folderNode(F_DEEP, 'Deep', F_PROJECTS),
    folderNode(F_ARCHIVE, 'Archive', null),
  ],
  notes: [
    noteNode(N_PLAN, 'plan', F_WORK),
    noteNode(N_DRAFT, 'draft', null),
    noteNode(N_IDEAS, 'ideas', F_ARCHIVE),
  ],
};

const names = (response: TreeResponse): string[] => [
  ...response.folders.map((folder) => folder.name),
  ...response.notes.map((note) => note.name),
];

describe('treeCacheKey', () => {
  it('is the entry `tree.queries.ts` reads, spelled the same way', () => {
    // A mutation that writes `['tree', id]` by hand is an optimistic update nobody renders. This is the one
    // assertion that keeps the two files from drifting apart silently.
    expect(treeCacheKey('019a3b4c-5d6e-7f80-9123-00000000000f')).toEqual(
      queryKeys.tree('019a3b4c-5d6e-7f80-9123-00000000000f'),
    );
  });
});

describe('applyRename', () => {
  it('renames a folder in place and leaves the notes alone', () => {
    const next = applyRename(TREE, { kind: 'folder', id: F_WORK, name: 'Work (old)' });
    expect(next.folders.find((folder) => folder.id === F_WORK)?.name).toBe('Work (old)');
    expect(next.notes).toEqual(TREE.notes);
    // Only the one row is a new object: a whole new tree would repaint 500 rows for a two-character edit.
    expect(next.folders.find((folder) => folder.id === F_PROJECTS)).toBe(
      TREE.folders.find((folder) => folder.id === F_PROJECTS),
    );
  });

  it('renames a note by writing `name`, which is the field the tree renders', () => {
    const next = applyRename(TREE, { kind: 'note', id: N_PLAN, name: 'plan-2' });
    expect(next.notes.find((note) => note.id === N_PLAN)?.name).toBe('plan-2');
    // The `.md` a person sees is `displayName`'s job on the way to the screen, never the cache's: a rewrite
    // that stored `plan-2.md` would store the extension the database does not have.
    expect(next.notes.find((note) => note.id === N_PLAN)?.name).not.toContain('.md');
  });

  it('is a no-op for an id this cache does not have', () => {
    // The stale-cache case, and the reason it must not "helpfully" add the row: the response is the server's,
    // and inventing a row here is a folder that does not exist until the refetch notices.
    const orphan = testId('folder', 90);
    expect(applyRename(TREE, { kind: 'folder', id: orphan, name: 'Ghost' })).toBe(TREE);
    expect(applyRename(TREE, { kind: 'note', id: testId('note', 90), name: 'Ghost' })).toBe(TREE);
  });

  it('does not touch the entry it was handed', () => {
    // `onError` writes the snapshot back verbatim; a rewrite that mutated it in place would restore the
    // optimistic name from the very object that is supposed to be the rollback.
    const before = names(TREE);
    applyRename(TREE, { kind: 'folder', id: F_WORK, name: 'changed' });
    applyDelete(TREE, { kind: 'folder', id: F_WORK, cascade: true });
    applyMove(TREE, { kind: 'folder', id: F_ARCHIVE, parentId: F_WORK });
    expect(names(TREE)).toEqual(before);
  });
});

describe('applyMove', () => {
  it('moves a folder by rewriting `parentId`', () => {
    const next = applyMove(TREE, { kind: 'folder', id: F_ARCHIVE, parentId: F_WORK });
    expect(next.folders.find((folder) => folder.id === F_ARCHIVE)?.parentId).toBe(F_WORK);
    // Its subtree travels with it, unmentioned: the nesting is derived from `parentId`, which is the whole
    // reason the server sends flat lists (§9.2 #12) and the reason a move is one field.
    expect(next.folders.find((folder) => folder.id === F_ARCHIVE)?.name).toBe('Archive');
    expect(next.notes.find((note) => note.id === N_IDEAS)?.folderId).toBe(F_ARCHIVE);
  });

  it('moves a note by rewriting `folderId`, including out to the root', () => {
    const next = applyMove(TREE, { kind: 'note', id: N_PLAN, parentId: null });
    expect(next.notes.find((note) => note.id === N_PLAN)?.folderId).toBeNull();
  });

  it('is a no-op for an illegal move, rather than painting a jump it then has to take back', () => {
    // The same rule `moveIsBlocked` refuses to send, applied to the cache: a dialog that offered an illegal
    // target would show the tree jump for a moment and snap back with no sentence to explain it.
    expect(applyMove(TREE, { kind: 'folder', id: F_WORK, parentId: F_PROJECTS })).toBe(TREE);
    expect(applyMove(TREE, { kind: 'folder', id: F_WORK, parentId: F_WORK })).toBe(TREE);
    expect(applyMove(TREE, { kind: 'folder', id: F_WORK, parentId: F_DEEP })).toBe(TREE);
    // …and a legal one from the same folder still works, so the guard is a rule and not a blanket.
    expect(applyMove(TREE, { kind: 'folder', id: F_WORK, parentId: F_ARCHIVE }).folders).not.toBe(
      TREE.folders,
    );
  });
});

describe('applyDelete', () => {
  it('deletes a note and nothing else', () => {
    const next = applyDelete(TREE, { kind: 'note', id: N_PLAN });
    expect(names(next)).toEqual(['Work', 'Projects', 'Deep', 'Archive', 'draft', 'ideas']);
  });

  it('takes a folder’s whole subtree with it, which is what `cascade=true` means', () => {
    const next = applyDelete(TREE, { kind: 'folder', id: F_WORK, cascade: true });
    expect(next.folders.map((folder) => folder.name)).toEqual(['Archive']);
    // `plan` was under Work and goes; `draft` is at the root and stays; `ideas` is under a surviving folder.
    expect(next.notes.map((note) => note.name)).toEqual(['draft', 'ideas']);
  });

  it('leaves a childless folder as an empty set of rows rather than a hole', () => {
    expect(names(applyDelete(TREE, { kind: 'folder', id: F_ARCHIVE, cascade: true }))).toEqual([
      'Work',
      'Projects',
      'Deep',
      'plan',
      'draft',
    ]);
  });

  it('is a no-op for an id this cache does not have', () => {
    expect(applyDelete(TREE, { kind: 'note', id: testId('note', 90) })).toBe(TREE);
    expect(applyDelete(TREE, { kind: 'folder', id: testId('folder', 90) })).toBe(TREE);
  });

  it('removes exactly the closed descendant set, and nothing else', () => {
    // One walk (`descendantFolderIds`) decides both "this folder cannot move here" and "these rows disappear".
    // Asserting the delete against the walk rather than against a hand-written list is what keeps the two from
    // splitting later: a change to the walk changes both answers, and this test says so.
    const gone = descendantFolderIds(TREE.folders, F_WORK);
    const next = applyDelete(TREE, { kind: 'folder', id: F_WORK, cascade: true });
    expect(next.folders.map((folder) => folder.id)).toEqual(
      TREE.folders.filter((folder) => !gone.has(folder.id)).map((folder) => folder.id),
    );
    expect(next.notes.map((note) => note.id)).toEqual(
      TREE.notes.filter((note) => note.folderId === null || !gone.has(note.folderId)).map((note) => note.id),
    );
  });
});

describe('moveIsBlocked (the client-side half of §9.2 #14)', () => {
  interface MoveCase {
    readonly target: string | null;
    readonly moving: string;
    readonly blocked: boolean;
  }

  const cases: readonly MoveCase[] = [
    // A folder into itself, the smallest illegal case.
    { target: F_WORK, moving: F_WORK, blocked: true },
    // Into a direct child.
    { target: F_PROJECTS, moving: F_WORK, blocked: true },
    // Into a grandchild: the whole branch is illegal, not just the parent.
    { target: F_DEEP, moving: F_WORK, blocked: true },
    // A sibling.
    { target: F_ARCHIVE, moving: F_WORK, blocked: false },
    // The root is not inside anything.
    { target: null, moving: F_WORK, blocked: false },
    // The parent of a sibling is a legal target.
    { target: F_WORK, moving: F_ARCHIVE, blocked: false },
  ];

  it.each(cases)('moving $moving to $target → blocked $blocked', ({ target, moving, blocked }) => {
    expect(moveIsBlocked(TREE, { kind: 'folder', id: moving, parentId: target })).toBe(blocked);
  });

  it('never blocks a note, which has no subtree to trap it', () => {
    // §9.2 #19's only rule about a note's destination folder is that the caller owns it, and that is the
    // server's to decide. Blocking a note into the folder it is already in would be a rule nobody asked for.
    expect(moveIsBlocked(TREE, { kind: 'note', id: N_PLAN, parentId: F_WORK })).toBe(false);
    expect(moveIsBlocked(TREE, { kind: 'note', id: N_PLAN, parentId: F_PROJECTS })).toBe(false);
  });

  it('says no for a folder this cache does not know about, and asks the server', () => {
    // Nothing to check against, and guessing "blocked" would mean a cold tab cannot move anything at all.
    expect(moveIsBlocked(TREE, { kind: 'folder', id: testId('folder', 90), parentId: F_ARCHIVE })).toBe(
      false,
    );
  });
});

describe('MoveBlockedError / mutationFailureMessage', () => {
  const conflict = new ApiError({
    status: 409,
    code: 'CONFLICT',
    message: 'a sibling already has that name',
  });

  it('shows the server its own words', () => {
    expect(mutationFailureMessage(conflict)).toBe('a sibling already has that name');
  });

  it('shows the client its own words, which are about a request that was never made', () => {
    const blocked = new MoveBlockedError('Projects');
    expect(mutationFailureMessage(blocked)).toContain('cannot move inside itself');
    expect(mutationFailureMessage(blocked)).toContain('Projects');
    // Not an `ApiError`: nothing answered, so there is no status, no code and no request id to show.
    expect(blocked).not.toBeInstanceOf(ApiError);
  });

  it('falls back to the app-wide sentence for anything else', () => {
    // A `TypeError` from inside the app, a `fetch` that never resolved: PR-08's "the server did not answer" is
    // the honest sentence, and it is already the one every other form in this app uses.
    expect(mutationFailureMessage(new TypeError('x'))).not.toBe('x');
    expect(mutationFailureMessage(undefined)).not.toBe('undefined');
  });
});
