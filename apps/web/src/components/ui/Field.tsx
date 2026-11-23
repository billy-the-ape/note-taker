import type { ReactNode } from 'react';

/**
 * Label, control, hint, error — one unit (docs/plans/mvp/MVP-08.md §5, §6).
 *
 * The `<label>` is a real `<label htmlFor>`, never a placeholder: a placeholder disappears the
 * moment anyone types, which is exactly when a password field still needs its label, and
 * `htmlFor` is what makes the click focus the input and what a screen reader reads out.
 *
 * `htmlFor` is a prop rather than a `useId()` inside because the *caller* has to put the same id on
 * the `<input>` (and may want `data-testid` to point at it). The hint and the error are rendered at
 * that id plus `-hint` / `-error`, which is the pair `aria-describedby` is built from — the
 * `describeBy()` helper below exists so a form does not retype that convention.
 *
 * An error replaces the hint rather than joining it. When something is wrong, the thing that is
 * wrong is the only thing worth reading.
 */
export interface FieldProps {
  readonly label: string;
  /** The `id` of the control this label belongs to. */
  readonly htmlFor: string;
  /**
   * `| undefined` twice over, because `exactOptionalPropertyTypes` is on: a form always has the error
   * expression in hand (`fieldErrors.username`) and it is `string | undefined`, and without the explicit
   * `| undefined` every caller would have to build a props object by conditional spread to avoid
   * passing the key at all.
   */
  readonly hint?: ReactNode | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <FieldError htmlFor={htmlFor}>{error}</FieldError>
      ) : hint ? (
        <p id={hintId(htmlFor)} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The id a `Field` renders its error under. */
export function errorId(htmlFor: string): string {
  return `${htmlFor}-error`;
}

/** The id a `Field` renders its hint under. */
export function hintId(htmlFor: string): string {
  return `${htmlFor}-hint`;
}

/**
 * What to hand the control's `aria-describedby`: the error when there is one, otherwise the hint,
 * otherwise nothing. `undefined` rather than `''` so the attribute is absent when it would be empty
 * — an `aria-describedby` pointing at no id is a worse experience than no attribute at all.
 */
export function describeBy(
  htmlFor: string,
  { error = false, hint = false }: { readonly error?: boolean; readonly hint?: boolean } = {},
): string | undefined {
  if (error) return errorId(htmlFor);
  if (hint) return hintId(htmlFor);
  return undefined;
}

/** A field-level error message, in the place `Field` put the ids. */
export function FieldError({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <p id={errorId(htmlFor)} className="text-sm text-danger">
      {children}
    </p>
  );
}

/**
 * A form-level message: the answer that belongs to no single field — "wrong username or password",
 * "self-sign-up is closed on this instance", a `429` with its wait.
 *
 * `role="alert"` because a submit that failed and redrew the same page is otherwise silent: focus
 * never moved, nothing appeared, and the user's next click is another wrong password. It is
 * deliberately **not** `aria-live="polite"` on a node that is already visible at first paint —
 * the message is mounted when it is created, which is what a `role="alert"` region announces.
 */
export function FormMessage({
  tone = 'error',
  testId,
  children,
}: {
  readonly tone?: 'error' | 'info';
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'border-danger/40 bg-danger-soft text-danger'
      : 'border-line bg-surface text-ink-muted';
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}
    >
      {children}
    </p>
  );
}
