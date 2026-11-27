// @vitest-environment jsdom
/**
 * The crash fallback's storage (docs/plans/mvp/MVP-14.md §6).
 *
 * These tests run in jsdom because the thing under test *is* `localStorage`, and the interesting
 * behaviours are the two that are not "set an item": the key format PR-19 is allowed to assert
 * (`note-draft:<id>`, not the `nt.` preferences namespace), and the match-conditional clear that stops
 * one tab from deleting another tab's unsaved text.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearDraft,
  clearDraftIf,
  createDraftMirror,
  DRAFT_KEY_PREFIX,
  draftKey,
  draftNeedsRestore,
  readDraft,
  writeDraft,
} from './draft';

const ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

afterEach(() => {
  localStorage.clear();
});

describe('the key', () => {
  it('is note-draft:<id>, which is the key §6 names and PR-19 asserts on', () => {
    expect(draftKey(ID)).toBe(`${DRAFT_KEY_PREFIX}${ID}`);
    expect(draftKey(ID)).toBe(`note-draft:${ID}`);
    // …and it is deliberately not in the `nt.` preferences namespace: this is a note body, not a UI
    // setting, and it does not belong in `uiStore`.
    expect(DRAFT_KEY_PREFIX.startsWith('nt.')).toBe(false);
  });
});

describe('read and write', () => {
  it('round-trips the buffer, including one that is only newlines', () => {
    writeDraft(ID, '# heading\n\nbody\n');
    expect(readDraft(ID)).toBe('# heading\n\nbody\n');
    expect(localStorage.getItem(draftKey(ID))).toBe('# heading\n\nbody\n');
  });

  it('has no draft before the first write, which is what a first visit looks like', () => {
    expect(readDraft(ID)).toBeUndefined();
  });

  it('keeps one note’s text away from another note’s key', () => {
    writeDraft(ID, 'this note');
    writeDraft(OTHER, 'that note');
    expect(readDraft(ID)).toBe('this note');
    expect(readDraft(OTHER)).toBe('that note');
  });

  it('treats the empty string as a real mirror, not as “no draft”', () => {
    writeDraft(ID, '');
    expect(readDraft(ID)).toBe('');
    // A note emptied in the editor and lost on a crash is still text the server does not have.
    expect(draftNeedsRestore(ID, 'what the server has')).toBe(true);
  });
});

describe('clearDraftIf', () => {
  it('removes the mirror while it holds the text it was promised', () => {
    writeDraft(ID, 'the text I am discarding');
    expect(clearDraftIf(ID, 'the text I am discarding')).toBe(true);
    expect(readDraft(ID)).toBeUndefined();
  });

  it('leaves a stranger’s draft alone, which is the cross-tab case', () => {
    // Another tab typed over the same key: this tab’s confirmed write must not eat that text.
    writeDraft(ID, 'what another tab is holding');
    expect(clearDraftIf(ID, 'what this tab just saved')).toBe(false);
    expect(readDraft(ID)).toBe('what another tab is holding');
  });

  it('says nothing happened when the key is already gone', () => {
    expect(clearDraftIf(ID, 'anything')).toBe(false);
  });
});

describe('clearDraft', () => {
  it('removes the key whatever it holds, because “throw this draft away” means it', () => {
    writeDraft(ID, 'somebody else’s text');
    clearDraft(ID);
    expect(readDraft(ID)).toBeUndefined();
    expect(localStorage.getItem(draftKey(ID))).toBeNull();
  });
});

describe('draftNeedsRestore', () => {
  it('is false with nothing mirrored, and false when the mirror already matches the server', () => {
    expect(draftNeedsRestore(ID, 'server text')).toBe(false);
    writeDraft(ID, 'server text');
    expect(draftNeedsRestore(ID, 'server text')).toBe(false);
  });

  it('is true exactly when the mirror holds text the buffer does not', () => {
    writeDraft(ID, 'the text a crash kept');
    expect(draftNeedsRestore(ID, 'server text')).toBe(true);
  });
});

describe('createDraftMirror', () => {
  it('binds both halves to one id, which is the shape the machine injects', () => {
    const mirror = createDraftMirror(ID);

    mirror.write('typed');
    expect(readDraft(ID)).toBe('typed');

    // The conditional clear is the machine's rule, kept here so the mirror's contract is one thing.
    mirror.clear('a different text');
    expect(readDraft(ID)).toBe('typed');

    mirror.clear('typed');
    expect(readDraft(ID)).toBeUndefined();
  });

  it('writes only its own key, so a mirror cannot reach another note', () => {
    const mirror = createDraftMirror(ID);
    mirror.write('typed');
    expect(Object.keys(localStorage)).toEqual([draftKey(ID)]);
  });
});
