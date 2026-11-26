/**
 * The create path and the two cache reads the dialog leans on (docs/plans/mvp/MVP-15.md §5, §6).
 *
 * Node environment on purpose: none of this needs a DOM, and the tree-cache behaviour is exactly what a
 * component test cannot see — whether a name is judged against the *target folder's* siblings, whether the
 * confirmed row that lands in `['tree', userId]` still carries `content`, and whether a cache this tab never
 * fetched gets invented.
 */
import { noteWithContentSchema, type TreeResponse } from '@note-taker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, queryKeys } from '../../lib/queryClient';

import { fakeApi, type Reply } from '../../test/fakeApi';
import {
  addNoteToTreeCache,
  createNote,
  isSiblingNameTaken,
  noteNodeOf,
  prefillNoteName,
  readTreeCache,
  takenSiblingNames,
} from './new-note';
import { requestEditorFocus, takesEditorFocus } from './open-note';

const STAMP = '2026-01-01T00:00:00.000Z';
const FOLDER_ID = '019a3b4c-5d6e-7f81-8123-456789abcdef';
const ROOT_NOTE_ID = '019a3b4c-5d6e-7f82-8123-456789abcdef';
const FOLDER_NOTE_ID = '019a3b4c-5d6e-7f83-8123-456789abcdef';
const CREATED_ID = '019a3b4c-5d6e-7f84-8123-456789abcdef';
const USER_ID = '019a3b4c-5d6e-7f80-9123-456789abcdef';

const note = (id: string, name: string, folderId: string | null) => ({
  id,
  name,
  folderId,
  version: 1,
  contentBytes: 2,
  wordCount: 1,
  contentUpdatedAt: STAMP,
  createdAt: STAMP,
  updatedAt: STAMP,
});

const TREE: TreeResponse = {
  folders: [{ id: FOLDER_ID, name: 'Ideas', parentId: null, createdAt: STAMP, updatedAt: STAMP }],
  notes: [note(ROOT_NOTE_ID, 'todo', null), note(FOLDER_NOTE_ID, 'draft', FOLDER_ID)],
};

/** The `201` a real `POST /api/notes` answers with (§9.2 #16), content and all. */
const CREATED = {
  ...note(CREATED_ID, 'report', FOLDER_ID),
  content: 'the body, which the tree must never see',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createNote', () => {
  it('posts the name and the folder it was given, and returns the parsed row', async () => {
    const reply: Reply = { status: 201, body: CREATED };
    const fake = fakeApi({ 'POST /api/notes': () => reply });
    vi.stubGlobal('fetch', fake.fetch);

    await expect(createNote({ name: 'report', folderId: FOLDER_ID })).resolves.toEqual(
      noteWithContentSchema.parse(CREATED),
    );
    expect(fake.calls).toEqual([
      { method: 'POST', path: '/api/notes', body: { name: 'report', folderId: FOLDER_ID } },
    ]);
  });

  it('sends `folderId: null` for the root rather than leaving the field out', async () => {
    const fake = fakeApi({ 'POST /api/notes': () => ({ status: 201, body: CREATED }) });
    vi.stubGlobal('fetch', fake.fetch);

    await createNote({ name: 'report', folderId: null });
    expect(fake.calls[0]?.body).toEqual({ name: 'report', folderId: null });
  });
});

describe('readTreeCache', () => {
  it('has no answer for a visitor with no user id, and invents no entry for one', () => {
    const client = createQueryClient();
    expect(readTreeCache(client, null)).toBeUndefined();
    client.setQueryData(queryKeys.tree('someone'), TREE);
    expect(readTreeCache(client, null)).toBeUndefined();
  });

  it('reads the entry PR-12’s query writes, and only that one', () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.tree(USER_ID), TREE);
    expect(readTreeCache(client, USER_ID)).toEqual(TREE);
    expect(readTreeCache(client, '019a3b4c-5d6e-7f90-9123-0123456789ab')).toBeUndefined();
  });

  it('treats an entry that is not a tree as no information, because that is what it is', () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.tree(USER_ID), { folders: [], notes: [{ id: 'not-a-note' }] });
    expect(readTreeCache(client, USER_ID)).toBeUndefined();
  });
});

