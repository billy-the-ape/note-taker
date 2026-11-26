/**
 * The folder tree: browse, create, rename, move, delete (docs/plans/mvp/MVP-12.md §5).
 *
 * This is the only file in the app that knows the shape of the tree at runtime: which rows are visible
 * (`flattenTree`, with the persisted collapsed set), which one the cursor is on, which dialog the cursor is
 * asking for, and what each key does. `FolderRow`/`NoteRow` render one row each, `TreeRow` holds their
 * shared attributes, and `features/tree/*` decides what is legal — so the arithmetic of a tree lives in one
 * file and is testable in one file.
 *
 * Three decisions worth more than their line count:
 *
 * **The cursor is the selection.** `aria-selected` is on exactly one row, and it is the row ↑/↓ are pointing
 * at. A tree where "selected" and "where the keys are" can disagree is a tree whose `aria-selected` is a
 * lie by the time a screen reader gets to it. Focus follows the cursor, and the cursor follows a click, so
 * the three are always the same thing seen three ways.
 *
 * **Mutations are awaited before a dialog closes.** `FolderTree` `await`s the mutation, so a `409` that
 * rolls the cache back is still in front of the person who caused it, in the dialog, before anything
 * disappears (§6: rollback *with an inline error*). The dialog is also where the server's words are read
 * first; the toast is the copy that survives scrolling, which is PR-08's split and not a new idea.
 *
 * **`cascade` is decided here, once.** §5's "a folder delete sends `cascade=true` only after that
 * confirmation" is this expression and no other: the flag is true exactly when the folder had children
 * (which is what made `DeleteConfirm` demand the typed name) and the dialog resolves. A note delete never
 * carries it — a note has no subtree to cascade over.
 *
 * **The new-folder form is inline, above the tree, and the only place the tree's own chrome lives.** The
 * README's `new-file-<msepoch>.md` rule is a *note* rule (PR-15's dialog); a folder is named by whoever
 * makes it, so the form asks for a name and enforces `names.ts`'s rules on the way to the request — the
 * server still decides sibling uniqueness, and its `CONFLICT` arrives in the form's own error line.
 */
import type { TreeResponse } from '@note-taker/contracts';
import { type KeyboardEvent, useState } from 'react';
import { readCollapsed, toggleCollapsed, writeCollapsed } from '../../features/tree/tree.expansion';
import { mutationFailureMessage, useTreeMutations } from '../../features/tree/tree.mutations';
import type { FlatRow } from '../../features/tree/tree.selectors';
import {
  breadcrumbFor,
  countNodes,
  descendantFolderIds,
  displayName,
  flattenTree,
  ROOT_LABEL,
} from '../../features/tree/tree.selectors';
import { DeleteConfirm } from '../notes/DeleteConfirm';
import { MoveDialog } from '../notes/MoveDialog';
import { nameProblem, RenameDialog } from '../notes/RenameDialog';
import { Button } from '../ui/Button';
import { describeBy, Field, FormMessage } from '../ui/Field';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { FolderRow } from './FolderRow';
import { NoteRow } from './NoteRow';

/** Where the new-folder form is putting its folder: `null` is the root, a string is that folder. */
type CreatingIn = { readonly parentId: string | null; readonly parentName: string };

/** The dialog the cursor is asking for, with the row it is about. */
type Dialog = { readonly kind: 'rename' | 'move' | 'delete'; readonly row: FlatRow };

export interface FolderTreeProps {
  /** The caller's tree, straight from `['tree', userId]` — this component never fetches. */
  readonly response: TreeResponse;
  /**
   * `Enter`/double-click on a note, and `null` when the note that was open gets deleted. The shell owns what
   * "open" means — PR-13's editor route is the first real implementation of that idea.
   */
  readonly onOpenNote?: ((note: { readonly id: string; readonly name: string } | null) => void) | undefined;
}

