/**
 * The tree, as pure functions (docs/plans/mvp/MVP-12.md §5).
 *
 * `GET /api/tree` (§9.2 #12) is deliberately two flat lists of metadata — folders and notes — with no
 * `content` and no nesting: nesting is a question the *client* answers (a collapsed sidebar and an
 * expanded one are different trees), and one recursive CTE returning 400 rows beats 400 requests. So
 * building the tree is the client's job, and this file is the whole of that job — nest, sort, flatten to
 * render order, walk back up for a location, and answer the one question the move dialog cannot ask the
 * server first: "is that folder under the folder I am moving?"
 *
 * **Why every function here is pure.** Acceptance is "flatten / sort / indent / ancestors / descendant
 * tested as pure functions" (§6), and a rule like "a folder never moves inside its own descendant" has to
 * be provable without a DOM. The same proofs are what make the optimistic cache rewrite in
 * `tree.mutations.ts` safe to write, and they are why a 500-node render is a loop over a flat array
 * rather than a recursive render. Components import these and hold no tree logic of their own.
 *
 * **Two rules the API leaves open, decided once here:**
 *
 * * **Order.** Folders before notes at every level, each alphabetical and case-insensitive, ties broken
 *   byte-wise and then by id so the order is *total* and React never re-keys a row because two names
 *   match. `GET /api/tree` answers its two lists in `C` collation, which is a different order, so sorting
 *   is the client's — "alphabetical, reorder-free" (§5) is this comparator and nothing else.
 * * **Nothing is ever orphaned.** A node whose parent is missing is rendered at the root rather than
 *   dropped, and a parent cycle (impossible from this API, which serialises folder mutations, but
 *   constructible by merging a stale cache with a fresh one) is broken at the repeat instead of hanging
 *   the walk. A sidebar that silently loses your notes is worse than one that shows a row one level too
 *   high for the second it takes a refetch to finish.
 */
import { type FolderNode, type NoteNode, type TreeResponse, withMd } from '@note-taker/contracts';

/** Which half of the tree a node came from: the two lists of §9.2 #12, named. */
export type NodeKind = 'folder' | 'note';

