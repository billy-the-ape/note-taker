/**
 * The transform table for every toolbar button (docs/plans/mvp/MVP-13.md §6).
 *
 * **No DOM, no React, no editor** — that is the point of the brief's "unit-tested without a DOM", and it
 * is why this file is the biggest test file in PR-13. Each case names the text it starts from, the caret
 * the person left, and *both* halves of the answer: the buffer that comes back and what is selected
 * afterwards. The selection is asserted as the string it covers (`selected()`), because
 * `{start: 6, end: 10}` means nothing to a reader of a failure message and `**bold**` does.
 *
 * §6's awkward list is here on purpose, and each of those rows says which line of `markdown.ts` it is
 * about to catch: unwrap-already-bold, a selection spanning list items, a link whose selection is both
 * the text and the URL, a table at an empty line, an empty selection at EOF, and a caret that a click
 * left in the middle of a code point.
 */
import { describe, expect, it } from 'vitest';

import {
  type Applied,
  blockquote,
  bold,
  bulletList,
  type Caret,
  codeBlock,
  EDITOR_KEYMAP,
  emphasis,
  heading,
  horizontalRule,
  inlineCode,
  italic,
  linesOf,
  link,
  orderedList,
  strikethrough,
  TOOLBAR_ITEMS,
  type Transform,
  table,
  taskList,
  transformFor,
  wordRangeAt,
} from './markdown.js';

/** Run a transform the way the editor does: `(selection, text)`. */
function run(transform: Transform, text: string, selection: Caret): Applied {
  return transform(selection, text);
}

/** What the returned selection covers — the assertion a reader can actually check. */
function selected(applied: Applied): string {
  return applied.text.slice(applied.selection.start, applied.selection.end);
}

/** The caret over a substring, by first match — so a case reads as the text it selects. */
function caretOf(text: string, phrase: string, from = 0): Caret {
  const start = text.indexOf(phrase, from);
  if (start === -1) throw new Error(`"${phrase}" is not in "${text}"`);
  return { start, end: start + phrase.length };
}

/** A collapsed caret at a literal offset. */
function caretAt(text: string, at: number): Caret {
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThanOrEqual(text.length);
  return { start: at, end: at };
}

