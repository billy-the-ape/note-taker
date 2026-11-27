/**
 * A stateful fake of PR-09's tree endpoints, for the component tests (docs/plans/mvp/MVP-12.md §6).
 *
 * `test/fakeApi.ts` answers from a table, which is the right shape for auth: a login either happened or did
 * not, and the interesting assertions are about the request. The tree is the other kind of API — a rename
 * changes what the next `GET /api/tree` says, a move that lands a folder inside itself is refused *by the
 * rules*, and a folder delete that skips `?cascade=true` is a `409` the server decides, not the client. A
 * table of literals for that is a fixture that lies: it would let a component test pass by remembering to
 * update three stubs in step, which is exactly the bookkeeping a test should not be doing.
 *
 * So this file is a small in-memory model of the same rules `apps/server/src/services/` enforces — sibling
 * uniqueness, the cycle rule, the emptiness gate, `cascade` — over the same contract shapes. It is *not* a
 * copy of the server: it is a stub that cannot reward a client-side mistake. If the UI could move a folder
 * into its own descendant without asking, this fake would answer `409` the way PR-09 does, and the test that
 * claims the client blocks it would fail rather than quietly assert the optimistic version of the tree.
 *
 * `failOnce` is the escape hatch for the case a correct model cannot produce on its own: a rename that loses
 * a race, a server that is unhappy for an unrelated reason (§6's "and when the server rejects a move anyway").
 */
import type { FolderNode, NoteNode, TreeResponse } from '@note-taker/contracts';

import type { Reply, Stub } from './fakeApi';
import { errorBody } from './fakeApi';

/** The ISO instants here are fixed rather than `new Date()`: two runs must produce the same list order. */
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

/** A folder row with sane defaults, so a test writes the three fields it cares about. */
export function folderNode(
  id: string,
  name: string,
  parentId: string | null = null,
  overrides: { readonly createdAt?: string; readonly updatedAt?: string } = {},
): FolderNode {
  return {
    id,
    name,
    parentId,
    createdAt: overrides.createdAt ?? T0,
    updatedAt: overrides.updatedAt ?? T1,
  };
}

/** A note row, metadata only — the tree has no `content` field to leak (§9.2 #12). */
export function noteNode(
  id: string,
  name: string,
  folderId: string | null = null,
  overrides: {
    readonly version?: number;
    readonly contentBytes?: number;
    readonly wordCount?: number;
    readonly contentUpdatedAt?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } = {},
): NoteNode {
  return {
    id,
    name,
    folderId,
    version: overrides.version ?? 1,
    contentBytes: overrides.contentBytes ?? 12,
    wordCount: overrides.wordCount ?? 2,
    contentUpdatedAt: overrides.contentUpdatedAt ?? T1,
    createdAt: overrides.createdAt ?? T0,
    updatedAt: overrides.updatedAt ?? T1,
  };
}

/**
 * Ids are UUID-shaped because `folderIdSchema`/`noteIdSchema` say so, and the last character says what kind
 * of row it is (`f` folder, `e` note — both hex, because the schema is a regex and does not care which).
 * A test can then read a `data.id` out of a `409` and tell which row won the race without counting.
 */
export function testId(kind: 'folder' | 'note', n: number): string {
  const marker = kind === 'folder' ? 'f' : 'e';
  return `019a3b4c-5d6e-7f80-9123-${String(n).padStart(11, '0')}${marker}`;
}

/** One queued failure: the next request that matches answers this and nothing else ever does. */
interface Queued {
  readonly method: string;
  readonly path: string;
  /** A promise is a *held* request (see {@link TreeServer.hold}) — the reply arrives when the test says so. */
  readonly reply: Reply | Promise<Reply>;
}

