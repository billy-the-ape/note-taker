/**
 * The typed-name confirmation (docs/plans/mvp/MVP-12.md §5): "destructive actions (folder with children, note
 * delete) require **typing the item name** to confirm; a folder delete sends `cascade=true` only after that
 * confirmation".
 *
 * Three things this file is responsible for:
 *
 * * **The gate is the button, not a warning.** `data-testid="delete-confirm-submit"` stays `disabled` until the
 *   box holds the item's name exactly — §6's "button disabled until it matches". No colour-only "are you
 *   sure?" and no `confirm()`: an unconfirmable dialog is a dialog whose Enter key is a data-loss shortcut.
 * * **What has to be typed is what the row shows**, i.e. the display name, `.md` and all. A person copying the
 *   name off the tree types what they can see; asking for the stored name instead would be a test of whether
 *   they know this app does not store extensions, and `plan` vs `plan.md` is not a distinction you want to
 *   get wrong on the way to a delete.
 * * **`requiresName` is a decision the caller makes**, from `folderHasChildren` for a folder and always for a
 *   note. An empty folder delete is not the same event as deleting a subtree, and a confirmation that always
 *   demands typing teaches people to type without reading — which is the opposite of what a typed
 *   confirmation is for.
 *
 * The `cascade` question is *not* asked here. The caller passes `cascade` when it decided the delete was
 * destructive, and `tree.api.ts` puts it in the query string; this component only ever asks "do you mean
 * this", never "and everything under it too" — those are the same click, and one dialog should have one
 * question. A folder that turned out not to be empty under us answers §9.2 #15's `CONFLICT`, which arrives in
 * the inline message below with the tree still intact.
 */
import { useState } from 'react';
import { mutationFailureMessage } from '../../features/tree/tree.mutations';
import type { NodeKind } from '../../features/tree/tree.selectors';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../ui/Dialog';
import { Field, FormMessage } from '../ui/Field';
import { Input } from '../ui/Input';

export interface DeleteConfirmProps {
  readonly open: boolean;
  readonly kind: NodeKind;
  readonly id: string;
  /** What the row reads as (`Draft.md`), and therefore what has to be typed. */
  readonly displayName: string;
  /** Where it lives, so the dialog can say which `draft` is going. */
  readonly location?: string;
  /** A folder with children, or any note: §5's destructive cases. */
  readonly requiresName: boolean;
  /** `3 folders and 12 notes go with it`, or absent when nothing does. The caller counts. */
  readonly alsoDeletes?: string | undefined;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}

export function DeleteConfirm({
  open,
  kind,
  id,
  displayName,
  location,
  requiresName,
  alsoDeletes,
  pending,
  onClose,
  onConfirm,
}: DeleteConfirmProps) {
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // Exact, not "contains" and not trimmed-equal: the point of typing a name is that you looked at it, and a
  // matcher that forgives a trailing space has quietly removed the only friction the dialog has.
  const matches = draft === displayName;
  const ready = !requiresName || matches;
  const where = location === undefined || location.length === 0 ? 'the top level' : location;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setFailure(undefined);
    try {
      await onConfirm();
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
      <DialogContent data-testid="delete-confirm" data-node-id={id} data-kind={kind}>
        <DialogTitle className="text-lg font-semibold text-ink">
          Delete {kind === 'folder' ? 'folder' : 'note'}
        </DialogTitle>
        <DialogDescription className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{displayName}</span> is in {where}.
          {alsoDeletes === undefined ? null : <span> {alsoDeletes}</span>} This cannot be undone.
        </DialogDescription>

        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {requiresName ? (
            <Field
              label={`Type “${displayName}” to confirm`}
              htmlFor="delete-confirm-name"
              hint="The name exactly as it appears in the tree."
            >
              <Input
                id="delete-confirm-name"
                data-testid="delete-confirm-name-input"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFailure(undefined);
                }}
                invalid={failure !== undefined}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
            </Field>
          ) : (
            <p className="text-sm text-ink-muted" data-testid="delete-confirm-empty-hint">
              Nothing is filed inside it, so this deletes the folder alone.
            </p>
          )}

          {failure === undefined ? null : <FormMessage testId="delete-error">{failure}</FormMessage>}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={pending} data-testid="delete-cancel">
              Keep it
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={pending}
              disabled={!ready || pending}
              data-testid="delete-confirm-submit"
            >
              Delete
            </Button>
          </DialogFooter>
        </form>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
