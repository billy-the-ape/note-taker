/**
 * The toolbar's Markdown transforms (docs/plans/mvp/MVP-13.md §4, §5).
 *
 * **Every button in `EditorToolbar` is one of these functions**, and every one of them has the same
 * shape: `(selection, text) => {text, selection}`. That shape is the whole reason this file has no
 * imports at all — no DOM, no React, no `document.execCommand`, no CodeMirror:
 *
 * * a transform is a value, so the awkward cases in §6's list are table rows in
 *   `markdown.test.ts` rather than a browser session;
 * * the *editor* keeps ownership of the text and of the undo stack, because a transform only says
 *   what the buffer should look like next (§5: "applied as a transaction so native undo history stays
 *   intact" — see `components/editor/MarkdownEditor.tsx` for the half that touches the DOM);
 * * the caller cannot get it wrong about selection: it hands over the caret it has and gets back the
 *   caret that means the same thing in the new text.
 *
 * ## Two rules every transform obeys
 *
 * **Never split a code point.** A caret is a UTF-16 index, so a click in the middle of `👍` (or of a
 * Han character written as a surrogate pair) names a boundary that does not exist. `snapToCodePoint`
 * is called once at the top of every transform, and it *excludes* rather than *includes*: a boundary
 * inside a pair moves out of the pair, so the worst a mid-glyph click can do is select nothing.
 *
 * **A transform is reversible, and mostly its own inverse.** Wrapping then unwrapping returns the
 * exact original text *and* the exact original selection, which is the property §6 asks of "bold →
 * undo restores the original". The browser's own Ctrl+Z is the mechanism in the product; this is the
 * same claim at the layer where it can be asserted without one.
 *
 * ## Empty selections
 *
 * A collapsed caret is the case every editor has to answer and the one most toolbars get wrong. Here
 * it has one answer per transform: emphasis wraps **the word under the caret** (and unwraps it if that
 * word is already wrapped, which is what "toggle bold on already-bold" means), a block transform acts
 * on the caret's line, and an inserted block (table, rule, code fence) lands on the caret's line, on
 * its own lines if that line has text on it. A caret with no word next to it — the brief's "empty
 * selection at EOF" — inserts the markers with the caret between them, so the keystroke that follows
 * is the content.
 */

/** A text selection in character offsets, `end >= start`, `end` exclusive. */
export interface Caret {
  readonly start: number;
  readonly end: number;
}

/** What a transform hands back: the whole new buffer, and the caret that means the same thing in it. */
export interface Applied {
  readonly text: string;
  readonly selection: Caret;
}

/** One toolbar button's worth of Markdown. */
export type Transform = (selection: Caret, text: string) => Applied;

// ───────────────────────────────────────────── code points ─────────────────────────────────────────

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Move a boundary that falls *inside* a surrogate pair out of it.
 *
 * `start` walks forward past a low surrogate (it was going to select the tail half of a pair) and
 * `end` walks back before a high surrogate (it was going to select the head half). Both directions
 * exclude the character rather than include half of it, which is the difference between "the click
 * selected nothing" and "the bold markers corrupted an emoji".
 */
export function snapToCodePoint(text: string, caret: Caret): Caret {
  const length = text.length;
  let start = clamp(caret.start, length);
  let end = clamp(caret.end, length);
  if (end < start) [start, end] = [end, start];
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  if (end < start) end = start;
  return { start, end };
}

function clamp(value: number, length: number): number {
  if (value <= 0) return 0;
  return Math.min(value, length);
}

/** A caret, ordered and snapped — the only shape a transform is allowed to read. */
function normalize(caret: Caret, text: string): Caret {
  return snapToCodePoint(text, caret);
}

// ─────────────────────────────────────────────── words ─────────────────────────────────────────────

/** Letters and digits, which is what a double-click and a word-wise toggle both mean by "word". */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The word under (or immediately before) the caret, or `null` when the caret sits on whitespace or
 * punctuation. Surrogates cannot match `WORD_CHAR`, so this walk can only ever stop *outside* a pair.
 */
