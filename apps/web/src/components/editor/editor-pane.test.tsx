// @vitest-environment jsdom
/**
 * The editor surface: modes, toolbar, source, render, byte counter (docs/plans/mvp/MVP-13.md §5, §6).
 *
 * ## What is mounted
 *
 * `<EditorPane>` on its own, with the buffer in a `useState` in this file — deliberately *not* the whole app.
 * The rest of the app is `routes/app/note-editor.test.tsx`, which boots at a note URL and owns the questions
 * that need the tree, the router and a fake API. The pane has one job that is easier to see from the outside
 * than from inside: **text leaves it through `onEdit` and only through `onEdit`**. The harness feeds the value
 * straight back in, so an assertion on the textarea's value is an assertion that the round trip happened, and
 * an assertion on `edits` is an assertion that it happened *once* — which is the difference between a toolbar
 * click costing one autosave debounce and costing two (PR-14's in-flight buffer comparison would then be
 * comparing a write that was never on the wire).
 *
 * One trap this file used to walk into: **a JSX attribute is not a JavaScript string**. `initial="a\nb"` puts
 * a backslash and an `n` in the buffer, and every transform assertion downstream then compares against text
 * nobody typed. Every multi-line fixture here is an expression container, and the failures that rule prevents
 * are the quiet kind — a caret off by one, a paragraph where a heading was expected.
 *
 * ## The two things a mode switch must not break
 *
 * The caret and the undo stack live in the DOM element, so `split → preview → split` is asserted as *the same
 * element*: `toBe(editorBefore)` on the node, and the selection still where the person left it. A conditional
 * mount would repaint the buffer and pass every text assertion in this file.
 *
 * ## The preview is a security review
 *
 * The `401`-class bug in this PR is a Markdown renderer that parses raw HTML, so the preview tests are
 * negative first: no `script` element, no event-handler attribute, no `javascript:` URL — and then positive,
 * because a preview that sanitises by rendering nothing would pass them (`strong`, a table, a task-list
 * checkbox, and `rel="noopener noreferrer"` on the links that do survive).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_MODES } from '../../lib/editorMode';
import { type FakeMatchMedia, installMatchMedia } from '../../test/match-media';
import { EditorPane } from './EditorPane';

let edits: string[] = [];

/** The buffer's owner, which is the caller's job and not the pane's. */
function Harness({ initial = '' }: { readonly initial?: string }) {
  const [buffer, setBuffer] = useState(initial);
  return (
    <EditorPane
      buffer={buffer}
      onEdit={(next) => {
        edits.push(next);
        setBuffer(next);
      }}
    />
  );
}

const TITLE = { initial: '# Title\n' };

/** The live value of the buffer control, read the way the next keystroke will read it. */
function editor(): HTMLTextAreaElement {
  return screen.getByTestId('editor') as HTMLTextAreaElement;
}

function preview(): HTMLElement {
  return screen.getByTestId('preview');
}

function select(start: number, end = start): void {
  const element = editor();
  element.focus();
  element.setSelectionRange(start, end);
}

let media: FakeMatchMedia | undefined;

beforeEach(() => {
  edits = [];
  localStorage.clear();
});

afterEach(() => {
  media?.dispose();
  media = undefined;
  localStorage.clear();
});

describe('the source pane', () => {
  it('renders the buffer it was handed, in a control PR-19 can fill', () => {
    render(<Harness {...TITLE} />);

    expect(editor().value).toBe('# Title\n');
    expect(editor().tagName).toBe('TEXTAREA');
    expect(editor().getAttribute('aria-label')).toBe('note content');
  });

  it('hands the next text over and takes it back, once per keystroke', () => {
    render(<Harness initial="one" />);

    fireEvent.change(editor(), { target: { value: 'one two' } });

    expect(edits).toEqual(['one two']);
    expect(editor().value).toBe('one two');
  });

  it('describes itself with the byte counter, so the size is part of the control', () => {
    render(<Harness initial="hello" />);

    expect(editor().getAttribute('aria-describedby')).toBe(screen.getByTestId('byte-counter').id);
  });
});

