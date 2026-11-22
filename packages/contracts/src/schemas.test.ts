/**
 * The DTO tests: what the API accepts on the way in, and what it promises on the way out
 * (docs/plans/mvp/MVP-05.md §7–§9).
 */
import { describe, expect, it } from 'vitest';

import {
  authResponseSchema,
  authStatusResponseSchema,
  changePasswordSchema,
  createUserSchema,
  displayNameSchema,
  loginSchema,
  PASSWORD_EQUALS_USERNAME_MESSAGE,
  passwordMatchesUsername,
  passwordSchema,
  registerSchema,
  sessionResponseSchema,
  sessionUserSchema,
  userIdSchema,
  usernameSchema,
  userRoleSchema,
  usersResponseSchema,
} from './auth.schemas.js';
import {
  createFolderSchema,
  deleteOptionsSchema,
  FOLDER_MAX_DEPTH,
  fitsWithinFolderDepth,
  folderIdParamsSchema,
  folderSchema,
  patchFolderSchema,
} from './folders.schemas.js';
import {
  contentUpdateSchema,
  createNoteSchema,
  NOTE_CONTENT_MAX_BYTES,
  NOTE_CONTENT_WARN_BYTES,
  noteIdParamsSchema,
  noteSchema,
  noteWithContentSchema,
  renameMoveSchema,
  utf8ByteLength,
} from './notes.schemas.js';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_RESULT_MAX,
  searchQuerySchema,
  searchResponseSchema,
  searchResultSchema,
} from './search.schemas.js';
import { patchSettingsSchema, settingsSchema, settingsThemeSchema } from './settings.schemas.js';
import { folderNodeSchema, noteNodeSchema, treeResponseSchema } from './tree.schemas.js';

const UUID_A = '3f2504e0-4f89-41d3-9a0c-03253d952394';
/** A UUIDv7-shaped id (version nibble `7`, variant `8`), which is what `newId()` mints (plan §8). */
const UUID_B = '019a2f6e-7f6e-7f6e-8f6e-7f6e7f6e7f6e';
const NOT_A_UUID = 'not-a-uuid';
const ISO = '2026-02-03T04:05:06.789Z';

const userRow = {
  id: UUID_A,
  username: 'ada',
  role: 'owner',
  displayName: 'Ada',
  createdAt: ISO,
};

const folderRow = { id: UUID_A, name: 'Work', parentId: null, createdAt: ISO, updatedAt: ISO };

const noteRow = {
  id: UUID_B,
  name: 'plan',
  folderId: null,
  version: 1,
  contentBytes: 0,
  wordCount: 0,
  contentUpdatedAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};

