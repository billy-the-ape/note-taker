/**
 * A folder row (docs/plans/mvp/MVP-12.md §5): the `TreeRow` shell, a chevron, the folder's own name, and its
 * menu.
 *
 * The name is rendered **without** a `.md`: the extension is a note idea (plan §8, `docs/NAME-RULES.md`), and a
 * folder called `notes.md` is legitimate, so a folder row prints exactly what is stored. Everything the row
 * *does* — the a11y attributes, indentation, the keyboard, the test id — comes from the shared shell, and the
 * decisions behind it come from `FolderTree`, which owns the tree's state.
 *
 * The chevron is `aria-hidden` and out of the tab order on purpose. `aria-expanded` on the row is the fact a
 * screen reader announces, `Enter` on the row is the keyboard way to change it, and a second control for the
 * same action inside a `treeitem` is a second thing to find by mistake. It is there for the mouse, which is the
 * only pointer this app has to aim.
 */
import type { KeyboardEvent, Ref } from 'react';

import type { FlatRow } from '../../features/tree/tree.selectors';
import { rowMenuTrigger, TreeContextMenu } from './TreeContextMenu';
import { TreeRow } from './TreeRow';

export interface FolderRowProps {
  readonly row: FlatRow;
  readonly selected: boolean;
  /** `undefined` for a childless folder: a leaf has no `aria-expanded` to announce. */
  readonly expanded?: boolean | undefined;
  readonly busy: boolean;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onContextMenuRequest: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onNewFolder: () => void;
  readonly onRename: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

export function FolderRow({
  row,
  selected,
  expanded,
  busy,
  menuOpen,
  onMenuOpenChange,
  onToggle,
  onSelect,
  onOpen,
  onContextMenuRequest,
  onKeyDown,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  ref,
}: FolderRowProps) {
  return (
    <TreeRow
      ref={ref}
      row={row}
      selected={selected}
      expanded={expanded}
      busy={busy}
      onKeyDown={onKeyDown}
      onSelect={onSelect}
      onOpen={onOpen}
      onContextMenuRequest={onContextMenuRequest}
      leading={
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          disabled={busy || !row.hasChildren}
          data-testid={`folder-toggle-${row.id}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-muted hover:text-ink disabled:opacity-30"
          onClick={(event) => {
            // Without the stop, one click would both fold the folder and re-aim the row's cursor, and the two
            // would disagree about which of them the user meant.
            event.stopPropagation();
            onToggle();
          }}
        >
          {/* A plain triangle in an `aria-hidden` button, with the glyph as the button's own text: it is the
              one glyph every platform draws the same way, and a wrapper span inside an element nothing
              pronounces is a DOM node for 500 rows of sidebar. */}
          {expanded ? '▾' : '▸'}
        </button>
      }
      label={row.name}
      menu={
        menuOpen ? (
          <TreeContextMenu
            kind="folder"
            id={row.id}
            name={row.name}
            open
            onOpenChange={onMenuOpenChange}
            onNewFolder={onNewFolder}
            onRename={onRename}
            onMove={onMove}
            onDelete={onDelete}
            busy={busy}
          />
        ) : (
          // A shut menu is a button, not a dropdown root: 500 rows of sidebar is 500 component renders the
          // tree does not need to afford (§6's render budget, and see `TreeContextMenu`'s header).
          rowMenuTrigger({
            id: row.id,
            name: row.name,
            kind: 'folder',
            busy,
            onOpen: () => onMenuOpenChange(true),
          })
        )
      }
    />
  );
}
