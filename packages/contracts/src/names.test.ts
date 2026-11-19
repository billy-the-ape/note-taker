import { describe, expect, it } from 'vitest';

import {
  endsInMd,
  FOLDER_NAME_MAX,
  folderNameIssue,
  folderNameRejection,
  isValidFolderName,
  isValidNoteName,
  MD_EXT,
  NAME_REJECTION_MESSAGES,
  NOTE_NAME_MAX,
  NOTE_NAME_RE,
  newFileName,
  noteNameIssue,
  noteNameRejection,
  stripMd,
  uniquify,
  withMd,
} from './names.js';

/** Longest legal name, and one character past it. */
const AT_MAX = 'n'.repeat(NOTE_NAME_MAX);
const OVER_MAX = `${AT_MAX}x`;

/** Control characters, spelled out so this file stays copy-pasteable and diff-friendly. */
const NUL = String.fromCharCode(0x00);
const NEWLINE = String.fromCharCode(0x0a);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);
const TAB = String.fromCharCode(0x09);

/**
 * A corpus wide enough to falsify the two properties below: unicode, an astral pair, the extension
 * forms, padding, reserved characters, the caps, and names that only *look* like they break a rule.
 */
const CORPUS = [
  'plan',
  'Plan',
  'plan-2',
  'Draft.md',
  'draft.MD',
  'new-file-1700000000000.md',
  'ünïcödé',
  '笔记',
  '😀',
  'emoji-😀-note',
  'trailing dot.',
  'inner.dots',
  'with space',
  'tab\tfree', // a literal tab is a C0 control character, so this one is expected to fail
  'a',
  '.a',
  'a.',
  AT_MAX,
  OVER_MAX,
  '',
  ' ',
  '  padded  ',
  '.',
  '..',
  '.md',
  '.MD',
  '..md',
  '..MD',
  'foo .md',
  ' .md',
  'foo.md.md',
  'foo.md.MD',
  'a/b',
  'a\\b',
  'a:b',
  'a*b',
  'a?b',
  'a"b',
  'a<b',
  'a>b',
  'a|b',
  `a${NUL}b`,
  `a${UNIT_SEPARATOR}b`,
  `a${DEL}b`,
  `a${NEWLINE}b`,
  `a${TAB}b`,
  'notes.md',
  'foo/bar.md',
];

describe('newFileName', () => {
  it('is the README rule, extension included, from the epoch milliseconds it is given', () => {
    expect(newFileName(1_700_000_000_000)).toBe('new-file-1700000000000.md');
    expect(newFileName(0)).toBe('new-file-0.md');
  });

  it('defaults to the current clock', () => {
    expect(newFileName()).toMatch(/^new-file-\d+\.md$/);
  });

  it('produces a name the rules accept once the extension is stripped', () => {
    expect(isValidNoteName(newFileName())).toBe(true);
  });
});

describe('stripMd / withMd', () => {
  it('removes exactly one trailing extension, case-insensitively', () => {
    expect(stripMd(`Draft${MD_EXT}`)).toBe('Draft');
    expect(stripMd('draft.MD')).toBe('draft');
    expect(stripMd('foo.md.md')).toBe('foo.md');
    expect(stripMd('plan')).toBe('plan');
    expect(stripMd('plan.mdx')).toBe('plan.mdx');
  });

  it('strips a bare extension to the empty string, which the rules then refuse', () => {
    expect(stripMd(MD_EXT)).toBe('');
    expect(isValidNoteName(MD_EXT)).toBe(false);
  });

  it('renders the extension for display and is idempotent over stored names', () => {
    expect(withMd('plan')).toBe('plan.md');
    expect(withMd('plan.md')).toBe('plan.md');
    expect(withMd('笔记')).toBe('笔记.md');
  });

  it('reports the extension case-insensitively', () => {
    expect(endsInMd('a.Md')).toBe(true);
    expect(endsInMd('a')).toBe(false);
    expect(endsInMd('a.md.md')).toBe(true);
  });
});

