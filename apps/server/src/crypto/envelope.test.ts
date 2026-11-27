import { describe, expect, it } from 'vitest';

import type { SealedContent } from '../db/repositories/notes.repo.js';
import {
  AES_256_GCM,
  contentStats,
  decrypt,
  EnvelopeError,
  encrypt,
  IV_BYTES,
  keyForVersion,
  noteAad,
  openNoteContent,
  sealNoteContent,
  TAG_BYTES,
} from './envelope.js';
import { type Keyring, keyFingerprint } from './keys.js';

/**
 * The envelope asserted at the layer PR-06 owns: no database, no routes, no server. The route-level
 * rendering of these failures (`INTERNAL`, the note id logged, never blank content) is PR-09's, because
 * the routes that could show them depend on this PR.
 */

/** 32 bytes of distinct key material: two of them, so "wrong key" is never an accident of equality. */
function key(seed: number): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, index) => (index * 7 + seed) % 251));
}

const KEY_1 = key(1);
const KEY_2 = key(99);

/** The keyring of a process that has never rotated: one key, version 1. */
const keyring1: Keyring = { current: { version: 1, key: KEY_1 }, previous: new Map() };
/** The same database after a rotation to version 2, with version 1 still decrypt-only. */
const keyring2: Keyring = { current: { version: 2, key: KEY_2 }, previous: new Map([[1, KEY_1]]) };
/** A process whose `_PREVIOUS` was emptied too early: version 1 rows are gone to it. */
const keyringWithout1: Keyring = { current: { version: 2, key: KEY_2 }, previous: new Map() };

const NOTE_ID = '6f1e6f7a-2c1c-4a2f-8f1e-4b7c2d9e0a11';
const OTHER_NOTE_ID = '2b8c0d1e-9f3a-4e5c-a6b7-8d1e2f3a4b5c';

/** A copy with one bit flipped somewhere in the body — the tamper the acceptance list asks for. */
function flipByte(cipher: Uint8Array, index = 0): Uint8Array {
  const tampered = Uint8Array.from(cipher);
  // `noUncheckedIndexedAccess` types the read as `number | undefined`; the index is in range by construction,
  // and `?? 0` keeps the flip total rather than writing NaN (which a typed array would silently store as 0).
  tampered[index] = (tampered[index] ?? 0) ^ 0x01;
  return tampered;
}

describe('the envelope format', () => {
  it('is aes-256-gcm with a 12-byte IV and a 16-byte appended tag', () => {
    expect(AES_256_GCM).toBe('aes-256-gcm');
    expect(IV_BYTES).toBe(12);
    expect(TAG_BYTES).toBe(16);
  });

  it('seals the empty string into a real envelope, and opens it back', () => {
    // `POST /api/notes` with no content stores this row (MVP-09 §5.6): the columns are never empty, so
    // reading one never has to guess whether empty columns meant empty content.
    const sealed = sealNoteContent('', NOTE_ID, keyring1);
    expect(sealed.contentIv).toHaveLength(IV_BYTES);
    expect(sealed.contentCipher).toHaveLength(TAG_BYTES);
    expect(sealed.contentBytes).toBe(0);
    expect(sealed.wordCount).toBe(0);
    expect(openNoteContent({ id: NOTE_ID, ...sealed }, keyring1)).toBe('');
  });

  it('uses a fresh IV per write, so the same text never repeats a ciphertext', () => {
    const first = sealNoteContent('the same text', NOTE_ID, keyring1);
    const second = sealNoteContent('the same text', NOTE_ID, keyring1);
    expect(first.contentIv).not.toEqual(second.contentIv);
    expect(first.contentCipher).not.toEqual(second.contentCipher);
    // …and both still open, which is the property PR-19 asserts over HTTP after an unchanged re-save.
    expect(openNoteContent({ id: NOTE_ID, ...first }, keyring1)).toBe('the same text');
    expect(openNoteContent({ id: NOTE_ID, ...second }, keyring1)).toBe('the same text');
  });

  it('round-trips unicode, newlines and a long body byte-for-byte', () => {
    const plain = `# 日本語 🎹\n\n- mixed\n- lists\n\n${'tail '.repeat(5_000)}`;
    const sealed = sealNoteContent(plain, NOTE_ID, keyring1);
    expect(openNoteContent({ id: NOTE_ID, ...sealed }, keyring1)).toBe(plain);
  });
});