export function FolderTree({ response, onOpenNote }: FolderTreeProps) {
  const { toast } = useToast();
  const mutations = useTreeMutations();

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const [cursor, setCursor] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreatingIn | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Focus targets by row id, because `flattenTree`'s order is what the arrow keys walk and a DOM query for
  // "the next row" would be a second, worse implementation of that order.
  const [elements] = useState(() => new Map<string, HTMLDivElement>());

  const rows = flattenTree(response, { collapsed });
  // The cursor has to survive the tree changing under it: a row that was deleted leaves the cursor on the
  // first row rather than on nothing, which would leave the tree with no tab stop at all.
  const selectedId = rows.some((row) => row.id === cursor) ? cursor : (rows[0]?.id ?? null);
  const counts = countNodes(response);

  const focusRow = (row: FlatRow | undefined): void => {
    if (row === undefined) return;
    setCursor(row.id);
    elements.get(row.id)?.focus();
  };

  const indexOf = (id: string | null): number => rows.findIndex((row) => row.id === id);
  const at = (index: number): FlatRow | undefined => rows.at(Math.max(0, Math.min(rows.length - 1, index)));

  /**
   * Close a row's menu, and put the focus back where it was.
   *
   * The trigger is remounted as a plain button when the menu unmounts (see `TreeContextMenu`), so Radix's
   * "return focus to the trigger" lands on a node that no longer exists and the caret ends up on `<body>` —
   * which in a tree whose rows are a single roving tab stop means the keyboard user has lost their place.
   */
  const closeMenu = (id: string): void => {
    setMenuFor(null);
    elements.get(id)?.focus();
  };

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = toggleCollapsed(current, id);
      writeCollapsed(next);
      return next;
    });
  };

  const openRow = (row: FlatRow): void => {
    if (row.kind === 'folder') {
      // "Open" a folder is the one thing a folder does: fold it out of the way or back into the tree.
      if (row.hasChildren) toggle(row.id);
      return;
    }
    setCursor(row.id);
    onOpenNote?.({ id: row.id, name: displayName(row) });
  };

  /**
   * The keyboard half of §5: `↑ ↓ ← →`, `Enter` open, `F2` rename, `Del` delete.
   *
   * `←`/`→` are the folder semantics every file manager teaches: right opens a folder that has children or
   * steps into it, left closes an open one or steps out to the nearest visible ancestor. Both are computed
   * from `flattenTree`'s order, so a collapsed subtree is invisible to the keyboard exactly as it is to the
   * eye — which is the one property that makes the two agree.
   */
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: FlatRow): void => {
    const index = indexOf(row.id);
    const key = event.key;

    // `steer` is the one place that both stops the browser's key and moves the cursor; each branch below calls
    // it and returns, rather than returning its value, because the handler's job ends there and a `void`
    // function that hands back a value is a lie about what it returns.
    if (key === 'ArrowDown') {
      steer(event, at(index + 1));
      return;
    }
    if (key === 'ArrowUp') {
      steer(event, at(index - 1));
      return;
    }
    if (key === 'Home') {
      steer(event, rows[0]);
      return;
    }
    if (key === 'End') {
      steer(event, rows[rows.length - 1]);
      return;
    }

    if (key === 'ArrowRight') {
      if (row.kind !== 'folder' || !collapsed.has(row.id)) {
        steer(event, at(index + 1));
        return;
      }
      if (row.hasChildren) {
        event.preventDefault();
        toggle(row.id);
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (row.kind === 'folder' && !collapsed.has(row.id) && row.hasChildren) {
        event.preventDefault();
        toggle(row.id);
        return;
      }
      // Step out: the nearest preceding row that is actually above this one in the tree.
      for (let probe = index - 1; probe >= 0; probe -= 1) {
        const candidate = rows[probe];
        if (candidate !== undefined && candidate.depth < row.depth) {
          steer(event, candidate);
          return;
        }
      }
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      openRow(row);
      return;
    }

    if (key === 'F2') {
      event.preventDefault();
      setCursor(row.id);
      setDialog({ kind: 'rename', row });
      return;
    }

    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      setCursor(row.id);
      setDialog({ kind: 'delete', row });
      return;
    }

    // `Shift+F10` and the platform's menu key are the keyboard's right-click, which is how a tree whose every
    // action is in a context menu stays "reachable by keyboard" (§5) without a second set of buttons.
    if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      setCursor(row.id);
      setMenuFor(row.id);
    }
  };

  const steer = (event: KeyboardEvent<HTMLDivElement>, row: FlatRow | undefined): void => {
    event.preventDefault();
    focusRow(row);
  };

  /**
   * Every mutation the tree can start, in one shape: await it, say what happened, and let the caller keep or
   * close the dialog. `after` is what success means for the UI, and an error means the dialog stays open with
   * the server's sentence in it — the tree under it has already been put back the way it was.
   */
  async function run(input: {
    readonly label: string;
    readonly failure: string;
    readonly work: () => Promise<unknown>;
    readonly after?: () => void;
  }): Promise<void> {
    try {
      await input.work();
      toast({ title: input.label, tone: 'success', durationMs: 2_500 });
      input.after?.();
    } catch (error) {
      toast({ title: input.failure, description: mutationFailureMessage(error), tone: 'error' });
      // Re-thrown so the dialog that started it can show the same words inline (§6).
      throw error;
    }
  }

  // ── create ────────────────────────────────────────────────────────────────────────────────────────
  const startCreate = (parentId: string | null): void => {
    const found = parentId === null ? undefined : response.folders.find((folder) => folder.id === parentId);
    setCreating({ parentId, parentName: found?.name ?? ROOT_LABEL });
    // A folder created inside a collapsed folder is a folder the person just failed to see, so the parent
    // opens as part of the same intent.
    if (parentId !== null && collapsed.has(parentId)) toggle(parentId);
  };

  const submitCreate = async (name: string): Promise<void> => {
    if (creating === null) return;
    const { parentId } = creating;
    await run({
      label: 'Folder created',
      failure: 'Could not create that folder',
      work: () => mutations.createFolder.mutateAsync({ name, parentId }),
      after: () => setCreating(null),
    });
  };

  // ── rename / move / delete ────────────────────────────────────────────────────────────────────────
  const submitRename = async (row: FlatRow, name: string): Promise<void> => {
    await run({
      label: 'Renamed',
      failure: 'Could not rename that',
      work: () => mutations.rename.mutateAsync({ kind: row.kind, id: row.id, name }),
      after: () => setDialog(null),
    });
  };

  const submitMove = async (row: FlatRow, parentId: string | null): Promise<void> => {
    await run({
      label: 'Moved',
      failure: 'Could not move that',
      work: () => mutations.move.mutateAsync({ kind: row.kind, id: row.id, parentId }),
      after: () => setDialog(null),
    });
  };

  const submitDelete = async (row: FlatRow): Promise<void> => {
    await run({
      label: 'Deleted',
      failure: 'Could not delete that',
      work: () =>
        mutations.remove.mutateAsync({
          kind: row.kind,
          id: row.id,
          // §5, in one expression: a folder that had children was confirmed by name, and only then does the
          // request carry `cascade=true`. A note never carries it.
          cascade: row.kind === 'folder' && row.hasChildren,
        }),
      // The cursor and the open note both have to let go of a row that no longer exists. `flattenTree` puts
      // the tab stop on the first remaining row by itself; the shell is told in the same step, because an
      // editor open on a deleted note is PR-14's "save into a row that is gone" bug at its source.
      after: () => {
        setDialog(null);
        if (row.kind === 'note') onOpenNote?.(null);
      },
    });
  };

  // ── render ────────────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2" data-testid="folder-tree">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs uppercase tracking-wide text-ink-muted" data-testid="tree-counts">
          {/* The counts are the status bar's job when there is a status bar; here they say what "0 notes"
              means before there is anything else on the screen. */}
          {counts.folders} {counts.folders === 1 ? 'folder' : 'folders'} · {counts.notes}{' '}
          {counts.notes === 1 ? 'note' : 'notes'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => startCreate(null)}
          disabled={mutations.busy || creating !== null}
          data-testid="new-folder"
        >
          New folder
        </Button>
      </div>

      {creating === null ? null : (
        <NewFolderForm
          parentName={creating.parentName}
          busy={mutations.createFolder.isPending}
          onCancel={() => setCreating(null)}
          onSubmit={submitCreate}
        />
      )}

      <div
        role="tree"
        aria-label="Folders and notes"
        aria-multiselectable={false}
        data-testid="tree"
        className="flex flex-col gap-0.5"
      >
        {rows.map((row) =>
          row.kind === 'folder' ? (
            <FolderRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              // A childless folder is a leaf: `aria-expanded` on it would promise a subtree that is not there,
              // and a keyboard user would press `→` and hear nothing happen.
              expanded={row.hasChildren ? !collapsed.has(row.id) : undefined}
              busy={mutations.busy}
              menuOpen={menuFor === row.id}
              onMenuOpenChange={(next) => (next ? setMenuFor(row.id) : closeMenu(row.id))}
              onToggle={() => toggle(row.id)}
              onSelect={() => setCursor(row.id)}
              onOpen={() => openRow(row)}
              onContextMenuRequest={() => {
                setCursor(row.id);
                setMenuFor(row.id);
              }}
              onKeyDown={(event) => onRowKeyDown(event, row)}
              onNewFolder={() => startCreate(row.id)}
              onRename={() => setDialog({ kind: 'rename', row })}
              onMove={() => setDialog({ kind: 'move', row })}
              onDelete={() => setDialog({ kind: 'delete', row })}
              ref={(element) => {
                if (element === null) elements.delete(row.id);
                else elements.set(row.id, element);
              }}
            />
          ) : (
            <NoteRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              busy={mutations.busy}
              menuOpen={menuFor === row.id}
              onMenuOpenChange={(next) => (next ? setMenuFor(row.id) : closeMenu(row.id))}
              onSelect={() => setCursor(row.id)}
              onOpen={() => openRow(row)}
              onContextMenuRequest={() => {
                setCursor(row.id);
                setMenuFor(row.id);
              }}
              onKeyDown={(event) => onRowKeyDown(event, row)}
              onRename={() => setDialog({ kind: 'rename', row })}
              onMove={() => setDialog({ kind: 'move', row })}
              onDelete={() => setDialog({ kind: 'delete', row })}
              ref={(element) => {
                if (element === null) elements.delete(row.id);
                else elements.set(row.id, element);
              }}
            />
          ),
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-1 py-3 text-sm text-ink-muted" data-testid="tree-empty">
          No folders and no notes yet. Make a folder, or start a note and it will land at the top level.
        </p>
      ) : null}

      {dialog === null ? null : (
        <RowDialogs
          dialog={dialog}
          response={response}
          busy={mutations.busy}
          onClose={() => setDialog(null)}
          onRename={(name) => submitRename(dialog.row, name)}
          onMove={(parentId) => submitMove(dialog.row, parentId)}
          onDelete={() => submitDelete(dialog.row)}
        />
      )}
    </div>
  );
}

