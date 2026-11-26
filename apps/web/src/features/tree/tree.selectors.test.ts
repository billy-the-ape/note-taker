/**
 * The tree, as the pure functions the brief asks to be tested as pure functions
 * (docs/plans/mvp/MVP-12.md §6: "flatten / sort / indent / ancestors / descendant test").
 *
 * `GET /api/tree` (§9.2 #12) sends two flat lists, so every claim the UI makes about nesting — what is under
 * what, in which order, how far indented, and which folder a person may not move a thing into — is produced
 * by `tree.selectors.ts` and nowhere else. That is the whole reason this file needs no DOM, no `fetch` and no
 * React: if any of these rules needed a render to check, the rule would exist in a component, and PR-13's
 * editor pane, PR-16's settings and the move picker would each hold their own opinion about the same folder.
 *
 * The fixtures are the two lists, spelled the way the server sends them: flat, unordered, and with the parent
 * id as the only hint of shape. `test/treeApi.ts` provides the row factories so a test writes the three fields
 * it cares about and the reader sees the tree in the `parentId`s.
 */

import type { TreeResponse } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';
import { folderNode, noteNode, testId } from '../../test/treeApi';
import {
  breadcrumbFor,
  buildTree,
  compareNames,
  countNodes,
  descendantFolderIds,
  displayName,
  flattenTree,
  folderAncestors,
  folderHasChildren,
  isDescendantOrSelf,
  legalMoveTargets,
  ROOT_LABEL,
  recentNotes,
} from './tree.selectors';

const F_WORK = testId('folder', 1);
const F_PROJECTS = testId('folder', 2);
const F_ARCHIVE = testId('folder', 3);
const F_NOTES = testId('folder', 4);
const N_DRAFT = testId('note', 1);
const N_PLAN = testId('note', 2);
const N_MEETING = testId('note', 3);
const N_IDEAS = testId('note', 4);

/**
 * The tree every test here starts from, drawn the way it renders:
 *
 * ```text
 * Work/            (root)
 *   Projects/      (Work/Projects)
 *     plan.md
 *   draft.md
 * Archive/         (root)
 * Notes/           (root, empty)
 * ideas.md         (root)
 * ```
 *
 * The response is deliberately *not* in render order: `folders` lists the child before its parent and `notes`
 * lists `plan` before `draft`, because a fixture already sorted would let a broken comparator pass.
 */
const TREE: TreeResponse = {
  folders: [
    folderNode(F_PROJECTS, 'Projects', F_WORK),
    folderNode(F_WORK, 'Work', null),
    folderNode(F_ARCHIVE, 'Archive', null),
    folderNode(F_NOTES, 'Notes', null),
  ],
  notes: [
    noteNode(N_PLAN, 'plan', F_PROJECTS),
    noteNode(N_DRAFT, 'draft', F_WORK),
    noteNode(N_IDEAS, 'ideas', null),
    noteNode(N_MEETING, 'meeting', F_WORK),
  ],
};

/** Just the visible rows, as `"kind:name@depth"` — the one string that says order and indent at once. */
function shape(response: TreeResponse, collapsed?: ReadonlySet<string>): readonly string[] {
  return flattenTree(response, { collapsed }).map((row) => `${row.kind}:${row.name}@${row.depth}`);
}

function ids(response: TreeResponse, collapsed?: ReadonlySet<string>): readonly string[] {
  return flattenTree(response, { collapsed }).map((row) => row.id);
}

