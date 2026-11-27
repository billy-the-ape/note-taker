import type { ReactNode } from 'react';

/**
 * The one loading indicator the app has (docs/plans/mvp/MVP-08.md §5).
 *
 * It is a real `role="status"` live region with text, not a decorative circle: a spinner a screen
 * reader cannot announce is a spinner that leaves the user staring at a page that appears to have
 * stopped answering. The text is what is announced, so the caller supplies the sentence
 * ("Loading the tree…") rather than a generic "loading" that says nothing about what is happening —
 * `label` is required for that reason.
 */
export interface SpinnerProps {
  /** What is happening, announced by the live region and shown when `showLabel` is set. */
  readonly label: string;
  /** Render the words next to the circle instead of only in the accessible name. */
  readonly showLabel?: boolean;
  /** Visual size; the touch target is unchanged, since this is never the only way to act. */
  readonly size?: 'sm' | 'md';
}

const SPINNER_SIZES = { sm: 'size-3.5 border-[1.5px]', md: 'size-5 border-2' } as const;

export function Spinner({ label, showLabel = false, size = 'md' }: SpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2" role="status">
      <span
        aria-hidden
        className={`animate-spin rounded-full border-current border-t-transparent ${SPINNER_SIZES[size]}`}
      />
      {/* The accessible name is always there; `showLabel` only decides whether it is also read out loud. */}
      <span className={showLabel ? 'text-sm text-ink-muted' : 'sr-only'}>{label}</span>
    </span>
  );
}

/**
 * A block-level spinner for a region with nothing in it yet, i.e. the state a route is in while the
 * query that would fill it is still running.
 */
export function LoadingBlock({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-ink-muted">
      <Spinner label={label} showLabel />
      {children}
    </div>
  );
}