export function wordRangeAt(text: string, at: number): Caret | null {
  const position = clamp(at, text.length);
  let start = position;
  let end = position;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start -= 1;
  while (end < text.length && WORD_CHAR.test(text.charAt(end))) end += 1;
  if (start === end) return null;
  return { start, end };
}

// ─────────────────────────────────────────────── lines ─────────────────────────────────────────────

interface Line {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The buffer as lines, with `end` naming the position of the `\n` that terminates the line (or the
 * length of the text, for a last line with no terminator). A line therefore never contains its own
 * newline, and the offsets stay in the coordinate system the caret uses.
 */
export function linesOf(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = index === text.length ? '\n' : (text[index] as string);
    if (char !== '\n') continue;
    lines.push({ start, end: index, text: text.slice(start, index) });
    start = index + 1;
  }
  return lines;
}

/** The line a position belongs to; the newline that ends a line belongs to that line. */
function lineIndexAt(lines: readonly Line[], position: number): number {
  let index = 0;
  for (let probe = 0; probe < lines.length; probe += 1) {
    if ((lines[probe] as Line).start > position) break;
    index = probe;
  }
  return index;
}

interface LineEdit {
  readonly text: string;
  readonly delta: number;
}

/**
 * Rewrite the lines a caret touches — all of them, whole, because a list marker or a `>` belongs to a
 * line and a selection that stops mid-word does not make the other lines in between somebody else's
 * problem (§6: "selection spanning list items").
 *
 * Every change a `fn` can make is at the start of its line, so a caret shift is exact arithmetic
 * rather than a guess: a position moves by the sum of the deltas of the touched lines that begin at or
 * before it.
 */
function eachLine(text: string, caret: Caret, fn: (line: string, index: number) => string): Applied {
  const lines = linesOf(text);
  const first = lineIndexAt(lines, caret.start);
  const last = lineIndexAt(lines, caret.end);
  const edits: LineEdit[] = [];
  let rewritten = '';

  for (let index = first; index <= last; index += 1) {
    const line = lines[index] as Line;
    const next = fn(line.text, index - first);
    edits.push({ text: next, delta: next.length - line.text.length });
    rewritten += next;
    if (index !== last) rewritten += '\n';
  }

  const shift = (position: number): number => {
    let moved = 0;
    for (let index = first; index <= last; index += 1) {
      const line = lines[index] as Line;
      if (line.start > position) break; // a line that starts after the position never touched it
      const delta = (edits[index - first] as LineEdit).delta;
      // Adding the deltas is exact for *insertion*, and wrong for removal: a caret at column 0 of its own
      // line, or anywhere inside a prefix that is about to be deleted, would move by the whole removal and
      // land on the line **above** — `'a\n- b'` with the caret before the `- ` of line 2 came back at
      // offset 0, i.e. inside line 1, and a selection's `start` pulled the same trick turned `{start: 2}`
      // into `{start: 0}` so that the *next* toolbar press acted on text this one had deliberately left
      // out. A removal can therefore never pull a position past the start of the line it sits on: the most
      // it may take back is the distance from that line's start.
      moved += delta < 0 ? Math.max(delta, -(position - line.start)) : delta;
    }
    return moved;
  };

  const head = text.slice(0, (lines[first] as Line).start);
  const tail = text.slice((lines[last] as Line).end);
  const next = `${head}${rewritten}${tail}`;
  return {
    text: next,
    selection: {
      start: clamp(caret.start + shift(caret.start), next.length),
      end: clamp(caret.end + shift(caret.end), next.length),
    },
  };
}

