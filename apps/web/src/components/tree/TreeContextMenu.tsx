/**
 * The row's menu: New folder, Rename, Move to…, Delete (docs/plans/mvp/MVP-12.md §5).
 *
 * It is Radix's dropdown from `components/ui/Menu.tsx`, which PR-08 built for exactly this ("PR-12's tree
 * context menu needs all of it"): roving focus inside the menu, `Escape`, close on outside click, and the items
 * moving under the arrow keys. Writing that again would have been a second menu with a worse keyboard.
 *
 * **It is one menu with two doors.** The `⋯` button opens it for a mouse, and `FolderTree` opens the same menu
 * for a right-click or `Shift+F10` on the focused row. One menu, one set of items, one `open` state owned by the
 * tree: a separate "context menu" implementation is how a tree ends up with a right-click menu whose items
 * differ from its button menu, which is the sort of thing nobody notices until PR-19's e2e run finds the one
 * action that was only ever in one of them.
 *
 * **Only the open row mounts the component.** A tree of 500 rows used to hold 500 dropdown roots — 500 contexts,
 * 500 trigger refs — about a third of the sidebar's render (§6's 500-node budget). A closed row renders
 * {@link rowMenuTrigger} instead, which is the same `<button>` written without a component boundary, and the
 * tree mounts the menu when — and only when — somebody has asked for it. Two things come out of that and both
 * are handled: the trigger is remounted as the plain button when the menu unmounts, so Radix's "return focus to
 * the trigger" lands on a node that is gone and `FolderTree` refocuses the row; and the trigger's
 * `aria-expanded` has to be written by the closed branch too, because a closed menu that does not say it is
 * closed is a screen reader lying about a control.
 *
 * **`New folder` is folder-only** — a note has no children to put one in — and `Delete` is the one `danger`
 * item, which repaints it and keeps the words doing the warning. The confirmation itself is `DeleteConfirm`'s
 * job: a menu item that deleted immediately would be the click-then-cry interaction §5's typed-name rule exists
 * to prevent.
 */
import type { ReactElement } from 'react';
import type { NodeKind } from '../../features/tree/tree.selectors';
import { buttonClass } from '../ui/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';

/** The `⋯` of a row whose menu is shut. */
export interface RowMenuTriggerProps {
  readonly id: string;
  /** The row's display name, in the accessible name: "Actions for Draft.md". */
  readonly name: string;
  readonly kind: NodeKind;
  /** Whether *this* row's menu is open, which is the fact `aria-expanded` is about. */
  readonly open?: boolean;
  /** A mutation is in flight; the menu waits rather than queueing a second one. */
  readonly busy?: boolean;
  /** The closed button's whole job: ask the tree for this row's menu. */
  readonly onOpen: () => void;
}

/**
 * The row's menu button, as an element rather than a component.
 *
 * `FolderRow`/`NoteRow` *call* this instead of rendering `<RowMenuTrigger/>`, which keeps 500 rows from costing
 * 500 component renders on top of the `<button>` they were always going to write. It is a function with a
 * documented signature, not a component with a hidden one: no hooks, no identity, nothing to key.
 */
export function rowMenuTrigger({
  id,
  name,
  open = false,
  busy = false,
  onOpen,
}: RowMenuTriggerProps): ReactElement {
  return (
    <button
      type="button"
      // The row is the tab stop; the menu is reachable from the keyboard by `Shift+F10`, which is the chord the
      // platform already uses for "the menu for this thing".
      tabIndex={-1}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Actions for ${name}`}
      data-testid={`row-menu-${id}`}
      disabled={busy}
      // Closed, this is an ordinary button that asks for the menu. Open, it is Radix's trigger and Radix's own
      // toggle closes it, which arrives as `onOpenChange(false)` in the component below.
      onClick={open ? undefined : onOpen}
      className={buttonClass(
        'ghost',
        'sm',
        'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100',
      )}
    >
      {/* The glyph is the button's whole content and `aria-label` is its accessible name, so the wrapper span it
          used to sit in was one DOM node per row buying nothing. */}
      ⋯
    </button>
  );
}

export interface TreeContextMenuProps {
  readonly kind: NodeKind;
  readonly id: string;
  /** The row's display name, in the trigger's accessible name: "Actions for Draft.md". */
  readonly name: string;
  /** Controlled by the row, so the keyboard chord and the right-click can open the same menu. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Absent for a note: there is nothing to file inside one. */
  readonly onNewFolder?: (() => void) | undefined;
  readonly onRename: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
  /** A mutation is in flight; the whole menu waits rather than queueing a second one. */
  readonly busy?: boolean;
}

/**
 * The open menu for one row. Mounted by the row only while `open` is true — see the header for why that is the
 * whole performance story of this file.
 */
export function TreeContextMenu({
  kind,
  id,
  name,
  open,
  onOpenChange,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  busy = false,
}: TreeContextMenuProps) {
  if (!open) {
    return rowMenuTrigger({ id, name, kind, busy, onOpen: () => onOpenChange(true) });
  }

  return (
    <Menu open onOpenChange={(next) => onOpenChange(next)}>
      <MenuTrigger asChild>
        {rowMenuTrigger({ id, name, kind, open: true, busy, onOpen: () => onOpenChange(true) })}
      </MenuTrigger>
      <MenuContent data-testid={`row-menu-content-${id}`}>
        {onNewFolder === undefined ? null : (
          <>
            <MenuItem data-testid="menu-new-folder" onSelect={onNewFolder}>
              New folder
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem data-testid="menu-rename" onSelect={onRename}>
          Rename
        </MenuItem>
        <MenuItem data-testid="menu-move" onSelect={onMove}>
          Move to…
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger data-testid="menu-delete" onSelect={onDelete}>
          Delete {kind === 'folder' ? 'folder' : 'note'}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
