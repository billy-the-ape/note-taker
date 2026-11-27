/**
 * The editor's three modes, and the two places the answer comes from (docs/plans/mvp/MVP-13.md §5).
 *
 * `split | write | preview` is the whole vocabulary, and it is persisted in the `ui` store — a preference
 * about the chrome, which is exactly what `lib/uiStore.ts` exists for and exactly what a settings row is
 * not (a second device with a different window is a different answer, which is why this is not PR-16's
 * `theme` row pretending to be a layout).
 *
 * **The default depends on the viewport, and the viewport is not stored.** Below 1024 px, split is two
 * unreadable half-panes, so a first visit starts in `write`; at or above it there is room for the source
 * and the rendering side by side, which is the mode the feature is *for*. A stored choice always beats
 * the default — that is what "persisted across reload" means — and because the width is read from
 * `matchMedia` rather than from a resize listener, the default is answerable in a test by saying whether
 * the query matched (see `test/match-media.ts`), which is the only honest way to assert a branch that
 * depends on a window you cannot resize in jsdom.
 *
 * **An invalid stored value is no value at all.** The store is `localStorage`: a future version of this
 * app, another tab, or a person with a devtools window can put anything in it. Reading falls back to the
 * viewport default rather than drawing a mode nothing renders.
 */
import { readUi, writeUi } from './uiStore';

/** The key the mode is stored under — one of the `ui` store's names, `nt.editorMode`. */
export const EDITOR_MODE_KEY = 'editorMode';

/** §5's three modes. */
export type EditorMode = 'split' | 'write' | 'preview';

/** The media query that decides the default: "wide enough for two panes to be readable". */
export const WIDE_VIEWPORT_QUERY = '(min-width: 1024px)';

/** Every mode, in the order the buttons are drawn and the tests walk them. */
export const EDITOR_MODES: readonly EditorMode[] = ['split', 'write', 'preview'];

/** The viewport's answer, as a function so a test can drive both branches without a window. */
export function defaultModeFor(matchesWideViewport: boolean): EditorMode {
  return matchesWideViewport ? 'split' : 'write';
}

/** Is a stored string one of the modes? (A `ui` store value is whatever anybody put there.) */
export function isEditorMode(value: string): value is EditorMode {
  return (EDITOR_MODES as readonly string[]).includes(value);
}

/**
 * The mode to open in: what this browser chose last, or the viewport's default when it has not chosen or
 * what it chose is not a mode any more.
 */
export function readEditorMode(matchesWideViewport: boolean): EditorMode {
  const stored = readUi(EDITOR_MODE_KEY, '');
  return isEditorMode(stored) ? stored : defaultModeFor(matchesWideViewport);
}

/** Remember the choice for the next load of this browser. */
export function writeEditorMode(mode: EditorMode): void {
  writeUi(EDITOR_MODE_KEY, mode);
}

/** Which panes a mode shows. Both are kept mounted (see `EditorPane`); only their visibility changes. */
export interface ModeLayout {
  readonly editor: boolean;
  readonly preview: boolean;
}

/**
 * What each mode draws.
 *
 * Note that neither pane is ever *unmounted* — the scroll-sync pairing and the editor's own undo history
 * both survive a mode switch precisely because the two elements stay in the document and CSS decides
 * which one is showing. That is also what makes the mode a preference rather than a state machine: there
 * is nothing in it to lose.
 */
export function modeLayout(mode: EditorMode): ModeLayout {
  switch (mode) {
    case 'split':
      return { editor: true, preview: true };
    case 'write':
      return { editor: true, preview: false };
    case 'preview':
      return { editor: false, preview: true };
  }
}

/** The button group's accessible name for a mode. */
export function modeLabel(mode: EditorMode): string {
  switch (mode) {
    case 'split':
      return 'Split — source and preview';
    case 'write':
      return 'Write — source only';
    case 'preview':
      return 'Preview — rendered only';
  }
}