/** The three dialogs one row can ask for, each mounted only while it is open. */
function RowDialogs({
  dialog,
  response,
  busy,
  onClose,
  onRename,
  onMove,
  onDelete,
}: {
  readonly dialog: Dialog;
  readonly response: TreeResponse;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRename: (name: string) => Promise<void>;
  readonly onMove: (parentId: string | null) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}) {
  const { row } = dialog;
  const shown = displayName(row);
  // `FlatRow.parentId` is already the answer for both kinds — a note row's parent *is* its folder — so the
  // dialogs are told where the row lives without this file reaching into the node for a second opinion.
  const parent = row.parentId;
  const location = breadcrumbFor(response.folders, parent);
  // The dialog is per row: `key` below is what resets a draft between rows, and the id on the panel is what
  // says which row a screenshot was of.

  if (dialog.kind === 'rename') {
    return (
      <RenameDialog
        key={`rename-${row.id}`}
        open
        kind={row.kind}
        id={row.id}
        name={row.name}
        location={location}
        pending={busy}
        onClose={onClose}
        onSubmit={(name) => onRename(name)}
      />
    );
  }

  if (dialog.kind === 'move') {
    return (
      <MoveDialog
        key={`move-${row.id}`}
        open
        kind={row.kind}
        id={row.id}
        name={shown}
        currentParentId={parent}
        folders={response.folders}
        pending={busy}
        onClose={onClose}
        onSubmit={(parentId) => onMove(parentId)}
      />
    );
  }

  const deleting = row.kind === 'folder' && row.hasChildren;
  const subtree = deleting ? subtreeCounts(response, row.id) : undefined;

  return (
    <DeleteConfirm
      key={`delete-${row.id}`}
      open
      kind={row.kind}
      id={row.id}
      displayName={shown}
      location={location}
      requiresName={row.kind === 'note' || deleting}
      alsoDeletes={subtree}
      pending={busy}
      onClose={onClose}
      onConfirm={onDelete}
    />
  );
}