describe('isValidNoteName', () => {
  it('accepts ordinary names, unicode, and a single extension it will strip', () => {
    for (const name of ['plan', 'plan-2', 'Draft.md', 'with space', 'trailing dot.', AT_MAX, '笔记', '😀']) {
      expect(isValidNoteName(name), name).toBe(true);
    }
  });

  it('refuses the empty name, whitespace padding, and the 121st character', () => {
    expect(isValidNoteName('')).toBe(false);
    expect(isValidNoteName('   ')).toBe(false);
    expect(isValidNoteName(' lead')).toBe(false);
    expect(isValidNoteName('trail ')).toBe(false);
    expect(isValidNoteName(OVER_MAX)).toBe(false);
    expect(NOTE_NAME_MAX).toBe(120);
  });

  it('exports NOTE_NAME_RE, the reserved-character rule of plan §7, and it is stateless', () => {
    // It matches a character that is forbidden, so `true` is the refusal.
    expect(NOTE_NAME_RE.test('a/b')).toBe(true);
    expect(NOTE_NAME_RE.test('plan')).toBe(false);
    expect(NOTE_NAME_RE.test('note: 1')).toBe(true);
    // Without the `g` flag there is no `lastIndex` to leak between calls, which is the classic way a
    // shared test regex starts answering differently on the second call.
    expect(NOTE_NAME_RE.flags).not.toContain('g');
    expect(NOTE_NAME_RE.test('a/b')).toBe(true);
  });

  it('refuses every reserved character, including control characters', () => {
    for (const name of [
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      `a${NEWLINE}b`,
      `a${NUL}b`,
      // DEL is outside the C0 range, which is why the rule is the Unicode control category.
      `a${DEL}b`,
      `a${UNIT_SEPARATOR}b`,
    ]) {
      expect(isValidNoteName(name), name).toBe(false);
      expect(noteNameRejection(name)).toBe('reserved-characters');
    }
  });

  it('refuses . and .. as names', () => {
    expect(isValidNoteName('.')).toBe(false);
    expect(isValidNoteName('..')).toBe(false);
    expect(noteNameRejection('..')).toBe('reserved-name');
  });

  it('runs every rule on stripMd(name): "..md" and "foo .md" fail on the rules they actually break', () => {
    // "..md" is not "too long" or "empty", it is `.` — the reserved name — once the extension is gone.
    expect(noteNameRejection('..md')).toBe('reserved-name');
    expect(isValidNoteName('..md')).toBe(false);
    // "foo .md" strips to "foo ": padding nobody can see in the UI.
    expect(noteNameRejection('foo .md')).toBe('whitespace-padded');
    expect(isValidNoteName('foo .md')).toBe(false);
    expect(noteNameRejection('.md')).toBe('empty');
    expect(noteNameRejection('')).toBe('empty');
    expect(noteNameRejection(OVER_MAX)).toBe('too-long');
  });

  it('refuses a stripped name that still ends in .md, because one strip has to be enough', () => {
    for (const name of ['foo.md.md', 'foo.md.MD', 'a.md.Md']) {
      expect(noteNameRejection(name), name).toBe('nested-extension');
      expect(isValidNoteName(name), name).toBe(false);
    }
    // The alternative — silently stripping twice — would store `foo.md` (breaking the §8 invariant, and
    // rendering identically to a stored note called `foo`) or collide `foo.md.md` with `foo`.
    expect(withMd('foo')).toBe(withMd('foo.md'));
  });

  it('is the same answer as the rejection list, for every shape in the corpus', () => {
    for (const name of CORPUS) {
      expect(isValidNoteName(name), name).toBe(noteNameRejection(name) === undefined);
    }
  });

  it('names the rule that failed, so a form can show it', () => {
    expect(noteNameIssue('plan')).toBeUndefined();
    expect(noteNameIssue(OVER_MAX)).toEqual({
      code: 'custom',
      path: ['name'],
      message: NAME_REJECTION_MESSAGES['too-long'],
    });
    expect(noteNameIssue('a/b', ['note', 'name'])?.path).toEqual(['note', 'name']);
  });
});