/** True when every line the caret touches satisfies `predicate` — the "already a list" half of a toggle. */
/**
 * A per-line callback for the line-prefix transforms, with two rules `eachLine` alone cannot know.
 *
 * **A blank line inside a multi-line selection is a separator, not content.** `allLinesMatch` already
 * ignores blank lines when it picks the mode, so a callback that wrote a marker onto a separator decided
 * one thing and did its opposite: three checked items with a blank line between two of them are in
 * `'remove'` mode, the items went back to plain text — and the blank came back as `- [ ] `, a stray empty
 * checkbox in the preview. `'add'` and `'check'` insert empty boxes on separators the same way, and the
 * heading button can put a `#` on a line that has nothing in it.
 *
 * A **collapsed** caret on an empty line is still a request to start a block there (that is §6's "a table
 * at an empty line" case, one line deep), which is why the test is "does the selection span more than one
 * line" rather than "is this line blank". One consequence is worth naming for `blockquote`: a
 * multi-paragraph quote whose separator stays blank renders as two quotes, and pressing the button again
 * with the caret on that line is how the separator gets its `>`. The alternative — a transform writing
 * lines nobody selected content on — is what made the other four wrong, so the rule is uniform.
 *
 * **The ordinal counts content lines.** `1. 2. 3.` has to survive a blank between two items; a separator
 * that consumes a number is a list that counts 1, 2, 4.
 */
function contentLines(
  text: string,
  caret: Caret,
  fn: (line: string, ordinal: number) => string,
): (line: string) => string {
  const lines = linesOf(text);
  const spans = lineIndexAt(lines, caret.end) > lineIndexAt(lines, caret.start);
  let ordinal = 0;
  return (line: string): string => {
    if (line.trim().length === 0) {
      if (spans) return line;
      return fn(line, ordinal);
    }
    return fn(line, ordinal++);
  };
}

function allLinesMatch(text: string, caret: Caret, predicate: (line: string) => boolean): boolean {
  const lines = linesOf(text);
  const first = lineIndexAt(lines, caret.start);
  const last = lineIndexAt(lines, caret.end);
  let sawContent = false;
  for (let index = first; index <= last; index += 1) {
    const line = lines[index] as Line;
    if (line.text.trim().length === 0) continue;
    sawContent = true;
    if (!predicate(line.text)) return false;
  }
  // Blank lines are neither: a caret on the empty line after a list is a request to start a list, not
  // to "toggle off" a marker that is not there.
  return sawContent;
}

// ──────────────────────────────────────────── emphasis ─────────────────────────────────────────────

/** The longest run of one marker character Markdown itself distinguishes: `***x***` is bold **and** italic. */
const STACK_MAX = 3;

/**
 * How far a run of `marker`'s character extends from a boundary.
 *
 * `dir: 1` counts from `at` rightwards (the run *starts* at `at`); `dir: -1` counts from `at - 1` leftwards
 * (the run *ends* at `at`). Every marker here is a repeated single character, so the boundary-adjacent end
 * of the marker names the character to count.
 */
function runFrom(text: string, at: number, marker: string, dir: 1 | -1): number {
  const char = dir === 1 ? marker.charAt(marker.length - 1) : marker.charAt(0);
  let count = 0;
  for (let index = dir === 1 ? at : at - 1; index >= 0 && index < text.length; index += dir) {
    if (text.charAt(index) !== char) break;
    count += 1;
  }
  return count;
}

/**
 * Is the marker touching the target **this** marker, or a slice of somebody else's longer run?
 *
 * The unwrap steps below match a marker by slicing `open.length`/`close.length` characters off the buffer,
 * and slicing is not reading: with `**bold**` and the italic button, the slice one character outside the
 * word *is* an asterisk, so italic "unwrapped" itself and the bold went with it — `*bold*`, a person's
 * emphasis quietly downgraded because they asked for more of it. The rule that makes the family behave:
 * the run has to be exactly this marker's length, or long enough (3) to hold this marker *inside* another
 * one, which is precisely what Markdown's `***x***` means — there, taking one layer off is the honest
 * answer for both buttons (`*x*` for bold, `**x**` for italic).
 *
 * `inward` picks the direction the run is read from: outside the target for step 1's
 * `**|bold|**`, inside it for step 2's `**|**bold**|**`.
 */
function markerIsOwn(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string,
  inward: boolean,
): boolean {
  const before = inward ? runFrom(text, start, open, 1) : runFrom(text, start, open, -1);
  const after = inward ? runFrom(text, end, close, -1) : runFrom(text, end, close, 1);
  if (before === open.length && after === close.length) return true;
  return Math.max(before, after) >= STACK_MAX;
}

