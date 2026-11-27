/**
 * The `localStorage` crash fallback (§6 of docs/plans/mvp/MVP-14.md).
 *
 * The buffer is mirrored to `note-draft:<id>` on **every** edit, not on every debounce: the debounce
 * window exists to keep the network quiet, and a tab that dies 200 ms into it must still hold those
 * 200 ms. Nothing here is reactive — the editor asks for the draft once, on mount, and offers to
 * restore it.
 *
 * **Why this is not a key in `lib/uiStore.ts`.** That store is the `nt.`-prefixed preferences box
 * (theme, sidebar width): one small string per name, read on mount. This is a per-note buffer of up
 * to 1 MiB under a key the brief names exactly (`note-draft:<id>`, so PR-19 can assert it), with
 * match-conditional clearing that box has no use for. Two different jobs, and pretending otherwise
 * would put a note body behind `readUi(key, fallback)`.
 *
 * **The cross-tab caveat, stated because it is real.** `localStorage` is shared by every tab of the
 * browser, so the mirror is per-browser-per-note and *not* a per-tab undo stack: two tabs with
 * different unsaved text share one key, and the last writer wins. That is acceptable for a crash
 * fallback and would not be acceptable for the save path, which is why the save path is the versioned
 * `PUT` of PR-10 and this file is never consulted before writing.
 */

import type { DraftMirror } from './autosave';

/** The prefix, exported so a test can say "the only key this app wrote here is mine". */
export const DRAFT_KEY_PREFIX = 'note-draft:';

/** The key one note's mirror lives on: `note-draft:0198…`. */
export function draftKey(id: string): string {
  return `${DRAFT_KEY_PREFIX}${id}`;
}

/**
 * Storage, or `undefined` when it is unreachable. The same three reasons as `uiStore`'s: private
 * mode, blocked storage, and a getter that throws the moment it is touched. A crash fallback that
 * cannot be written is a fallback that is simply absent, so every entry point here degrades rather
 * than throwing — the editor must not die because a browser said no to `setItem`.
 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The mirrored text, or `undefined` when there is none. A stored empty string is a real answer. */
export function readDraft(id: string): string | undefined {
  const store = storage();
  if (store === undefined) return undefined;
  try {
    const raw = store.getItem(draftKey(id));
    return raw === null ? undefined : raw;
  } catch {
    return undefined;
  }
}

/** Mirrors the buffer. A failed write is silent: see {@link storage}. */
export function writeDraft(id: string, content: string): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(draftKey(id), content);
  } catch {
    /* ignored on purpose */
  }
}

/** Drops the mirror outright. Used by "discard this draft", where an old text is the thing to remove. */
export function clearDraft(id: string): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.removeItem(draftKey(id));
  } catch {
    /* ignored on purpose */
  }
}

/**
 * Drops the mirror only while it still holds exactly `content`, and says whether it did.
 *
 * The condition is the whole point. A confirmed write clears the mirror because the server has that
 * text now — but if a second tab typed something newer into the same key, that tab's unsaved text is
 * not this one's to delete. Removing-on-match costs one string comparison and keeps the crash
 * fallback honest in the one case where two tabs disagree.
 */
export function clearDraftIf(id: string, content: string): boolean {
  if (readDraft(id) !== content) return false;
  clearDraft(id);
  return true;
}

/**
 * Whether the mirror holds text the server does not. That is the restore prompt's whole condition:
 * equal means the write landed before the crash and there is nothing to recover, only a stale key.
 */
export function draftNeedsRestore(id: string, content: string): boolean {
  const draft = readDraft(id);
  return draft !== undefined && draft !== content;
}

/**
 * The mirror as the state machine wants it (lib/autosave.ts's `DraftMirror`), bound to one note.
 *
 * The machine takes it as an injected object rather than importing this module for the same reason it
 * takes `save` as a function: the unit suite then sees writes and clears as plain recorded calls and
 * never needs a `localStorage` to exist.
 */
export function createDraftMirror(id: string): DraftMirror {
  return {
    write: (content) => writeDraft(id, content),
    clear: (content) => {
      clearDraftIf(id, content);
    },
  };
}