describe('usernameSchema', () => {
  it('trims, and pins the 3-32 ASCII set the case-insensitive unique index needs', () => {
    expect(usernameSchema.parse(' ada ')).toBe('ada');
    expect(usernameSchema.safeParse('Ada').success).toBe(true);
    expect(usernameSchema.safeParse('ada.lace.y').success).toBe(true);
    expect(usernameSchema.safeParse('ad').success).toBe(false);
    expect(usernameSchema.safeParse('   ').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(33)).success).toBe(false);
    // An accented or spaced name would make `Bob` and `bob` two accounts the DB calls one.
    expect(usernameSchema.safeParse('ada lace').success).toBe(false);
    expect(usernameSchema.safeParse('ada@example').success).toBe(false);
    // …and so would punctuation at either end, which reads as part of the sentence around it.
    expect(usernameSchema.safeParse('.ada').success).toBe(false);
    expect(usernameSchema.safeParse('ada.').success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('is the plan §10 policy: at least 10 characters, at most 512', () => {
    expect(passwordSchema.safeParse('ten chars.').success).toBe(true);
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(512)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(513)).success).toBe(false);
  });

  it('refuses a password equal to the username, ignoring case', () => {
    expect(passwordMatchesUsername({ username: 'ada', password: 'ada' })).toBe(true);
    expect(passwordMatchesUsername({ username: 'Ada', password: 'ada' })).toBe(true);
    expect(passwordMatchesUsername({ username: 'ada', password: 'adams-family' })).toBe(false);

    // Long enough to pass the length rule on its own, so this is the equality rule failing and not a
    // coincidence of the same field also being too short.
    const parsed = registerSchema.safeParse({ username: 'adaLaceyard', password: 'adaLaceyard' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toHaveLength(1);
      expect(parsed.error.issues[0]?.path).toEqual(['password']);
      // The words are exported, because `POST /api/auth/password` has to add this same issue around a username
      // that is not in its body (`changePasswordBodySchemaFor`, `apps/server/src/routes/auth.schemas.ts`) and the
      // four endpoints that enforce §10's second rule must not be free to phrase it four different ways.
      expect(parsed.error.issues[0]?.message).toBe(PASSWORD_EQUALS_USERNAME_MESSAGE);
    }
  });

  it('caps a display name and refuses a blank one', () => {
    expect(displayNameSchema.parse(' Ada ')).toBe('Ada');
    expect(displayNameSchema.safeParse('   ').success).toBe(false);
    expect(displayNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });
});

describe('registerSchema / createUserSchema', () => {
  it('accepts a credential pair, with displayName only on register', () => {
    const body = { username: 'ada', password: 'correct horse battery' };
    expect(registerSchema.safeParse(body).success).toBe(true);
    expect(createUserSchema.safeParse(body).success).toBe(true);
    expect(registerSchema.safeParse({ ...body, displayName: 'Ada' }).success).toBe(true);
    // `POST /api/users` can only ever create a member (plan §8), so `role` is not a field a client sends.
    expect(createUserSchema.safeParse({ ...body, role: 'owner' }).success).toBe(true);
    expect(createUserSchema.parse({ ...body, role: 'owner' })).not.toHaveProperty('role');
    expect(registerSchema.safeParse({ ...body, displayName: '   ' }).success).toBe(false);
    // The password rule is the same one on both routes, not a copy that can drift on one of them.
    expect(createUserSchema.safeParse({ username: 'adaLaceyard', password: 'adaLaceyard' }).success).toBe(
      false,
    );
  });
});

describe('loginSchema', () => {
  it('stays permissive, so a wrong username is UNAUTHORIZED and never an enumeration of the policy', () => {
    expect(loginSchema.safeParse({ username: 'x', password: 'short' }).success).toBe(true);
    expect(loginSchema.safeParse({ username: 'ada@example.com', password: 'whatever' }).success).toBe(true);
    // Only the shape of the body is enforced: an empty password and a megabyte of it are both refused.
    expect(loginSchema.safeParse({ username: 'ada', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: '', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'ada', password: 'a'.repeat(513) }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('requires a new password that is neither the old one nor too short', () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'old password', newPassword: 'new password' })
        .success,
    ).toBe(true);
    const same = changePasswordSchema.safeParse({
      currentPassword: 'same password',
      newPassword: 'same password',
    });
    expect(same.success).toBe(false);
    if (!same.success) {
      expect(same.error.issues[0]?.path).toEqual(['newPassword']);
    }
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'old password', newPassword: 'short' }).success,
    ).toBe(false);
  });
});