describe('isValidFolderName', () => {
  it('shares the character and length rules with notes', () => {
    expect(FOLDER_NAME_MAX).toBe(NOTE_NAME_MAX);
    for (const name of ['a/b', 'a|b', '.', '..', ' ', 'trail ', OVER_MAX]) {
      expect(isValidFolderName(name), name).toBe(false);
      expect(folderNameRejection(name), name).toBe(noteNameRejection(name));
    }
    expect(isValidFolderName(AT_MAX)).toBe(true);
  });

  it('has no extension handling: a folder may legitimately be called "notes.md"', () => {
    expect(isValidFolderName('notes.md')).toBe(true);
    expect(folderNameRejection('notes.md')).toBeUndefined();
    // …while the same string as a note name is a legal note whose stored name is `notes`.
    expect(isValidNoteName('notes.md')).toBe(true);
    expect(stripMd('notes.md')).toBe('notes');
    // Padding and nested extensions are note-only ideas too, so folders see them as ordinary text.
    expect(isValidFolderName('foo .md')).toBe(true);
    expect(folderNameRejection('foo.md.md')).toBeUndefined();
  });

  it('names the rule that failed', () => {
    expect(folderNameIssue('work')).toBeUndefined();
    expect(folderNameIssue('')).toEqual({ code: 'custom', path: ['name'], message: 'must not be empty' });
  });
});

describe('strip-idempotence', () => {
  it('isValidNoteName(n) implies stripMd(stripMd(n)) === stripMd(n)', () => {
    for (const name of CORPUS) {
      if (!isValidNoteName(name)) continue;
      const once = stripMd(name);
      expect(stripMd(once), `${name} -> ${once}`).toBe(once);
      // Stated the other way: a name the rules accept never stores a value that still ends in .md.
      expect(endsInMd(once), `${name} -> ${once}`).toBe(false);
    }
  });

  it('so a stored name needs no strip at all: stripMd(stored) === stored', () => {
    const stored = CORPUS.filter(isValidNoteName).map(stripMd);
    for (const name of stored) {
      expect(stripMd(name)).toBe(name);
    }
  });

  it('deliberately does NOT claim stripMd(n) === n — "Draft.md" is valid and does change', () => {
    expect(isValidNoteName('Draft.md')).toBe(true);
    expect(stripMd('Draft.md')).toBe('Draft');
  });
});

describe('collision', () => {
  it('two distinct stored names never render to the same withMd() display string', () => {
    const stored = [...new Set(CORPUS.filter(isValidNoteName).map(stripMd))];
    const displayed = stored.map(withMd);
    expect(new Set(displayed).size, `${stored.join(', ')} -> ${displayed.join(', ')}`).toBe(stored.length);
  });

  it('which is exactly why "foo.md" may not be stored next to "foo"', () => {
    const stored = ['foo', 'foo.md'];
    expect(new Set(stored.map(withMd)).size).toBe(1); // the collision the rules exist to prevent…
    expect(isValidNoteName('foo.md.md')).toBe(false); // …and the rule that prevents it.
  });
});

describe('uniquify', () => {
  it('appends -2, -3, … to the stored, extension-free base', () => {
    const taken = new Set<string>();

    const first = uniquify('plan', taken);
    expect(first).toBe('plan');
    taken.add(first);

    const second = uniquify('plan', taken);
    expect(second).toBe('plan-2');
    taken.add(second);

    const third = uniquify('plan', taken);
    expect(third).toBe('plan-3');
  });

  it('never emits a name that still carries the extension', () => {
    expect(uniquify('plan', new Set(['plan']))).toBe('plan-2');
    expect(uniquify('plan.md', new Set())).toBe('plan');
    expect(uniquify('plan.md', new Set(['plan', 'plan-2']))).toBe('plan-3');
    expect(uniquify('plan.md', new Set(['plan']))).not.toContain('.md-');
    expect(uniquify('notes.md', new Set(['notes.md']))).toBe('notes');
  });

  it('is case-sensitive, exactly like the sibling unique indexes', () => {
    expect(uniquify('Plan', new Set(['plan']))).toBe('Plan');
    expect(uniquify('plan', new Set(['Plan']))).toBe('plan');
  });

  it('hands back a name the note rules accept, for every corpus entry that had one to begin with', () => {
    const taken = new Set(['plan', 'plan-2']);
    for (const name of CORPUS.filter(isValidNoteName)) {
      const candidate = uniquify(name, taken);
      expect(isValidNoteName(candidate), `${name} -> ${candidate}`).toBe(true);
      expect(endsInMd(candidate), candidate).toBe(false);
    }
  });
});
