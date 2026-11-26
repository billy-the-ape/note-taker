/**
 * The only place the autosave machine touches a browser (docs/plans/mvp/MVP-14.md §7).
 *
 * Everything a note editor needs to be autosave-safe is wired here and nowhere else: React subscribes
 * to the machine, the flush triggers §6 lists get their listeners, the `localStorage` mirror gets its
 * per-note binding, and the settings flag gets injected. The machine itself (`lib/autosave.ts`) stays
 * DOM-free so every row of its table can be tested with fake timers; the split is the whole reason
 * this file is mostly `addEventListener` calls and almost no logic.
 *
 * ## Where the text is
 *
 * `snapshot.buffer` is the buffer. The editor renders it and calls {@link UseAutosaveResult#edit} with
 * the next one — a textarea holding its own `useState` on top of this hook is two owners of one
 * string, and §5's in-flight snapshot comparison only means something if there is one.
 *
 * ## One machine per note id
 *
 * The machines live in a `Map` on a ref, keyed by id. Two reasons, both real:
 *
 * * A note switch must flush the **outgoing** note. Each machine owns its own listeners, so changing
 *   `id` runs the old machine's effect cleanup, which is where §6's "flush triggers … note switch"
 *   lives. Nothing has to remember the previous id, because the previous machine is still there.
 * * Coming back to a note you typed in two minutes ago must not lose the text if that write never
 *   landed. Keeping the machine keeps the buffer, the `version`, the failure and the conflict.
 *
 * A machine is a closure over three strings and three timers, so "one per note opened by this page
 * load" is not a leak worth engineering around.
 */
import type { NoteWithContent } from '@note-taker/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  type Autosaver,
  type AutosaveSnapshot,
  createAutosaver,
  type FlushOutcome,
} from '../../lib/autosave';
import { clearDraftIf, createDraftMirror, draftNeedsRestore, readDraft } from '../../lib/draft';
import { TREE_KEY_PREFIX } from '../../lib/queryClient';
import { autosaveFlag, settingsOptions } from '../settings/settings.api';
import { createContentSaver, createNoteFromBuffer, syncSavedNote } from './note.mutations';

export interface UseAutosaveOptions {
  /** The note this machine saves. Changing it retires one machine and starts another. */
  readonly id: string;
  /** The content and `version` as loaded (§9.2 #17). Only read when this id's machine is created. */
  readonly content: string;
  readonly version: number;
  /** Where "save as a new note" puts the row after a `404` (§4). Defaults to the root. */
  readonly folderId?: string | null;
  /**
   * §6's injected flag. When it is left out the value comes from `GET /api/settings` (§9.2 #22) — and
   * that request is skipped entirely when it *is* supplied, so a caller that owns the flag (a test, or
   * an editor that already reads the settings row) costs nothing.
   */
  readonly autosave?: boolean;
  /** `Ctrl`/`Cmd+S` on the document. On by default; a caller with its own toolbar can own the keys. */
  readonly saveShortcut?: boolean;
  /** `blur`, `visibilitychange`, `pagehide`, `beforeunload`. On by default (§6's flush triggers). */
  readonly windowFlushes?: boolean;
}

/** The crash fallback, as a prompt (§6: "with a restore prompt"). */
export interface AutosaveDraft {
  /** Text the server has never seen, left behind by a previous visit to this note. */
  readonly content: string | undefined;
  /** Put it in the buffer (and therefore into the next debounce window). */
  readonly restore: () => void;
  /** Throw it away: the key goes empty, which is the only way it stops asking. */
  readonly discard: () => void;
}

export interface UseAutosaveResult {
  /** The machine's view of the world — the buffer, the state, the conflict, the failure. */
  readonly snapshot: AutosaveSnapshot;
  /** The machine itself, for the flush triggers only a caller can know about (a rename, a move). */
  readonly machine: Autosaver;
  /** The flag actually in force, after the injection and the settings read. */
  readonly autosave: boolean;
  /** The editor's `onChange`. */
  readonly edit: (content: string) => void;
  /** `Ctrl`/`Cmd+S` and the Save button: writes with autosave off too (§6). */
  readonly saveNow: () => FlushOutcome;
  /** §6's "folder rename/move affecting the open note", and any navigation the caller owns. */
  readonly flushForNavigation: () => FlushOutcome;
  /** The banner's "Keep mine". */
  readonly resolveKeepMine: () => FlushOutcome;
  /** The banner's "Use server". */
  readonly resolveUseServer: () => void;
  /** §4's manual retry out of `error`. */
  readonly retryNow: () => FlushOutcome;
  /** The `404` escape hatch. Resolves with the created note; rejects with the server's `ApiError`. */
  readonly saveAsNewNote: () => Promise<NoteWithContent>;
  readonly draft: AutosaveDraft;
}