/**
 * `3 folders and 12 notes go with it` — over the whole subtree, not one level, because that is what
 * `cascade=true` (§9.2 #15) really deletes. The count comes from the same `descendantFolderIds` the move
 * dialog bans with, so the sentence under the type-the-name box cannot disagree with what the request does.
 */
function subtreeCounts(response: TreeResponse, folderId: string): string {
  const below = descendantFolderIds(response.folders, folderId);
  const folders = below.size - 1; // the set is closed: it names the folder being deleted too
  const notes = response.notes.filter((note) => note.folderId !== null && below.has(note.folderId)).length;

  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} ${folders === 1 ? 'folder' : 'folders'}`);
  if (notes > 0) parts.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
  const total = folders + notes;
  // The verb agrees with the count, because "1 note go with it" is the kind of sentence that makes a person
  // reread a dialog about a delete and check the tree again.
  return parts.length === 0
    ? 'Nothing else goes with it.'
    : `${parts.join(' and ')} ${total === 1 ? 'goes' : 'go'} with it.`;
}

/**
 * The inline new-folder form.
 *
 * `names.ts` decides what a folder may be called and the server decides whether this sibling already has the
 * name; the form's job is the difference between them — a rule broken can be shown before the request, a name
 * taken cannot. That is why there are two error paths below and why neither one pretends to be the other.
 */
function NewFolderForm({
  parentName,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly parentName: string;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const problem = name.length === 0 ? 'a folder needs a name' : nameProblem('folder', name);
  const inRoot = parentName === 'No folder';
  // An empty box is not a mistake yet, so nothing is complained about before the first keystroke — but the
  // moment there is something in it, the complaint is immediate. Gating this on *submit* would gate it on a
  // button the same rule disables, and the message would be unreachable.
  const shown = dirty ? problem : undefined;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setDirty(true);
    if (problem !== undefined) return;
    setFailure(undefined);
    try {
      await onSubmit(name);
      setName('');
    } catch (error) {
      setFailure(mutationFailureMessage(error));
    }
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-line bg-paper-2 p-2"
      onSubmit={submit}
      noValidate
      data-testid="new-folder-form"
      data-parent={inRoot ? 'root' : parentName}
    >
      <Field
        label={inRoot ? 'New folder at the top level' : `New folder in ${parentName}`}
        htmlFor="new-folder-name"
        error={shown}
      >
        <Input
          id="new-folder-name"
          data-testid="new-folder-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setDirty(true);
            setFailure(undefined);
          }}
          invalid={dirty && problem !== undefined}
          aria-describedby={describeBy('new-folder-name', { error: shown !== undefined })}
          autoComplete="off"
          disabled={busy}
        />
      </Field>

      {failure === undefined ? null : <FormMessage testId="new-folder-error">{failure}</FormMessage>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} data-testid="new-folder-cancel">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={problem !== undefined || busy}
          data-testid="new-folder-submit"
        >
          Create
        </Button>
      </div>
    </form>
  );
}
