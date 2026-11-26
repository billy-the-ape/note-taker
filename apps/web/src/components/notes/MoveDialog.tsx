/**
 * The "Move to…" picker (docs/plans/mvp/MVP-12.md §5) — a folder tree you can only move *into* the places a
 * move is legal, which is the whole criterion: "Move into own descendant blocked **client-side**".
 *
 * `legalMoveTargets` (see `features/tree/tree.selectors.ts`) returns the root plus every folder that is neither
 * the node itself nor one of its descendants, in tree order, with the depth each one indents to. The picker is
 * that list and nothing more, so the illegal targets are not greyed out and awaiting a click — **they are not
 * in the document**, which is the difference between a dialog that cannot fail and a dialog that fails
 * prettily. `tree.mutations.ts` refuses the same move again before `fetch` (nothing about a dialog is a
 * substitute for the server's advisory-locked check, §9.2 #14), and a rejection from the server still lands in
 * this form's inline message with the tree already rolled back behind it.
 *
 * It is a radiogroup rather than a `<select>` because the tree has depth and a `<select>` of a tree is a list
 * with tabs in it: the radio labels indent the way the sidebar does, the group is one tab stop with arrows
 * inside it (that is what a radiogroup gets you for free), and "which folder is this inside" is legible without
 * opening anything.
 *
 * Moving a note or folder into the folder it is already in is not an error, it is nothing: that option is
 * rendered as the selected one and submit stays disabled, because a `PATCH` that changes nothing should not be
 * sent just because a button was clickable.
 */
import type { FolderNode } from '@note-taker/contracts';
import { useState } from 'react';
import { mutationFailureMessage } from '../../features/tree/tree.mutations';
import type { MoveTarget, NodeKind } from '../../features/tree/tree.selectors';
import { legalMoveTargets, ROOT_LABEL } from '../../features/tree/tree.selectors';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../ui/Dialog';
import { FormMessage } from '../ui/Field';

export interface MoveDialogProps {
  readonly open: boolean;
  readonly kind: NodeKind;
  readonly id: string;
  /** The display name of the thing being moved, in the heading — "Move `Draft.md` to…". */
  readonly name: string;
  /** Where it is now: `null` is the root. The one target that is legal and means "stay". */
  readonly currentParentId: string | null;
  /** The caller's folders. Notes are not destinations, so they are not wanted here. */
  readonly folders: readonly FolderNode[];
  readonly pending: boolean;
  readonly onClose: () => void;
  /** `null` is the root (§9.2 #14's `parentId: null`), and it is a real choice, not "unchanged". */
  readonly onSubmit: (parentId: string | null) => Promise<void>;
}

/** The test id a target answers to: the root has no UUID, so it gets a name instead. */
export function moveTargetTestId(target: MoveTarget): string {
  return target.id === null ? 'move-target-root' : `move-target-${target.id}`;
}

export function MoveDialog({
  open,
  kind,
  id,
  name,
  currentParentId,
  folders,
  pending,
  onClose,
  onSubmit,
}: MoveDialogProps) {
  const targets = legalMoveTargets(folders, { kind, id });
  const [target, setTarget] = useState<string | null>(currentParentId);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // A target that stopped being offered (the list is recomputed from the cache on every render) is not a
  // selection, and submitting it would be submitting an id this dialog never showed anybody.
  const chosen = targets.some((candidate) => candidate.id === target) ? target : currentParentId;
  const unchanged = chosen === currentParentId;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (unchanged) return;
    setFailure(undefined);
    try {
      await onSubmit(chosen);
    } catch (error) {
      setFailure(mutationFailureMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent data-testid="move-dialog" data-node-id={id}>
        <DialogTitle className="text-lg font-semibold text-ink">Move {name} to…</DialogTitle>
        <DialogDescription className="text-sm text-ink-muted">
          {kind === 'folder'
            ? 'A folder never moves inside itself, so its own contents are not offered below.'
            : 'Notes go in one folder, or at the top level.'}
        </DialogDescription>

        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <fieldset className="flex flex-col gap-1 border-0 p-0" data-testid="move-targets">
            <legend className="sr-only">Destination folder</legend>
            {targets.map((candidate) => {
              const isCurrent = candidate.id === currentParentId;
              return (
                <label
                  key={candidate.id ?? 'root'}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-ink hover:bg-paper-2"
                  // Indentation is the tree. `ch` so it survives a font change, and a real string so a screen
                  // reader that reads labels reads the position too.
                  style={{ paddingLeft: `${0.5 + candidate.depth * 1.25}rem` }}
                >
                  <input
                    type="radio"
                    name={`move-target-${id}`}
                    value={candidate.id ?? ''}
                    checked={chosen === candidate.id}
                    onChange={() => {
                      setTarget(candidate.id);
                      setFailure(undefined);
                    }}
                    disabled={pending}
                    data-testid={moveTargetTestId(candidate)}
                    data-current={isCurrent ? 'true' : undefined}
                  />
                  <span className={isCurrent ? 'text-ink-muted' : undefined}>
                    {candidate.name}
                    {isCurrent ? ' (current)' : ''}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {failure === undefined ? null : <FormMessage testId="move-error">{failure}</FormMessage>}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={pending} data-testid="move-cancel">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              disabled={unchanged || pending}
              data-testid="move-submit"
            >
              Move
            </Button>
          </DialogFooter>
        </form>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/** The label the picker puts on the root, re-exported so a test can name it without importing the selector. */
export const MOVE_ROOT_LABEL = ROOT_LABEL;
