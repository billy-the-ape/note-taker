/**
 * The name wrapper (docs/plans/mvp/MVP-15.md §4, §6).
 *
 * Two claims, and the suite is arranged to fail on each of them separately:
 *
 * 1. **It adds no rules.** Every verdict this file asserts is also asserted of `isValidNoteName`, the
 *    contract's own predicate — including on inputs no dialog produces. A wrapper that quietly became
 *    stricter (or laxer) than the contract is the failure mode §4 names, and a table of values checked
 *    against both sides catches it.
 * 2. **The three compositions do what they say.** The prefill is unique against a set, the submitted name
 *    has no extension, and the field error is the contract's sentence rather than a paraphrase of it.
 */
import { isValidNoteName, NAME_REJECTION_MESSAGES, NOTE_NAME_MAX, newFileName } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { newNoteBaseName, noteNameProblem, submittedName } from './name';

describe('noteNameProblem', () => {
  // Every case §6 asks the dialog to explain, plus the two the contract has and this PR would rather not
  // rediscover in a review: `.` (a name that is not a name) and a nested extension in upper case.
  const invalid: readonly [string, keyof typeof NAME_REJECTION_MESSAGES][] = [
    ['', 'empty'],
    ['a/b', 'reserved-characters'],
    ['foo.md.md', 'nested-extension'],
    ['todo ', 'whitespace-padded'],
    ['.'.repeat(121), 'too-long'],
    ['..', 'reserved-name'],
    ['report.MD.md', 'nested-extension'],
  ];

  it.each(invalid)('refuses %s with the contract’s own sentence for %s', (value, rejection) => {
    const problem = noteNameProblem(value);
    expect(problem?.rejection).toBe(rejection);
    // `toBe` and not `toMatch`: the dialog quotes the same string the API puts in `details[].message`, and
    // a paraphrase here is a second authority wearing the first one's clothes.
    expect(problem?.message).toBe(NAME_REJECTION_MESSAGES[rejection]);
  });

  it('says nothing about a name the API would take', () => {
    for (const value of ['new-file-1700000000000', 'report', 'rèsumé', 'plan-2', 'a'.repeat(NOTE_NAME_MAX)]) {
      expect(noteNameProblem(value)).toBeUndefined();
    }
  });

  it('agrees with isValidNoteName on every value it is given, which is the whole point of the wrapper', () => {
    const values = ['', '..', '.', 'a/b', 'a\\b', 'foo.md', 'foo.md.md', 'todo ', 'todo', 'x'.repeat(121)];
    for (const value of values) {
      expect(noteNameProblem(value) === undefined).toBe(isValidNoteName(value));
    }
  });

  it('refuses a 121-character name and accepts the 120 it replaced', () => {
    expect(noteNameProblem('x'.repeat(NOTE_NAME_MAX))).toBeUndefined();
    expect(noteNameProblem('x'.repeat(NOTE_NAME_MAX + 1))?.rejection).toBe('too-long');
  });
});

describe('submittedName', () => {
  it('drops the display extension on its way to the request body', () => {
    expect(submittedName('report')).toBe('report');
    expect(submittedName('report.md')).toBe('report');
    expect(submittedName('report.MD')).toBe('report');
    // One suffix only, which is what makes `foo.md.md` a refusal rather than a name that silently loses
    // characters and then collides with a stored `foo`.
    expect(submittedName('foo.md.md')).toBe('foo.md');
  });
});

describe('newNoteBaseName', () => {
  const MS = 1_700_000_000_000;

  it('is the README’s name without the README’s extension', () => {
    expect(newNoteBaseName(MS, new Set())).toBe('new-file-1700000000000');
    expect(newFileName(MS)).toBe('new-file-1700000000000.md');
  });

  it('walks the uniquify sequence against the siblings, so two dialogs in one millisecond differ', () => {
    const taken = new Set(['new-file-1700000000000']);
    expect(newNoteBaseName(MS, taken)).toBe('new-file-1700000000000-2');
    expect(newNoteBaseName(MS, new Set([...taken, 'new-file-1700000000000-2']))).toBe(
      'new-file-1700000000000-3',
    );
  });

  it('compares the stored spelling, which is the spelling `taken` must arrive in', () => {
    expect(newNoteBaseName(MS, new Set([`new-file-${MS}`]))).toBe(`new-file-${MS}-2`);
    // `uniquify` strips the *candidate*, because `notes.name` never carries a suffix (MVP-05 §8). A set
    // naming `new-file-….md` is therefore not a collision but a caller that read the display form out of
    // the tree instead of the stored one - which is what `takenSiblingNames` exists to prevent.
    expect(newNoteBaseName(MS, new Set([`new-file-${MS}.md`]))).toBe(`new-file-${MS}`);
  });
});
