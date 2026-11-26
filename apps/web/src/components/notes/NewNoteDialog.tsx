import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useSession } from '../../features/auth/useSession';
import {
  isSiblingNameTaken,
  prefillNoteName,
  readTreeCache,
  useCreateNoteMutation,
} from '../../features/notes/new-note';
import { openNoteInEditor } from '../../features/notes/open-note';
import { ApiError } from '../../lib/api';
import { MD_EXT, noteNameProblem, submittedName } from '../../lib/name';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/Dialog';
import { describeBy, Field, FormMessage } from '../ui/Field';
import { Input } from '../ui/Input';

/**
 * The new-note dialog (docs/plans/mvp/MVP-15.md §5) — the README's file-naming rule, made unbreakable.
 *
 * **The `.md` is not in the input.** `new-file-1700000000000.md` is one string on screen and two nodes in
 * the DOM: a value (`new-file-1700000000000`) and a fixed suffix sibling (`span[data-testid=new-note-suffix]`).
 * A user cannot delete, select, or type over what the input does not hold, so "the suffix cannot be edited
 * or deleted" is a property of the markup rather than of a `keydown` handler that has to catch every way of
 * producing the same character (Backspace, Delete, cut, drag-out, drop, autofill, a screen reader's text
 * replacement, Android keyboards). The one thing that *can* still put `.md` in the value is a paste of
 * `report.md`, and `submittedName()` strips it on the way to the body — belt-and-braces, because the column
 * is documented extension-free.
 *
 * **Nothing here knows which folder is "selected".** The tree is PR-12's and its selection is its own
 * state, so the target arrives as `NewNoteTarget` and `null` means the root: `TopBar`'s and the tree
 * context menu's job is to pass what they have selected, and this dialog's job is to send exactly that or
 * `null`. Guessing a folder is worse than the root, because a note in the wrong folder is a note the user
 * did not ask to move.
 *
 * **Uniqueness is asked of the cache, on a debounce, and never of the API** (§5). The debounce is not there
 * to protect a server — it protects a `Set` lookup from running once per keystroke across a 500-node tree
 * (`FolderTree` of PR-12 renders that many), and it makes the wait a named constant instead of an accident.
 * A name that is free in this cache and taken in the database is not a bug in this dialog: the `409`
 * arrives, the dialog stays open with the text intact, and the tree cache refreshes behind it.
 */

/** How long the dialog waits after a keystroke before it looks at the tree cache (§5's "debounced"). */
export const NAME_CHECK_DEBOUNCE_MS = 200;

/** The field's id, so the label, the `aria-describedby` pair and the tests all name the same control. */
export const NEW_NOTE_FIELD_ID = 'new-note-name';

/** The collision sentence: a rule fragment, in the same voice as the contract's own field errors. */
export const NAME_TAKEN_MESSAGE = 'name already used in this folder';

/** What the dialog says when the failure was not an `ApiError`, i.e. never came from the API at all. */
export const UNKNOWN_CREATE_FAILURE = 'the note could not be created';

/** Where the new note goes: a folder of this user's, or the root when `folderId` is `null`. */
export interface NewNoteTarget {
  readonly folderId: string | null;
  /** The folder's name, for the sentence under the title only. Absent means "home folder". */
  readonly folderName?: string | undefined;
}

export interface NewNoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: NewNoteTarget;
}

/**
 * The dialog, controlled from wherever the "New note" button lives.
 *
 * It is controlled rather than self-opening because it has two hosts and neither owns it: PR-12's `TopBar`
 * (and `StatusBar`) button, and its tree context menu, whose selected folder is the whole reason the dialog
 * needs a target at all.
 */
export function NewNoteDialog({ open, onOpenChange, target }: NewNoteDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-note-dialog"
        // Radix would otherwise focus the first focusable element, which is the input but *with the caret
        // wherever the browser puts it*. Preventing the default and placing it ourselves is what makes
        // "the caret sits before the `.md`" a claim about this file rather than about focus heuristics.
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          placeCaretBeforeSuffix(inputRef.current);
        }}
      >
        <NewNoteForm inputRef={inputRef} target={target} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Focuses the field and puts the caret at the end of what the user can edit — which is immediately before
 * the fixed `.md`, because the value never contains it.
 *
 * This runs **once**, on open. After that the caret is the user's: the input is controlled by `value`, and a
 * controlled React input keeps the caret where the user left it, so nothing here has to fight a re-render.
 */
export function placeCaretBeforeSuffix(input: HTMLInputElement | null): void {
  if (input === null) return;
  const end = input.value.length;
  input.focus();
  input.setSelectionRange(end, end);
}

interface NewNoteFormProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly target: NewNoteTarget;
  readonly onClose: () => void;
}

/**
 * The form inside the panel.
 *
 * It is a separate component because that is how its state gets reset for free: Radix unmounts
 * `DialogContent` when the dialog closes, so the prefill is a `useState` initialiser that runs on every
 * open — no "reset on open" effect to forget, and no chance of the previous attempt's half-typed name or
 * stale `409` riding along into the next note.
 */
