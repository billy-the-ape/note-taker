import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

/**
 * The modal primitive (docs/plans/mvp/MVP-08.md §5): Radix's dialog with this app's chrome, and
 * nothing else.
 *
 * Radix is what makes the boring parts correct — focus is trapped inside, `Escape` closes, the rest
 * of the page is `aria-hidden`, and focus returns to the trigger on close. The exported pieces are
 * the ones PR-12/15/16 need; the styling lives here so the tree's context dialog and the settings
 * page's dialog are the same shape.
 *
 * `DialogContent` does not invent a title: Radix warns (and a screen reader guesses) when a dialog is
 * unnamed, so the caller supplies `DialogTitle`, and the type makes that the caller's job rather than
 * a prop with a placeholder in it.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export interface DialogContentProps extends DialogPrimitive.DialogContentProps {
  readonly children: ReactNode;
}

/** The panel, portalled to `document.body` so it escapes any transformed or overflow-hidden ancestor. */
export function DialogContent({ className = '', children, ...rest }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/45" data-testid="dialog-overlay" />
      <DialogPrimitive.Content
        {...rest}
        className={`fixed left-1/2 top-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2
          -translate-y-1/2 flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-xl
          focus:outline-none ${className}`}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * The close button every dismissible dialog wants. Its accessible name is "Close" rather than the
 * glyph, because "×" is announced as "multiplication sign" by some readers and as nothing at all by
 * others.
 */
export function DialogCloseButton({ className = '' }: { readonly className?: string }) {
  return (
    <DialogPrimitive.Close
      aria-label="Close"
      className={`absolute right-3 top-3 rounded-md p-1 text-ink-muted hover:bg-paper-2 hover:text-ink
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
    >
      <span aria-hidden>✕</span>
    </DialogPrimitive.Close>
  );
}

/** The row of actions at the bottom of a dialog, right-aligned, primary last in reading order. */
export function DialogFooter({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}