/**
 * Wrapping emphasis: `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` ``.
 *
 * `*` and `**` share a character, so the family has three states and they are all reachable: `*x*`,
 * `**x**`, `***x***`. Pressing the *other* button **stacks** (`**x**` + italic → `***x***`), and pressing it
 * on a `***x***` takes one layer off — which is why steps 1 and 2 ask {@link markerIsOwn} before unwrapping.
 *
 * Three moves, in this order, and the order is the whole behaviour:
 *
 * 1. **unwrap around the target** — the markers are on the *outside* of what the caret names
 *    (`**|bold|**`, or the caret sitting just after the closing pair with the word behind it);
 * 2. **unwrap inside the target** — the caret names the whole wrapped run, markers included
 *    (`**|**bold**|**`, i.e. a double-click that swallowed the asterisks);
 * 3. **wrap** — everything else, including a collapsed caret with a word next to it.
 *
 * 1 and 2 are what make the button a *toggle*: the transform for already-emphasised text takes the
 * markers off rather than stacking a second pair, which is the difference between a bold button and a
 * typewriter.
 */
export function emphasis(open: string, close: string = open): Transform {
  return (rawSelection, text) => {
    const caret = normalize(rawSelection, text);
    const target =
      caret.start === caret.end
        ? (wordRangeAt(text, caret.start) ?? { start: caret.start, end: caret.start })
        : caret;
    const { start, end } = target;

    // 1. markers immediately outside the target — and only when they are this transform's own.
    if (
      end > start &&
      start >= open.length &&
      text.slice(start - open.length, start) === open &&
      text.slice(end, end + close.length) === close &&
      markerIsOwn(text, start, end, open, close, false)
    ) {
      const before = text.slice(0, start - open.length);
      const inner = text.slice(start, end);
      const after = text.slice(end + close.length);
      return {
        text: `${before}${inner}${after}`,
        selection: { start: start - open.length, end: end - open.length },
      };
    }

    // 2. the target carries its own markers, again this transform's own and not a longer run's edge.
    if (
      end - start >= open.length + close.length &&
      text.slice(start, start + open.length) === open &&
      text.slice(end - close.length, end) === close &&
      markerIsOwn(text, start, end, open, close, true)
    ) {
      const inner = text.slice(start + open.length, end - close.length);
      const next = `${text.slice(0, start)}${inner}${text.slice(end)}`;
      return { text: next, selection: { start, end: start + inner.length } };
    }

    // 3. wrap (or open the markers around nothing, at a caret with no word next to it).
    const inner = text.slice(start, end);
    const next = `${text.slice(0, start)}${open}${inner}${close}${text.slice(end)}`;
    return { text: next, selection: { start: start + open.length, end: start + open.length + inner.length } };
  };
}

export const bold: Transform = emphasis('**');
export const italic: Transform = emphasis('*');
export const strikethrough: Transform = emphasis('~~');
export const inlineCode: Transform = emphasis('`');

// ──────────────────────────────────────────── line blocks ──────────────────────────────────────────

/** `#`, `##`, `###`. A level change *replaces* the marker; the same level again removes it. */
export function heading(level: 1 | 2 | 3): Transform {
  const marker = '#'.repeat(level);
  const anyHeading = /^ {0,3}(#{1,6})\s+/u;
  const thisHeading = new RegExp(`^ {0,3}(${marker})\\s+`, 'u');
  return (rawSelection, text) => {
    const caret = normalize(rawSelection, text);
    const remove = allLinesMatch(text, caret, (line) => thisHeading.test(line));
    return eachLine(
      text,
      caret,
      contentLines(text, caret, (line) => {
        const stripped = line.replace(anyHeading, '');
        // Toggle-off keeps the text; a different level keeps it too, which is what makes H1→H2 one click.
        return remove ? stripped : `${marker} ${stripped}`;
      }),
    );
  };
}

/** `> ` on every touched line; again removes it. */
export const blockquote: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const quote = /^ {0,3}>\s?/u;
  const remove = allLinesMatch(text, caret, (line) => quote.test(line));
  return eachLine(
    text,
    caret,
    contentLines(text, caret, (line) => (remove ? line.replace(quote, '') : `> ${line}`)),
  );
};

