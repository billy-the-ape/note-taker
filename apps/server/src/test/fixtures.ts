/**
 * Test data for the DB-backed suite (docs/plans/mvp/MVP-04.md §5).
 *
 * These are **raw schema inserts on purpose**: the auth-shaped `users.repo.ts`/`sessions.repo.ts` arrive with
 * PR-07, so a fixture that waited for them could not be written in this PR. Raw also means the fixtures state
 * every column the repositories later fill in — `id` from `newId()`, `password_hash`, `role` — instead of
 * depending on a default someone will change.
 *
 * Two users, roles written explicitly:
 *
 * * one `role='owner'` and one `role='member'`, because every cross-user case needs a second person, and
 *   because a fixture that omitted `role` twice would collide on `users_one_owner_uidx` the moment the default
 *   was `owner`. Both roles are named here so the collision is a fact the suite tests (see
 *   `schema.int.test.ts`) rather than an accident it depends on.
 * * the `settings` row goes in with the `users` row in the same transaction, which is the rule PR-07 inherits.
 *
 * PR-11 added the two fixtures a searchable corpus cannot be built without: {@link seedNotes}, which seals
 * **real** envelopes (a search that decrypts bodies cannot be tested against {@link sealedContent}'s hash
 * stand-in), and {@link fillerNotes}, which generates the hundreds of rows a scan bound and a p95 are measured
 * over. Both mint the id before sealing, the rule the services follow for the same AAD reason; the two places
 * {@link seedNotes} departs from `createNote` are written out on it.
 */
import { createHash } from 'node:crypto';
import { type SealedNoteContent, sealNoteContent } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keys.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import type { SealedContent } from '../db/repositories/notes.repo.js';
import { createNote } from '../db/repositories/notes.repo.js';
import { type Note, notes, settings, type User, type UserRole, users } from '../db/schema.js';

export interface CreateUserInput {
  readonly username: string;
  /** Written explicitly; a role-less insert would inherit `member` and be unable to own anything. */
  readonly role: UserRole;
  readonly passwordHash?: string;
  readonly displayName?: string | null;
}

/**
 * Inserts one user and its `settings` row in a single transaction.
 *
 * @throws if a second `role='owner'` user already exists: that is `users_one_owner_uidx`, and the fixture does
 *   not paper over it.
 */
export async function createUser(db: Db, input: CreateUserInput): Promise<User> {
  const id = newId();
  const [created] = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(users)
      .values({
        id,
        username: input.username,
        passwordHash:
          input.passwordHash ??
          // Not a password hash — a placeholder with the shape of an argon2id encoded string, so nothing
          // later mistakes it for a verifiable one. PR-07 writes the real thing.
          '$argon2id$v=19$m=65536,t=3,p=4$c2FsdEBzaXplMTY$notarealhashforfixtures',
        displayName: input.displayName ?? null,
        role: input.role,
      })
      .returning();
    await tx.insert(settings).values({ userId: id });
    return [inserted];
  });

  const user = created;
  if (!user) throw new Error(`fixture createUser(${input.username}) returned no row`);
  return user;
}

/** The owner: the only row in the database allowed to hold `role='owner'`. */
export function createOwner(db: Db, username = 'owner'): Promise<User> {
  return createUser(db, { username, role: 'owner', displayName: 'Olive Owner' });
}

/** A second person, for every cross-user case that must come back empty. */
export function createMember(db: Db, username = 'member'): Promise<User> {
  return createUser(db, { username, role: 'member', displayName: 'Mira Member' });
}

export interface UserPair {
  readonly owner: User;
  readonly member: User;
}

/**
 * Both roles in one call — the common setup. The owner is inserted first so that a broken
 * `users_one_owner_uidx` cannot make this fixture's outcome depend on insert order.
 */
export async function createUserPair(db: Db): Promise<UserPair> {
  const owner = await createOwner(db);
  const member = await createMember(db);
  return { owner, member };
}

/**
 * A deterministic stand-in for a sealed note, so a repository test can assert that the exact bytes it handed in
 * are the bytes that come back.
 *
 * It is a hash, not encryption: this layer must not contain an implementation of envelope encryption (that is
 * PR-06's `crypto/envelope.ts`), and the repository is not allowed to care which one it is holding. The default
 * text is three words, so a test that does not care about sizes still sees non-zero statistics.
 */
export function sealedContent(plaintext?: string, keyVersion?: number): SealedContent {
  const text = plaintext ?? 'one two three';
  const digest = (label: string): Uint8Array => new Uint8Array(createHash('sha256').update(label).digest());
  return {
    contentCipher: digest(`cipher:${text}`),
    // 12 bytes, the GCM IV width, so a future PR-06 test can pass a real envelope through the same helper.
    contentIv: digest(`iv:${text}`).subarray(0, 12),
    keyVersion: keyVersion ?? 1,
    contentBytes: new TextEncoder().encode(text).byteLength,
    wordCount: text.split(/\s+/).filter((word) => word.length > 0).length,
  };
}

export interface MakeNoteInput {
  readonly name: string;
  /** `null`/omitted = the root. */
  readonly folderId?: string | null;
  /** The stand-in plaintext; defaults to three words. */
  readonly text?: string;
  readonly keyVersion?: number;
}

