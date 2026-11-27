/**
 * The two pure halves of search — the fold and the snippet window (docs/plans/mvp/MVP-11.md §4).
 *
 * They are unit-tested because both are functions of a string, and the cases that make them interesting are
 * strings no database needs to hold: a body whose accents arrive decomposed, a match one code point from the cut,
 * an emoji sitting exactly where a UTF-16 slice would break. `search.service.int.test.ts` proves the same rules
 * against a real corpus and a real keyring; this file is what makes them cheap enough to enumerate.
 *
 * One assertion here earns its place against the integration suite: `foldKey` and the fold inside
 * {@link snippetAround} are **two implementations** — one native `normalize` pass for matching (which only needs
 * yes/no), one per-code-point pass that also carries the index map a snippet needs. They agree on decomposition
 * and on stripping; the single case where they cannot (`Σ`, whose lowercase depends on whether it ends a word) is
 * pinned below, together with the degradation it causes — a snippet anchored at the front, never a lost result.
 */
import { describe, expect, it } from 'vitest';

import { foldKey, SNIPPET_MAX_CODEPOINTS, snippetAround } from './search.service.js';

/** Code points, because that is the unit the snippet budget is written in. */
function cps(text: string): number {
  return Array.from(text).length;
}

/** A string with no lone surrogate anywhere: the property a truncated snippet has to keep. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('foldKey — NFD, strip combining marks, lowercase (§4)', () => {
  it('folds accents to their base letters, composed or decomposed', () => {
    expect(foldKey('café')).toBe('cafe');
    expect(foldKey('café')).toBe('cafe'); // the same word as `e` + U+0301
    expect(foldKey('CAFÉ')).toBe('cafe');
    expect(foldKey('Crème brûlée')).toBe('creme brulee');
    expect(foldKey('naïve')).toBe('naive');
    expect(foldKey('Ångström')).toBe('angstrom');
    expect(foldKey('Å')).toBe('a');
    expect(foldKey('Ø'), 'the slash is part of the letter').toBe('ø');
  });

  it('is the identity on what cannot fold, and idempotent on everything else', () => {
    const ascii = 'plain lowercase 42 + punctuation!';
    expect(foldKey(ascii)).toBe(ascii); // the fast path: the very same string, not a copy

    for (const text of ['café', 'Crème brûlée', 'ﬁle', 'ΑΣΠΕΣ', '日本語', '🦄 needle', 'ẞ']) {
      expect(foldKey(foldKey(text)), text).toBe(foldKey(text));
    }
  });

  it('leaves characters that only case-fold alone, and never touches a code point it cannot decompose', () => {
    // `ß` has no NFD decomposition and no simple uppercase mapping pair; `ﬁ` is a compatibility ligature, which
    // NFD (canonical, not compatibility) deliberately leaves alone. Both stay themselves, lowercased.
    expect(foldKey('ß')).toBe('ß');
    expect(foldKey('ﬁ')).toBe('ﬁ');
    expect(foldKey('🦄')).toBe('🦄');
    expect(foldKey('日本語')).toBe('日本語');
    // The Greek sigma is the interesting one: JS `toLowerCase` applies Unicode's final-sigma rule, so a word-end
    // `Σ` becomes `ς` while an interior one becomes `σ`. That is the one place a whole-string fold and a
    // per-character fold genuinely differ, and `snippetAround`'s fallback is what that divergence costs (below).
    expect(foldKey('ΟΔΥΣΣΕΥΣ')).toBe('οδυσσευς');
    expect(foldKey('Σ')).toBe('σ');
    expect(foldKey('ς')).toBe('ς');
  });
});

describe('snippetAround — ~120 code points around the match, cut on a boundary (§4)', () => {
  const needle = 'needle';

  it('returns the whole text when it fits, and puts the match in the middle otherwise', () => {
    expect(snippetAround('a needle in a short body', needle)).toBe('a needle in a short body');

    const text = `${'x'.repeat(300)}needle${'y'.repeat(300)}`;
    const snippet = snippetAround(text, needle);
    expect(cps(snippet)).toBe(SNIPPET_MAX_CODEPOINTS);
    expect(snippet).toContain(needle);
    expect(snippet.startsWith('x')).toBe(true);
    expect(snippet.endsWith('y')).toBe(true);
  });

  it('clamps at the edges instead of padding, so the snippet stays the text it came from', () => {
    const leading = `${needle}${'z'.repeat(300)}`;
    // The match is at the front, so there is nothing before it to show: the window opens at 0 and runs to the
    // budget, rather than being centred with 60 phantom characters in front.
    expect(snippetAround(leading, needle)).toBe(leading.slice(0, SNIPPET_MAX_CODEPOINTS));

    const trailing = `${'z'.repeat(300)}${needle}`;
    // …and the mirror case: 60 code points of context, then the match, then the end of the text. Shorter than
    // the budget, because padding a snippet with invented text would be a worse promise than a short one.
    expect(snippetAround(trailing, needle)).toBe(`${'z'.repeat(60)}${needle}`);
  });

  it('never splits a surrogate pair, however the window lands', () => {
    const field = '🦄'.repeat(80);
    const cases: readonly string[] = [
      `${field}${needle}${field}`,
      `${needle}${field}`,
      `${field}${needle}`,
      `${'👍🏽'.repeat(70)}${needle}${'🇯🇵'.repeat(70)}`,
      // A variation selector and a ZWJ sequence: multi-unit, multi-code-point "one character" to a reader.
      `${'❤️'.repeat(70)}${needle}${'👩‍👩‍👧'.repeat(70)}`,
    ];

    for (const text of cases) {
      const snippet = snippetAround(text, needle);
      expect(snippet, text.slice(0, 24)).toContain(needle);
      expect(cps(snippet), text.slice(0, 24)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
      expect(hasLoneSurrogate(snippet), text.slice(0, 24)).toBe(false);
    }
  });

  it('cuts at the match, not at the folded index, when the body carries combining marks', () => {
    // 120 marks before the match: the folded index of `needle` is 120 and its index in the source is 240, so a
    // window cut at the folded index would open 120 code points early and stop containing the match.
    const text = `${'a\u0301'.repeat(120)}${'x'.repeat(60)}${needle} tail`;
    const snippet = snippetAround(text, needle);
    expect(snippet).toContain(needle);
    expect(cps(snippet)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
  });

  it('shows the accents it was given, so a folded match still quotes plaintext', () => {
    const text = `nothing here, but the café on ${'x'.repeat(80)} the corner closed${'y'.repeat(80)}`;
    const snippet = snippetAround(text, foldKey('café'));
    expect(cps(snippet)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
    // The window is plaintext (the accent is still there) and it is the region the *folded* match pointed at.
    expect(snippet).toContain('café');
    expect(foldKey(snippet)).toContain(foldKey('café'));
  });

  it('gives up gracefully when the two folds ever disagree, rather than losing the result', () => {
    // No match at all: the documented fallback is a window from the front, not a thrown error and not an empty
    // string (an empty snippet would read as "this note contains nothing", which is a different claim).
    const snippet = snippetAround('a body with no such thing', 'zzz');
    expect(cps(snippet)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippetAround('', needle)).toBe('');
  });

  it('survives the one input where the matching fold and the snippet fold differ', () => {
    // `ΕΥΣ` at the end of a word folds to `ευς` whole-string and `ευσ` per character (the final-sigma rule is the
    // only context-sensitive thing in either fold), so the snippet pass cannot find the match the matching pass
    // found. What has to hold in that case is degradation, not failure: the result stands, its snippet is still a
    // window on the body, and nothing is thrown, emptied or invented.
    const text = 'ΟΔΥΣΣΕΥΣ';
    const snippet = snippetAround(text, foldKey('ΕΥΣ'));
    expect(snippet.length).toBeGreaterThan(0);
    expect(cps(snippet)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
    expect(snippet).toContain(text);
  });

  it('handles a query longer than the budget by quoting the front of the match', () => {
    const long = 'needle'.padEnd(150, '!');
    const snippet = snippetAround(`${'x'.repeat(40)}${long}${'y'.repeat(40)}`, long);
    expect(cps(snippet)).toBe(SNIPPET_MAX_CODEPOINTS);
    // 150 code points of match cannot fit in 120 of snippet; what comes back has to be *from* the match and start
    // where it starts, rather than a window of unrelated context or the match's own tail.
    expect(snippet.startsWith(long.slice(0, SNIPPET_MAX_CODEPOINTS))).toBe(true);
    expect(cps(snippet)).toBeLessThan(cps(long));
  });

  it('is stable for every nasty case against both folds', () => {
    const marked = 'Crème brûlée naïve Ångström café'.repeat(4);
    const cases: readonly (readonly [string, string])[] = [
      [marked, 'creme'],
      [marked, 'brulee'],
      [marked, 'naive'],
      [marked, 'angstrom'],
      [`prefix ${'café'.repeat(60)} suffix`, 'cafe'],
      [`decomposed cafe\u0301 here ${'x'.repeat(100)}`, 'cafe'],
      [`emoji 🦄 and ${'é'.repeat(50)} then ${needle}`, needle],
    ];

    for (const [text, folded] of cases) {
      expect(foldKey(text), text.slice(0, 20)).toContain(folded);
      const snippet = snippetAround(text, folded);
      expect(cps(snippet), text.slice(0, 20)).toBeLessThanOrEqual(SNIPPET_MAX_CODEPOINTS);
      expect(hasLoneSurrogate(snippet), text.slice(0, 20)).toBe(false);
      // The snippet is plaintext, so it may legitimately show `Crème` where the key says `creme`. What must hold
      // is that re-folding the window finds the match again: that is the agreement between the matching fold and
      // the snippet fold expressed as a behaviour, which is the only form of it a caller can observe.
      expect(foldKey(snippet), text.slice(0, 20)).toContain(folded);
    }
  });
});