/** `- ` on every touched line. An ordered or task sibling is *replaced*, so the markers cannot stack. */
export const bulletList: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const marker = /^ {0,3}([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/u;
  const remove = allLinesMatch(text, caret, (line) => /^ {0,3}[-*+]\s+(?!\[[ xX]\])/u.test(line));
  return eachLine(
    text,
    caret,
    contentLines(text, caret, (line) => {
      const stripped = line.replace(marker, '');
      return remove ? stripped : `- ${stripped}`;
    }),
  );
};

/** `1. 2. 3.` — renumbered from the first touched line, because a list that counts 1,1,1 is not a list. */
export const orderedList: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const marker = /^ {0,3}([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/u;
  const remove = allLinesMatch(text, caret, (line) => /^ {0,3}\d+[.)]\s+/u.test(line));
  // The ordinal comes from `contentLines`, so a separator between two items costs a number: a list that
  // counts 1, 2, 4 is the bug the blank-line rule above is here to prevent, and renumbering is the half of
  // "a list that counts 1,1,1 is not a list" that a blank line can break on its own.
  return eachLine(
    text,
    caret,
    contentLines(text, caret, (line, ordinal) => {
      const stripped = line.replace(marker, '');
      return remove ? stripped : `${ordinal + 1}. ${stripped}`;
    }),
  );
};

/**
 * `- [ ] `, and the three-state cycle a checkbox has: add the boxes, check them, remove them.
 *
 * The states are decided over **every** non-blank line the caret touches, which is what makes the
 * button a toggle rather than a random walk — and a line that already has a box keeps the box it has
 * when the button is adding the missing ones, so pressing it on a half-converted list cannot lose a
 * tick somebody made by hand.
 */
export const taskList: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const task = /^ {0,3}([-*+]|\d+[.)])\s+\[( |x|X)\]\s+/u;
  const checked = /^ {0,3}([-*+]|\d+[.)])\s+\[[xX]\]\s+/u;
  const everyTask = allLinesMatch(text, caret, (line) => task.test(line));
  const everyChecked = everyTask && allLinesMatch(text, caret, (line) => checked.test(line));
  const mode: 'add' | 'check' | 'remove' = !everyTask ? 'add' : everyChecked ? 'remove' : 'check';

  return eachLine(
    text,
    caret,
    contentLines(text, caret, (line) => {
      const found = task.exec(line);
      if (found === null) {
        const stripped = line.replace(/^ {0,3}([-*+]|\d+[.)])\s+/u, '');
        return `- ${mode === 'check' ? '[x]' : '[ ]'} ${stripped}`;
      }
      // The third press takes the whole task item back to a plain line: leaving `- milk` behind would
      // make this button half of a toggle and the bullet button somebody else's business.
      if (mode === 'remove') return line.slice(found.index).replace(task, '');
      // A line that already has a box is left exactly as it is when the button is only filling in the
      // missing ones. `mode === 'add'` means "not every touched line has a box", and a mixed selection is
      // the ordinary case — a list halfway down, a paste of two lines, a caret on one row of a five-row
      // list — so ticking the box the person left open would be the button deciding an item is finished.
      // That is `'check'`'s job, and `'check'` is only ever reached when *every* touched line is a task
      // item and at least one is still open.
      if (mode === 'add') return line;
      const after = line.slice(found.index + found[0].length);
      return `- [x] ${after}`;
    }),
  );
};

// ────────────────────────────────────────────── link ───────────────────────────────────────────────

const URLISH = /(?:https?:\/\/|www\.)\S+/iu;