describe('the toolbar table itself', () => {
  it('has the fifteen buttons §5 lists, each with a transform and an id', () => {
    expect(TOOLBAR_ITEMS.map((item) => item.testId)).toEqual([
      'toolbar-h1',
      'toolbar-h2',
      'toolbar-h3',
      'toolbar-bold',
      'toolbar-italic',
      'toolbar-strike',
      'toolbar-code',
      'toolbar-codeblock',
      'toolbar-quote',
      'toolbar-bullet',
      'toolbar-ordered',
      'toolbar-task',
      'toolbar-link',
      'toolbar-table',
      'toolbar-rule',
    ]);
    // Every id is `toolbar-`-prefixed, because that is the prefix PR-19's specs click through.
    for (const item of TOOLBAR_ITEMS) {
      expect(item.testId).toMatch(/^toolbar-[a-z0-9]+$/u);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });

  it('points every chord at a button that exists', () => {
    expect(Object.keys(EDITOR_KEYMAP)).toEqual(['b', 'i', 'k']);
    for (const testId of Object.values(EDITOR_KEYMAP)) {
      expect(transformFor(testId)).toBeTypeOf('function');
    }
    // The three keys §5 names, and nothing else: `Ctrl/Cmd+S` belongs to the autosave engine (PR-14) and
    // `Ctrl/Cmd+K` belongs to the editor while it has focus (PR-17's precedence rule).
    expect(EDITOR_KEYMAP).toEqual({ b: 'toolbar-bold', i: 'toolbar-italic', k: 'toolbar-link' });
  });

  it('answers an unknown id with nothing rather than a wrong transform', () => {
    expect(transformFor('toolbar-nope')).toBeUndefined();
  });
});

describe('headings', () => {
  it('adds the level in front of the caret’s line and keeps the text selected', () => {
    const text = 'Release notes';
    const applied = run(heading(1), text, caretOf(text, 'Release notes'));
    expect(applied.text).toBe('# Release notes');
    expect(selected(applied)).toBe('Release notes');
  });

  it('presses the same level twice to take the marker off', () => {
    const text = '# Release notes';
    const applied = run(heading(1), text, caretOf(text, 'Release'));
    expect(applied.text).toBe('Release notes');
    // The caret moved with the text it names, which is the whole difference between "the marker went
    // away" and "the selection jumped to the start of the line".
    expect(selected(applied)).toBe('Release');
  });

  it('replaces another level instead of stacking markers', () => {
    const text = '## Release notes';
    const applied = run(heading(3), text, caretOf(text, 'notes'));
    expect(applied.text).toBe('### Release notes');
    expect(selected(applied)).toBe('notes');
  });

  it('marks every line a selection spanning them touches', () => {
    const text = 'one\ntwo\nthree';
    const applied = run(heading(2), text, { start: 1, end: 8 });
    expect(applied.text).toBe('## one\n## two\n## three');
  });
});

describe('blockquote', () => {
  it('quotes the whole lines a mid-word selection covers', () => {
    const text = 'first line\nsecond line';
    const applied = run(blockquote, text, { start: 2, end: 14 });
    expect(applied.text).toBe('> first line\n> second line');
    // Both lines gained two characters *inside* the selection, so the selection grew by four and now
    // names the second marker too. That is what "it moved with the content" means for a block edit.
    expect(applied.selection).toEqual({ start: 4, end: 18 });
    expect(selected(applied)).toBe('rst line\n> sec');
  });

  it('removes the marker again from a quoted block', () => {
    const text = '> first\n> second';
    const applied = run(blockquote, text, { start: 2, end: text.length });
    expect(applied.text).toBe('first\nsecond');
    expect(selected(applied)).toBe('first\nsecond');
  });

  it('acts on the caret’s own line when the selection names only that line', () => {
    // Half a quote, half not: the button is about the lines the caret names, and the other one is the
    // person’s own business.
    const text = '> first\n> second';
    expect(run(blockquote, text, caretOf(text, 'first')).text).toBe('first\n> second');
  });

  it('does not mistake a `>` in the middle of a line for its own quote marker', () => {
    const text = 'a > b';
    expect(run(blockquote, text, caretAt(text, 2)).text).toBe('> a > b');
  });
});

describe('bullet and numbered lists', () => {
  const items = 'milk\nbread\ncheese';

  it('marks every item a selection spanning list items covers (§6)', () => {
    const applied = run(bulletList, items, { start: 0, end: items.length });
    expect(applied.text).toBe('- milk\n- bread\n- cheese');
    // Three lines gained a marker each, inside the selection, so the caret still names the whole block.
    expect(selected(applied)).toBe('milk\n- bread\n- cheese');
  });

  it('takes the marker off the whole list the selection spans', () => {
    const text = '- milk\n- bread';
    const applied = run(bulletList, text, { start: 0, end: text.length });
    expect(applied.text).toBe('milk\nbread');
    expect(selected(applied)).toBe('milk\nbread');
  });

  it('takes the marker off the caret’s own item, and only that one', () => {
    const text = '- milk\n- bread';
    const applied = run(bulletList, text, caretOf(text, 'bread'));
    expect(applied.text).toBe('- milk\nbread');
    expect(selected(applied)).toBe('bread');
  });

  it('turns a numbered list into a bullet list rather than a two-marker list', () => {
    const text = '1. milk\n2. bread';
    expect(run(bulletList, text, { start: 0, end: text.length }).text).toBe('- milk\n- bread');
  });

  it('numbers from 1 across the block, which is the only way a numbered list reads', () => {
    const applied = run(orderedList, items, { start: 0, end: items.length });
    expect(applied.text).toBe('1. milk\n2. bread\n3. cheese');
  });

  it('is the toggle every other block button is: press it on a numbered list and the numbers go', () => {
    const counted = '1. one\n2. two\n3. three';
    expect(run(orderedList, counted, { start: 0, end: counted.length }).text).toBe('one\ntwo\nthree');
  });

  it('renumbers from 1 when it converts a bullet list, which is the only way a list reads', () => {
    const text = '- one\n- two\n- three';
    expect(run(orderedList, text, { start: 0, end: text.length }).text).toBe('1. one\n2. two\n3. three');
  });

  it('turns a bullet list into a numbered one', () => {
    const text = '- milk\n- bread';
    expect(run(orderedList, text, { start: 0, end: text.length }).text).toBe('1. milk\n2. bread');
  });
});

describe('task lists', () => {
  it('gives plain lines their boxes', () => {
    const text = 'milk\nbread';
    expect(run(taskList, text, { start: 0, end: text.length }).text).toBe('- [ ] milk\n- [ ] bread');
  });

  it('is the three-state cycle: add, check, remove', () => {
    const plain = 'milk';
    const boxed = run(taskList, plain, caretAt(plain, 2));
    expect(boxed.text).toBe('- [ ] milk');
    const checked = run(taskList, boxed.text, caretAt(boxed.text, 9));
    expect(checked.text).toBe('- [x] milk');
    const back = run(taskList, checked.text, caretAt(checked.text, 7));
    expect(back.text).toBe('milk');
  });

  it('fills in the missing box without losing the tick somebody made by hand', () => {
    const text = '- [x] milk\nbread';
    expect(run(taskList, text, { start: 0, end: text.length }).text).toBe('- [x] milk\n- [ ] bread');
  });

  it('fills in the missing box without ticking one that is open', () => {
    // The other half of the same promise, and the half the case above cannot see: an unchecked box is a
    // decision that the item is **not** finished, and a person pressing the button to give the pasted line
    // a box has said nothing about the one they left open. `mode` is `'add'` here (not every touched line
    // is a task item), and `'add'` adds; ticking is `'check'`, which is only reached when every touched
    // line already has a box.
    const text = '- [ ] milk\nbread';
    expect(run(taskList, text, { start: 0, end: text.length }).text).toBe('- [ ] milk\n- [ ] bread');
    // The marker a line arrived with is not the button's to normalise either: `*` stays `*`, or a five-line
    // list written with `+` comes back with one row in `-` and everybody's diff blames the toolbar.
    expect(run(taskList, '* [ ] milk\nbread', { start: 0, end: '* [ ] milk\nbread'.length }).text).toBe(
      '* [ ] milk\n- [ ] bread',
    );
  });

  it('ticks every box when every touched line is a task item and one is open', () => {
    // …which is the case that *should* tick, kept beside the one above so the two cannot be confused.
    const text = '- [ ] milk\n- [x] bread\n- [ ] milk';
    expect(run(taskList, text, { start: 0, end: text.length }).text).toBe(
      '- [x] milk\n- [x] bread\n- [x] milk',
    );
  });

  it('converts a numbered item, so the markers cannot stack', () => {
    const text = '1. milk';
    expect(run(taskList, text, caretAt(text, 3)).text).toBe('- [ ] milk');
  });
});

describe('emphasis', () => {
  it('wraps a selection in markers and leaves the content selected', () => {
    const text = 'ship the release';
    const applied = run(bold, text, caretOf(text, 'release'));
    expect(applied.text).toBe('ship the **release**');
    expect(selected(applied)).toBe('release');
  });

  it('unwraps a selection that is already wrapped (§6)', () => {
    const text = 'ship the **release** today';
    const applied = run(bold, text, caretOf(text, 'release'));
    expect(applied.text).toBe('ship the release today');
    expect(selected(applied)).toBe('release');
  });

  it('unwraps when the selection carries the markers too', () => {
    const text = 'a **release** plan';
    const applied = run(bold, text, caretOf(text, '**release**'));
    expect(applied.text).toBe('a release plan');
    expect(selected(applied)).toBe('release');
  });

  it('wraps the word under a collapsed caret, which is what a caret in a word means', () => {
    const text = 'ship the release today';
    const applied = run(bold, text, caretAt(text, 15));
    expect(applied.text).toBe('ship the **release** today');
    expect(selected(applied)).toBe('release');
  });

  it('is its own inverse: wrap then unwrap restores the text and the caret exactly', () => {
    const text = 'ship the release today';
    const selection = caretOf(text, 'release');
    const wrapped = run(bold, text, selection);
    const back = run(bold, wrapped.text, wrapped.selection);
    expect(back.text).toBe(text);
    expect(back.selection).toEqual(selection);
  });

  it.each([
    ['italic', italic, 'italic'],
    ['strikethrough', strikethrough, 'strike'],
    ['inline code', inlineCode, 'code'],
  ] as const)('wraps and unwraps %s with its own markers', (_label, transform, source) => {
    const plain = `a ${source} b`;
    const wrapped = run(transform, plain, caretOf(plain, source));
    expect(selected(wrapped)).toBe(source);
    const unwrapped = run(transform, wrapped.text, wrapped.selection);
    expect(unwrapped.text).toBe(plain);
    expect(unwrapped.selection).toEqual(caretOf(plain, source));
  });

  it('stacks on a different emphasis rather than stealing its marker', () => {
    // The word is italic one character away; "already bold" is about the two characters on each side, so
    // bold adds its own pair — and `***x***` is what bold *and* italic looks like.
    const text = '*emphasis* here';
    expect(run(bold, text, caretOf(text, 'emphasis')).text).toBe('***emphasis*** here');
  });
});

describe('links', () => {
  it('turns a selected URL into a link with the address as its own target (§6)', () => {
    const text = 'see https://example.com/a?b=1 now';
    const applied = run(link, text, caretOf(text, 'https://example.com/a?b=1'));
    expect(applied.text).toBe('see [https://example.com/a?b=1](https://example.com/a?b=1) now');
  });

  it('keeps the selected words as the label and puts the caret inside the target', () => {
    const text = 'read the handbook first';
    const applied = run(link, text, caretOf(text, 'handbook'));
    expect(applied.text).toBe('read the [handbook]() first');
    expect(applied.selection.start).toBe('read the [handbook]('.length);
    expect(selected(applied)).toBe('');
  });

  it('opens the brackets at a collapsed caret, with the caret where the label goes', () => {
    const text = 'notes';
    const applied = run(link, text, caretAt(text, 0));
    expect(applied.text).toBe('[]()notes');
    expect(applied.selection).toEqual({ start: 1, end: 1 });
  });

  it('wraps text and URL that are both in the selection (§6)', () => {
    // One selection, both halves: the words stay the label and the address becomes the target.
    const text = 'see Example https://example.com today';
    const applied = run(link, text, caretOf(text, 'Example https://example.com'));
    expect(applied.text).toBe('see [Example](https://example.com) today');
  });

  it('accepts a www address as the target half of a selection', () => {
    const text = 'www.example.com docs';
    const applied = run(link, text, caretOf(text, 'www.example.com docs'));
    expect(applied.text).toBe('[docs](www.example.com)');
  });
});

describe('inserted blocks', () => {
  it('replaces the empty line a table is inserted at (§6)', () => {
    const text = 'Summary\n\n\nNext\n';
    // The caret is on the second empty line: that line becomes the table, and the blank line above it
    // survives, so the table is separated from the paragraph rather than glued under it.
    const at = text.indexOf('\n\n') + 2;
    const applied = run(table, text, caretAt(text, at));
    expect(applied.text).toBe(`Summary\n\n${tableText()}\nNext\n`);
  });

  it('puts a table on its own lines when the caret’s line has text on it', () => {
    const text = 'Summary';
    const applied = run(table, text, caretAt(text, 3));
    expect(applied.text).toBe(`Summary\n\n${tableText()}`);
    expect(applied.selection.start).toBe(applied.text.length);
  });

  it('never leaves a rule that a setext heading could be mistaken for', () => {
    const text = 'Title\nbody';
    expect(run(horizontalRule, text, caretAt(text, 2)).text).toBe('Title\n\n---\nbody');
  });

  it('inserts a rule at EOF without a trailing blank line', () => {
    const text = 'Title';
    expect(run(horizontalRule, text, caretAt(text, text.length)).text).toBe('Title\n\n---');
  });

  it('inserts the first block into an empty buffer, which is a real first keystroke', () => {
    expect(run(table, '', caretAt('', 0)).text).toBe(tableText());
    expect(run(horizontalRule, '', caretAt('', 0)).text).toBe('---');
  });

  it('fences a selection on its own lines and keeps the code selected', () => {
    const text = 'let x = 1';
    const applied = run(codeBlock, text, caretOf(text, 'let x = 1'));
    expect(applied.text).toBe('```\nlet x = 1\n```');
    expect(selected(applied)).toBe('let x = 1');
  });

  it('opens an empty fence with the caret on the line inside it', () => {
    const applied = run(codeBlock, '', caretAt('', 0));
    expect(applied.text).toBe('```\n\n```');
    expect(applied.selection).toEqual({ start: 4, end: 4 });
  });
});

describe('the awkward cases §6 names', () => {
  it('handles an empty selection at EOF: markers open around nothing', () => {
    const text = 'a sentence\n';
    const applied = run(bold, text, caretAt(text, text.length));
    // There is no word adjacent to a caret sitting after the newline, so the transform cannot guess one;
    // it opens the markers and lets the next keystroke be the content.
    expect(applied.text).toBe('a sentence\n****');
    expect(applied.selection).toEqual({ start: text.length + 2, end: text.length + 2 });
  });

  it('bolds the word immediately before the caret at EOF', () => {
    const text = 'a sentence';
    const applied = run(bold, text, caretAt(text, text.length));
    expect(applied.text).toBe('a **sentence**');
  });

  it('never splits a code point: a click in the middle of an emoji selects nothing', () => {
    const text = 'a😀';
    // `😀` is a surrogate pair, so offset 2 is the low half of it and names no boundary. The caret is
    // pushed out of the pair, finds no word on either side, and the markers open around nothing.
    const applied = run(bold, text, { start: 2, end: 2 });
    expect(applied.text).toBe('a😀****');
  });

  it('never splits a code point: a selection that starts inside a pair starts after it', () => {
    const text = 'a😀b';
    const applied = run(bold, text, { start: 2, end: 4 });
    // The low half is dropped rather than wrapped, and the surviving selection names `b`.
    expect(applied.text).toBe('a😀**b**');
    expect(selected(applied)).toBe('b');
  });

  it('never splits a code point: a selection that ends inside a pair ends before it', () => {
    const text = 'a😀b';
    const applied = run(bold, text, { start: 0, end: 2 });
    expect(applied.text).toBe('**a**😀b');
    expect(selected(applied)).toBe('a');
  });

  it('wraps CJK text without touching a character', () => {
    const text = '标题内容';
    const applied = run(bold, text, { start: 1, end: 3 });
    expect(applied.text).toBe('标**题内**容');
  });

  it('wraps a character written as two surrogate pairs and leaves both halves together', () => {
    const text = '𠮷𠮷';
    // Both boundaries fall inside a pair, so both characters are excluded rather than cut.
    const applied = run(bold, text, { start: 1, end: 3 });
    expect(applied.text).toBe('𠮷****𠮷');
    expect(selected(applied)).toBe('');
  });

  it('keeps a whole-line transform honest when the buffer ends without a newline', () => {
    const text = 'one\ntwo';
    expect(run(bulletList, text, { start: 0, end: text.length }).text).toBe('- one\n- two');
  });

  it('clamps a caret that names positions past the end of the text', () => {
    const text = 'short';
    const applied = run(bold, text, { start: 20, end: 40 });
    // Clamped to EOF, which is a caret inside the last word — so the word gets bolded rather than the
    // transform inventing a selection nobody asked for.
    expect(applied.text).toBe('**short**');
  });

  it('orders a reversed selection instead of producing a negative offset', () => {
    const text = 'reverse this';
    const applied = run(bold, text, { start: 12, end: 8 });
    expect(applied.text).toBe('reverse **this**');
  });
});

describe('the small helpers the editor borrows', () => {
  it('splits a buffer into lines that never contain their own newline', () => {
    const lines = linesOf('one\ntwo\n');
    expect(lines.map((line) => line.text)).toEqual(['one', 'two', '']);
    expect(lines.map((line) => line.start)).toEqual([0, 4, 8]);
    expect(lines.map((line) => line.end)).toEqual([3, 7, 8]);
  });

  it('finds the word under a position, the one behind a caret at its end, and none between words', () => {
    expect(wordRangeAt('two words', 5)).toEqual({ start: 4, end: 9 });
    expect(wordRangeAt('two words', 3)).toEqual({ start: 0, end: 3 });
    expect(wordRangeAt('a - b', 2)).toBeNull();
    expect(wordRangeAt('', 0)).toBeNull();
  });

  it('answers every toolbar transform for the shape §4 promises', () => {
    for (const item of TOOLBAR_ITEMS) {
      const applied = item.transform({ start: 0, end: 0 }, 'text');
      expect(typeof applied.text).toBe('string');
      expect(applied.selection.start).toBeLessThanOrEqual(applied.text.length);
      expect(applied.selection.end).toBeLessThanOrEqual(applied.text.length);
      expect(applied.selection.start).toBeLessThanOrEqual(applied.selection.end);
    }
  });

  it('is not confused by an empty buffer for any button', () => {
    for (const item of TOOLBAR_ITEMS) {
      expect(() => item.transform({ start: 0, end: 0 }, '')).not.toThrow();
    }
  });
});

/** The two-column skeleton `toolbar-table` writes, spelled once. */
function tableText(): string {
  return ['| Column | Column |', '| --- | --- |', '| Cell | Cell |'].join('\n');
}

// `emphasis` is exported as the factory the four marker pairs come from; the row above exercises it
// directly so a future change to one marker cannot silently change the factory.
describe('emphasis()', () => {
  it('takes different open and close markers', () => {
    const quote = emphasis('«', '»');
    expect(quote({ start: 0, end: 4 }, 'word').text).toBe('«word»');
  });
});
