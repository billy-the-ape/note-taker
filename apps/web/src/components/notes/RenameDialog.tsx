/**
 * The rename form (docs/plans/mvp/MVP-12.md §5) — shared by a folder and a note, and the shape a dialog here
 * takes: Radix's `Dialog` from `components/ui/Dialog.tsx`, `Field`/`Input` from the UI kit, and **the server's
 * refusal shown inline**.
 *
 * Why inline and not only a toast (§5 asks for it by name here): a `409 CONFLICT` from a rename is a fact about
 * the box you are typing in — "a sibling already has that name" — and the fix is to type something else. A
 * toast that fades in ten seconds while the form is still open loses its correction to the memory of the person
 * making it. The toast still fires for the same failure at the mutation layer, which is PR-08's split: field
 * failures next to the field, everything else in the corner of the screen.
 *
 * **The `.md` is not in the box.** `notes.name` is stored extension-free (plan §8, `docs/NAME-RULES.md`), the
 * tree renders it back with `withMd()`, and the README's rule is that the extension is not editable — so the
 * field is prefilled with the stored name and says why it has no suffix. Prefilling `plan.md` would put the app
 * in the position of stripping what it just displayed, which is how a note called `plan.md` — rendered as
 * `plan.md.md` — eventually exists.
 *
 * **State resets by unmounting, not by an effect.** The caller renders this component only while a row is being
 * renamed, so a rename of a second row is a second mount with that row's name. The alternative (a dialog that
 * stays mounted and re-initialises) is how a form ends up submitting the previous row's draft, and Radix keeps a
 * dialog mounted while it animates out — which is exactly the window in which that mistake becomes visible.
 *
 * `onSubmit` rejects rather than returning an error object: the promise is TanStack Query's, and a form that has
 * to know every way a mutation can fail is a form that re-implements the mutation layer.
 */
import { folderNameRejection, NAME_REJECTION_MESSAGES, noteNameRejection } from '@note-taker/contracts';
import { useState } from 'react';
import { mutationFailureMessage } from '../../features/tree/tree.mutations';
import type { NodeKind } from '../../features/tree/tree.selectors';
import { ROOT_LABEL } from '../../features/tree/tree.selectors';
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

/** What the form shows while it is open, and what a submit needs to know. */
export interface RenameDialogProps {
  readonly open: boolean;
  readonly kind: NodeKind;
  /** The row's id, on the `data-node-id` of the panel: two rows renamed in a row should be tellable apart. */
  readonly id: string;
  /** The **stored** name, extension-free — the same string the input is filled with. */
  readonly name: string;
  /** Where the row lives, so renaming `draft` in two folders says which one is being renamed. */
  readonly location?: string;
  readonly pending: boolean;
  readonly onClose: () => void;
  /** Resolves when the rename is done; rejects with whatever the mutation threw. */
  readonly onSubmit: (name: string) => Promise<void>;
}

/**
 * The rule the box broke, in the contract's own words, or `undefined` when the name is usable.
 *
 * Exported because PR-15's new-note dialog has the same field and must not re-type the rules — `names.ts` is
 * the one place they live (AGENTS.md), and this is the one place they become a sentence under an input.
 */
export function nameProblem(kind: NodeKind, raw: string): string | undefined {
  const rejection = kind === 'folder' ? folderNameRejection(raw) : noteNameRejection(raw);
  return rejection === undefined ? undefined : NAME_REJECTION_MESSAGES[rejection];
}

export function RenameDialog({
  open,
  kind,
  id,
  name,
  location,
  pending,
  onClose,
  onSubmit,
}: RenameDialogProps) {
  const [value, setValue] = useState(name);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const problem = value.length === 0 ? 'a name cannot be empty' : nameProblem(kind, value);
  const unchanged = value === name;
  const where = location === undefined || location === ROOT_LABEL ? 'the top level' : location;
  const inputId = `rename-name-${id}`;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (problem !== undefined || unchanged) return;
    setFailure(undefined);
    try {
      // Resolves only once the cache has been told; the caller closes the dialog when it does.
      await onSubmit(value);
    } catch (error) {
      // §5: a conflict belongs in the form, and the tree has already rolled back by the time this line runs.
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
      <DialogContent data-testid="rename-dialog" data-node-id={id}>
        <DialogTitle className="text-lg font-semibold text-ink">
          Rename {kind === 'folder' ? 'folder' : 'note'}
        </DialogTitle>
        <DialogDescription className="text-sm text-ink-muted">
          Names are referenced everywhere: this one is in {where}.
        </DialogDescription>

        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <Field
            label="Name"
            htmlFor={inputId}
            error={problem}
            hint={kind === 'folder' ? undefined : 'The .md extension is shown in the tree, never stored.'}
          >
            <Input
              id={inputId}
              data-testid="rename-name"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                // A stale conflict message above a box that has since been rewritten is a message about a
                // request that is no longer the one on screen.
                setFailure(undefined);
              }}
              invalid={problem !== undefined}
              autoComplete="off"
              // A dialog that can submit while the server is still answering the first submit is two renames,
              // and the second one's sibling clash is the first one's own name.
              disabled={pending}
            />
          </Field>

          {failure === undefined ? null : <FormMessage testId="rename-error">{failure}</FormMessage>}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={pending} data-testid="rename-cancel">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              // Unchanged is not a rename: a `PATCH` that changes nothing is a request that reports a success
              // nobody needed, and a button that sends it claims to have done something.
              disabled={problem !== undefined || unchanged || pending}
              data-testid="rename-submit"
            >
              Rename
            </Button>
          </DialogFooter>
        </form>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