describe('sessionUserSchema and the auth bodies', () => {
  it('accepts the user row, with a nullable display name', () => {
    expect(sessionUserSchema.safeParse(userRow).success).toBe(true);
    expect(sessionUserSchema.safeParse({ ...userRow, displayName: null }).success).toBe(true);
    expect(sessionUserSchema.safeParse({ ...userRow, id: NOT_A_UUID }).success).toBe(false);
    expect(sessionUserSchema.safeParse({ ...userRow, createdAt: '2026-02-03' }).success).toBe(false);
    expect(sessionUserSchema.safeParse({ ...userRow, username: 'a b' }).success).toBe(false);
  });

  it('has exactly two roles', () => {
    expect(userRoleSchema.safeParse('owner').success).toBe(true);
    expect(userRoleSchema.safeParse('member').success).toBe(true);
    // `admin` is not a role in this product, and neither is anything a client invents.
    expect(userRoleSchema.safeParse('admin').success).toBe(false);
    expect(userIdSchema.safeParse(UUID_A).success).toBe(true);
  });

  it('wraps the user in {user} for setup, register, login and POST /api/users', () => {
    expect(authResponseSchema.safeParse({ user: userRow }).success).toBe(true);
    expect(authResponseSchema.safeParse(userRow).success).toBe(false);
    expect(usersResponseSchema.safeParse({ users: [userRow] }).success).toBe(true);
    expect(usersResponseSchema.safeParse({ users: [] }).success).toBe(true);
    expect(usersResponseSchema.safeParse({ users: [{ ...userRow, role: 'admin' }] }).success).toBe(false);
  });

  it('reads the two flags of GET /api/auth/status', () => {
    expect(authStatusResponseSchema.safeParse({ needsSetup: true, registrationOpen: false }).success).toBe(
      true,
    );
    // A stray member must not flip `needsSetup` (plan §9.2 #2), so the flag is a boolean, never a count.
    expect(authStatusResponseSchema.safeParse({ needsSetup: 0, registrationOpen: false }).success).toBe(
      false,
    );
    expect(authStatusResponseSchema.safeParse({}).success).toBe(false);
  });

  it('only lets a signed-in session carry an expiry', () => {
    expect(sessionResponseSchema.safeParse({ user: null }).success).toBe(true);
    expect(sessionResponseSchema.safeParse({ user: userRow, expiresAt: ISO }).success).toBe(true);
    const odd = sessionResponseSchema.safeParse({ user: null, expiresAt: ISO });
    expect(odd.success).toBe(false);
    if (!odd.success) {
      expect(odd.error.issues[0]?.path).toEqual(['expiresAt']);
    }
  });
});

describe('the folder endpoints', () => {
  it('returns a folder node with a nullable parent', () => {
    expect(folderSchema.safeParse(folderRow).success).toBe(true);
    expect(folderSchema.safeParse({ ...folderRow, parentId: UUID_B }).success).toBe(true);
    expect(folderSchema.safeParse({ ...folderRow, parentId: NOT_A_UUID }).success).toBe(false);
  });

  it('treats an omitted parentId as the root, like an explicit null', () => {
    expect(createFolderSchema.parse({ name: 'Work' })).toEqual({ name: 'Work', parentId: null });
    expect(createFolderSchema.parse({ name: 'Work', parentId: null })).toEqual({
      name: 'Work',
      parentId: null,
    });
    expect(createFolderSchema.parse({ name: 'Work', parentId: UUID_B }).parentId).toBe(UUID_B);
  });

  it('refuses a folder name that breaks the shared character rules, on the name field', () => {
    for (const name of ['', 'work/2026', 'trail ', '.']) {
      const parsed = createFolderSchema.safeParse({ name });
      expect(parsed.success, name).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path, name).toEqual(['name']);
      }
    }
    // No extension handling: this one is legal, and a note called the same is not the same object.
    expect(createFolderSchema.safeParse({ name: 'notes.md' }).success).toBe(true);
  });

  it('refuses an empty PATCH, which is a form that forgot what it changed', () => {
    expect(patchFolderSchema.safeParse({}).success).toBe(false);
    expect(patchFolderSchema.safeParse({ name: 'New name' }).success).toBe(true);
    expect(patchFolderSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(patchFolderSchema.safeParse({ name: 'bad*name' }).success).toBe(false);
  });

  it('only cascades a delete on the literal "true"', () => {
    expect(deleteOptionsSchema.parse({})).toEqual({ cascade: false });
    expect(deleteOptionsSchema.parse({ cascade: 'true' })).toEqual({ cascade: true });
    expect(deleteOptionsSchema.parse({ cascade: 'false' })).toEqual({ cascade: false });
    // `z.coerce.boolean()` would read `cascade=false` as true, and that difference is a deleted subtree.
    expect(deleteOptionsSchema.safeParse({ cascade: 'yes' }).success).toBe(false);
    expect(deleteOptionsSchema.safeParse({ cascade: true }).success).toBe(false);
  });

  it('refuses a non-uuid :id before it reaches SQL', () => {
    expect(folderIdParamsSchema.safeParse({ id: UUID_A }).success).toBe(true);
    expect(folderIdParamsSchema.safeParse({ id: NOT_A_UUID }).success).toBe(false);
  });

  it('caps the tree at depth 99, root included (§9.2 #13/#14)', () => {
    expect(FOLDER_MAX_DEPTH).toBe(99);
    // A create under the root lands at depth 1.
    expect(fitsWithinFolderDepth(0)).toBe(true);
    // Depth 100 is the refusal PR-09 answers with VALIDATION.
    expect(fitsWithinFolderDepth(99)).toBe(false);
    expect(fitsWithinFolderDepth(98)).toBe(true);
    // A move has to fit the whole subtree, not just the folder being moved.
    expect(fitsWithinFolderDepth(5, 93)).toBe(true);
    expect(fitsWithinFolderDepth(5, 94)).toBe(false);
    expect(fitsWithinFolderDepth(-1)).toBe(false);
    expect(fitsWithinFolderDepth(0, -1)).toBe(false);
  });
});