/**
 * `[text](url)`, including the case §6 calls out — a selection carrying **both** the text and the URL.
 *
 * * the selection holds a URL *and* other words → the words stay the label and the address becomes the
 *   target (`Example https://example.com` → `[Example](https://example.com)`); this is the shape of a
 *   paste from a chat log, and it is the only reading of "wrapping both URL and text" that does not
 *   make somebody retype the half they already had;
 * * the selection is only a URL → `[url](url)`, because somebody selecting a bare link and pressing
 *   "link" wants a real link, and an empty label is a worse guess than an address one;
 * * any other selection keeps its text and gets an empty target with the caret *inside the
 *   parentheses*, so the next keystroke is the address (the caret goes after the finished link when
 *   the address was already there — there is nothing left to type);
 * * a collapsed caret gets `[]()` with the caret where the label goes, which is the order people
 *   actually type a link in.
 */
export const link: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const selected = text.slice(caret.start, caret.end);

  const replace = (inner: string, caretInside: number): Applied => ({
    text: `${text.slice(0, caret.start)}${inner}${text.slice(caret.end)}`,
    selection: { start: caretInside, end: caretInside },
  });

  if (selected.length === 0) {
    return replace('[]()', caret.start + 1);
  }

  const found = URLISH.exec(selected);
  if (found !== null) {
    const href = found[0].trim();
    const label = selected.replace(href, ' ').replace(/\s+/gu, ' ').trim();
    const target = label.length === 0 ? href : label;
    const inner = `[${target}](${href})`;
    return replace(inner, caret.start + inner.length);
  }

  return replace(`[${selected}]()`, caret.start + selected.length + 3);
};

// ──────────────────────────────────────────── insertions ───────────────────────────────────────────

/**
 * Put a multi-line block on the caret's line, alone.
 *
 * An empty line is *replaced* (that is what "insertion at an empty line" means — no stray blank line
 * above the table); a line with text on it gets the block after it, separated by a blank line so a
 * `---` can never be misread as the underline of a setext heading. The result always ends on its own
 * line, so a block inserted mid-note cannot glue itself to the following paragraph.
 */
export function insertBlock(block: string): Transform {
  return (rawSelection, text) => {
    const caret = normalize(rawSelection, text);
    const lines = linesOf(text);
    const line = lines[lineIndexAt(lines, caret.start)] as Line;
    const tail = text.slice(line.end);
    const empty = line.text.trim().length === 0;
    const at = empty ? line.start : line.end;
    const before = text.slice(0, at);
    const pad = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    // `line.end` is the index of the `\n` that ends the line, so `tail` *starts with* that newline
    // whenever the line is terminated — which means `!tail.startsWith('\n')` is false in every case where
    // there is a following line at all, and the gap the doc comment above promises would never happen.
    // The real question is whether a **blank** line follows, so the test goes one character past the
    // terminator: `tail.slice(1)` is what comes after the block's own line. It matters most for a table,
    // which in GFM ends only at a blank line — without the gap the next paragraph is a table body row,
    // and a person who pressed "Table" watching their prose become cells.
    const needsGap = tail.length > 1 && !tail.startsWith('\n\n');
    const inserted = `${pad}${block}${needsGap ? '\n' : ''}`;
    const next = `${before}${inserted}${tail}`;
    const position = clamp(at + pad.length + block.length, next.length);
    return { text: next, selection: { start: position, end: position } };
  };
}

/** A GFM table with two columns and one empty row, ready to be typed into. */
export const table: Transform = insertBlock('| Column | Column |\n| --- | --- |\n| Cell | Cell |');

/** `---`, on its own lines. */
export const horizontalRule: Transform = insertBlock('---');

/**
 * A fenced code block. Inside the fence nothing is transformed — which is the honest reading of "code
 * block" and the reason it is *not* `emphasis('```')` (three backticks in `emphasis` would fight the
 * inline-code button for the same text).
 */
/**
 * A fenced code block — and the fence always begins a **line**.
 *
 * `insertBlock` already does this for tables and rules; the fence needs it for a sharper reason. Three
 * backticks that do not start a line are not a fence at all: Markdown reads them as inline code, so
 * `'foo ```\nbar\n``` baz'` is a mangled line rather than a block — and the person asked for a code block,
 * not for a pair of literal backticks in their sentence. So the selection is lifted onto its own lines: the
 * text before it keeps its line, the text after it keeps its line, and nothing is deleted on either side.
 * A selection that already spans whole lines is unaffected, which is what the §6 cases assert.
 */