/** A folder with its children attached — the nested shape the flat lists do not have. */
export interface FolderBranch {
  readonly kind: 'folder';
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** Root is `0`, which is how the server counts depth too (the §9.2 #13 cap is on this number). */
  readonly depth: number;
  readonly folders: readonly FolderBranch[];
  readonly notes: readonly NoteLeaf[];
  readonly node: FolderNode;
}

/** A note. It is always a leaf, which is why the cycle question is folders only. */
export interface NoteLeaf {
  readonly kind: 'note';
  readonly id: string;
  readonly name: string;
  /** `null` is the root of the tree, exactly as `notes.folder_id` stores it. */
  readonly parentId: string | null;
  readonly depth: number;
  readonly node: NoteNode;
}

export type TreeNode = FolderBranch | NoteLeaf;

/**
 * One row of the sidebar, in the order it is drawn.
 *
 * This is the shape the components render *and* the keyboard walks: `flattenTree` has already decided
 * which nodes are visible (a collapsed folder's whole subtree is not), in what order, and how far each
 * indents. `index` is its position in that list, which is what makes ↑/↓ `index ± 1` rather than a DOM
 * query, and `depth` is what a row turns into left padding — the "indent" half of §6's first box.
 */
export interface FlatRow {
  readonly kind: NodeKind;
  readonly id: string;
  /** The stored name, extension-free. {@link displayName} is what a person reads. */
  readonly name: string;
  readonly depth: number;
  readonly parentId: string | null;
  /** Visible siblings at the same parent, for `aria-posinset`/`aria-setsize`. */
  readonly setSize: number;
  readonly setPosition: number;
  /**
   * A folder with at least one child, note or folder. Drives the chevron and `aria-expanded`, and — the
   * reason it is on the row rather than recomputed by the caller — whether a delete is destructive enough
   * to need the name typed (§5).
   */
  readonly hasChildren: boolean;
  readonly node: FolderNode | NoteNode;
}

/** What `flattenTree` needs beyond the response: which folders are folded up. */
export interface FlattenOptions {
  /** Folded-up folders. `undefined` is "nothing is collapsed", and is the default the caller passes through. */
  readonly collapsed?: ReadonlySet<string> | undefined;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const EMPTY: ReadonlySet<string> = new Set();

/** The root of the tree, in the one phrase the UI uses for it. */
export const ROOT_LABEL = 'No folder';

/**
 * The comparator: case-insensitive first (so `Notes` and `notes` sort as one alphabetic run), then
 * byte-wise, and callers add the id so the order is total.
 *
 * `String.localeCompare` is avoided on purpose — it consults this environment's ICU data, so "which of
 * these two notes is first in my sidebar" would depend on the container's locale. `<` on the lower-cased
 * string is the same answer in every build of this app, which is the property a stable list needs.
 */
export function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/** Names that collide as siblings ignore case; ids never do, so the order ends up total. */
function compareNameAndId(a: { name: string; id: string }, b: { name: string; id: string }): number {
  const byName = compareNames(a.name, b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The root level of a nested tree, plus every built folder by id. */
export interface TreeNesting {
  readonly rootFolders: readonly FolderBranch[];
  readonly rootNotes: readonly NoteLeaf[];
  /** Every folder that exists, including ones inside a collapsed folder. */
  readonly byId: ReadonlyMap<string, FolderBranch>;
}

/**
 * Nest the two flat lists, sorted, with the two rules from the header applied.
 *
 * `buildTree` is the only function here that walks the response; everything below is expressed over its
 * output or over the raw lists, which is what keeps each of them testable with a dozen literal objects.
 */
export function buildTree(response: TreeResponse): TreeNesting {
  const knownFolders = new Set(response.folders.map((folder) => folder.id));
  const childFolders = groupBy(response.folders, (folder) => folder.parentId);
  const childNotes = groupBy(response.notes, (note) => note.folderId);

  const byId = new Map<string, FolderBranch>();
  // "Attached" is what makes the two rules enforceable: a folder attached to a built parent is not a root,
  // and one that never got attached (orphan, or a member of a cycle nobody could reach) becomes one.
  const attachedFolders = new Set<string>();
  const attachedNotes = new Set<string>();

  const sortedFolders = [...response.folders].sort(compareNameAndId);

  const build = (
    folder: FolderNode,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): FolderBranch | undefined => {
    // The cycle break: `ancestors` is the path from the root to here, so a child already on that path is
    // skipped rather than walked forever. Skipping the *child* keeps the parent's subtree visible.
    if (ancestors.has(folder.id)) return undefined;
    const path = new Set(ancestors);
    path.add(folder.id);

    const folders: FolderBranch[] = [];
    for (const child of (childFolders.get(folder.id) ?? []).sort(compareNameAndId)) {
      const built = build(child, depth + 1, path);
      if (built !== undefined) {
        folders.push(built);
        attachedFolders.add(built.id);
      }
    }

    const notes: NoteLeaf[] = [];
    for (const note of (childNotes.get(folder.id) ?? []).sort(compareNameAndId)) {
      notes.push({
        kind: 'note',
        id: note.id,
        name: note.name,
        parentId: folder.id,
        depth: depth + 1,
        node: note,
      });
      attachedNotes.add(note.id);
    }

    const branch: FolderBranch = {
      kind: 'folder',
      id: folder.id,
      name: folder.name,
      // An orphan is reported as a root rather than keeping a parent id nothing renders, which is what makes
      // "nothing is orphaned" true for the rows *below* it too: they are attached to this branch.
      parentId: folder.parentId !== null && knownFolders.has(folder.parentId) ? folder.parentId : null,
      depth,
      folders,
      notes,
      node: folder,
    };
    byId.set(folder.id, branch);
    return branch;
  };

  // Pass one: the folders a walk from nothing can reach — the root level and everything hanging off it.
  for (const folder of sortedFolders) {
    if (folder.parentId === null || !knownFolders.has(folder.parentId)) build(folder, 0, EMPTY);
  }
  // Pass two: whatever a walk from the roots cannot reach, which on a healthy response is nothing and on a
  // cycle is the cycle. Building those at the root is what keeps every row on screen; the `ancestors` set
  // inside `build` is what stops the repeat from recursing forever.
  for (const folder of sortedFolders) {
    if (!byId.has(folder.id)) build(folder, 0, EMPTY);
  }

  const rootFolders = sortedFolders
    .filter((folder) => !attachedFolders.has(folder.id))
    .map((folder) => byId.get(folder.id))
    .filter((branch): branch is FolderBranch => branch !== undefined);

  const rootNotes = response.notes
    .filter((note) => !attachedNotes.has(note.id))
    .map((note) => ({
      kind: 'note' as const,
      id: note.id,
      name: note.name,
      parentId: note.folderId !== null && knownFolders.has(note.folderId) ? note.folderId : null,
      depth: 0,
      node: note,
    }))
    .sort(compareNameAndId);

  return { rootFolders, rootNotes, byId };
}

/**
 * Flatten to render order: one pass over the visible rows, depth-first, folders before notes at each
 * level (§5), skipping the subtree of every collapsed folder.
 *
 * `setSize`/`setPosition` count *visible* siblings under the same parent — "row 3 of 7", which is what
 * `aria-setsize`/`aria-posinset` mean to a screen reader — and they are filled in a second pass, because
 * a flat walk cannot know a level's size while it is writing the level.
 */
export function flattenTree(response: TreeResponse, options: FlattenOptions = {}): readonly FlatRow[] {
  const collapsed = options.collapsed ?? NO_COLLAPSED;
  const nesting = buildTree(response);
  const rows: FlatRow[] = [];

  const push = (node: TreeNode, hasChildren: boolean): void => {
    rows.push({
      kind: node.kind,
      id: node.id,
      name: node.name,
      depth: node.depth,
      parentId: node.parentId,
      setSize: 0,
      setPosition: 0,
      hasChildren,
      node: node.node,
    });
  };

  const walk = (branch: FolderBranch): void => {
    push(branch, branch.folders.length > 0 || branch.notes.length > 0);
    if (collapsed.has(branch.id)) return;
    for (const child of branch.folders) walk(child);
    for (const note of branch.notes) push(note, false);
  };

  for (const folder of nesting.rootFolders) walk(folder);
  for (const note of nesting.rootNotes) push(note, false);

  const positions = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (const row of rows) sizes.set(row.parentId ?? '', (sizes.get(row.parentId ?? '') ?? 0) + 1);
  const numbered = rows.map((row) => {
    const key = row.parentId ?? '';
    const position = (positions.get(key) ?? 0) + 1;
    positions.set(key, position);
    return { ...row, setPosition: position, setSize: sizes.get(key) ?? position };
  });

  return numbered;
}

/**
 * Every folder id strictly below `id`, optionally including `id` itself.
 *
 * `includeSelf` defaults to on because both callers want the closed set: a folder is never a legal target
 * for its own move, and deleting a folder removes it along with everything under it. Iterative, since a
 * 100-level tree (§9.2 #13's cap) would otherwise put 100 frames on the stack for every question.
 */
export function descendantFolderIds(
  folders: readonly FolderNode[],
  id: string,
  includeSelf = true,
): ReadonlySet<string> {
  const children = groupBy(folders, (folder) => folder.parentId);
  const found = new Set<string>();
  if (includeSelf) found.add(id);

  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const child of children.get(current) ?? []) {
      // `found` doubles as the visited set, which is what stops a cycle from spinning here forever.
      if (!found.has(child.id)) {
        found.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return found;
}

/**
 * The rule §9.2 #14 enforces server-side, asked of the cache before a request is sent: a folder may not
 * move inside itself or under one of its own descendants.
 *
 * The server still checks it — under the per-user advisory lock, in the same transaction, which is the
 * only place the answer is *true* — but a picker that offered an illegal target would be a picker that can
 * only ever fail, so this is what removes those options (§6: blocked **client-side**).
 */
export function isDescendantOrSelf(
  folders: readonly FolderNode[],
  candidateId: string,
  ancestorId: string,
): boolean {
  if (candidateId === ancestorId) return true;
  return descendantFolderIds(folders, ancestorId).has(candidateId);
}

/** A folder's parent chain, outermost first; empty for a root folder or an unknown id. */
export function folderAncestors(folders: readonly FolderNode[], id: string): readonly FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: FolderNode[] = [];
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current !== undefined && current.parentId !== null && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (parent === undefined) break; // an orphan's chain stops where the evidence does
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/**
 * Where something lives, in words: `Work / Projects`, or {@link ROOT_LABEL} for the root.
 *
 * It takes the *parent* id, so a note's location is its folder's path rather than a sentence containing
 * the note's own name. The rename and delete dialogs say where the thing they are about is standing.
 */
export function breadcrumbFor(
  folders: readonly FolderNode[],
  parentId: string | null,
  separator = ' / ',
): string {
  if (parentId === null) return ROOT_LABEL;
  const ancestors = folderAncestors(folders, parentId);
  const self = folders.find((folder) => folder.id === parentId);
  if (self === undefined) return ROOT_LABEL;
  const names = [...ancestors.map((folder) => folder.name), self.name];
  return names.length === 0 ? ROOT_LABEL : names.join(separator);
}

/** Whether deleting this folder destroys other people's work, i.e. §5's typed-name rule. */
export function folderHasChildren(response: TreeResponse, id: string): boolean {
  return (
    response.folders.some((folder) => folder.parentId === id) ||
    response.notes.some((note) => note.folderId === id)
  );
}

/** A legal destination in the move picker: `id: null` is the root, `depth` is for the picker's indent. */
export interface MoveTarget {
  readonly id: string | null;
  readonly depth: number;
  readonly name: string;
}

/**
 * The legal destinations for a move: the root, then every folder that is neither the node itself nor one of
 * its descendants, in tree order.
 *
 * A banned branch's whole subtree is banned too (it is below a descendant), so the walk prunes there rather
 * than filtering each row — which is also what makes an illegally deep tree cheap to describe. Notes are
 * leaves, so `kind: 'note'` is unlimited by descent: it can go anywhere, including back to the root.
 *
 * It takes the folders rather than the whole `TreeResponse` because the tree of *destinations* has always
 * been made of folders: a note is not somewhere you can put something.
 */
export function legalMoveTargets(
  folders: readonly FolderNode[],
  moving: { kind: NodeKind; id: string },
): readonly MoveTarget[] {
  const banned = moving.kind === 'folder' ? descendantFolderIds(folders, moving.id) : EMPTY;
  const nesting = buildTree({ folders: [...folders], notes: [] });
  const targets: MoveTarget[] = [{ id: null, depth: 0, name: ROOT_LABEL }];

  const walk = (branch: FolderBranch, depth: number): void => {
    if (banned.has(branch.id)) return;
    // `+ 1` under the root row: the picker indents one level below "No folder", because that is what the
    // tree actually looks like and the picker is supposed to be the tree.
    targets.push({ id: branch.id, depth, name: branch.name });
    for (const child of branch.folders) walk(child, depth + 1);
  };
  for (const folder of nesting.rootFolders) walk(folder, 1);

  return targets;
}

/**
 * The most recently touched notes, newest first.
 *
 * `contentUpdatedAt` is the field that means "the note changed" (§9.2 #17); `updatedAt` also moves when a
 * note is renamed or moved, and a recents list reordered by a move would be a list reordering itself while
 * you are looking at it.
 */
export function recentNotes(notes: readonly NoteNode[], limit = 8): readonly NoteNode[] {
  return notes
    .slice()
    .sort((a, b) => {
      if (a.contentUpdatedAt === b.contentUpdatedAt) return compareNameAndId(a, b);
      return a.contentUpdatedAt < b.contentUpdatedAt ? 1 : -1;
    })
    .slice(0, Math.max(0, limit));
}

/** What the status bar counts, in the only two words the tree has. */
export function countNodes(response: TreeResponse): { folders: number; notes: number } {
  return { folders: response.folders.length, notes: response.notes.length };
}

/**
 * The name a person reads: notes carry back the `.md` the database never stored (plan §8), folders carry
 * their name exactly, and `withMd` is idempotent, so a name that already looks like a file cannot grow a
 * second extension on the way to the screen.
 */
export function displayName(row: Pick<FlatRow, 'kind' | 'name'>): string {
  return row.kind === 'note' ? withMd(row.name) : row.name;
}

/**
 * Whether deleting `deleted` takes the **opened** note with it — the shell's question, answered by the tree's
 * data because the tree is the half that can see both rows.
 *
 * Two directions were both wrong before it was written out. A note row in the sidebar is not necessarily the
 * note on screen, so clearing the shell on *any* note delete drops an editor over a note that is still there;
 * and a folder delete takes its notes with it, including the one being read, which "it was not a note row"
 * quietly missed. A folder's notes are the whole subtree, so this is the same closed set the cascade request
 * destroys, walked the same way.
 */
export function opensDeletedNote(
  response: TreeResponse,
  openedNoteId: string | null | undefined,
  deleted: { readonly kind: NodeKind; readonly id: string },
): boolean {
  if (openedNoteId === null || openedNoteId === undefined) return false;
  if (deleted.kind === 'note') return openedNoteId === deleted.id;

  const opened = response.notes.find((note) => note.id === openedNoteId);
  // A note the cache does not hold is not being read from under this folder — it is not in the tree at all,
  // which is a different problem than the one this answers — and a note at the root is in no subtree.
  if (opened === undefined || opened.folderId === null) return false;
  return descendantFolderIds(response.folders, deleted.id).has(opened.folderId);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    if (name === null) continue; // `null` parents are the root, and the root is not a bucket here
    const bucket = out.get(name);
    if (bucket === undefined) out.set(name, [item]);
    else bucket.push(item);
  }
  return out;
}
