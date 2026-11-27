// @vitest-environment jsdom
/**
 * The editor mode: its vocabulary, its default, and what a stored value is allowed to mean
 * (docs/plans/mvp/MVP-13.md §5, §6's "the mode default/persistence").
 *
 * Two rules are worth pinning here rather than in a component test, because a component test can only see
 * the mode the component happens to have:
 *
 * * **the default is the viewport, and it is a branch** — `split` at ≥ 1024 px, `write` below it. It is a
 *   function of a boolean rather than a read of `window.innerWidth` for exactly this reason: the assertion
 *   then says which half of the split the feature chose and why, and does not depend on jsdom's pretend
 *   1024×768 window (which, note, is *on the boundary* — a test that read the width directly would be
 *   testing the query's `min-width` arithmetic, not the choice).
 * * **a stored mode is a preference, an invalid one is not a preference.** `localStorage` is shared with
 *   every other tab and every older build of this app, so `nt.editorMode = 'zen'` is a thing that happens.
 *   Falling back to the viewport default is the same call an unread key makes, which is the tidy part:
 *   there is one "we have no answer" path, not two.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultModeFor,
  EDITOR_MODE_KEY,
  EDITOR_MODES,
  isEditorMode,
  modeLabel,
  modeLayout,
  readEditorMode,
  WIDE_VIEWPORT_QUERY,
  writeEditorMode,
} from './editorMode';

afterEach(() => {
  localStorage.clear();
});

describe('the mode vocabulary', () => {
  it('knows the three modes in the order §5 lists them', () => {
    expect(EDITOR_MODES).toEqual(['split', 'write', 'preview']);
  });

  it('names the storage key with the ui store prefix', () => {
    // `uiStore` owns the prefix; this is the assertion that the mode is a *ui* preference and not a
    // settings row. If it ever writes somewhere else by accident, this is the test that notices.
    expect(EDITOR_MODE_KEY).toBe('editorMode');
    writeEditorMode('write');
    expect(localStorage.getItem('nt.editorMode')).toBe('write');
  });

  it('labels each mode as a sentence about what you will see', () => {
    // The labels are the accessible names of three one-word buttons.
    expect(EDITOR_MODES.map(modeLabel)).toEqual([
      'Split — source and preview',
      'Write — source only',
      'Preview — rendered only',
    ]);
  });
});

describe('the viewport default', () => {
  it('splits when there is room for two readable panes', () => {
    expect(defaultModeFor(true)).toBe('split');
  });

  it('writes when there is not', () => {
    expect(defaultModeFor(false)).toBe('write');
  });

  it('asks the viewport a min-width query rather than a device width', () => {
    // `min-width` (not `width`) because the query has to be true for every wider window too, and because
    // a rotated tablet is the case that would otherwise flip the mode for no reason a person can see.
    expect(WIDE_VIEWPORT_QUERY).toBe('(min-width: 1024px)');
  });
});

describe('reading the mode back', () => {
  it('opens in the stored mode whatever the viewport would have chosen', () => {
    writeEditorMode('preview');
    expect(readEditorMode(true)).toBe('preview');
    expect(readEditorMode(false)).toBe('preview');
  });

  it('takes the viewport default when this browser has never chosen', () => {
    expect(readEditorMode(true)).toBe('split');
    expect(localStorage.getItem('nt.editorMode')).toBeNull();
    expect(readEditorMode(false)).toBe('write');
  });

  it('ignores a stored value that is not a mode', () => {
    for (const junk of ['', ' ', 'Zen', 'split ', 'SPLIT', 'split,write', 'preview\n']) {
      localStorage.setItem('nt.editorMode', junk);
      expect(isEditorMode(junk)).toBe(false);
      expect(readEditorMode(true)).toBe('split');
    }
  });

  it('accepts only the three words it can draw', () => {
    for (const mode of EDITOR_MODES) {
      expect(isEditorMode(mode)).toBe(true);
    }
  });
});

describe('what each mode draws', () => {
  it('shows both panes in split', () => {
    expect(modeLayout('split')).toEqual({ editor: true, preview: true });
  });

  it('shows exactly one pane in the two single-pane modes', () => {
    for (const mode of EDITOR_MODES) {
      const layout = modeLayout(mode);
      const shown = [layout.editor, layout.preview].filter(Boolean).length;
      if (mode === 'split') expect(shown).toBe(2);
      else expect(shown).toBe(1);
    }
  });

  it('never hides both, which is the mode that would leave a blank editor', () => {
    for (const mode of EDITOR_MODES) {
      const layout = modeLayout(mode);
      expect(layout.editor || layout.preview).toBe(true);
    }
  });
});
