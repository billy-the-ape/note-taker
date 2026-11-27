import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

/**
 * The context/application menu (docs/plans/mvp/MVP-08.md §5): Radix's dropdown with this app's chrome.
 *
 * Radix is again the point — roving focus with the arrow keys, typeahead, `Escape`, close on outside
 * click — none of which is worth re-deriving, and PR-12's tree context menu needs all of it.
 *
 * A trigger is expected to be a `Button`: pass `asChild`, and `Button`'s `ref`-as-prop support is what
 * lets Radix attach its handlers to it instead of nesting a `<button>` inside a `<button>`.
 */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuCheckboxItem = MenuPrimitive.CheckboxItem;
export const MenuRadioItem = MenuPrimitive.RadioItem;
export const MenuGroup = MenuPrimitive.Group;
export const MenuLabel = MenuPrimitive.Label;
export const MenuSeparator = MenuPrimitive.Separator;

export interface MenuContentProps extends MenuPrimitive.DropdownMenuContentProps {
  readonly children: ReactNode;
}

/**
 * The popup. `loop` is on so the arrow keys wrap a short list instead of stopping at the edge, and
 * `outline-none` is only acceptable because every item paints its own highlight (`data-[highlighted]`)
 * — Radix moves focus with the keyboard, so without that a keyboard user would have no cursor.
 */
export function MenuContent({ className = '', children, ...rest }: MenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        loop
        align="start"
        sideOffset={4}
        {...rest}
        className={`z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-lg
          focus:outline-none ${className}`}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

/**
 * One row. `danger` is for the rows that destroy something (delete, sign out everywhere): it repaints
 * the label, so the warning is not carried by hue alone — the words still say what it does.
 */
export function MenuItem({
  danger = false,
  className = '',
  children,
  ...rest
}: MenuPrimitive.DropdownMenuItemProps & { readonly danger?: boolean; readonly children: ReactNode }) {
  return (
    <MenuPrimitive.Item
      {...rest}
      className={`flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm
        outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50
        data-[highlighted]:bg-paper-2 ${danger ? 'text-danger' : 'text-ink'} ${className}`}
    >
      {children}
    </MenuPrimitive.Item>
  );
}