describe('compareNames (the order the sidebar is in)', () => {
  it('sorts case-insensitively, so one alphabetic run is one run', () => {
    expect(['beta', 'Alpha', 'gamma'].sort(compareNames)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('breaks a case tie byte-wise, which makes the order total rather than merely stable', () => {
    // `Z` before `a` only *after* the case-insensitive comparison has failed; the two are not the same rule
    // and the second one exists only so a name collision has one answer.
    expect(compareNames('Zeta', 'zeta')).toBeLessThan(0);
    expect(compareNames('a', 'a')).toBe(0);
  });

  it('is not `localeCompare`, so the order does not depend on the container’s ICU data', () => {
    // A `-` is not whitespace and not a letter: locale-aware collation ignores it, plain comparison does not.
    expect(['a-b', 'ab'].sort(compareNames)).toEqual(['a-b', 'ab']);
    // And `ä`: ICU collation in English files it with `a` (so before `z`), a byte comparison puts it after
    // every ASCII letter. Whichever way a machine's ICU leans, this app's sidebar says the same thing, and
    // that is the property a list a person reopens every day needs — not which of the two is "right".
    expect(['ä', 'z'].sort(compareNames)).toEqual(['z', 'ä']);
  });
});

describe('buildTree (nesting the two flat lists)', () => {
  it('nests children under parents and keeps the root level at depth 0', () => {
    const { rootFolders, rootNotes, byId } = buildTree(TREE);
    expect(rootFolders.map((folder) => folder.name)).toEqual(['Archive', 'Notes', 'Work']);
    expect(rootFolders[1]?.depth).toBe(0);
    expect(rootNotes.map((note) => note.name)).toEqual(['ideas']);

    const work = byId.get(F_WORK);
    expect(work?.folders.map((folder) => folder.name)).toEqual(['Projects']);
    expect(work?.notes.map((note) => note.name)).toEqual(['draft', 'meeting']);
    expect(byId.get(F_PROJECTS)?.folders.length).toBe(0);
    expect(byId.get(F_PROJECTS)?.notes.map((note) => note.name)).toEqual(['plan']);
  });

  it('renders an orphan at the root rather than dropping it', () => {
    // A response mid-refetch, or one built by merging a stale cache with a fresh one, can name a parent that
    // is not in the list. Losing the row would be losing the note, and a sidebar that silently eats a
    // person's folder is the worse of the two answers by a wide margin.
    const orphaned: TreeResponse = {
      folders: [folderNode(F_WORK, 'Work', '019a3b4c-5d6e-7f80-9123-99999999999f')],
      notes: [noteNode(N_DRAFT, 'draft', F_WORK)],
    };
    const { rootFolders, byId } = buildTree(orphaned);
    expect(rootFolders.map((folder) => folder.name)).toEqual(['Work']);
    // The orphan is a root *for rendering*, and its own `parentId` is reported as `null` so nothing downstream
    // computes a breadcrumb from an id that is not on screen.
    expect(byId.get(F_WORK)?.parentId).toBeNull();
    expect(shape(orphaned)).toEqual(['folder:Work@0', 'note:draft@1']);
  });

  it('breaks a parent cycle instead of hanging, and still shows every row', () => {
    // The server cannot send this (folder mutations take a per-user advisory lock, §9.2 #14), but a cache
    // merged from two responses can, and a recursive walk with no visited set would take the tab down.
    const cycled: TreeResponse = {
      folders: [folderNode(F_WORK, 'Work', F_PROJECTS), folderNode(F_PROJECTS, 'Projects', F_WORK)],
      notes: [noteNode(N_DRAFT, 'draft', F_WORK)],
    };
    // Neither folder has a reachable root, so the second pass adopts one of them (`Projects`, first by name)
    // and the other stays where the cycle put it. The point is not which of the two is the root — it is that
    // the walk stops, and the note is still on screen underneath its folder.
    expect(shape(cycled)).toEqual(['folder:Projects@0', 'folder:Work@1', 'note:draft@2']);
    // …and each of the two appears exactly once, which is what "it terminated" looks like from outside.
    const idsSeen = ids(cycled);
    expect(idsSeen.filter((id) => id === F_WORK)).toHaveLength(1);
    expect(idsSeen.filter((id) => id === F_PROJECTS)).toHaveLength(1);
  });

  it('keeps a cycle deep in the tree from taking its parent with it', () => {
    const deep: TreeResponse = {
      folders: [
        folderNode(F_WORK, 'Work', null),
        folderNode(F_PROJECTS, 'Projects', F_WORK),
        folderNode(F_ARCHIVE, 'Archive', F_ARCHIVE),
      ],
      notes: [],
    };
    // `Archive` points at itself, which the walk refuses; `Work` was reachable anyway, so the two rows under
    // it are untouched and the self-parent shows up as an ordinary root folder.
    expect(shape(deep)).toEqual(['folder:Archive@0', 'folder:Work@0', 'folder:Projects@1']);
  });
});

describe('flattenTree (order, indent and what is visible)', () => {
  it('draws depth-first with folders before notes at every level', () => {
    // §5's "notes shown under their folder", and the folders-first half is what makes a collapsed folder
    // visible as one row instead of a row plus a hole where its notes used to be.
    expect(shape(TREE)).toEqual([
      'folder:Archive@0',
      'folder:Notes@0',
      'folder:Work@0',
      'folder:Projects@1',
      'note:plan@2',
      'note:draft@1',
      'note:meeting@1',
      'note:ideas@0',
    ]);
  });

  it('puts the depth on the row, which is the indent', () => {
    const rows = flattenTree(TREE);
    const plan = rows.find((row) => row.id === N_PLAN);
    expect(plan?.depth).toBe(2);
    // The root level is 0, and the server counts the §9.2 #13 depth cap the same way — one file, one rule.
    expect(rows.find((row) => row.id === N_IDEAS)?.depth).toBe(0);
  });

  it('hides a collapsed folder’s whole subtree and nothing else', () => {
    const collapsed = new Set([F_WORK]);
    // `Projects`, `plan` and the two notes under Work all disappear; the *other* roots do not, and neither does
    // Work's own row (a collapsed folder is still a folder you can see).
    expect(shape(TREE, collapsed)).toEqual([
      'folder:Archive@0',
      'folder:Notes@0',
      'folder:Work@0',
      'note:ideas@0',
    ]);
    expect(shape(TREE, new Set([F_PROJECTS]))).toEqual(shape(TREE).filter((row) => row !== 'note:plan@2'));
  });

  it('marks the folder with children so a leaf does not get a chevron', () => {
    const byId = new Map(flattenTree(TREE).map((row) => [row.id, row]));
    expect(byId.get(F_WORK)?.hasChildren).toBe(true);
    expect(byId.get(F_ARCHIVE)?.hasChildren).toBe(false);
    expect(byId.get(N_DRAFT)?.hasChildren).toBe(false);
    // The reason it is on the row rather than a helper the caller calls: the delete dialog asks the same
    // question to decide whether the name has to be typed (§5), and the two answers must be the same one.
    expect(byId.get(F_WORK)?.hasChildren).toBe(folderHasChildren(TREE, F_WORK));
  });

  it('numbers visible siblings for aria-posinset/aria-setsize', () => {
    const rows = flattenTree(TREE);
    const work = rows.find((row) => row.id === F_WORK);
    // The root level is one group of four: three folders and a note. `aria-setsize` counts the rows a screen
    // reader can move between under one parent, and a root note is one of them whether or not the two came
    // from different lists in the response.
    expect([work?.setPosition, work?.setSize]).toEqual([3, 4]);
    // Two levels, two independent runs: `plan` is the only visible child of `Projects`.
    const plan = rows.find((row) => row.id === N_PLAN);
    expect([plan?.setPosition, plan?.setSize]).toEqual([1, 1]);
    const draft = rows.find((row) => row.id === N_DRAFT);
    expect([draft?.setPosition, draft?.setSize]).toEqual([2, 3]);
  });

  it('keeps the numbering a self-consistent run, open or collapsed', () => {
    // The invariant a screen reader assumes: under one parent, the positions are exactly `1..n` where `n` is
    // the size it was told. A collapsed folder that left `aria-posinset="6" aria-setsize="7"` behind would
    // announce three rows nobody can tab to, and it would do it silently.
    for (const collapsed of [new Set<string>(), new Set([F_WORK]), new Set([F_PROJECTS, F_WORK])]) {
      const rows = flattenTree(TREE, { collapsed });
      const byParent = new Map<string, readonly (typeof rows)[number][]>();
      for (const row of rows) {
        const key = row.parentId ?? '';
        byParent.set(key, [...(byParent.get(key) ?? []), row]);
      }
      for (const siblings of byParent.values()) {
        expect(Math.max(...siblings.map((row) => row.setPosition))).toBe(siblings.length);
        expect(siblings.map((row) => row.setPosition)).toEqual([...siblings.map((_, index) => index + 1)]);
        expect(new Set(siblings.map((row) => row.setSize))).toEqual(new Set([siblings.length]));
      }
      // A collapsed folder’s whole group is gone, rather than renumbered into a hole.
      if (collapsed.has(F_WORK)) {
        expect(rows.filter((row) => row.parentId === F_WORK)).toEqual([]);
      }
    }
  });

  it('returns no rows for an empty tree, which is what the empty state renders', () => {
    expect(flattenTree({ folders: [], notes: [] })).toEqual([]);
  });
});

describe('descendantFolderIds / isDescendantOrSelf (the rule §9.2 #14 enforces)', () => {
  const DEEP: TreeResponse = {
    folders: [
      folderNode(F_WORK, 'Work', null),
      folderNode(F_PROJECTS, 'Projects', F_WORK),
      folderNode(testId('folder', 5), 'Deep', F_PROJECTS),
      folderNode(F_ARCHIVE, 'Archive', null),
    ],
    notes: [],
  };
  const F_DEEP = testId('folder', 5);

  it('includes the folder itself and every level below it', () => {
    // `includeSelf` is on by default because both callers want the closed set: a folder is never a legal
    // target for its own move, and a delete takes itself with its subtree.
    expect(descendantFolderIds(DEEP.folders, F_WORK)).toEqual(new Set([F_WORK, F_PROJECTS, F_DEEP]));
    expect(descendantFolderIds(DEEP.folders, F_WORK, false)).toEqual(new Set([F_PROJECTS, F_DEEP]));
  });

  it('does not reach sideways or upward', () => {
    expect(descendantFolderIds(DEEP.folders, F_WORK).has(F_ARCHIVE)).toBe(false);
    expect(descendantFolderIds(DEEP.folders, F_ARCHIVE)).toEqual(new Set([F_ARCHIVE]));
    expect(isDescendantOrSelf(DEEP.folders, F_ARCHIVE, F_WORK)).toBe(false);
    expect(isDescendantOrSelf(DEEP.folders, F_PROJECTS, F_WORK)).toBe(true);
  });

  it('says yes to the smallest illegal case, a folder inside itself', () => {
    expect(isDescendantOrSelf(DEEP.folders, F_WORK, F_WORK)).toBe(true);
  });

  it('terminates on a cycle, which is the 100-level-deep version of the same question', () => {
    const cycled = [folderNode(F_WORK, 'Work', F_PROJECTS), folderNode(F_PROJECTS, 'Projects', F_WORK)];
    expect(descendantFolderIds(cycled, F_WORK)).toEqual(new Set([F_WORK, F_PROJECTS]));
  });

  it('walks a 100-level chain without recursion', () => {
    // §9.2 #13 caps the tree at 100 levels, so the deepest question this file can be asked is a hundred
    // frames deep — which is the reason the walk is a queue rather than a recursive call.
    const chain = Array.from({ length: 100 }, (_, i) =>
      folderNode(testId('folder', i + 10), `L${i}`, i === 0 ? null : testId('folder', i + 9)),
    );
    const top = testId('folder', 10);
    expect(descendantFolderIds(chain, top).size).toBe(100);
    expect(isDescendantOrSelf(chain, testId('folder', 109), top)).toBe(true);
    expect(isDescendantOrSelf(chain, top, testId('folder', 109))).toBe(false);
  });
});

describe('folderAncestors / breadcrumbFor (where something is)', () => {
  it('names the chain from the outermost folder in', () => {
    expect(folderAncestors(TREE.folders, F_PROJECTS).map((folder) => folder.name)).toEqual(['Work']);
    expect(breadcrumbFor(TREE.folders, F_PROJECTS)).toBe('Work / Projects');
    expect(breadcrumbFor(TREE.folders, F_WORK)).toBe('Work');
  });

  it('calls the root by its one phrase rather than by nothing at all', () => {
    expect(breadcrumbFor(TREE.folders, null)).toBe(ROOT_LABEL);
    // …and the id of a folder nobody can see is the same answer, rather than a breadcrumb with a hole in it.
    expect(breadcrumbFor(TREE.folders, '019a3b4c-5d6e-7f80-9123-88888888888f')).toBe(ROOT_LABEL);
  });

  it('takes the parent id, so a note’s location does not contain the note', () => {
    const note = noteNode(N_DRAFT, 'draft', F_WORK);
    expect(breadcrumbFor(TREE.folders, note.folderId)).toBe('Work');
  });

  it('stops an orphan’s chain where the evidence stops', () => {
    const orphan = folderNode(F_WORK, 'Work', '019a3b4c-5d6e-7f80-9123-77777777777f');
    expect(folderAncestors([orphan], F_WORK)).toEqual([]);
    expect(breadcrumbFor([orphan], F_WORK)).toBe('Work');
  });
});

describe('legalMoveTargets (what the picker may offer)', () => {
  it('offers the root and every folder the node is not inside of, in tree order', () => {
    // Moving `Work` cannot offer `Work` or `Projects`, and pruning the branch rather than filtering the row is
    // what makes that true two levels down as well as one.
    expect(legalMoveTargets(TREE.folders, { kind: 'folder', id: F_WORK })).toEqual([
      { id: null, depth: 0, name: ROOT_LABEL },
      { id: F_ARCHIVE, depth: 1, name: 'Archive' },
      { id: F_NOTES, depth: 1, name: 'Notes' },
    ]);
  });

  it('never offers the folder itself, nor its own subtree, nor a whole branch below one', () => {
    const targets = legalMoveTargets(TREE.folders, { kind: 'folder', id: F_WORK });
    const offered = targets.map((target) => target.id);
    expect(offered).not.toContain(F_WORK);
    expect(offered).not.toContain(F_PROJECTS);
    // A folder may be moved to the root, which is the one target with no id and no parent to check.
    expect(offered).toContain(null);
    // …and the depths are `root, then one level`: nothing reappears at a shallower indent behind the prune.
    expect(targets.map((target) => target.depth)).toEqual([0, 1, 1]);
  });

  it('offers everything for a note, which has no subtree to trap it in', () => {
    const targets = legalMoveTargets(TREE.folders, { kind: 'note', id: N_DRAFT });
    expect(targets.map((target) => target.id)).toEqual([null, F_ARCHIVE, F_NOTES, F_WORK, F_PROJECTS]);
  });

  it('agrees with isDescendantOrSelf about which targets it removed', () => {
    // Two implementations of one rule is the bug; this assertion is the cheap way of noticing when they split.
    const offered = new Set(legalMoveTargets(TREE.folders, { kind: 'folder', id: F_WORK }).map((t) => t.id));
    for (const folder of TREE.folders) {
      expect(offered.has(folder.id)).toBe(!isDescendantOrSelf(TREE.folders, folder.id, F_WORK));
    }
  });
});

describe('recentNotes (the index page’s list)', () => {
  // Notes here are the whole row, not an id: the ordering field is `contentUpdatedAt` (§9.2 #17), and the
  // three fixtures share nothing except the folder they are standing in.
  const LATE = noteNode(testId('note', 9), 'late', F_WORK, {
    contentUpdatedAt: '2026-03-01T00:00:00.000Z',
  });
  const PLAN_ROW = noteNode(N_PLAN, 'plan', F_PROJECTS, {
    contentUpdatedAt: '2026-02-01T00:00:00.000Z',
  });
  const EARLY = noteNode(testId('note', 8), 'early', null, {
    contentUpdatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('orders by the content, newest first', () => {
    // Unordered input on purpose: a fixture already sorted would pass with a comparator that does nothing.
    expect(recentNotes([PLAN_ROW, LATE, EARLY], 3).map((note) => note.name)).toEqual([
      'late',
      'plan',
      'early',
    ]);
  });

  it('ignores a rename or a move, which is why the field is contentUpdatedAt', () => {
    // `updatedAt` also moves when a note is renamed or moved, and a recents list that reordered itself while
    // a person was looking at it is a list that cannot be clicked.
    const moved = noteNode(testId('note', 7), 'moved', F_WORK, {
      contentUpdatedAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    expect(recentNotes([moved, LATE], 2).map((note) => note.name)).toEqual(['late', 'moved']);
    // Same instant of content, a newer row timestamp: the content decides, not the row.
    const renamed = noteNode(testId('note', 6), 'aaa-renamed', F_WORK, {
      contentUpdatedAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(recentNotes([moved, renamed], 2).map((note) => note.name)).toEqual(['aaa-renamed', 'moved']);
  });

  it('breaks a tie by name, and does not mutate the caller’s array', () => {
    const input = [
      noteNode(N_MEETING, 'meeting', F_WORK),
      noteNode(N_DRAFT, 'draft', F_WORK),
      noteNode(N_IDEAS, 'ideas', null),
    ]; // three notes sharing an instant, listed out of order
    const copy = [...input];
    expect(recentNotes(input, 3).map((note) => note.name)).toEqual(['draft', 'ideas', 'meeting']);
    expect(input).toEqual(copy);
  });

  it('limits without going negative, and returns nothing for nothing', () => {
    expect(recentNotes([PLAN_ROW, LATE], 1).map((note) => note.name)).toEqual(['late']);
    expect(recentNotes([PLAN_ROW], 0)).toEqual([]);
    expect(recentNotes([PLAN_ROW], -1)).toEqual([]);
    expect(recentNotes([])).toEqual([]);
  });
});

describe('displayName (the .md the database never stored)', () => {
  it('shows the extension on a note and never on a folder', () => {
    expect(displayName({ kind: 'note', name: 'draft' })).toBe('draft.md');
    expect(displayName({ kind: 'folder', name: 'Work' })).toBe('Work');
  });

  it('is idempotent, so a name that already looks like a file cannot grow a second extension', () => {
    // A rename dialog that let `draft.md` through would store `draft` (the contract strips it on the way in),
    // and the tree would then render the stored name; this is the belt under that.
    expect(displayName({ kind: 'note', name: 'draft.md' })).toBe('draft.md');
  });
});

describe('countNodes (the status bar)', () => {
  it('counts the two lists it was sent, in the two words the tree has', () => {
    expect(countNodes(TREE)).toEqual({ folders: 4, notes: 4 });
    expect(countNodes({ folders: [], notes: [noteNode(N_DRAFT, 'draft', null)] })).toEqual({
      folders: 0,
      notes: 1,
    });
  });

  it('counts a collapsed tree the same as an open one', () => {
    // Collapsing is a view, not a delete: §5's counts are about the caller's work, not about the sidebar.
    expect(countNodes(TREE)).toEqual(countNodes({ folders: TREE.folders, notes: TREE.notes }));
    expect(flattenTree(TREE, { collapsed: new Set([F_WORK]) }).length).toBeLessThan(flattenTree(TREE).length);
  });
});
