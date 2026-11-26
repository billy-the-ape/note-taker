/**
 * The row shell both kinds of tree item are built from (docs/plans/mvp/MVP-12.md §5).
 *
 * There are four files in this directory and this is the reason a fifth exists: `role="treeitem"` and its
 * satellites — `aria-selected`, `aria-level`, `aria-posinset`/`aria-setsize`, the roving `tabIndex`, the
 * `data-testid` PR-19 selects — have to be *identical* for folders and notes, and a screen reader can tell the
 * moment they are not. Two copies of that attribute list is two copies to drift; one shell means
 * `FolderRow`/`NoteRow` differ only in the affordances they render inside (a chevron and a name for a folder,
 * a name with its `.md` for a note).
 *
 * **The keyboard model** is the APG's "tree view" pattern, kept small: one tab stop for the whole tree (the
 * roving `tabIndex`), ↑/↓ through the visible rows, ←/→ into and out of a folder, `Enter` to open, `F2` to
 * rename, `Del` to delete, `Shift+F10` for the same menu the right-click opens. None of that arithmetic lives
 * here: the shell reports key events for the row it is given and *only* for that row (`event.target ===
 * currentTarget`, below), because the buttons inside a row own their own keys — `Enter` on the chevron toggles
 * the folder and must not also be read as `Enter` on the row.
 *
 * **Why a `div` and not a `<button>`**: a `treeitem` is a row with a position in a list, not a control. Nested
 * buttons are not allowed inside a button, and the row has two of them (chevron, menu). Focus and `aria-*` do
 * the work a button would have done.
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';

import type { FlatRow } from '../../features/tree/tree.selectors';

/** How far one level of depth moves a row in. Exported so the skeleton indents the same way. */
export const INDENT_REM = 1;

/**
 * The width a folder's leading affordance occupies — a `size-5` chevron plus the row's `gap-1`.
 *
 * It exists because a note row passes `leading={null}` rather than a spacer span: 480 notes used to carry an
 * empty `<span>` each, purely so their labels lined up with the folders above them. Folding the same 1.5 rem
 * into the indent below keeps the alignment identical with 480 fewer DOM nodes, which is a measurable slice of
 * §6's 500-node render budget.
 */
export const LEADING_REM = 1.5;

/** The `data-testid` a UI test selects a row by, in the two words the tree has. */
export function rowTestId(row: Pick<FlatRow, 'kind' | 'id'>): string {
  return `${row.kind === 'folder' ? 'folder' : 'note'}-row-${row.id}`;
}

export interface TreeRowProps {
  readonly row: FlatRow;
  /** The tree's single selection: the cursor, which is also the roving tab stop. */
  readonly selected: boolean;
  /** Folders only; a note row must not carry `aria-expanded` at all. */
  readonly expanded?: boolean | undefined;
  /** A mutation is in flight: the row's own controls are off, the tree stays readable. */
  readonly busy?: boolean;
  /**
   * Everything that makes a folder a folder: chevron, icon, and PR-16's badge.
   *
   * `null` is a real answer rather than "nothing yet": it means this row has no leading element, so its label
   * lines up by taking {@link LEADING_REM} out of the indent instead.
   */
  readonly leading?: ReactNode | null;
  readonly label: ReactNode;
  readonly trailing?: ReactNode | undefined;
  /** The row's own `⋯` menu, with its right-click wiring already inside it. */
  readonly menu: ReactNode;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  /** Right-click, or its keyboard equivalent. The row has no opinion about which one it was. */
  readonly onContextMenuRequest: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

/**
 * One visible row. It renders no state and decides nothing: `FolderTree` owns which rows exist, which one is
 * selected, whether a folder is open and what the keys do, so the arithmetic of a tree is in exactly one file.
 */
export function TreeRow({
  row,
  selected,
  expanded,
  busy = false,
  leading,
  label,
  trailing,
  menu,
  onSelect,
  onOpen,
  onContextMenuRequest,
  onKeyDown,
  ref,
}: TreeRowProps) {
  const hasLeading = leading !== null && leading !== undefined;

  return (
    <div
      ref={ref}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expanded}
      aria-level={row.depth + 1}
      aria-posinset={row.setPosition}
      aria-setsize={row.setSize}
      aria-busy={busy || undefined}
      data-testid={rowTestId(row)}
      data-node-id={row.id}
      data-kind={row.kind}
      // The roving tab stop: `FolderTree` keeps exactly one row at `0`, so the tree is one Tab from the rest
      // of the page however many rows it has.
      tabIndex={selected ? 0 : -1}
      // Indentation is content, not decoration, so it is a style rather than a Tailwind class list — the depth
      // comes from the selector and no class-name map can know it in advance.
      data-depth={row.depth}
      style={{
        // The indent is the tree: `depth` levels of `INDENT_REM`, plus the leading width a note does not
        // spend on a spacer.
        paddingLeft: `${(hasLeading ? 0 : LEADING_REM) + 0.5 + row.depth * INDENT_REM}rem`,
      }}
      className={`group flex h-8 w-full cursor-default select-none items-center gap-1 pr-1 text-sm
        rounded-md text-ink outline-none hover:bg-paper-2 focus-visible:ring-2 focus-visible:ring-brand
        ${selected ? 'bg-paper-2 font-medium' : ''}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(event) => {
        // The browser's own menu would replace ours and there would be nothing to disagree about later.
        event.preventDefault();
        onContextMenuRequest();
      }}
      onKeyDown={(event) => {
        // Only keys aimed at the row itself. `Enter` on the chevron inside this row belongs to the chevron.
        if (event.target !== event.currentTarget) return;
        onKeyDown(event);
      }}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {menu}
    </div>
  );
}