describe('openNoteContent() refuses instead of answering', () => {
  const sealed = sealNoteContent('do not read this aloud', NOTE_ID, keyring1);
  const row = { id: NOTE_ID, ...sealed };

  it('throws when a ciphertext byte is flipped', () => {
    const tampered = { ...row, contentCipher: flipByte(sealed.contentCipher) };
    expect(() => openNoteContent(tampered, keyring1)).toThrow(EnvelopeError);
    // The id is what PR-09 puts in the log; the content never reaches the caller at all.
    try {
      openNoteContent(tampered, keyring1);
      expect.unreachable();
    } catch (error) {
      expect((error as EnvelopeError).noteId).toBe(NOTE_ID);
    }
  });

  it('throws when the tag itself is flipped', () => {
    const tampered = {
      ...row,
      contentCipher: flipByte(sealed.contentCipher, sealed.contentCipher.length - 1),
    };
    expect(() => openNoteContent(tampered, keyring1)).toThrow(EnvelopeError);
  });

  it('throws when the IV is tampered with', () => {
    const tampered = { ...row, contentIv: flipByte(sealed.contentIv, 0) };
    expect(() => openNoteContent(tampered, keyring1)).toThrow(EnvelopeError);
  });

  it('throws for another key, even one this process used to hold', () => {
    const foreign: Keyring = { current: { version: 1, key: key(13) }, previous: new Map() };
    expect(() => openNoteContent(row, foreign)).toThrow(/does not authenticate/);
  });

  it('throws when the ciphertext is moved to another note id (the AAD is note:<uuid>)', () => {
    // Same bytes, same key, same version: only the AAD differs. Without it the copy would read fine.
    expect(() => openNoteContent({ ...row, id: OTHER_NOTE_ID }, keyring1)).toThrow(/does not authenticate/);
    expect(openNoteContent(row, keyring1)).toBe('do not read this aloud');
  });

  it.each([
    ['a zero-length IV', new Uint8Array(0)],
    ['a 16-byte IV from somewhere else', new Uint8Array(16)],
  ])('throws with a message naming the IV for %s', (_label, contentIv) => {
    expect(() => openNoteContent({ ...row, contentIv }, keyring1)).toThrow(
      new RegExp(`IV is ${contentIv.length} bytes, not ${IV_BYTES}`),
    );
  });

  it('throws when the body is shorter than the tag it would have to carry', () => {
    expect(() => openNoteContent({ ...row, contentCipher: new Uint8Array(TAG_BYTES - 1) }, keyring1)).toThrow(
      /shorter than the 16-byte GCM tag/,
    );
  });

  it('throws rather than returning blank content in place of a failure', () => {
    // A body that is exactly one tag long passes the shape checks and then fails authentication. The
    // failure mode this test rules out is a caller that "helpfully" returned '' — an empty note on
    // screen where the truth is that the row cannot be read.
    const broken = () => openNoteContent({ ...row, contentCipher: new Uint8Array(TAG_BYTES) }, keyring1);
    expect(broken).toThrow(EnvelopeError);
    expect(broken).toThrow(/does not authenticate/);
  });
});

describe('key versions', () => {
  it('stamps the current version into every new envelope', () => {
    const keyring7: Keyring = { current: { version: 7, key: KEY_1 }, previous: new Map() };
    expect(sealNoteContent('new row', NOTE_ID, keyring7).keyVersion).toBe(7);
  });

  it('still decrypts a version-1 row while version 1 sits in _PREVIOUS', () => {
    const legacy = sealNoteContent('written before the rotation', NOTE_ID, keyring1);
    expect(legacy.keyVersion).toBe(1);
    expect(openNoteContent({ id: NOTE_ID, ...legacy }, keyring2)).toBe('written before the rotation');
  });

  it('reads the current key once no row needs the old one any more', () => {
    const current = sealNoteContent('written after the rotation', NOTE_ID, keyring2);
    expect(openNoteContent({ id: NOTE_ID, ...current }, keyringWithout1)).toBe('written after the rotation');
  });

  it('makes exactly the version-1 rows unreadable when its _PREVIOUS entry is removed', () => {
    // This is the lossy case an explicit NOTE_ENCRYPTION_KEY_VERSION prevents: the operator who drops
    // `_PREVIOUS` while rows still carry version 1 loses those rows, loudly.
    const legacy = sealNoteContent('written before the rotation', NOTE_ID, keyring1);
    const row = { id: NOTE_ID, ...legacy };
    expect(openNoteContent(row, keyring2)).toBe('written before the rotation');
    expect(() => openNoteContent(row, keyringWithout1)).toThrow(/no key for key_version 1/);
  });

  it('names the version and the versions this process does have', () => {
    expect(() => keyForVersion(keyringWithout1, 3)).toThrow(/key_version 3.*version 2.*none/s);
    expect(() => keyForVersion(keyring1, 2)).toThrow(/no key for key_version 2/);
    expect(keyForVersion(keyring2, 1)).toBe(KEY_1);
    expect(keyForVersion(keyring2, 2)).toBe(KEY_2);
  });

  it('lists every decrypt-only version when the answer is a rotation still in progress', () => {
    // The other half of that sentence, which is the half an operator reads *during* a rotation: with `_PREVIOUS`
    // populated the message has to enumerate what this process can still read (so "add version 3 back" is
    // answerable from the log line), and "none" — the correct word for `keyringWithout1` — would be a lie.
    const withThird = new Map<number, Uint8Array>([
      [1, KEY_1],
      [2, key(50)],
    ]);
    const midRotation: Keyring = { current: { version: 3, key: key(51) }, previous: withThird };
    expect(() => keyForVersion(midRotation, 4)).toThrow(/can decrypt versions 1, 2\./su);
    // Sorted numerically, not by insertion order: an operator who put `{"2": …, "1": …}` in the variable should
    // still read `1, 2`, because `2, 1` looks like a version that was removed.
    const insertedBackwards = new Map<number, Uint8Array>([
      [2, key(50)],
      [1, KEY_1],
    ]);
    const reversed: Keyring = { current: { version: 9, key: key(52) }, previous: insertedBackwards };
    expect(() => keyForVersion(reversed, 8)).toThrow(/can decrypt versions 1, 2\./su);
  });
});

