/**
 * The envelope: one note body, AES-256-GCM (docs/plans/mvp/MVP-06.md §5, plan Appendix A.3).
 *
 * ADR-0002 — the decision record for this module (why per-record AES-256-GCM rather than `pgcrypto`, an
 * encrypted volume, or field-level encryption) lands at `docs/adr/0002-encryption-at-rest.md` with **PR-20**,
 * which owns `docs/adr/` (plan §7 maps every file to one PR); this comment is the pointer it lands at.
 *
 * What this module owns:
 *
 * * `aes-256-gcm`, the keyring's current key, a **fresh 12-byte IV per write**, and the 16-byte
 *   authentication tag **appended to the ciphertext**: `node:crypto` never appends it, so `encrypt()` copies it
 *   out of `cipher.getAuthTag()` and `decrypt()` splits the same number of bytes back off the tail. That is why
 *   `notes.content_cipher` is one `bytea` column and not two.
 * * AAD = `note:<uuid>`. Two rows holding the same text therefore produce different ciphertexts, and a blob
 *   copied from one row to another fails authentication instead of silently reading as someone else's note.
 * * `key_version` comes from `keyring.current.version` — that is, from `NOTE_ENCRYPTION_KEY_VERSION`. A writer
 *   never chooses a version, which is what keeps the column honest (MVP-06 §4).
 * * **No plaintext mode.** `sealNoteContent('', …)` still yields a 12-byte IV and a 16-byte tag, so
 *   `notes.content_cipher`/`content_iv` are never empty and `openNoteContent()` never sees a NULL (MVP-09 §5.6).
 * * **Nothing is ever returned blank.** Every failure — a flipped byte, a foreign key, the wrong note id, a
 *   truncated blob, or a `key_version` this process has no key for — throws {@link EnvelopeError}. Its
 *   route-level rendering (`INTERNAL`, the note id logged, never blank-or-garbage content) is asserted in PR-09,
 *   because this PR has no routes yet.
 *
 * What is deliberately **not** encrypted (ADR-0002's accepted MVP limitation): usernames, folder and note
 * names, timestamps, sizes — the tree and the listings have to work without mass decryption.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { type Keyring, keyFingerprint } from './keys.js';

/** The one algorithm this module uses; `key_version` exists so a later one can be added alongside it. */
export const AES_256_GCM = 'aes-256-gcm' as const;

/** GCM's IV for this construction. A fresh one per write, always this long, on every row, always. */
export const IV_BYTES = 12;

/** The authentication tag, appended to the ciphertext. `notes.content_cipher` is always at least this long. */
export const TAG_BYTES = 16;

/** The AAD of one note: `note:<uuid>` (plan §10). */
export function noteAad(noteId: string): string {
  return `note:${noteId}`;
}

/** An encrypted body plus the two columns that describe it. `cipher` is ciphertext ‖ tag. */
export interface Envelope {
  readonly cipher: Uint8Array;
  readonly iv: Uint8Array;
  readonly keyVersion: number;
}

export interface EncryptOptions {
  /** {@link noteAad} for the row this is being written to. */
  readonly aad: string;
  readonly keyring: Keyring;
  /**
   * The key to seal with. It defaults to — and in application code must always be —
   * `keyring.current.version`; the option exists so a test can hold a legacy envelope still, and an
   * application path that passes anything else is on its way to a corrupt `key_version`.
   */
  readonly keyVersion?: number;
}

export interface DecryptOptions {
  /** {@link noteAad} for the row this was read from. */
  readonly aad: string;
  readonly keyring: Keyring;
  /** Only so the failure names the row an operator has to go and look at. Never used to make a decision. */
  readonly noteId?: string;
}

/**
 * Every way an envelope can refuse to open. `mapError()` has no case for it, which is the point: it becomes
 * `INTERNAL`, the reason is logged, and no caller ever receives blank content in place of a failure.
 */
export class EnvelopeError extends Error {
  /** The row, when the caller knew it — the id PR-09 asserts is in the log. */
  readonly noteId?: string;