describe('the note endpoints', () => {
  it('returns metadata without content, and content only where a key was used', () => {
    const parsed = noteSchema.parse(noteRow);
    expect(parsed).toEqual(noteRow);
    // The tree must be servable without decrypting anything, so a note node has no content field.
    expect(parsed).not.toHaveProperty('content');
    expect(noteSchema.safeParse({ ...noteRow, folderId: UUID_A }).success).toBe(true);
    expect(noteSchema.safeParse({ ...noteRow, version: 0 }).success).toBe(false);
    expect(noteSchema.safeParse({ ...noteRow, name: '' }).success).toBe(false);
    expect(noteWithContentSchema.safeParse({ ...noteRow }).success).toBe(false);
    expect(noteWithContentSchema.safeParse({ ...noteRow, content: '# hi' }).success).toBe(true);
  });

  it('accepts an empty POST /api/notes body: name, folder and content are all optional', () => {
    expect(createNoteSchema.parse({})).toEqual({ folderId: null });
    expect(createNoteSchema.parse({ folderId: null })).toEqual({ folderId: null });
    expect(createNoteSchema.parse({ content: '' })).toEqual({ folderId: null, content: '' });
    expect(createNoteSchema.safeParse({ name: 'plan' }).success).toBe(true);
    // `Draft.md` is accepted here and stored as `Draft`; the strip is the service's job (plan §8).
    expect(createNoteSchema.safeParse({ name: 'Draft.md' }).success).toBe(true);
  });

  it('reports a name that breaks the rules on the name field', () => {
    for (const name of ['', 'a/b', 'foo.md.md', 'trail ', 'x'.repeat(121)]) {
      const parsed = createNoteSchema.safeParse({ name });
      expect(parsed.success, name).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path, name).toEqual(['name']);
      }
    }
  });

  it('measures the body in UTF-8 bytes, without a Node or DOM global', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('笔记')).toBe(6);
    // The astral pair is one character and four bytes; a lone surrogate is counted as it arrives.
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('😀😀')).toBe(8);
    // A dangling surrogate cannot be encoded, so it costs what an encoder replaces it with (U+FFFD).
    expect(utf8ByteLength('\uD83D')).toBe(3);
    expect(NOTE_CONTENT_MAX_BYTES).toBe(1024 * 1024);
    // The UI warns before the request can fail (§9.2).
    expect(NOTE_CONTENT_WARN_BYTES).toBe(900 * 1024);
    expect(NOTE_CONTENT_WARN_BYTES).toBeLessThan(NOTE_CONTENT_MAX_BYTES);
  });

  it('refuses a body past the 1 MiB cap, and accepts one right up to it', () => {
    const atCap = 'a'.repeat(NOTE_CONTENT_MAX_BYTES);
    const overCap = `${atCap}x`;
    expect(utf8ByteLength(atCap)).toBe(NOTE_CONTENT_MAX_BYTES);
    expect(contentUpdateSchema.safeParse({ content: atCap, baseVersion: 1 }).success).toBe(true);
    const over = contentUpdateSchema.safeParse({ content: overCap, baseVersion: 1 });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues[0]?.path).toEqual(['content']);
    }
    expect(createNoteSchema.safeParse({ content: overCap }).success).toBe(false);
  });

  it('requires the version the write was made against (§9.2 #18)', () => {
    expect(contentUpdateSchema.safeParse({ content: '', baseVersion: 1 }).success).toBe(true);
    expect(contentUpdateSchema.safeParse({ content: 'text' }).success).toBe(false);
    // `version` starts at 1, so a base of 0 is not a stale read, it is a bug.
    expect(contentUpdateSchema.safeParse({ content: 'text', baseVersion: 0 }).success).toBe(false);
    expect(contentUpdateSchema.safeParse({ content: 'text', baseVersion: 1.5 }).success).toBe(false);
  });

  it('renames and moves, including to the root, but never both nothing', () => {
    expect(renameMoveSchema.safeParse({ name: 'new name' }).success).toBe(true);
    expect(renameMoveSchema.safeParse({ folderId: null }).success).toBe(true);
    expect(renameMoveSchema.safeParse({ folderId: UUID_A, name: 'new name' }).success).toBe(true);
    expect(renameMoveSchema.safeParse({}).success).toBe(false);
    expect(renameMoveSchema.safeParse({ name: 'bad/name' }).success).toBe(false);
    expect(noteIdParamsSchema.safeParse({ id: UUID_B }).success).toBe(true);
  });
});

