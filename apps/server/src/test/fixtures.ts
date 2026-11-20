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
 */
import { createHash } from 'node:crypto';

import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import type { SealedContent } from '../db/repositories/notes.repo.js';
import { createNote } from '../db/repositories/notes.repo.js';
import type { Note } from '../db/schema.js';
import { settings, type User, type UserRole, users } from '../db/schema.js';

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
