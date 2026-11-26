/**
 * A note row (docs/plans/mvp/MVP-12.md §5): the `TreeRow` shell and the note's name **with the `.md` visible** —
 * "notes shown under their folder with the `.md` suffix visible", which is §5's sentence for this one line of
 * code, and `displayName()`'s reason for existing.
 *
 * `withMd()` from `@note-taker/contracts` is the only place the extension is added (plan §8: `notes.name` is
 * stored extension-free, `stripMd()` on the way in), and it is idempotent, so a name that already looks like a
 * file cannot grow a second suffix on the way to the screen.
 *
 * The leading span keeps the note's name in the same column as the folders around it; it is deliberately not an
 * icon of a page. A note is a leaf and its row is already distinguishable by having no chevron and by the
 * suffix, and §5's "reorder-free" tree is not improved by a glyph that means nothing.
 */
import type { KeyboardEvent, Ref } from 'react';

import type { FlatRow } from '../../features/tree/tree.selectors';
import { displayName } from '../../features/tree/tree.selectors';
import { rowMenuTrigger, TreeContextMenu } from './TreeContextMenu';
import { TreeRow } from './TreeRow';

export interface NoteRowProps {
  readonly row: FlatRow;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onContextMenuRequest: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onRename: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

export function NoteRow({
  row,
  selected,
  busy,
  menuOpen,
  onMenuOpenChange,
  onSelect,
  onOpen,
  onContextMenuRequest,
  onKeyDown,
  onRename,
  onMove,
  onDelete,
  ref,
}: NoteRowProps) {
  // The name a person reads, and the name the dialog asks them to type if they delete it, are the same string —
  // so this call is made once here and handed down rather than recomputed at the other end.
  const label = displayName(row);

  return (
    <TreeRow
      ref={ref}
      row={row}
      selected={selected}
      busy={busy}
      // A note is a leaf: no `aria-expanded`, no chevron (and no spacer pretending to be one —
      // see `LEADING_REM`), and the menu has no "New folder" in it.
      expanded={undefined}
      onKeyDown={onKeyDown}
      onSelect={onSelect}
      onOpen={onOpen}
      onContextMenuRequest={onContextMenuRequest}
      leading={null}
      label={label}
      menu={
        menuOpen ? (
          <TreeContextMenu
            kind="note"
            id={row.id}
            name={label}
            open
            onOpenChange={onMenuOpenChange}
            onRename={onRename}
            onMove={onMove}
            onDelete={onDelete}
            busy={busy}
          />
        ) : (
          rowMenuTrigger({
            id: row.id,
            name: label,
            kind: 'note',
            busy,
            onOpen: () => onMenuOpenChange(true),
          })
        )
      }
    />
  );
}