function NewNoteForm({ inputRef, target, onClose }: NewNoteFormProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user } = useSession();
  const userId = user?.id ?? null;
  const create = useCreateNoteMutation(userId);

  const [name, setName] = useState(() => prefillNoteName(readTreeCache(client, userId), target.folderId));
  const [collides, setCollides] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  // The debounced uniqueness check. Everything it needs is in the closure — the latest `name` included —
  // and the cleanup clears the pending timer, so a fast typist reads the cache once per pause rather than
  // once per keystroke. No request is made here, in either direction: §5 forbids the endpoint.
  useEffect(() => {
    const timer = setTimeout(() => {
      setCollides(isSiblingNameTaken(readTreeCache(client, userId), target.folderId, name));
    }, NAME_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name, client, userId, target.folderId]);

  const problem = noteNameProblem(name);
  const error = problem?.message ?? (collides ? NAME_TAKEN_MESSAGE : undefined);
  const blocked = error !== undefined;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The disabled button is the promise; this is the same promise, because `Enter` in a text field is a
    // submit that never passes a button. `isPending` is the double-click guard: mutations never retry
    // (`createQueryClient`), and a second `POST /api/notes` is a second note.
    if (blocked || create.isPending) return;

    create.mutate(
      { name: submittedName(name), folderId: target.folderId },
      {
        onSuccess: (note) => {
          // Cache first (the mutation's own `onSuccess` has already written `['note', id]` and the tree),
          // then close, then ask for the caret — in that order, so the editor this navigation mounts can
          // render the note it is being told about instead of a spinner.
          onClose();
          openNoteInEditor({ client, navigate }, note.id);
        },
        onError: (failure) => {
          // No close, no reset: §5's `409` case is "show the inline error and keep the dialog open with the
          // text intact", and the name the stranger took is a fact about the *other* note.
          setServerError(failure instanceof ApiError ? failure.message : UNKNOWN_CREATE_FAILURE);
        },
      },
    );
  };

  return (
    <form className="flex flex-col gap-4" data-testid="new-note-form" onSubmit={submit}>
      <DialogTitle className="text-lg font-semibold text-ink" data-testid="new-note-title">
        New note
      </DialogTitle>
      <DialogDescription className="text-sm text-ink-muted" data-testid="new-note-target">
        {targetSentence(target)}
      </DialogDescription>

      <Field label="Name" htmlFor={NEW_NOTE_FIELD_ID} error={error}>
        {/* One control and one fixed suffix. The suffix is `aria-hidden` on purpose: the input is the whole
            labelled control, and a reader that announced the decoration too would say the name twice over
            ("new note new point m d") for a string the label already implies. */}
        <div className="flex items-stretch">
          <Input
            id={NEW_NOTE_FIELD_ID}
            data-testid={NEW_NOTE_FIELD_ID}
            ref={inputRef}
            value={name}
            spellCheck={false}
            autoComplete="off"
            aria-required="true"
            invalid={blocked}
            aria-describedby={describeBy(NEW_NOTE_FIELD_ID, { error: blocked })}
            className="rounded-r-none border-r-0"
            onChange={(event) => {
              setName(event.target.value);
              // A typed edit makes the last server answer about a name that is no longer in the box.
              setServerError(undefined);
            }}
          />
          <span
            aria-hidden
            data-testid="new-note-suffix"
            className="inline-flex items-center rounded-r-md border border-l-0 border-line bg-paper-2 px-2 text-sm text-ink-muted"
          >
            {MD_EXT}
          </span>
        </div>
      </Field>

      {serverError === undefined ? null : (
        <FormMessage testId="new-note-server-error">{serverError}</FormMessage>
      )}

      <DialogFooter>
        <Button variant="ghost" data-testid="new-note-cancel" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="new-note-create"
          loading={create.isPending}
          disabled={blocked}
        >
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The sentence that tells the user where this note is about to appear, before it has an id. */
export function targetSentence(target: NewNoteTarget): ReactNode {
  return target.folderName === undefined
    ? 'The note is created in your home folder.'
    : `The note is created in ${target.folderName}.`;
}

/**
 * The wiring PR-12's three "New note" affordances call.
 *
 * ```tsx
 * const newNote = useNewNoteDialog();
 * // TopBar / StatusBar:
 * <Button variant="secondary" onClick={() => newNote.openFor()}>New note</Button>
 * // a tree row's context menu, with the row's folder:
 * <MenuItem onSelect={() => newNote.openFor({ folderId: folder.id, folderName: folder.name })}>New note</MenuItem>
 * // …and once per host, anywhere in the tree:
 * {newNote.dialog}
 * ```
 *
 * The `dialog` element is returned rather than rendered here because the host decides where it lives; Radix
 * portals it to `document.body` anyway, so "anywhere" is honest. `openFor()` with no argument is the
 * TopBar/StatusBar case — the root — and passing `{folderId, folderName}` is the context-menu case, which is
 * the whole difference between the two buttons beyond their labels.
 */
export interface NewNoteDialogHandle {
  readonly open: boolean;
  readonly target: NewNoteTarget;
  readonly openFor: (target?: NewNoteTarget) => void;
  readonly close: () => void;
  readonly dialog: ReactNode;
}

const ROOT_TARGET: NewNoteTarget = { folderId: null };

export function useNewNoteDialog(): NewNoteDialogHandle {
  const [target, setTarget] = useState<NewNoteTarget | null>(null);

  const openFor = useCallback((next: NewNoteTarget = ROOT_TARGET) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);

  return {
    open: target !== null,
    target: target ?? ROOT_TARGET,
    openFor,
    close,
    dialog: (
      <NewNoteDialog
        open={target !== null}
        onOpenChange={(next) => (next ? undefined : close())}
        target={target ?? ROOT_TARGET}
      />
    ),
  };
}