export interface TreeServer {
  /** Handed to `fakeApi` as its fallback, so every tree route — including ids created mid-test — is answered. */
  readonly stub: Stub;
  /** The current response, the shape `GET /api/tree` sends. */
  tree(): TreeResponse;
  /** Replace the whole model (the optimistic tests start from a known tree). */
  set(tree: Partial<TreeResponse>): void;
  /** Queue one reply for the next request matching `method`/`path`. */
  failOnce(method: string, path: string, reply: Reply): void;
  /**
   * Hold the next matching request open until the test releases it.
   *
   * This exists for the two criteria that are sequences rather than states: "optimistic update, then rollback
   * with an inline error on `409`" and "the error is surfaced and the tree reverts". A fake that always answers
   * in the same tick paints the optimistic tree and the rollback in one frame, so the test can only ever see
   * the second half and passes while proving the first.
   */
  hold(method: string, path: string): { readonly release: (reply: Reply) => void };
  /**
   * The plaintext behind `GET /api/notes/:id` for one row (PR-13's editor route reads it; the tree never
   * sees it, §9.2 #12).
   *
   * The body lives *outside* the note row for the same reason it lives in a different column on the server:
   * a fake whose tree rows carried `content` would let a test assert that the sidebar had decrypted
   * something.
   */
  setNoteContent(id: string, content: string): void;
  /** The ids the model has handed out, so a test can assert on what a create made without reading its stub. */
  created(): readonly string[];
}

/** Sibling uniqueness is on the *parent* — the root is one parent too — and case-sensitive (§5.5 of PR-09). */
function siblingKey(parentId: string | null, name: string): string {
  // Case-sensitive, because `folders_unique_sib`/`notes_unique_sib` are: `Draft.md` and `draft.md` are two
  // siblings the server allows, and a fake that were stricter than the DB would let a UI test pass on a rename
  // production answers 200 to (docs/NAME-RULES.md §5.5, PR-09). The `\u0000` separator is what makes the pair
  // injective: NAME-RULES rejects control characters in a name, so no name can forge the boundary the way a
  // printable `:` would.
  return `${parentId ?? ''}\u0000${name}`;
}

/** `PATCH`/`DELETE` paths are `/api/folders/<id>`; the fake recovers the id rather than parsing a URL. */
function idOf(path: string, prefix: string): string | undefined {
  if (!path.startsWith(`${prefix}/`)) return undefined;
  const id = path.slice(prefix.length + 1);
  return id.length > 0 && !id.includes('/') ? id : undefined;
}

/** The note a `PUT /api/notes/:id/content` names — `idOf` cannot answer it, it refuses a two-segment path. */
function contentIdOf(path: string): string | undefined {
  const found = /^\/api\/notes\/([^/]+)\/content$/u.exec(path);
  return found?.[1];
}

/**
 * The metadata a write re-derives from the new plaintext, exactly as PR-10's service does: `contentBytes`
 * is UTF-8 bytes (not characters — the counter in the editor and the cap in the contract both count bytes),
 * and `wordCount` is whitespace-separated words.
 */
function sizeOf(content: string): { readonly contentBytes: number; readonly wordCount: number } {
  return {
    contentBytes: new TextEncoder().encode(content).length,
    wordCount: content.split(/\s+/u).filter((word) => word.length > 0).length,
  };
}

const noCascade = (): Reply => ({
  status: 409,
  body: errorBody('CONFLICT', 'that folder is not empty', { requestId: requestId() }),
});

