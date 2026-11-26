/**
 * The tiny persisted UI store (docs/plans/mvp/MVP-08.md §6).
 *
 * §6 splits client state three ways: server state is TanStack Query's, routing is the router's, and
 * "transient UI state is local + a tiny `ui` store persisted in `localStorage`". This file is the third
 * box, and it is deliberately the boring one: a namespaced key, a string in, a string out, and no
 * reactivity — a component that cares re-reads on mount, because the only thing in here today is a theme
 * the page paints once.
 *
 * **What does not go in here.** Anything another device would need (that is PR-09's settings row),
 * anything a second component has to agree on right now (that is React state), and anything secret. PR-12
 * adds a persisted sidebar collapse and PR-13 a note sort order; both are one key name away, which is the entire reason
 * the store exists rather than each component inventing its own `localStorage` incantation.
 *
 * Values are stored as plain strings, not JSON. A quoted `"dark"` in a debugging console is a worse
 * experience than a bare one, and no value this app holds today needs anything a string cannot say.
 */

/** The prefix every key here carries, so this app cannot collide with anything else on the origin. */
export const UI_STORAGE_PREFIX = 'nt.';

/** The names this store knows about. PR-12/13 add to this union; nothing else names a key ad hoc. */
export type UiKey = 'theme' | 'sidebarCollapsed' | 'treeCollapsed';

/** The storage key a name lands on: `theme` is `nt.theme`. */
export function uiStorageKey(key: UiKey): string {
  return `${UI_STORAGE_PREFIX}${key}`;
}

/**
 * The store, or `undefined` when storage is unreachable. It is not always there — Safari's private tabs,
 * cookies blocked, a `localStorage` getter that throws the moment it is touched — and a preference that
 * cannot be persisted is still a preference for the length of the visit, so every entry point here
 * degrades instead of throwing.
 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Reads a key, or the caller's fallback. The caller supplies the fallback rather than the store knowing
 * every default, because a default is a fact about the feature: PR-12's sidebar collapse and its collapsed
 * folder ids both belong to the components that draw them, not to this file.
 *
 * Note the union is three names wide as of PR-12 and this function still knows nothing about any of them.
 * `treeCollapsed`'s value is a comma-joined list of ids (see `features/tree/tree.expansion.ts`) and
 * `sidebarCollapsed`'s is the word `true`: encoding is the feature's business, storage is the store's.
 */
export function readUi(key: UiKey, fallback: string): string {
  const store = storage();
  if (store === undefined) return fallback;
  try {
    const raw = store.getItem(uiStorageKey(key));
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/** Writes a key. A failed write is silent on purpose: see `storage()`. */
export function writeUi(key: UiKey, value: string): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(uiStorageKey(key), value);
  } catch {
    /* ignored on purpose */
  }
}

/**
 * Drops every key this app wrote. `test/setup.ts` clears the whole window between tests; this exists for
 * a caller (or a test) that wants only its own keys back, and it is careful because `localStorage` on
 * `localhost` is shared by everything running on that port.
 */
export function clearUi(): void {
  const store = storage();
  if (store === undefined) return;
  try {
    for (const name of Object.keys(store)) {
      if (name.startsWith(UI_STORAGE_PREFIX)) store.removeItem(name);
    }
  } catch {
    /* ignored on purpose */
  }
}