/** A live read of the flag, shared by every machine this hook owns. */
export interface AutosaveFlagRef {
  current: boolean;
}

/**
 * The machine for `id`, created on first sight of it and then reused.
 *
 * `content`/`version` are read here and only here: after this call the machine owns the buffer, and a
 * later server re-read is followed with `adopt` — and only while nothing is unsaved.
 *
 * `settings` is a getter over the caller's ref rather than a captured boolean, so PR-16's toggle is
 * felt by an already-mounted editor: the flag changing must not re-create the machine (that would drop
 * a dirty buffer), and a machine frozen with the boolean from its first render would quietly autosave
 * after a person turned it off.
 */
function machineFor(input: {
  readonly machines: Map<string, Autosaver>;
  readonly id: string;
  readonly content: string;
  readonly version: number;
  readonly flag: AutosaveFlagRef;
  readonly onSaved: (note: NoteWithContent) => void;
}): Autosaver {
  const existing = input.machines.get(input.id);
  if (existing !== undefined) return existing;
  const created = createAutosaver({
    save: createContentSaver(input.id, { onSaved: input.onSaved }),
    settings: () => ({ autosave: input.flag.current }),
    draft: createDraftMirror(input.id),
    content: input.content,
    version: input.version,
  });
  input.machines.set(input.id, created);
  return created;
}

