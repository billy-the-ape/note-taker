// @vitest-environment jsdom
/**
 * Which folders are folded up, and the fact that it survives a reload
 * (docs/plans/mvp/MVP-12.md §5: "expand/collapse persisted per session").
 *
 * Two halves, and they fail differently. The set arithmetic is a state machine over ids — pure, and cheap to
 * pin. The persistence is the one place in `features/tree/` where a bug is invisible to every other test in
 * this PR: a `ui` store key that is written but never read back looks exactly like a working collapse until a
 * person reloads the page and the tree is open again. So the interesting assertions here are about **what is
 * on disk**, in the key AGENTS.md tells PR-12 to use, rather than about a component that appears to remember.
 *
 * Needs a DOM because `localStorage` is the storage; `lib/uiStore.ts` degrades to "nothing persisted" when it
 * is missing, which is the right behaviour for Safari's private tabs and the wrong thing to test against.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { UI_STORAGE_PREFIX, uiStorageKey } from '../../lib/uiStore';
import {
  COLLAPSED_SEPARATOR,
  parseCollapsed,
  readCollapsed,
  serializeCollapsed,
  TREE_COLLAPSED_KEY,
  toggleCollapsed,
  writeCollapsed,
} from './tree.expansion';

const F_WORK = '019a3b4c-5d6e-7f80-9123-000000000001';
const F_PROJECTS = '019a3b4c-5d6e-7f80-9123-000000000002';
const F_ARCHIVE = '019a3b4c-5d6e-7f80-9123-000000000003';

beforeEach(() => localStorage.clear());

describe('the store key', () => {
  it('is the namespaced ui-store key AGENTS.md reserves for PR-12', () => {
    // Not an assertion about a constant's spelling for its own sake: `uiStore` is the third box in §6's split
    // of client state, and a second key name for the same fact means the sidebar remembers one thing and
    // forgets another depending on which writer ran last.
    expect(TREE_COLLAPSED_KEY).toBe('treeCollapsed');
    expect(uiStorageKey(TREE_COLLAPSED_KEY)).toBe(`${UI_STORAGE_PREFIX}treeCollapsed`);
    expect(localStorage.getItem(uiStorageKey(TREE_COLLAPSED_KEY))).toBeNull();
  });
});

describe('serializeCollapsed / parseCollapsed', () => {
  it('round-trips a set through the string on disk', () => {
    const ids = new Set([F_WORK, F_PROJECTS]);
    expect(parseCollapsed(serializeCollapsed(ids))).toEqual(ids);
  });

  it('writes sorted, so two identical sets are one string', () => {
    // Otherwise the same sidebar state produces two different strings depending on click order, and a diff of
    // what a person's browser is holding stops being readable.
    expect(serializeCollapsed(new Set([F_ARCHIVE, F_WORK]))).toBe(
      serializeCollapsed(new Set([F_WORK, F_ARCHIVE])),
    );
    expect(serializeCollapsed(new Set([F_ARCHIVE, F_WORK]))).toBe(
      [F_ARCHIVE, F_WORK].sort().join(COLLAPSED_SEPARATOR),
    );
  });

  it('writes the empty string for nothing collapsed, which is also what a first run holds', () => {
    expect(serializeCollapsed(new Set())).toBe('');
    expect(parseCollapsed('')).toEqual(new Set());
  });

  it('reads junk as "nothing collapsed" rather than guessing at ids', () => {
    // A truncated write, a value from an older build, somebody's hand in devtools: the default answer is the
    // safe one, which is the whole tree open.
    for (const junk of ['   ', ',,,', ' , ']) {
      expect(parseCollapsed(junk).size).toBe(0);
    }
    // A real id with padding is not junk, though, and is not the same string as the id: trimming happens
    // before the filter, so this is "two folders collapsed", not "one and a discard".
    expect(parseCollapsed(` ${F_WORK} ,${F_PROJECTS}, `)).toEqual(new Set([F_WORK, F_PROJECTS]));
  });
});

describe('toggleCollapsed', () => {
  it('folds a closed set open and an open one shut', () => {
    const first = toggleCollapsed(new Set(), F_WORK);
    expect(first).toEqual(new Set([F_WORK]));
    expect(toggleCollapsed(first, F_WORK)).toEqual(new Set());
  });

  it('returns a new set and leaves the caller’s alone', () => {
    // `FolderTree` hands this straight to `setState`, where mutating the previous value would mean React never
    // sees a new reference and the tree does not repaint.
    const before = new Set([F_WORK]);
    const after = toggleCollapsed(before, F_PROJECTS);
    expect(before).toEqual(new Set([F_WORK]));
    expect(after).toEqual(new Set([F_WORK, F_PROJECTS]));
  });

  it('survives two rapid clicks on the same chevron, in either order', () => {
    // The state is a *function* of the old set for this reason: two clicks that both close over the value from
    // the render would agree on nothing, and the chevron would stop matching the subtree under it.
    const start = new Set<string>([F_ARCHIVE]);
    const once = toggleCollapsed(start, F_WORK);
    const twice = toggleCollapsed(once, F_WORK);
    expect(twice).toEqual(start);
  });
});

describe('readCollapsed / writeCollapsed (the persistence)', () => {
  it('writes what a reload reads back', () => {
    // The half that no component test catches: collapse two folders, and the string on disk is the whole
    // memory the next page load has.
    const ids = new Set([F_WORK, F_ARCHIVE]);
    writeCollapsed(ids);
    expect(localStorage.getItem(uiStorageKey(TREE_COLLAPSED_KEY))).toBe(
      [F_ARCHIVE, F_WORK].sort().join(COLLAPSED_SEPARATOR),
    );
    expect(readCollapsed()).toEqual(ids);
  });

  it('reads "nothing collapsed" on a first run, which is the default the tree renders', () => {
    expect(readCollapsed().size).toBe(0);
  });

  it('does not validate ids, and a stray entry costs nothing', () => {
    // There is deliberately no UUID check: an entry that matches no folder is inert (nothing collapses), so a
    // value from an older build or a hand in devtools degrades to "the tree is open" instead of throwing on
    // the way into the sidebar. Validating here would only move that failure to a place with worse messages.
    localStorage.setItem(uiStorageKey(TREE_COLLAPSED_KEY), 'not-a-tree');
    expect(readCollapsed()).toEqual(new Set(['not-a-tree']));
  });

  it('writes an empty string when the last folder is opened again', () => {
    writeCollapsed(new Set([F_WORK]));
    writeCollapsed(new Set());
    expect(localStorage.getItem(uiStorageKey(TREE_COLLAPSED_KEY))).toBe('');
    expect(readCollapsed().size).toBe(0);
  });
});