  constructor(
    message: string,
    options: { readonly noteId?: string | undefined; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'EnvelopeError';
    if (options.noteId !== undefined) this.noteId = options.noteId;
  }
}

/**
 * The key a version names: the current key first (it is the common case and needs no map lookup), then the
 * decrypt-only `_PREVIOUS` entries.
 *
 * A missing version is a *loud* failure and never a fallback to the current key: decrypting with the wrong key
 * would turn "the operator dropped `_PREVIOUS` too early" into garbage content on screen.
 */
export function keyForVersion(keyring: Keyring, keyVersion: number): Uint8Array {
  if (keyVersion === keyring.current.version) return keyring.current.key;

  const key = keyring.previous.get(keyVersion);
  if (key !== undefined) return key;

  const known =
    keyring.previous.size > 0 ? [...keyring.previous.keys()].sort((a, b) => a - b).join(', ') : 'none';
  throw new EnvelopeError(
    `no key for key_version ${keyVersion}: this process encrypts with version ${keyring.current.version} ` +
      `(fingerprint ${keyFingerprint(keyring.current.key)}) and can decrypt versions ${known}. ` +
      'During a rotation the old entry must stay in NOTE_ENCRYPTION_KEY_PREVIOUS until no row uses it',
  );
}

/**
 * Seals `plain` for one note. The returned `keyVersion` is the version that was sealed with, so the caller can
 * write the triple into its columns without trusting {@link EncryptOptions} to have defaulted the way it looks.
 */
export function encrypt(plain: string, options: EncryptOptions): Envelope {
  const keyVersion = options.keyVersion ?? options.keyring.current.version;
  const key = keyForVersion(options.keyring, keyVersion);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_256_GCM, key, iv);
  cipher.setAAD(Buffer.from(options.aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  return { cipher: new Uint8Array(body), iv: new Uint8Array(iv), keyVersion };
}

/**
 * Opens an envelope, or throws {@link EnvelopeError}. Never returns `''` to mean "failed": an emptied note and a
 * tampered note are different facts and only one of them is allowed to look like an empty string.
 */
export function decrypt(envelope: Envelope, options: DecryptOptions): string {
  const noteId = options.noteId;
  const key = keyForVersion(options.keyring, envelope.keyVersion);

  if (envelope.iv.length !== IV_BYTES) {
    throw new EnvelopeError(
      `stored IV is ${envelope.iv.length} bytes, not ${IV_BYTES}: this row was not written by crypto/envelope.ts`,
      { noteId },
    );
  }
  if (envelope.cipher.length < TAG_BYTES) {
    throw new EnvelopeError(
      `stored body is ${envelope.cipher.length} bytes, shorter than the ${TAG_BYTES}-byte GCM tag it cannot authenticate`,
      { noteId },
    );
  }

  const bodyEnd = envelope.cipher.length - TAG_BYTES;
  try {
    const decipher = createDecipheriv(AES_256_GCM, key, envelope.iv);
    decipher.setAAD(Buffer.from(options.aad, 'utf8'));
    decipher.setAuthTag(envelope.cipher.subarray(bodyEnd));
    const plain = Buffer.concat([decipher.update(envelope.cipher.subarray(0, bodyEnd)), decipher.final()]);
    return plain.toString('utf8');
  } catch (error) {
    // The one place a GCM failure is translated. Its text names no key material and quotes no content.
    throw new EnvelopeError(
      'this ciphertext does not authenticate: it was sealed with a different key, for a different note, ' +
        'or has been tampered with',
      { ...(noteId === undefined ? {} : { noteId }), cause: error },
    );
  }
}

/**
 * What the plaintext statistics `notes` stores beside an envelope amount to.
 *
 * The database cannot compute either one — it only ever holds ciphertext (docs/DATA-MODEL.md §2) — so the caller
 * that seals the content supplies both. `wordCount` is whitespace-separated words, which is what PR-12's preview
 * needs and is nothing to do with a dictionary.
 */
export function contentStats(content: string): { readonly contentBytes: number; readonly wordCount: number } {
  let words = 0;
  for (const word of content.split(/\s+/)) {
    if (word !== '') words += 1;
  }
  return { contentBytes: Buffer.byteLength(content, 'utf8'), wordCount: words };
}

/**
 * The five columns one content write fills. Structurally identical to `SealedContent` in
 * `db/repositories/notes.repo.ts`, and deliberately not imported from it: the database layer stays
 * plaintext-agnostic, and the crypto layer stays database-free.
 */
export interface SealedNoteContent {
  readonly contentCipher: Uint8Array;
  readonly contentIv: Uint8Array;
  readonly keyVersion: number;
  readonly contentBytes: number;
  readonly wordCount: number;
}

/** The columns {@link openNoteContent} reads; a contracts `Note` satisfies it, and so does a narrow select. */
export interface NoteEnvelope {
  readonly id: string;
  readonly contentCipher: Uint8Array;
  readonly contentIv: Uint8Array;
  readonly keyVersion: number;
}

/**
 * Seals a note body for `notes`, including the empty string: a note created without content still stores a real
 * envelope (MVP-09 §5.6), so `openNoteContent()` never has to guess whether an empty column means empty content.
 */
export function sealNoteContent(content: string, noteId: string, keyring: Keyring): SealedNoteContent {
  const sealed = encrypt(content, { aad: noteAad(noteId), keyring });
  return {
    contentCipher: sealed.cipher,
    contentIv: sealed.iv,
    keyVersion: sealed.keyVersion,
    ...contentStats(content),
  };
}

/** Opens a `notes` row. Throws {@link EnvelopeError} rather than returning blank-or-garbage content. */
export function openNoteContent(row: NoteEnvelope, keyring: Keyring): string {
  return decrypt(
    { cipher: row.contentCipher, iv: row.contentIv, keyVersion: row.keyVersion },
    {
      aad: noteAad(row.id),
      keyring,
      noteId: row.id,
    },
  );
}