describe('the plaintext statistics the columns store', () => {
  it('counts bytes as UTF-8 and words as whitespace-separated runs', () => {
    expect(contentStats('héllo wörld')).toEqual({ contentBytes: 13, wordCount: 2 });
    expect(contentStats('   \n\t  ')).toEqual({ contentBytes: 7, wordCount: 0 });
    expect(contentStats('one')).toEqual({ contentBytes: 3, wordCount: 1 });
  });

  it('describes the plaintext, never the ciphertext', () => {
    const plain = '1234567890';
    const sealed = sealNoteContent(plain, NOTE_ID, keyring1);
    expect(sealed.contentBytes).toBe(plain.length);
    expect(sealed.contentCipher.length).toBeGreaterThan(plain.length);
  });
});

describe('encrypt() at the boundary', () => {
  it('returns the version it sealed with, defaulting to the current key', () => {
    const sealed = encrypt('body', { aad: noteAad(NOTE_ID), keyring: keyring2 });
    expect(sealed.keyVersion).toBe(2);
    expect(decrypt(sealed, { aad: noteAad(NOTE_ID), keyring: keyring2 })).toBe('body');
  });

  it('can hold a legacy envelope still, but never silently rewrites its tag', () => {
    const legacy = encrypt('legacy', { aad: noteAad(NOTE_ID), keyring: keyring2, keyVersion: 1 });
    expect(legacy.keyVersion).toBe(1);
    // Reading it back needs the same AAD and a keyring that still has version 1.
    expect(() => decrypt(legacy, { aad: noteAad(NOTE_ID), keyring: keyringWithout1 })).toThrow(
      /no key for key_version 1/,
    );
    expect(decrypt(legacy, { aad: noteAad(NOTE_ID), keyring: keyring2 })).toBe('legacy');
  });

  it('names the row it failed on only when the caller supplied one', () => {
    const sealed = encrypt('body', { aad: 'not-a-note-aad', keyring: keyring1 });
    try {
      decrypt(sealed, { aad: noteAad(NOTE_ID), keyring: keyring1, noteId: NOTE_ID });
      expect.unreachable();
    } catch (error) {
      expect((error as EnvelopeError).noteId).toBe(NOTE_ID);
    }
    // No id in, no id out — and never a silent success either.
    expect(() => decrypt(sealed, { aad: noteAad(NOTE_ID), keyring: keyring1 })).toThrow(EnvelopeError);
  });
});

describe('keyFingerprint()', () => {
  it('is 8 hex characters of sha256, stable for one key and different across keys', () => {
    expect(keyFingerprint(KEY_1)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyFingerprint(KEY_1)).toBe(keyFingerprint(Uint8Array.from(KEY_1)));
    expect(keyFingerprint(KEY_1)).not.toBe(keyFingerprint(KEY_2));
  });
});

describe('the shape the note repository stores', () => {
  it('is exactly SealedContent, with no cast in either direction', () => {
    // `crypto/envelope.ts` never imports the database layer and `notes.repo.ts` never imports crypto, so the
    // two halves of "the row is the envelope" agree only by structure. This line is where that is checked: if
    // the repository gains a column the envelope does not fill, or the envelope renames one, `tsc` fails here
    // instead of PR-09 discovering it while wiring the service.
    const forRepository: SealedContent = sealNoteContent('body with words', NOTE_ID, keyring1);
    expect(forRepository.keyVersion).toBe(1);
    expect(forRepository.contentBytes).toBeGreaterThan(0);
    expect(forRepository.wordCount).toBe(3);
    expect(forRepository.contentIv).toHaveLength(IV_BYTES);
  });
});