export function useAutosave(options: UseAutosaveOptions): UseAutosaveResult {
  const { id, content, version } = options;
  const folderId = options.folderId ?? null;
  const saveShortcut = options.saveShortcut ?? true;
  const windowFlushes = options.windowFlushes ?? true;

  const client = useQueryClient();

  // The flag: injected when a caller owns it (then no request at all), otherwise the settings row the
  // toggle writes — the same cache entry PR-16 patches, so the pill and the settings page cannot
  // disagree about what "autosave off" means.
  const injected = options.autosave;
  const settingsQuery = useQuery({ ...settingsOptions(), enabled: injected === undefined });
  const autosave = injected ?? autosaveFlag(settingsQuery.data);

  // A live read of the flag, not a captured one: the machine is created once per note id and must not
  // be re-created when a setting changes (that would drop a dirty buffer), and a machine holding the
  // boolean from its first render would quietly go on autosaving after somebody turned it off in
  // PR-16's screen. Assigned during render so the value is current before any listener can read it.
  const flag = useRef(autosave);
  flag.current = autosave;

  const machines = useRef(new Map<string, Autosaver>());
  const onSaved = useCallback((saved: NoteWithContent) => syncSavedNote(client, saved.id, saved), [client]);
  const machine = machineFor({ machines: machines.current, id, content, version, flag, onSaved });

  const snapshot = useSyncExternalStore(machine.subscribe, machine.snapshot, machine.snapshot);

  // When the flag flips back on, a buffer that went dirty while it was off opens a fresh debounce
  // window instead of waiting for the next keystroke to come along and start one.
  useEffect(() => {
    if (autosave) machine.resume();
  }, [autosave, machine]);

  // The server's copy moved under us (a refetch, PR-13's re-read after a conflict) and we have nothing
  // unsaved: follow it. A dirty buffer never moves for a fetch — the alternative is a keystroke losing
  // a race with a response, which is last-write-wins with extra steps.
  useEffect(() => {
    if (machine.isDirty()) return;
    const current = machine.snapshot();
    if (current.version === version && current.buffer === content) return;
    machine.adopt(content, version);
  }, [machine, content, version]);

  // §6's restore prompt. Only worth asking when the mirror holds text this machine has never seen; a
  // mirror equal to the buffer means the last write landed and the key is merely untidy.
  const [staleDraft, setStaleDraft] = useState<string | undefined>(undefined);
  useEffect(() => {
    setStaleDraft(draftNeedsRestore(id, machine.getBuffer()) ? readDraft(id) : undefined);
  }, [id, machine]);

  // §6's flush triggers that live on the window, plus the unload budget and the dirty-guard prompt.
  useEffect(() => {
    if (!windowFlushes || typeof window === 'undefined') return;

    const flushOnBlur = (): void => {
      machine.flushAutomatic();
    };
    const onVisibilityChange = (): void => {
      // `visible` gets nothing: §6 gives no reason to re-read or re-write a note when somebody comes back
      // to it. `hidden` is §11.4's unload-adjacent trigger and goes through the machine's own decision,
      // because a closing tab hides *before* `pagehide` and an ordinary `PUT` started here would occupy
      // rule 1 and then be aborted by the unload — the keepalive write would never start at all.
      if (document.visibilityState === 'hidden') machine.flushOnHide();
    };
    const onPageHide = (): void => {
      machine.flushOnUnload();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // The prompt is the *only* thing standing between a buffer the unload cannot keep (§6's budget, an
      // autosave-off buffer, an ordinary request the unload is about to abort) and the browser's memory,
      // so it is armed by exactly the negation of "the unload carries this" — and never on top of a save
      // already leaving on a transport that survives the unload.
      if (machine.unloadCarriesBuffer()) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('blur', flushOnBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('blur', flushOnBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Unmount is §6's "note switch" trigger wearing a different hat: this machine's listeners are
      // going away, so whatever it still owes goes out now. An in-flight request is not re-sent (rule
      // 1), and a buffer that cannot be sent is what the mirror and the prompt are for.
      machine.flushAutomatic();
    };
  }, [machine, windowFlushes]);

  // `Ctrl`/`Cmd+S`, which works with autosave off (§6) — the flag turns off *automatic* writes, never
  // the ability to save. `preventDefault` is what stops the browser's own "save this page" dialog
  // eating the keystroke; note that this listener is on the document, so exactly one mounted editor may
  // own it, which is what {@link UseAutosaveOptions#saveShortcut} is for.
  useEffect(() => {
    if (!saveShortcut || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's') return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      machine.flush();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [machine, saveShortcut]);

  const edit = useCallback((next: string) => machine.onEdit(next), [machine]);
  const saveNow = useCallback(() => machine.flush(), [machine]);
  const flushForNavigation = useCallback(() => machine.flushAutomatic(), [machine]);
  const resolveKeepMine = useCallback(() => machine.keepMine(), [machine]);
  const resolveUseServer = useCallback(() => machine.useServer(), [machine]);
  const retryNow = useCallback(() => machine.retry(), [machine]);

  const saveAsNewNote = useCallback(async (): Promise<NoteWithContent> => {
    // The text the new row is about to hold, captured *before* the request: a keystroke after this point
    // is text the new row will not have, and the mirror has to keep it.
    const saved = machine.getBuffer();
    const created = await createNoteFromBuffer(saved, folderId);
    // The text is on the server now, under an id this machine never had, so the mirror under the dead
    // id is a stale copy rather than a fallback: it goes with the note that died — but only while it
    // still holds exactly the text that got saved (§6's rule for this key).
    clearDraftIf(id, saved);
    syncSavedNote(client, created.id, created);
    // A new row belongs in the sidebar, so this invalidation is a real refetch and not a `refetchType:
    // 'none'` marking.
    await client.invalidateQueries({ queryKey: TREE_KEY_PREFIX });
    return created;
  }, [client, folderId, id, machine]);

  const draft: AutosaveDraft = {
    content: staleDraft,
    restore: () => {
      if (staleDraft === undefined) return;
      // An edit, not an adopt: restored text is unsaved by definition, and it should reach the server
      // the way a typed sentence would — through the debounce window and the version guard.
      machine.onEdit(staleDraft);
      setStaleDraft(undefined);
    },
    discard: () => {
      // "Throw it away" is an answer about the text the prompt *showed*. The editor stayed usable under
      // the prompt, so `onEdit` may have rewritten the key with something newer by now, and deleting that
      // would break the one rule §6 gives this key — cleared only while it still holds the text being
      // discarded — and lose the crash fallback for text nobody has saved.
      if (staleDraft !== undefined) clearDraftIf(id, staleDraft);
      setStaleDraft(undefined);
    },
  };

  return {
    snapshot,
    machine,
    autosave,
    edit,
    saveNow,
    flushForNavigation,
    resolveKeepMine,
    resolveUseServer,
    retryNow,
    saveAsNewNote,
    draft,
  };
}