/** A note through the real repository, so a fixture cannot create a row the code under test could not. */
export function makeNote(db: Db, userId: string, input: MakeNoteInput): Promise<Note> {
  return createNote(db, {
    userId,
    folderId: input.folderId ?? null,
    name: input.name,
    content: sealedContent(input.text, input.keyVersion),
  });
}

/**
 * A note with a **real envelope**, for the fixture that needs its rows decryptable (PR-11's search).
 *
 * {@link sealedContent} above is a hash with the shape of an envelope, which is exactly right for a repository
 * test that only asks whether the bytes round-trip and wrong for anything that has to open the body again:
 * `crypto/envelope.ts` refuses a blob it cannot authenticate, and correctly so. This seals with a real keyring,
 * under the same rule the service follows — the id is minted before the body is sealed, because the envelope's
 * AAD is `note:<uuid>` — and its `createNote` sibling below writes through the repository one row at a time.
 */
export function sealFixtureNote(input: {
  readonly id: string;
  readonly body: string;
  readonly keyring: Keyring;
}): SealedNoteContent {
  return sealNoteContent(input.body, input.id, input.keyring);
}

/** One row of {@link seedNotes}: a name, a plaintext body, and optionally where it sits and when it changed. */
export interface NoteFixture {
  readonly name: string;
  /** The plaintext, sealed on the way in. The empty string is a legal body and still stores a real envelope. */
  readonly body: string;
  /** `null`/omitted = the root. */
  readonly folderId?: string | null;
  /**
   * The row's `content_updated_at`, and so its place in the "500 most recently updated" window.
   *
   * Absent means "whatever the clock says", which for a fixture of more than a handful of rows means dozens of
   * notes sharing one millisecond and an ordering only `id` breaks. A test that counts candidates therefore names
   * its own clock: recency stops being a race and the 501st note is the 501st note.
   */
  readonly contentUpdatedAt?: Date;
}

/**
 * The volume fixture: many notes at once, each with a real envelope, in a handful of statements.
 *
 * `makeNote`/`createNote` is the honest single-note path and stays the one to use for a row a test asserts the
 * shape of. It is also one INSERT each, so the fixtures PR-11 needs — a 1 000-note corpus, a 501-note scan bound
 * — would spend the measurement on round trips instead of on the thing being measured. This helper is the same
 * eleven columns `contentColumns()` writes, with two deliberate differences, both stated here so a reviewer can
 * find them:
 *
 * * **the clock is a parameter** (`contentUpdatedAt`), for the reason written on {@link NoteFixture}; and
 * * **the id is minted here**, before the body is sealed, exactly as `note.service.ts` mints it for the same AAD
 *   reason — which is what makes these rows openable rather than merely present.
 *
 * A row this helper cannot create is a row the app cannot create: `updated_at` still moves with the insert, no
 * column is defaulted differently, and the body goes through `sealNoteContent()` rather than a stand-in.
 */
export async function seedNotes(
  db: Db,
  input: { readonly userId: string; readonly keyring: Keyring; readonly notes: readonly NoteFixture[] },
): Promise<Note[]> {
  const inserted: Note[] = [];
  // Chunked because a driver caps the parameters of one statement, and a 1 000-note fixture would otherwise be a
  // 12 000-parameter insert.
  for (let start = 0; start < input.notes.length; start += SEED_CHUNK_ROWS) {
    const chunk = input.notes.slice(start, start + SEED_CHUNK_ROWS);
    const rows = chunk.map((note) => {
      const id = newId();
      const contentUpdatedAt = note.contentUpdatedAt ?? new Date();
      return {
        id,
        userId: input.userId,
        folderId: note.folderId ?? null,
        name: note.name,
        ...sealFixtureNote({ id, body: note.body, keyring: input.keyring }),
        contentUpdatedAt,
        updatedAt: contentUpdatedAt,
      };
    });
    inserted.push(...(await db.insert(notes).values(rows).returning()));
  }
  return inserted;
}

/** {@link seedNotes}'s insert batch size: well under the driver's parameter cap, well over any test's row width. */
const SEED_CHUNK_ROWS = 100;

/**
 * `count` fixtures named `prefix-0…n`, each body `prefix-N <extra>`.
 *
 * The numbered name is what makes "the 501st most recent note is not searched" assertable without reading the
 * corpus back: the answer either contains `filler-500` or it does not.
 */
export function fillerNotes(
  count: number,
  prefix: string,
  options: { readonly body?: string; readonly folderId?: string | null; readonly baseTime?: Date } = {},
): NoteFixture[] {
  const base = options.baseTime?.getTime() ?? Date.now();
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i}`,
    body: options.body ?? `body of ${prefix}-${i}`,
    ...(options.folderId === undefined ? {} : { folderId: options.folderId }),
    // Descending, so index 0 is the newest note in the corpus and the last index is the one that has to fall
    // outside the scan window. One second apart: far enough for a millisecond-granular column to keep the order
    // the caller wrote, and inside `id`'s reach as a tiebreak.
    contentUpdatedAt: new Date(base - i * 1000),
  }));
}
