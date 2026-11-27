/**
 * The one layout a setting row on `/app/settings` uses: a name, a sentence about what it changes,
 * and the control on the right.
 *
 * PR-08 owns the shared kit (`components/ui/*`, Radix + Tailwind) and PR-12 owns the app shell this
 * will eventually sit inside; until those exist this file keeps the four rows of this screen
 * consistent without inventing a design system in someone else's folder.
 */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly htmlFor?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 border-b border-ink/10 py-4 last-of-type:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          {htmlFor === undefined ? (
            <span className="font-medium">{title}</span>
          ) : (
            <label className="font-medium" htmlFor={htmlFor}>
              {title}
            </label>
          )}
          <p className="text-sm text-ink-muted">{description}</p>
        </div>
        <div className="flex items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