describe('takenSiblingNames / isSiblingNameTaken', () => {
  it('lists the siblings of the folder asked for, and of nothing else', () => {
    expect(takenSiblingNames(TREE, null)).toEqual(new Set(['todo']));
    expect(takenSiblingNames(TREE, FOLDER_ID)).toEqual(new Set(['draft']));
  });

  it('says nothing when this tab has no tree, which is the same answer as "nothing is taken"', () => {
    expect(takenSiblingNames(undefined, null).size).toBe(0);
    expect(isSiblingNameTaken(undefined, null, 'todo')).toBe(false);
  });

  it('ignores folder names: a folder called `todo` does not stop a note called `todo.md`', () => {
    expect(isSiblingNameTaken(TREE, FOLDER_ID, 'Ideas')).toBe(false);
  });

  it('judges `todo` and `todo.md` as the same sibling, in one folder only', () => {
    expect(isSiblingNameTaken(TREE, FOLDER_ID, 'draft')).toBe(true);
    expect(isSiblingNameTaken(TREE, FOLDER_ID, 'draft.md')).toBe(true);
    expect(isSiblingNameTaken(TREE, null, 'draft')).toBe(false);
    // An empty box is invalid for other reasons; it is never "already used".
    expect(isSiblingNameTaken(TREE, FOLDER_ID, '')).toBe(false);
    expect(isSiblingNameTaken(TREE, FOLDER_ID, '.md')).toBe(false);
  });
});

describe('prefillNoteName', () => {
  const MS = 1_700_000_000_000;

  it('is the generated name, uniquified against the target folder only', () => {
    expect(prefillNoteName(TREE, null, MS)).toBe('new-file-1700000000000');
    expect(prefillNoteName(TREE, FOLDER_ID, MS)).toBe('new-file-1700000000000');
  });

  it('gives the second dialog of the same millisecond the second name', () => {
    // The §6 case: the first create is already in the cache, and the clock has not moved.
    const afterFirst: TreeResponse = {
      folders: TREE.folders,
      notes: [...TREE.notes, note(CREATED_ID, 'new-file-1700000000000', null)],
    };
    expect(prefillNoteName(afterFirst, null, MS)).toBe('new-file-1700000000000-2');
    // …and the folder is still free, because a sibling two folders away never took this name.
    expect(prefillNoteName(afterFirst, FOLDER_ID, MS)).toBe('new-file-1700000000000');
  });

  it('asks the clock when nobody told it what time it is', () => {
    const now = 1_700_000_999_999;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(prefillNoteName(undefined, null)).toBe(`new-file-${now}`);
    vi.restoreAllMocks();
  });
});

describe('noteNodeOf / addNoteToTreeCache', () => {
  it('drops `content` on the way into the tree, which is metadata-only by contract', () => {
    const node = noteNodeOf(CREATED);
    expect(node.name).toBe('report');
    expect('content' in node).toBe(false);
  });

  it('adds the created row to the tree this tab is holding, without touching the folders', () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.tree(USER_ID), TREE);

    addNoteToTreeCache(client, USER_ID, CREATED);

    const written = client.getQueryData<TreeResponse>(queryKeys.tree(USER_ID));
    expect(written?.folders).toEqual(TREE.folders);
    expect(written?.notes.at(-1)).toEqual(note(CREATED_ID, 'report', FOLDER_ID));
  });

  it('leaves an absent tree absent, instead of calling one note the whole sidebar', () => {
    const client = createQueryClient();
    addNoteToTreeCache(client, USER_ID, CREATED);
    expect(client.getQueryData(queryKeys.tree(USER_ID))).toBeUndefined();
  });
});

describe('the editor focus handoff (PR-13’s contract)', () => {
  it('marks one note at a time, and only that note answers', () => {
    const client = createQueryClient();
    expect(takesEditorFocus(client, CREATED_ID)).toBe(false);

    requestEditorFocus(client, CREATED_ID);
    expect(takesEditorFocus(client, CREATED_ID)).toBe(true);
    expect(takesEditorFocus(client, ROOT_NOTE_ID)).toBe(false);

    // Read, not consumed: PR-13 may ask twice (StrictMode mounts it twice in development) and still be told
    // the truth the second time.
    expect(takesEditorFocus(client, CREATED_ID)).toBe(true);

    requestEditorFocus(client, FOLDER_NOTE_ID);
    expect(takesEditorFocus(client, CREATED_ID)).toBe(false);
    expect(takesEditorFocus(client, FOLDER_NOTE_ID)).toBe(true);
  });

  it('goes away with the cache, which is what a sign-out is', async () => {
    const client = createQueryClient();
    requestEditorFocus(client, CREATED_ID);
    await client.clear();
    expect(takesEditorFocus(client, CREATED_ID)).toBe(false);
  });

  it('lives under the key every later PR reads the same way', () => {
    expect(queryKeys.editorFocus).toEqual(['editor-focus']);
  });
});
