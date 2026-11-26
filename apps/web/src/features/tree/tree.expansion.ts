/**
 * Which folders are folded up (docs/plans/mvp/MVP-12.md §5: "expand/collapse persisted per session").
 *
 * The state is a set of **collapsed** ids rather than a set of expanded ones, because the default is
 * "everything open" and a default should be the empty value: a first run, a fresh profile and a database
 * with one folder all behave correctly with nothing stored, and a new folder is open without anyone
 * having to add it to a list.
 *
 * It lives in the `ui` store (`lib/uiStore.ts`) under `nt.treeCollapsed`, which is where AGENTS.md says
 * PR-12/PR-13 put persisted UI rather than inventing a fifth store. The consequence worth naming: it is
 * per *browser profile*, not per tab, so a second tab keeps its own view of the tree in memory and the
 * last writer wins on disk. That is a preference about a sidebar; it is not worth a `Storage` event
 * listener, and `sessionStorage` would lose the tree on the one action this app does constantly —
 * refreshing a note.
 *
 * The value is a comma-joined list of UUIDs rather than JSON, because that is the shape `uiStore` stores
 * (a string in, a string out) and nothing in a UUID needs escaping. Junk on disk reads as "nothing
 * collapsed", which is the same answer a first run gets.
 */
import { readUi, writeUi } from '../../lib/uiStore';

/** The `uiStore` key holding the collapsed folder ids. */
export const TREE_COLLAPSED_KEY = 'treeCollapsed';
/** The separator, exported because a test says what is on disk, not just what is in memory. */
export const COLLAPSED_SEPARATOR = ',';

/** Read the persisted set. An unreachable `localStorage` is "nothing collapsed", which is the default. */
export function readCollapsed(): ReadonlySet<string> {
  return parseCollapsed(readUi(TREE_COLLAPSED_KEY, ''));
}

/** Write the set. A write that fails is silent (see `uiStore`), and costs a re-expand on the next load. */
export function writeCollapsed(ids: ReadonlySet<string>): void {
  writeUi(TREE_COLLAPSED_KEY, serializeCollapsed(ids));
}

/**
 * The one mutation: fold a folder open or shut.
 *
 * Returned as a function of the old set so a caller can hand it to `setState` without closing over a
 * stale value — two rapid clicks on the same chevron must not disagree about which one they were.
 */
export function toggleCollapsed(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** What goes on disk: sorted, so two identical sets are the same string (and a diff is reviewable). */
export function serializeCollapsed(ids: ReadonlySet<string>): string {
  return [...ids].sort().join(COLLAPSED_SEPARATOR);
}

/** What comes back: anything unparseable is the empty set, never a guess about which ids were meant. */
export function parseCollapsed(raw: string): ReadonlySet<string> {
  if (raw.trim().length === 0) return new Set<string>();
  return new Set(
    raw
      .split(COLLAPSED_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}
