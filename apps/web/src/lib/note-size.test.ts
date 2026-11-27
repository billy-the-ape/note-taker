/**
 * How big a note is (docs/plans/mvp/MVP-13.md §6: "unit-test the threshold logic; do not build a 900 KiB DOM
 * fixture").
 *
 * The fixture *here* is the 900 KiB string, and that is the point: a megabyte of text in a test of a pure
 * function costs a millisecond, while the same fixture in a DOM test costs a rendered `<textarea>` and buys
 * nothing the arithmetic does not already prove. The component test hands `EditorPane` a status; this file is
 * where the status comes from.
 *
 * The two thresholds are the contract's own constants, and the boundary assertions are written **against the
 * constants** rather than against 921600 and 1048576: a cap change is supposed to move these lines' *inputs*
 * and leave their verdicts alone. What would be a real bug — the warning drifting off the server's cap
 * because somebody edited a number in `lib/` — is asserted by the last test, which quotes both constants and
 * the fact that the client warns before the server refuses.
 */
import { NOTE_CONTENT_MAX_BYTES, NOTE_CONTENT_WARN_BYTES } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { counterText, formatBytes, noteSize, sizeStatus, sizeWarning } from './note-size';

/** A string of exactly `bytes` UTF-8 bytes. ASCII, so the byte count is the length. */
const ofBytes = (bytes: number): string => 'a'.repeat(bytes);

describe("the byte count is the server's number", () => {
  it('counts UTF-8 bytes, not characters', () => {
    // The case the guard would get wrong if it counted `.length`: an emoji is 4 bytes and 2 UTF-16 units,
    // so a client that trusted `length` would under-report by half.
    const size = noteSize('🙂🙂🙂🙂');
    expect(size.chars).toBe(8);
    expect(size.bytes).toBe(16);
  });

  it('counts a multi-byte script the way the seal will', () => {
    // Three bytes apiece in UTF-8, one in UTF-16: the two numbers are allowed to disagree, which is why
    // the counter shows both.
    const size = noteSize('λβγδ');
    expect(size.chars).toBe(4);
    expect(size.bytes).toBe(8);
  });

  it('is empty for the empty note', () => {
    expect(noteSize('')).toEqual({ bytes: 0, chars: 0, status: 'ok' });
  });
});

describe('the threshold', () => {
  it('is quiet below the warning point', () => {
    expect(sizeStatus(0)).toBe('ok');
    expect(sizeStatus(NOTE_CONTENT_WARN_BYTES - 1)).toBe('ok');
  });

  it('warns from the threshold itself, not one byte past it', () => {
    // "900 KiB and over" is the promise; a threshold you have to exceed is a threshold nobody hits.
    expect(sizeStatus(NOTE_CONTENT_WARN_BYTES)).toBe('warn');
  });

  it('stays in warning all the way to the cap, which the server still accepts', () => {
    expect(sizeStatus(NOTE_CONTENT_MAX_BYTES)).toBe('warn');
    expect(sizeStatus(NOTE_CONTENT_MAX_BYTES - 1)).toBe('warn');
  });

  it('calls it over the moment the server would refuse', () => {
    expect(sizeStatus(NOTE_CONTENT_MAX_BYTES + 1)).toBe('over');
    expect(sizeStatus(NOTE_CONTENT_MAX_BYTES * 2)).toBe('over');
  });

  it('warns before the cap, so the warning is a chance to act rather than an obituary', () => {
    expect(NOTE_CONTENT_WARN_BYTES).toBeLessThan(NOTE_CONTENT_MAX_BYTES);
    // The gap is 124 KiB — a long note's worth of room to cut something. Asserted as a floor rather than as
    // the exact subtraction, because the useful promise is "you get time to react", and a cap change that
    // shrinks the gap under a paragraph is the failure this catches.
    const gap = NOTE_CONTENT_MAX_BYTES - NOTE_CONTENT_WARN_BYTES;
    expect(gap).toBeGreaterThanOrEqual(64 * 1024);
    expect(gap).toBeLessThan(NOTE_CONTENT_MAX_BYTES / 4);
  });

  it('agrees with noteSize, which is the pair the component actually calls', () => {
    // The cap itself still fits (`contentUpdateSchema` accepts a body of exactly 1 MiB), so the byte that
    // changes the verdict is the one *after* it — and `noteSize` has to reach the same verdict from the
    // string, because that is the call `EditorPane` makes on every keystroke.
    expect(noteSize(ofBytes(NOTE_CONTENT_MAX_BYTES)).status).toBe('warn');
    expect(noteSize(ofBytes(NOTE_CONTENT_MAX_BYTES + 1)).status).toBe('over');
  });
});

describe('the sentences', () => {
  it('says nothing when the note is an ordinary size', () => {
    expect(sizeWarning('ok')).toBeUndefined();
  });

  it('names the number it is warning about', () => {
    const warn = sizeWarning('warn') ?? '';
    expect(warn).toContain(formatBytes(NOTE_CONTENT_WARN_BYTES));
    expect(warn).toContain(formatBytes(NOTE_CONTENT_MAX_BYTES));
  });

  it('says what will happen once the cap is behind us', () => {
    // Past the cap the useful fact is the consequence, because the save is going to fail and PR-14's pill is
    // about to say so too.
    expect(sizeWarning('over') ?? '').toContain('refuse');
  });

  it('puts both numbers and the character count on one line', () => {
    // `hello ` plus an emoji: 10 bytes and 8 UTF-16 units, i.e. the two numbers the line exists to show
    // side by side instead of making the person guess which one the cap is about.
    const text = counterText(noteSize('hello 🙂'));
    expect(text).toContain('10 B of ');
    expect(text).toContain('8 characters');
  });
});

describe('formatBytes', () => {
  it('is exact below a kibibyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('switches to KiB only when it helps', () => {
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(4300)).toBe('4.20 KiB');
  });

  it('states the cap as a round number a person can compare against', () => {
    expect(formatBytes(NOTE_CONTENT_MAX_BYTES)).toBe('1.00 MiB');
    expect(formatBytes(NOTE_CONTENT_WARN_BYTES)).toBe('900.0 KiB');
  });
});
