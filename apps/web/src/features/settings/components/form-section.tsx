/**
 * The two shared shapes of `/app/settings`: a section with a heading and a sentence, and the
 * "not answered yet" note a mutation shows next to its control.
 *
 * `PendingNote` is an `aria-live` region on purpose. Every one of this screen's writes is optimistic,
 * so the only thing that changes on screen is a word appearing next to the switch — and a screen
 * reader needs to hear that word, not read the row again.
 */
export function FormSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** The copy a mutation that has not answered yet shows next to its control. */
export function PendingNote({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <span aria-live="polite" className="text-sm text-ink-muted">
      {label}
    </span>
  );
}
