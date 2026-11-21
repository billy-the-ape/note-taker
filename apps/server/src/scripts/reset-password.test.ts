/**
 * The bytes behind the hidden prompt (docs/plans/mvp/MVP-07.md §6).
 *
 * `reset-password.ts` collects raw-mode input as bytes and decodes once, at Enter, because raw-mode input *is*
 * a byte stream and the prompt may not echo. That design has exactly one weak point, and PR-07's review found
 * it: an edit. A `bytes.pop()` on `päss` leaves the lead byte of `ä` as the whole buffer, which decodes to
 * U+FFFD — the script would enforce the password rules on, hash, and commit that, print success, and revoke
 * every session, and the operator would find out at the login box. `popLastCharacter` is the fix, so it is
 * tested the way the terminal behaves: characters in, one keystroke off at a time, whole code points out.
 *
 * Not a subprocess test: the prompt needs a TTY, and `reset-password.int.test.ts` (which the `integration` job
 * runs) covers the script's contract with the password arriving as an argument instead.
 */
import { describe, expect, it } from 'vitest';

import { popLastCharacter } from './reset-password.js';

const bytesOf = (text: string): number[] => [...Buffer.from(text, 'utf8')];
const textOf = (bytes: readonly number[]): string => Buffer.from(bytes).toString('utf8');

describe('popLastCharacter', () => {
  it('removes both bytes of ä instead of leaving its lead byte behind', () => {
    // The case from the review: the operator typed up to the `ä` and pressed Backspace once to correct it. The
    // buffer is a stack, so the character under the cursor is its last one — which is why the sample stops at
    // `ä` rather than spelling the whole word out.
    const bytes = bytesOf('pä');

    expect(popLastCharacter(bytes)).toBe(2);
    expect(textOf(bytes)).toBe('p');

    // What the old code committed. Asserted from both sides, because `expect(x).not.toContain('\uFFFD')` on its
    // own would pass for a buffer that dropped the wrong byte somewhere else entirely.
    expect(textOf(bytes)).not.toContain('\uFFFD');
    expect(Buffer.from([0xc3]).toString('utf8')).toBe('\uFFFD');

    // And the same word with the `ä` in the middle: two plain bytes go first, then the whole character.
    const word = bytesOf('päss');
    expect(popLastCharacter(word)).toBe(1);
    expect(popLastCharacter(word)).toBe(1);
    expect(popLastCharacter(word)).toBe(2);
    expect(textOf(word)).toBe('p');
  });

  it('spends one keystroke on a 1-, 2-, 3- and 4-byte character alike', () => {
    const cases: [string, number][] = [
      ['a', 1],
      ['é', 2],
      ['日', 3],
      ['😀', 4],
    ];
    for (const [text, expected] of cases) {
      const bytes = bytesOf(text);
      expect(popLastCharacter(bytes), `the character ${text}`).toBe(expected);
      expect(bytes, `the buffer after ${text}`).toEqual([]);
    }
  });

  it('walks a password back to nothing one character at a time', () => {
    const samples = [
      'correct horse battery staple',
      'pässword-𝄞-日本😀',
      'ÅÄÖ—ß',
      'a😀b', // the surrogate pair in the middle, so the buffer is never all-ASCII or all-multibyte
    ];
    for (const sample of samples) {
      const characters = Array.from(sample);
      const bytes = bytesOf(sample);

      for (let i = characters.length - 1; i >= 0; i -= 1) {
        const removed = popLastCharacter(bytes);
        const expected = characters.slice(0, i).join('');
        expect(removed, `a keystroke with ${JSON.stringify(expected)} left`).toBeGreaterThan(0);
        expect(textOf(bytes), `the buffer after a keystroke at ${JSON.stringify(expected)}`).toBe(expected);
      }

      // …and the empty buffer says so rather than removing something it should not.
      expect(popLastCharacter(bytes)).toBe(0);
      expect(bytes).toEqual([]);
    }
  });

  it('drains a buffer that is only continuation bytes rather than leaving half a character', () => {
    // A terminal cannot deliver this (one character arrives as one chunk), but "leaves half a character in the
    // buffer" is the bug itself, so the degenerate input is pinned as well as the reachable one.
    const bytes = [0x80, 0x80];

    expect(popLastCharacter(bytes)).toBe(2);
    expect(bytes).toEqual([]);
  });
});