function requestId(): string {
  return `req_test_${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
}

/**
 * The fake: `stub` answers every tree route over an in-memory model of PR-09's rules.
 *
 * `initial` defaults to an empty tree — the empty state is a state worth testing, and an empty starting point
 * makes each test's fixtures the only thing a reader has to hold in their head.
 */
/**
 * Two words, eleven bytes — deliberately the same shape as `noteNode`'s default `wordCount: 2` and
 * `contentBytes: 12`, so a test that reads a fixture's metadata and then asks for its body is not
 * surprised by a different note. Above all it is not `''`: an empty body is a state worth testing, and
 * a default that is empty cannot tell you the difference between "the fake had nothing" and "the note is
 * blank".
 */
export const DEFAULT_NOTE_CONTENT = 'lorem ipsum';

/**
 * The fake: `stub` answers every tree route over an in-memory model of PR-09's rules.
 *
 * `initial` defaults to an empty tree — the empty state is a state worth testing, and an empty starting point
 * makes each test's fixtures the only thing a reader has to hold in their head.
 */
export function makeTreeServer(
  initial: Partial<TreeResponse> & { readonly contents?: Record<string, string> } = {},
): TreeServer {
  let folders: FolderNode[] = [...(initial.folders ?? [])];
  let notes: NoteNode[] = [...(initial.notes ?? [])];
  // One note's plaintext, keyed by id, absent until somebody says what it is. A missing entry is not "empty
  // note": the row still exists, so `GET /api/notes/:id` answers it with {@link DEFAULT_NOTE_CONTENT}.
  const bodies = new Map<string, string>(Object.entries(initial.contents ?? {}));
  const queued: Queued[] = [];
  const created: string[] = [];
  // Ids this fake hands out start at 50 so they cannot collide with a test's own fixtures, which count from 1.
  // A duplicate id in the model is a worse bug than a long number: the same row would answer to two ids.
  let issued = 49;

  const newId = (kind: 'folder' | 'note'): string => {
    issued += 1;
    const id = testId(kind, issued);
    created.push(id);
    return id;
  };

  const clash = (message: string, id?: string): Reply => ({
    status: 409,
    body: errorBody('CONFLICT', message, {
      ...(id === undefined ? {} : { data: { id } }),
      requestId: requestId(),
    }),
  });

  const notFound = (what: string): Reply => ({
    status: 404,
    body: errorBody('NOT_FOUND', `no ${what} you can see`, { requestId: requestId() }),
  });

  const childrenOf = (parentId: string | null) => ({
    folders: folders.filter((folder) => folder.parentId === parentId),
    notes: notes.filter((note) => note.folderId === parentId),
  });

  const subtree = (id: string): Set<string> => {
    const found = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      for (const folder of folders) {
        if (folder.parentId === current && !found.has(folder.id)) {
          found.add(folder.id);
          queue.push(folder.id);
        }
      }
    }
    return found;
  };

  const treeStub: Stub = (request) => {
    const next = queued.findIndex((entry) => entry.method === request.method && entry.path === request.path);
    if (next !== -1) {
      const [entry] = queued.splice(next, 1);
      // Returned as-is, promise and all: `fakeApi` awaits a stub, which is what lets a test hold a request open.
      return (
        entry?.reply ?? {
          status: 500,
          body: errorBody('INTERNAL', 'queued nothing', { requestId: requestId() }),
        }
      );
    }

    switch (`${request.method} ${request.path}`) {
      case 'GET /api/tree':
        return { status: 200, body: { folders, notes } };

      case 'POST /api/folders': {
        const body = (request.body ?? {}) as { name?: string; parentId?: string | null };
        const name = body.name ?? '';
        const parentId = body.parentId ?? null;
        if (name.length === 0)
          return {
            status: 400,
            body: errorBody('VALIDATION', 'a name is required', { requestId: requestId() }),
          };
        if (parentId !== null && !folders.some((folder) => folder.id === parentId)) return notFound('folder');
        const taken = folders.find(
          (folder) => siblingKey(folder.parentId, folder.name) === siblingKey(parentId, name),
        );
        // §9.2 #13: the winner's id in `data.id`, which is the payload the client is told to go look at.
        if (taken !== undefined) return clash('a sibling already has that name', taken.id);
        const folder = folderNode(newId('folder'), name, parentId);
        folders = [...folders, folder];
        return { status: 201, body: folder };
      }

      case 'POST /api/notes': {
        // PR-14's escape hatch (`createNoteFromBuffer`) and PR-15's dialog both land here: `{content,
        // folderId}`, no name. §9.2 #16 is the rule that makes this route worth modelling rather than
        // stubbing: a name the client did not type is the server's to invent, `new-file-<msepoch>`, and it
        // is the one name that may be re-picked on a clash instead of answered `409`. The epoch plus this
        // fake's monotone id counter is what keeps two creates in the same millisecond apart — a fake that
        // answered `409` there would be testing the retry budget of a route that has one only by accident.
        const body = (request.body ?? {}) as { name?: string; content?: string; folderId?: string | null };
        const folderId = body.folderId ?? null;
        if (folderId !== null && !folders.some((folder) => folder.id === folderId)) return notFound('folder');
        const name = body.name ?? `new-file-${Date.now() + issued}`;
        const taken = notes.find(
          (note) => siblingKey(note.folderId, note.name) === siblingKey(folderId, name),
        );
        if (body.name !== undefined && taken !== undefined)
          return clash('a sibling already has that name', taken.id);
        const content = body.content ?? DEFAULT_NOTE_CONTENT;
        const note: NoteNode = {
          ...noteNode(newId('note'), name, folderId),
          ...sizeOf(content),
          contentUpdatedAt: T1,
        };
        notes = [...notes, note];
        bodies.set(note.id, content);
        // `NoteWithContent`, not a tree row: the caller adopts this row as its new baseline, and a response
        // without `content` would send PR-14's `adopt` off with an empty buffer.
        return { status: 201, body: { ...note, content } };
      }

      default:
        break;
    }

    // Ids are only known at runtime, so the two `:id` routes are matched by prefix instead of by table key.
    const folderId = idOf(request.path, '/api/folders');
    const noteId = idOf(request.path, '/api/notes');

    // PR-13's editor read: the row, plus the body the tree is not allowed to carry.
    if (request.method === 'GET' && noteId !== undefined) {
      const note = notes.find((candidate) => candidate.id === noteId);
      if (note === undefined) return notFound('note');
      return { status: 200, body: { ...note, content: bodies.get(noteId) ?? DEFAULT_NOTE_CONTENT } };
    }

    if (request.method === 'PATCH' && folderId !== undefined) {
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (folder === undefined) return notFound('folder');
      const body = (request.body ?? {}) as { name?: string; parentId?: string | null };

      if (body.parentId !== undefined) {
        if (body.parentId !== null && !folders.some((candidate) => candidate.id === body.parentId)) {
          return notFound('folder');
        }
        // §9.2 #14: the cycle answer the client is supposed to prevent. A UI that forgot to block the move
        // gets this, and a test that asserted the block passes would be wrong here rather than pleased with
        // itself.
        if (body.parentId !== null && subtree(folderId).has(body.parentId)) {
          return clash('that would move a folder inside itself');
        }
      }

      const nextParent = body.parentId === undefined ? folder.parentId : body.parentId;
      const nextName = body.name ?? folder.name;
      const rival = folders.find(
        (candidate) =>
          candidate.id !== folderId &&
          siblingKey(candidate.parentId, candidate.name) === siblingKey(nextParent, nextName),
      );
      if (body.name !== undefined && rival !== undefined)
        return clash('a sibling already has that name', rival.id);

      const updated: FolderNode = { ...folder, name: nextName, parentId: nextParent, updatedAt: T1 };
      folders = folders.map((candidate) => (candidate.id === folderId ? updated : candidate));
      return { status: 200, body: updated };
    }

    if (request.method === 'DELETE' && folderId !== undefined) {
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (folder === undefined) return notFound('folder');
      const cascade = request.url.includes('cascade=true');
      const { folders: childFolders, notes: childNotes } = childrenOf(folderId);
      if (!cascade && (childFolders.length > 0 || childNotes.length > 0)) return noCascade();
      const gone = subtree(folderId);
      folders = folders.filter((candidate) => !gone.has(candidate.id));
      notes = notes.filter((candidate) => candidate.folderId === null || !gone.has(candidate.folderId));
      return { status: 204 };
    }

    // The autosave write. Modelled rather than left to the `no stub` answer at the bottom, because PR-13's
    // route does the one thing a stub cannot fake: it reacts to the *difference* between `200`, `404` and
    // `409 VERSION_CONFLICT` — `deleted` stops the machine, a conflict opens a banner, a success adopts a
    // version. A fake that answered `500` to everything would let the route pass while the machine under it
    // had never been asked to do any of that.
    if (request.method === 'PUT' && contentIdOf(request.path) !== undefined) {
      const id = contentIdOf(request.path) as string;
      const note = notes.find((candidate) => candidate.id === id);
      if (note === undefined) return notFound('note');
      const body = (request.body ?? {}) as { content?: string; baseVersion?: number };
      const content = body.content ?? '';
      // PR-10's optimistic lock, in the same shape the contract gives it: the loser gets the row's current
      // content and version, which is the input PR-14's comparison needs.
      if (body.baseVersion !== note.version) {
        return {
          status: 409,
          body: errorBody('VERSION_CONFLICT', 'someone saved this note first', {
            data: { content: bodies.get(id) ?? DEFAULT_NOTE_CONTENT, version: note.version },
            requestId: requestId(),
          }),
        };
      }
      const updated: NoteNode = {
        ...note,
        version: note.version + 1,
        ...sizeOf(content),
        contentUpdatedAt: T1,
        updatedAt: T1,
      };
      notes = notes.map((candidate) => (candidate.id === id ? updated : candidate));
      bodies.set(id, content);
      return { status: 200, body: { ...updated, content } };
    }

    if (request.method === 'PATCH' && noteId !== undefined) {
      const note = notes.find((candidate) => candidate.id === noteId);
      if (note === undefined) return notFound('note');
      const body = (request.body ?? {}) as { name?: string; folderId?: string | null };
      const nextFolder = body.folderId === undefined ? note.folderId : body.folderId;
      if (nextFolder !== null && !folders.some((folder) => folder.id === nextFolder))
        return notFound('folder');
      const nextName = body.name ?? note.name;
      const rival = notes.find(
        (candidate) =>
          candidate.id !== noteId &&
          siblingKey(candidate.folderId, candidate.name) === siblingKey(nextFolder, nextName),
      );
      if (body.name !== undefined && rival !== undefined)
        return clash('a sibling already has that name', rival.id);
      const updated: NoteNode = { ...note, name: nextName, folderId: nextFolder, updatedAt: T1 };
      notes = notes.map((candidate) => (candidate.id === noteId ? updated : candidate));
      return { status: 200, body: updated };
    }

    if (request.method === 'DELETE' && noteId !== undefined) {
      const index = notes.findIndex((candidate) => candidate.id === noteId);
      if (index === -1) return notFound('note');
      notes = notes.filter((candidate) => candidate.id !== noteId);
      return { status: 204 };
    }

    // The same words `fakeApi`'s table would have used, on purpose. A test that stubs `noReply: ['login']`
    // to mean "nobody answers that" and then asserts on the error text should not have its answer depend on
    // which fake was consulted; the honest answer here is that nothing answered.
    return {
      status: 500,
      body: errorBody('INTERNAL', `no stub for ${request.method} ${request.path}`, {
        requestId: requestId(),
      }),
    };
  };

  return {
    stub: treeStub,
    tree: () => ({ folders, notes }),
    set: (next) => {
      folders = [...(next.folders ?? [])];
      notes = [...(next.notes ?? [])];
    },
    failOnce: (method, path, reply) => {
      queued.push({ method, path, reply });
    },
    hold: (method, path) => {
      let release: (reply: Reply) => void = () => {};
      queued.push({
        method,
        path,
        reply: new Promise<Reply>((resolve) => {
          release = resolve;
        }),
      });
      return { release };
    },
    setNoteContent: (id, content) => {
      bodies.set(id, content);
    },
    created: () => created,
  };
}
