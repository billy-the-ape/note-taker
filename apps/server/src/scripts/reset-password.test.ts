/**
 * The bytes behind the hidden prompt (docs/plans/mvp/MVP-07.md §6).
 *
 * `reset-password.ts` collects raw-mode input as bytes and decodes once, at Enter, because raw-mode input *is*
 * a byte stream and the prompt may not echo. That design has two weak points, and PR-07's review found both:
 * an edit and a key with a name. A `bytes.pop()` on `päss` leaves the lead byte of `ä` as the whole buffer,
 * which decodes to U+FFFD; skipping bytes below `0x20` "drops the escape sequence", but `↑` is `1b 5b 41` and
 * only the first of those is below `0x20`, so the arrow used to append `[A` and draw two `*`. Either way the
 * script would enforce the password rules on, hash, and commit a password nobody typed, print success, and
 * revoke every session — and the operator would find out at the login box.
 *
 * `popLastCharacter` and `feedPasswordInput` are the two fixes, tested the way the terminal behaves: bytes in,
 * including sequences split across reads, and the buffer that would be hashed out. `feedPasswordInput` is
 * exercised rather than `readHiddenPassword`, because the latter needs a TTY;
 * `reset-password.int.test.ts` (which the `integration` job runs) covers the script's contract with the
 * password arriving as an argument instead.
 */
import { describe, expect, it } from 'vitest';

import { feedPasswordInput, popLastCharacter, TEXT_PHASE } from './reset-password.js';

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

interface Fed {
  readonly text: string;
  readonly bytes: number[];
  readonly draw: number;
  readonly erase: number;
  readonly stop: 'submit' | 'cancel' | undefined;
  /** The phase the machine finished in: `text` means it is ready for the next keystroke. */
  readonly phase: string;
}

/**
 * Feeds whole reads in order, carrying the phase between them the way `readHiddenPassword` does, and totals what
 * the screen would have been told. Reading stops at Enter or Ctrl-C, like the prompt.
 */
function feed(chunks: readonly (readonly number[])[]): Fed {
  let bytes: number[] = [];
  let phase = TEXT_PHASE;
  let draw = 0;
  let erase = 0;
  let stop: Fed['stop'];

  for (const chunk of chunks) {
    const result = feedPasswordInput({ bytes, phase, chunk });
    bytes = result.bytes;
    phase = result.phase;
    draw += result.draw;
    erase += result.erase;
    stop = result.stop;
    if (result.stop !== undefined) break;
  }
  return { text: textOf(bytes), bytes, draw, erase, stop, phase: phase.kind };
}

/** A key that starts with `ESC`: `csi('[', 'A')` is `↑` on the wire, i.e. `1b 5b 41`. */
const esc = (...body: readonly number[]): number[] => [0x1b, ...body];

