import type { InputHTMLAttributes, Ref } from 'react';

/**
 * The only text input in the app (docs/plans/mvp/MVP-08.md §5).
 *
 * Two things it exists for beyond a class list:
 *
 * * `invalid` sets `aria-invalid` as well as painting the border red. A red outline is information a
 *   screen reader does not get, and `:user-invalid` cannot express "the *server* said no" — which is
 *   most of what this app reports (docs/plans/mvp/MVP-08.md §6).
 * * It is a plain `<input>`, so every native attribute (`autoComplete`, `name`, `inputMode`,
 *   `required`) stays available to the caller. Password managers and Safari's autofill read those,
 *   and PR-08's acceptance criteria include them.
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Renders the error ring and announces the field as invalid. Pair it with `Field`'s `error`. */
  readonly invalid?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid = false, className = '', ref, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`h-10 w-full rounded-md border bg-surface px-3 text-base text-ink
        placeholder:text-ink-muted placeholder:opacity-70
        focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1 focus:ring-offset-paper
        disabled:cursor-not-allowed disabled:opacity-60
        ${invalid ? 'border-danger' : 'border-line'} ${className}`}
    />
  );
}