describe('settings', () => {
  it('is the autosave flag plus one of three themes', () => {
    expect(settingsSchema.safeParse({ autosave: true, theme: 'system', updatedAt: ISO }).success).toBe(true);
    expect(settingsThemeSchema.safeParse('dark').success).toBe(true);
    expect(settingsThemeSchema.safeParse('light').success).toBe(true);
    // The DB has a CHECK for exactly this set, so the contract must not be looser than it.
    expect(settingsThemeSchema.safeParse('neon').success).toBe(false);
    expect(settingsSchema.safeParse({ autosave: 'yes', theme: 'system', updatedAt: ISO }).success).toBe(
      false,
    );
  });

  it('refuses an empty PATCH', () => {
    expect(patchSettingsSchema.safeParse({}).success).toBe(false);
    expect(patchSettingsSchema.safeParse({ autosave: false }).success).toBe(true);
    expect(patchSettingsSchema.safeParse({ theme: 'dark' }).success).toBe(true);
  });
});

describe('search', () => {
  it('requires a query, trims it, and caps the result count at 25', () => {
    expect(searchQuerySchema.parse({ q: 'note' })).toEqual({ q: 'note', limit: SEARCH_RESULT_MAX });
    expect(searchQuerySchema.parse({ q: '  note  ' }).q).toBe('note');
    expect(searchQuerySchema.parse({ q: 'note', limit: '5' }).limit).toBe(5);
    expect(SEARCH_RESULT_MAX).toBe(25);
    expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'note', limit: '26' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'note', limit: '0' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'note', limit: 'many' }).success).toBe(false);
  });

  it('returns noteId, name, folderPath, snippet and score, at most 25 times', () => {
    const hit = { noteId: UUID_B, name: 'plan', folderPath: 'Work/2026', snippet: '…the plan…', score: 12.5 };
    expect(searchResultSchema.safeParse(hit).success).toBe(true);
    // A note at the root has an empty display path, so the type has to allow it.
    expect(searchResultSchema.safeParse({ ...hit, folderPath: '', snippet: '' }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...hit, noteId: NOT_A_UUID }).success).toBe(false);
    expect(searchResponseSchema.safeParse({ results: [hit] }).success).toBe(true);
    expect(searchResponseSchema.safeParse({ results: Array.from({ length: 26 }, () => hit) }).success).toBe(
      false,
    );
  });
});

describe('the tree response', () => {
  it('is two flat lists of nodes, folders and notes, with no content anywhere', () => {
    const tree = { folders: [folderRow], notes: [noteRow] };
    expect(treeResponseSchema.parse(tree)).toEqual(tree);
    expect(treeResponseSchema.safeParse({ folders: [], notes: [] }).success).toBe(true);
    expect(treeResponseSchema.safeParse({ folders: [folderRow] }).success).toBe(false);
    expect(noteNodeSchema.safeParse(noteRow).success).toBe(true);
    expect(folderNodeSchema.safeParse({ ...folderRow, name: '' }).success).toBe(false);
    // A note node smuggles no plaintext, even if a server bug puts the field in the row.
    const leaked = noteNodeSchema.parse({ ...noteRow, content: '# secret' });
    expect(leaked).not.toHaveProperty('content');
  });
});
