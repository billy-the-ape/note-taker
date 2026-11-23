import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { Spinner } from './Spinner';

/**
 * The only button in the app (docs/plans/mvp/MVP-08.md §5).
 *
 * Four variants because that is the whole vocabulary a notes app needs: one thing to want
 * (`primary`), one thing that is also allowed (`secondary`), one thing that is not a button until
 * you hover it (`ghost`), and one thing that cannot be undone (`danger`). Anything else is a class
 * list someone will have to guess the meaning of in six months.
 *
 * It takes `ref` as a plain prop rather than through `forwardRef` (React 19), which is also what
 * lets it sit inside a Radix `asChild` trigger — the primitive clones it and hands it the trigger's
 * own props and ref, and a component that swallowed `ref` would silently break that menu.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand/90 focus-visible:ring-brand',
  secondary: 'bg-surface text-ink border border-line hover:bg-paper-2 focus-visible:ring-brand',
  ghost: 'bg-transparent text-ink-muted hover:bg-paper-2 hover:text-ink focus-visible:ring-brand',
  danger: 'bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-sm gap-1.5',
  md: 'h-10 px-4 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * Spins in place of the label and disables the button. The label stays in the accessible name, so
   * a submitting form never announces itself as an empty control.
   */
  readonly loading?: boolean;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  children,
  className = '',
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex select-none items-center justify-center rounded-md font-medium transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-paper
        disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {loading ? <Spinner label="Working" size="sm" /> : null}
      {children}
    </button>
  );
}