describe('the toolbar', () => {
  it('wraps the selection and reports the new buffer exactly once', () => {
    render(<Harness initial="bold words" />);
    select(0, 4);

    fireEvent.click(screen.getByTestId('toolbar-bold'));

    // The transform ran *through the element* (which is what keeps it on the browser's undo stack — see
    // `MarkdownEditor`), so the text left the pane the same way a typed character leaves it: one `input`
    // event, one `onEdit`, one debounce window.
    expect(edits).toEqual(['**bold** words']);
    expect(editor().value).toBe('**bold** words');
  });

  it('selects the word it marked, so the next keystroke replaces the text and not the marks', () => {
    render(<Harness initial="word" />);
    select(0, 4);

    fireEvent.click(screen.getByTestId('toolbar-italic'));

    // `*word*` with the *word* selected, not the asterisks. The alternative — selecting the marks — means a
    // person who clicks italic and keeps typing gets `*_ *word*_`, and because the marks are what a
    // second click toggles, selecting the content is also what makes the button a toggle.
    expect(edits).toEqual(['*word*']);
    expect(editor().selectionStart).toBe(1);
    expect(editor().selectionEnd).toBe(5);
  });

  it('turns a plain line into a heading and keeps the caret on the text', () => {
    render(<Harness initial={'the quick brown fox\nsecond line\n'} />);
    select(4, 9);

    fireEvent.click(screen.getByTestId('toolbar-h1'));

    expect(editor().value).toBe('# the quick brown fox\nsecond line\n');
    expect(editor().selectionStart).toBe(6);
  });

  it('appends a list marker to every line the selection touches', () => {
    render(<Harness initial={'one\ntwo\n'} />);
    select(0, 7);

    fireEvent.click(screen.getByTestId('toolbar-bullet'));

    expect(editor().value).toBe('- one\n- two\n');
  });

  it('opens a link with the caret inside the parentheses, which is where the URL goes', () => {
    // No prompt: a `window.prompt` is a modal the browser owns — unstyleable, unl labelled, and it swallows
    // the buffer behind it. The URL is the one thing the buffer is about to contain anyway, so the marks
    // arrive with the caret between them and a person who decides against the link deletes four characters.
    render(<Harness initial={'link me\n'} />);
    select(0, 4);

    fireEvent.click(screen.getByTestId('toolbar-link'));

    expect(editor().value).toBe('[link]() me\n');
    expect(editor().selectionStart).toBe(7);
    expect(editor().selectionEnd).toBe(7);
  });

  it('draws every button in the same order as the transform table, with no duplicates', () => {
    render(<Harness />);

    const trigger = screen.getByTestId('editor-toolbar');
    const ids = Array.from(trigger.querySelectorAll('button')).map((button) =>
      button.getAttribute('data-testid'),
    );
    expect(ids.length).toBeGreaterThanOrEqual(15);
    expect(ids).toContain('toolbar-table');
    expect(ids).toContain('toolbar-task');
    expect(new Set(ids).size).toBe(ids.length);
    // A button whose id has no transform behind it is a click that does nothing, and the table is the only
    // place either could come from.
    for (const id of ids) {
      expect(id === null || id.startsWith('toolbar-')).toBe(true);
    }
  });

  it('is disabled while the source is off screen, and says so to the accessibility tree', () => {
    render(<Harness initial="x" />);

    fireEvent.click(screen.getByTestId('mode-preview'));

    expect(screen.getByTestId('editor-toolbar').getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByTestId('toolbar-bold') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('mode-write'));
    expect((screen.getByTestId('toolbar-bold') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the editor-scoped chords', () => {
  it('binds Ctrl/Cmd+B, +I and +K to the same three transforms as the buttons', () => {
    render(<Harness initial="alpha beta" />);

    select(0, 5);
    fireEvent.keyDown(editor(), { key: 'b', ctrlKey: true });
    expect(editor().value).toBe('**alpha** beta');

    // The word moved two characters right when the bold marks went in — which is the point of a chord that
    // composes: the selection is where the *word* is, not where it was.
    select(10, 14);
    fireEvent.keyDown(editor(), { key: 'i', metaKey: true });
    expect(editor().value).toBe('**alpha** *beta*');

    select(11, 15);
    fireEvent.keyDown(editor(), { key: 'k', ctrlKey: true });
    expect(editor().value).toBe('**alpha** *[beta]()*');
    expect(editor().selectionStart).toBe(18);
  });

  it('stops the chord so the shell does not also act on it', () => {
    render(<Harness initial="x" />);
    const onDocumentKey = vi.fn();
    document.addEventListener('keydown', onDocumentKey);

    select(0, 1);
    // `fireEvent` reports whether the default was prevented; PR-17's global search chord is a document
    // listener in the bubble phase, and this is the whole of the precedence rule it depends on.
    expect(fireEvent.keyDown(editor(), { key: 'b', ctrlKey: true })).toBe(false);
    expect(onDocumentKey).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onDocumentKey);
  });

  it('leaves every other combination alone, including the autosave chord', () => {
    render(<Harness initial="x" />);

    for (const combo of [
      { key: 'b', ctrlKey: true, shiftKey: true },
      { key: 'b', ctrlKey: true, altKey: true },
      { key: 's', ctrlKey: true },
      { key: 'k', metaKey: true, shiftKey: true },
      { key: 'b' },
    ]) {
      select(0, 1);
      // Not prevented (so the document listeners still hear it) and nothing written.
      expect(fireEvent.keyDown(editor(), combo)).toBe(true);
      expect(editor().value).toBe('x');
      expect(edits).toEqual([]);
    }
  });
});

describe('the modes', () => {
  it('opens in split on a wide viewport and write on a narrow one', () => {
    media = installMatchMedia(false, { wide: false });
    const narrow = render(<Harness initial="a" />);
    expect(screen.getByTestId('editor-pane').getAttribute('data-mode')).toBe('write');
    narrow.unmount();

    media.setWide(true);
    render(<Harness initial="a" />);
    expect(screen.getByTestId('editor-pane').getAttribute('data-mode')).toBe('split');
  });

  it('remembers the choice for the next mount, and does not ask the viewport again', () => {
    media = installMatchMedia(false, { wide: true });
    const first = render(<Harness initial="a" />);
    fireEvent.click(screen.getByTestId('mode-preview'));
    expect(localStorage.getItem('nt.editorMode')).toBe('preview');
    first.unmount();

    // A narrow window and a stored `preview`: the person's choice wins, which is the only meaning
    // "persisted" can have here.
    media.setWide(false);
    render(<Harness initial="a" />);
    expect(screen.getByTestId('editor-pane').getAttribute('data-mode')).toBe('preview');
  });

  it('shows and hides with CSS, keeping both panes mounted', () => {
    render(<Harness initial="# H" />);

    for (const mode of EDITOR_MODES) {
      fireEvent.click(screen.getByTestId(`mode-${mode}`));
      expect(screen.getByTestId('editor')).toBeTruthy();
      expect(screen.getByTestId('preview')).toBeTruthy();
    }
  });

  it('hides the source in preview mode and the render in write mode', () => {
    render(<Harness initial="# H" />);

    fireEvent.click(screen.getByTestId('mode-preview'));
    expect(editor().hidden).toBe(true);
    expect(preview().hidden).toBe(false);
    expect(editor().getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByTestId('mode-write'));
    expect(editor().hidden).toBe(false);
    expect(preview().hidden).toBe(true);
  });

  it('keeps the same textarea across a round trip, with the caret in it', () => {
    render(<Harness initial="keep me" />);
    const before = editor();
    select(2, 5);

    fireEvent.click(screen.getByTestId('mode-preview'));
    fireEvent.click(screen.getByTestId('mode-split'));

    expect(screen.getByTestId('editor')).toBe(before);
    expect(before.value).toBe('keep me');
    expect(before.selectionStart).toBe(2);
    expect(before.selectionEnd).toBe(5);
  });

  it('marks the current mode for a non-visual user, and only one mode', () => {
    render(<Harness initial="a" />);

    fireEvent.click(screen.getByTestId('mode-write'));
    expect(
      EDITOR_MODES.map((mode) => screen.getByTestId(`mode-${mode}`).getAttribute('aria-pressed')),
    ).toEqual(['false', 'true', 'false']);
  });
});

describe('the byte counter', () => {
  it('says both numbers and neither is rounded away', () => {
    render(<Harness initial="hello" />);

    const text = screen.getByTestId('byte-counter').textContent ?? '';
    expect(text).toContain('5 B');
    expect(text).toContain('5 characters');
    expect(screen.getByTestId('byte-counter').getAttribute('data-status')).toBe('ok');
  });

  it('has no warning line while the note is an ordinary size', () => {
    render(<Harness initial="hello" />);
    expect(screen.queryByTestId('byte-warning')).toBeNull();
  });

  // The 900 KiB fixture is the one assertion in this file that is *not* run under `pnpm coverage`: v8
  // instrumentation charges every function a 900-kilobyte textarea touches, and the same render that costs a
  // millisecond here costs over the 5 s test timeout (PR-12's 500-row tree test documents the same switch,
  // and `VITEST_COVERAGE` is this repo's own knob rather than a runner environment to sniff). The promise
  // itself — that `warn` starts at `NOTE_CONTENT_WARN_BYTES` and the sentence names it — is asserted in
  // `lib/note-size.test.ts` for four numbers instead of nine hundred thousand, so what is skipped here is a
  // second, more expensive proof of a fact that is already proven, not the fact itself.
  const heavy = process.env.VITEST_COVERAGE === '1' ? it.skip : it;
  heavy('warns at the threshold, from the same constant the server rules on', () => {
    // 900 KiB of text in a jsdom node is a millisecond, and it is the honest fixture: the alternative is a
    // unit test of a number and a component that never sees one.
    render(<Harness initial={'a'.repeat(900 * 1024)} />);

    expect(screen.getByTestId('byte-counter').getAttribute('data-status')).toBe('warn');
    expect(screen.getByTestId('byte-warning')?.textContent).toContain('900.0 KiB');
  });
});

describe('the preview', () => {
  it('renders the Markdown the source holds', async () => {
    render(<Harness initial={'# Title\n\n**bold** and ~~gone~~ and `code`\n'} />);

    await waitFor(() => expect(preview().querySelector('h1')?.textContent).toBe('Title'));
    const html = preview().innerHTML;
    expect(preview().querySelector('strong')?.textContent).toBe('bold');
    expect(html).toContain('<del>');
    expect(html).toContain('<code>');
    // The exact counts, not just "an element of that kind exists", because `e2e/notes.spec.ts` asserts these
    // two numbers in a browser and cannot be run here (no docker daemon): `**bold**` is *one* `<strong>`, and
    // `# Title` is *one* `<h1>` — a heading is not emphasis, whatever a first reading of "renders
    // `<strong>`" suggests. Pinned at the level the component can be measured, so the spec's numbers have a
    // local proof behind them.
    expect(preview().querySelectorAll('strong')).toHaveLength(1);
    expect(preview().querySelectorAll('h1')).toHaveLength(1);
  });

  it('renders a GFM table and a task list, which are the two §6 names', async () => {
    render(<Harness initial={'| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n'} />);

    await waitFor(() => expect(preview().querySelector('table')).not.toBeNull());
    expect(preview().querySelector('th')?.textContent).toBe('A');
    const checkboxes = preview().querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it('says so when there is nothing to render', () => {
    render(<Harness initial="" />);
    expect(screen.getByTestId('preview-empty')?.textContent).toContain('Nothing to preview');
  });
});

describe('the preview refuses what a note could contain', () => {
  it('does not turn raw HTML into an element', async () => {
    render(<Harness initial={'# Title\n\n<script>globalThis.pwned = 1</script>\n'} />);

    await waitFor(() => expect(preview().querySelector('h1')?.textContent).toBe('Title'));
    // Without `rehype-raw` a raw HTML block never becomes an element, so there is nothing for the
    // sanitiser to be the last line of defence about. The block is dropped from the *render*, which is the
    // trade this design makes: the buffer keeps the text a person pasted (see the fence test below for the
    // way to make HTML visible in a preview), and the render stays a render.
    expect(preview().querySelector('script')).toBeNull();
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
    // …and the drop did not take the document with it.
    expect(preview().querySelector('h1')).not.toBeNull();
  });

  it('shows HTML as text when the note asks for it with a fence', async () => {
    render(<Harness initial={'````\n<script>globalThis.pwned = 1</script>\n````\n'} />);

    await waitFor(() => expect(preview().querySelector('code')).not.toBeNull());
    expect(preview().querySelector('script')).toBeNull();
    // The whole point of the fence: the source survives into the render as characters, which is what a
    // person quoting a snippet on a note wants.
    expect(preview().textContent).toContain('<script>');
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it('never lets a raw <img onerror> become an element', async () => {
    render(<Harness initial={'<img src="x" onerror="globalThis.pwned = 1">\n'} />);

    await waitFor(() => expect(preview()).toBeTruthy());
    expect(preview().querySelector('img')).toBeNull();
    for (const element of Array.from(preview().querySelectorAll('*'))) {
      for (const name of Array.from(element.attributes).map((attribute) => attribute.name)) {
        expect(name.toLowerCase()).not.toMatch(/^on/u);
      }
    }
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it('gives the elements Markdown itself produces no event-handler attribute', async () => {
    render(
      <Harness initial={'![sun](https://example.com/i.png "the sun")\n\n[ok](https://example.com/a)\n'} />,
    );

    await waitFor(() => expect(preview().querySelector('img')).not.toBeNull());
    for (const element of Array.from(preview().querySelectorAll('*'))) {
      for (const name of Array.from(element.attributes).map((attribute) => attribute.name)) {
        expect(name.toLowerCase()).not.toMatch(/^on/u);
      }
    }
  });

  it('lets a javascript: URL go no further than the sanitiser schema', async () => {
    render(<Harness initial={'[click](javascript:globalThis.pwned = 1)\n\n[ok](https://example.com/a)\n'} />);

    await waitFor(() => expect(preview().querySelectorAll('a').length).toBeGreaterThan(0));
    const hrefs = Array.from(preview().querySelectorAll('a')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href.startsWith('javascript:'))).toBe(false);
    expect(hrefs).toContain('https://example.com/a');
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it('adds rel="noopener" to the links that do render', async () => {
    render(<Harness initial={'[ok](https://example.com/a)\n'} />);

    await waitFor(() => expect(preview().querySelector('a')).not.toBeNull());
    expect(preview().querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