describe('feedPasswordInput', () => {
  it('drops an arrow key instead of appending its printable tail to the password', () => {
    // The finding, byte for byte: only `1b` is below `0x20`, so the old filter skipped the introducer and typed
    // `[A` into the recovery password — and drew two `*` doing it.
    const up = feed([esc(0x5b, 0x41)]);
    expect(up.bytes).toEqual([]);
    expect(up.text).toBe('');
    expect(up.draw).toBe(0);
    expect(up.erase).toBe(0);
    expect(up.stop).toBeUndefined();
    // …and it finishes back in `text`, which is what makes the machine safe to leave running: a phase it could
    // get stuck in would swallow the next Enter, and the operator would sit at the prompt holding a password
    // that never submits. Every case below ends the same way.
    expect(up.phase).toBe('text');
  });

  it('drops every named key a terminal sends, plain or modified, in one read', () => {
    const keys: [string, number[]][] = [
      ['up', esc(0x5b, 0x41)],
      ['down', esc(0x5b, 0x42)],
      ['home', esc(0x5b, 0x48)],
      ['end', esc(0x5b, 0x46)],
      ['delete', esc(0x5b, 0x33, 0x7e)],
      ['page-up', esc(0x5b, 0x35, 0x7e)],
      ['F1 (SS3)', esc(0x4f, 0x50)],
      ['ctrl-home', esc(0x5b, 0x31, 0x3b, 0x35, 0x48)],
      ['ctrl-F1', esc(0x4f, 0x31, 0x3b, 0x35, 0x50)],
      ['DECSET report (private)', esc(0x5b, 0x3f, 0x36, 0x68)],
      ['bracketed paste start', esc(0x5b, 0x32, 0x30, 0x30, 0x7e)],
    ];
    for (const [name, bytes] of keys) {
      const fed = feed([bytes]);
      expect(fed.bytes, name).toEqual([]);
      expect(fed.draw, name).toBe(0);
      expect(fed.erase, name).toBe(0);
    }
  });

  it('keeps the sequence across read boundaries, which is what a paste is', () => {
    // Node hands the prompt whatever the pty had ready, so the `ESC` and its body can arrive in different reads.
    // A filter that only looked inside one chunk would be right on the first arrow of a session and wrong on the
    // second, which is the worst possible shape for a bug on this screen.
    const splitThree = feed([[0x1b], [0x5b], [0x41]]);
    expect(splitThree.bytes).toEqual([]);
    expect(splitThree.draw).toBe(0);

    const splitTwo = feed([esc(0x5b), [0x41]]);
    expect(splitTwo.bytes).toEqual([]);

    // Two whole keys and a character, in five reads, none of them aligned to a key boundary.
    const interleaved = feed([[0x1b], esc(0x5b, 0x41, 0x1b, 0x5b, 0x42), bytesOf('p'), [0x1b], [0x4f, 0x50]]);
    expect(interleaved.text).toBe('p');
    expect(interleaved.draw).toBe(1);
  });

  it('leaves the text a human typed intact around a stray keypress', () => {
    // The half that a "drop any chunk that starts with ESC" fix would get wrong for the wrong reason and right by
    // accident: `ESC` arrives mid-chunk here, with real password bytes on both sides of it.
    const typed = feed([bytesOf('päss'), esc(0x5b, 0x41), bytesOf('word')]);
    expect(typed.text).toBe('pässword');
    expect(typed.draw).toBe(8); // one glyph for each of the eight characters, `ä` included

    // A lone `ESC` introduces nothing, so the `b` behind it is still the operator's `b`.
    const stray = feed([[0x61, 0x1b, 0x62]]);
    expect(stray.text).toBe('ab');
    expect(stray.draw).toBe(2);
  });

  it('erases exactly what it drew when a named key shows up between two keystrokes', () => {
    // Why the display and the buffer have to be decided by the same function: the old code drew a `*` per byte,
    // so an arrow cost two glyphs the operator never typed, and one `\b \b` on Backspace left the other behind.
    const typed = feed([bytesOf('a'), esc(0x5b, 0x41), [0x7f]]);
    expect(typed.text).toBe('');
    expect(typed.draw).toBe(1);
    expect(typed.erase).toBe(1);
  });

  it('stops at Enter and drops the rest of that read', () => {
    // `\r` is what a terminal sends on Enter; the `XY` behind it is the tail of a paste, not part of the password.
    const submit = feed([bytesOf('abc\rXY')]);
    expect(submit.text).toBe('abc');
    expect(submit.stop).toBe('submit');

    // A readline-style driver sends `\n`, and the prompt has accepted both since it was written.
    expect(feed([bytesOf('abc\n')]).stop).toBe('submit');
  });

  it('treats Ctrl-C as a cancellation and never as a submission', () => {
    // The distinction is load-bearing: `stop: 'submit'` here would resolve the prompt with `abc`, and the script
    // would hash it, commit it and sign the account out of every device — because someone reached for Ctrl-C.
    const cancelled = feed([[0x61, 0x62, 0x63, 0x03]]);
    expect(cancelled.stop).toBe('cancel');
    // …and the bytes behind it are not what gets written: `run()` rejects, so nothing reaches the hasher.
    expect(cancelled.text).toBe('abc');
  });

  it('still refuses every other control byte without stopping', () => {
    for (const byte of [0x09 /* Tab */, 0x04 /* Ctrl-D */, 0x07 /* Bell */, 0x18 /* Ctrl-X */]) {
      const fed = feed([[byte]]);
      expect(fed.bytes, `0x${byte.toString(16)}`).toEqual([]);
      expect(fed.draw, `0x${byte.toString(16)}`).toBe(0);
      // …and none of them ends the prompt, which Ctrl-C and Enter alone may do.
      expect(fed.stop, `0x${byte.toString(16)}`).toBeUndefined();
    }
  });
});