export const codeBlock: Transform = (rawSelection, text) => {
  const caret = normalize(rawSelection, text);
  const selected = text.slice(caret.start, caret.end);
  const before = text.slice(0, caret.start);
  const after = text.slice(caret.end);
  const fence = '```';
  // Only a *mid-line* boundary needs a newline: at a line start or end the fence is already alone.
  const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const trail = after.length === 0 || after.startsWith('\n') ? '' : '\n';

  const inserted = `${lead}${fence}\n${selected}\n${fence}${trail}`;
  const next = `${before}${inserted}${after}`;
  // The fenced text stays selected (or, when it is empty, the caret sits on the line the code goes on), so
  // the next transform acts on the code rather than on a fence mark.
  const start = caret.start + lead.length + fence.length + 1;
  return { text: next, selection: { start, end: start + selected.length } };
};

// ────────────────────────────────────────────── toolbar ────────────────────────────────────────────

/** One button of `EditorToolbar`, in the §5 order. */
export interface ToolbarItem {
  /** `toolbar-<name>`: the id `EditorToolbar` renders and PR-19's specs click. */
  readonly testId: string;
  /** The accessible name, and the text a screenshot shows. */
  readonly label: string;
  /** The `title`, which is where the chord goes when there is one. */
  readonly hint: string;
  readonly transform: Transform;
}

/**
 * The fifteen transforms §5 lists, in the order it lists them.
 *
 * It is data rather than fifteen JSX props so the toolbar, the keymap and the test table read the same
 * list: a button that exists in the UI but not here cannot be tested, and one that exists only here is
 * dead code with a `data-testid`.
 */
export const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { testId: 'toolbar-h1', label: 'H1', hint: 'Heading level 1', transform: heading(1) },
  { testId: 'toolbar-h2', label: 'H2', hint: 'Heading level 2', transform: heading(2) },
  { testId: 'toolbar-h3', label: 'H3', hint: 'Heading level 3', transform: heading(3) },
  { testId: 'toolbar-bold', label: 'B', hint: 'Bold — Ctrl/Cmd+B', transform: bold },
  { testId: 'toolbar-italic', label: 'I', hint: 'Italic — Ctrl/Cmd+I', transform: italic },
  { testId: 'toolbar-strike', label: 'S', hint: 'Strikethrough', transform: strikethrough },
  { testId: 'toolbar-code', label: '<>', hint: 'Inline code', transform: inlineCode },
  { testId: 'toolbar-codeblock', label: '```', hint: 'Code block', transform: codeBlock },
  { testId: 'toolbar-quote', label: '"', hint: 'Blockquote', transform: blockquote },
  { testId: 'toolbar-bullet', label: '•', hint: 'Bullet list', transform: bulletList },
  { testId: 'toolbar-ordered', label: '1.', hint: 'Numbered list', transform: orderedList },
  { testId: 'toolbar-task', label: '☐', hint: 'Task list', transform: taskList },
  { testId: 'toolbar-link', label: 'Link', hint: 'Link — Ctrl/Cmd+K', transform: link },
  { testId: 'toolbar-table', label: 'Table', hint: 'Table', transform: table },
  { testId: 'toolbar-rule', label: 'Rule', hint: 'Horizontal rule', transform: horizontalRule },
];

/** The three chords the editor owns (§5), each named by the id of the button it stands for. */
export const EDITOR_KEYMAP: Readonly<Record<'b' | 'i' | 'k', string>> = {
  b: 'toolbar-bold',
  i: 'toolbar-italic',
  k: 'toolbar-link',
};

/** A button's transform by test id — the keymap's lookup, and the test table's. */
export function transformFor(testId: string): Transform | undefined {
  return TOOLBAR_ITEMS.find((item) => item.testId === testId)?.transform;
}
