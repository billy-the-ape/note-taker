// @vitest-environment jsdom
/**
 * The write wiring (docs/plans/mvp/MVP-14.md §7), asserted against the client the app actually uses.
 *
 * `lib/api.ts` is not mocked here, and that is the point of the file: the versioned `PUT` has to leave
 * with `X-CSRF-Token` on it, a `403` has to be refresh-and-replayed exactly once by the wrapper (and
 * therefore must look to the machine like **one** failure), and a `401` has to reach the one app-wide
 * hook PR-08 installed — which is how "the session went away mid-edit" ends up on the sign-in page.
 * An autosave transport with its own fetch wrapper is how a save path ends up missing a header the
 * server requires, so these tests run through the real one.
 */
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, type NoteWithContent, ROUTES } from '@note-taker/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setUnauthorizedHandler } from '../../lib/api';
import { contentWriteBytes } from '../../lib/autosave';
import { createQueryClient, queryKeys } from '../../lib/queryClient';
import {
  createContentSaver,
  createNoteFromBuffer,
  putNoteContent,
  putNoteContentKeepalive,
  syncSavedNote,
} from './note.mutations';

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly keepalive: boolean | undefined;
  readonly csrf: string | null;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A `fetch` that records every request the client produced, and answers from a table keyed by
 * `` `PUT /api/notes/:id/content` ``. No entry is a `500` on purpose, so a test that asked a question
 * nobody thought to ask cannot pass by accident.
 */
function installFetch(routes: Readonly<Record<string, (request: Sent) => Reply>>) {
  const sent: Sent[] = [];

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = String(input).split('?')[0] ?? String(input);
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    const record: Sent = {
      method,
      path,
      body,
      keepalive: init.keepalive,
      csrf: new Headers(init.headers).get(CSRF_HEADER_NAME),
    };
    sent.push(record);

    const stub = routes[`${method} ${path}`];
    if (stub === undefined) {
      return jsonResponse(
        { error: { code: 'INTERNAL', message: `no stub for ${method} ${path}` } },
        { status: 500 },
      );
    }
    const reply = stub(record);
    if (reply.body === undefined)
      return new Response(null, { status: reply.status, headers: { ...reply.headers } });
    return jsonResponse(reply.body, reply);
  };

  vi.stubGlobal('fetch', fetchImpl);
  return { sent, calls: () => sent.map((entry) => `${entry.method} ${entry.path}`) };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

/** The row `noteWithContentSchema` accepts — the answer every one of these calls has to parse. */
function noteBody(overrides: Partial<NoteWithContent> = {}): NoteWithContent {
  return {
    id: NOTE_ID,
    name: 'draft',
    folderId: null,
    version: 8,
    contentBytes: 3,
    wordCount: 1,
    contentUpdatedAt: '2026-01-01T12:00:00.000Z',
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    content: 'new text',
    ...overrides,
  };
}

const NOTE_ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CONTENT_PATH = ROUTES.noteContent(NOTE_ID);

beforeEach(() => {
  // The header value comes from the cookie the server issues, so the test sets the same thing a
  // browser would have after a sign-in. Reading `document.cookie` is what `lib/api.ts` does, and this
  // file is deliberately testing the shipped client rather than a mocked one.
  // biome-ignore lint/suspicious/noDocumentCookie: the client under test reads the CSRF cookie
  document.cookie = `${CSRF_COOKIE_NAME}=token-abc; path=/`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  // biome-ignore lint/suspicious/noDocumentCookie: see the beforeEach above
  document.cookie = `${CSRF_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
});

describe('putNoteContent (§9.2 #18)', () => {
  it('sends the plaintext and the version it was written against, and parses the row back', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody({ version: 8, content: 'new text' }) }),
    });

    const note = await putNoteContent(NOTE_ID, { content: 'new text', baseVersion: 7 });

    expect(fetch.sent).toHaveLength(1);
    expect(fetch.sent[0]).toMatchObject({
      method: 'PUT',
      path: CONTENT_PATH,
      body: { content: 'new text', baseVersion: 7 },
      keepalive: undefined,
      csrf: 'token-abc',
    });
    expect(note.version).toBe(8);
  });

  it('surfaces a stale write as the pair §5 compares, without a second request', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 409,
        body: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'someone saved this note first',
            data: { content: 'what is on the server', version: 9 },
          },
        },
      }),
    });

    const error = await putNoteContent(NOTE_ID, { content: 'mine', baseVersion: 7 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'VERSION_CONFLICT',
      data: { content: 'what is on the server', version: 9 },
    });
    // One request: the payload arrives with the refusal, which is what makes the fork in §5 possible
    // without reading somebody else's note twice.
    expect(fetch.sent).toHaveLength(1);
  });
});

describe('putNoteContentKeepalive (§6’s unload write)', () => {
  it('is one fetch with keepalive set and the CSRF header still on it', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody() }),
    });

    const note = await putNoteContentKeepalive(NOTE_ID, { content: 'on the way out', baseVersion: 7 });

    expect(fetch.sent).toHaveLength(1);
    expect(fetch.sent[0]).toMatchObject({
      method: 'PUT',
      keepalive: true,
      csrf: 'token-abc',
      body: { content: 'on the way out', baseVersion: 7 },
    });
    expect(note?.version).toBe(8);
  });

  it('reports “no note in the answer” instead of inventing one, which the saver then reasons about', async () => {
    installFetch({ [`PUT ${CONTENT_PATH}`]: () => ({ status: 204 }) });
    await expect(putNoteContentKeepalive(NOTE_ID, { content: 'x', baseVersion: 7 })).resolves.toBeUndefined();
  });

  // The premise of §6's unload budget. `lib/autosave.ts` refuses to import `lib/api.ts`, so it measures
  // the body it is *documented* to be given: `JSON.stringify({content, baseVersion})`. Add a third field
  // to this request and that measure silently starts under-reporting — the exact way to send a body over
  // the browser's `keepalive` cap, where `fetch` rejects before anything leaves and the save is lost
  // after the machine promised the buffer fit.
  it('sends exactly the two keys the unload budget measures, on both transports', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody() }),
    });

    await putNoteContent(NOTE_ID, { content: 'plain', baseVersion: 7 });
    await putNoteContentKeepalive(NOTE_ID, { content: 'keepalive', baseVersion: 7 });

    for (const entry of fetch.sent) {
      expect(Object.keys(entry.body as Record<string, unknown>).sort()).toEqual(['baseVersion', 'content']);
    }
    // …and the machine's measure is the byte length of that body, not of the text inside it.
    expect(contentWriteBytes('on the way out', 7)).toBe(
      new TextEncoder().encode(JSON.stringify({ content: 'on the way out', baseVersion: 7 })).byteLength,
    );
  });
});

describe('createContentSaver', () => {
  const call = (via: 'put' | 'keepalive') => ({ content: 'text', baseVersion: 7, via });

  it('answers the engine with the version the server moved to, both transports', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody({ version: 8 }) }),
    });

    await expect(createContentSaver(NOTE_ID)({ ...call('put') })).resolves.toEqual({ version: 8 });
    await expect(createContentSaver(NOTE_ID)({ ...call('keepalive') })).resolves.toEqual({ version: 8 });
    expect(fetch.sent.map((entry) => entry.keepalive)).toEqual([undefined, true]);
  });

  it('adopts version + 1 when a keepalive write answers with no body, because PR-10 always moves by one', async () => {
    installFetch({ [`PUT ${CONTENT_PATH}`]: () => ({ status: 204 }) });
    await expect(createContentSaver(NOTE_ID)({ ...call('keepalive') })).resolves.toEqual({ version: 8 });
  });

  it('hands the row to onSaved, which is how the note cache and the sidebar keep up', async () => {
    installFetch({ [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody() }) });
    const saved: NoteWithContent[] = [];

    await createContentSaver(NOTE_ID, { onSaved: (note) => saved.push(note) })({ ...call('put') });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe('new text');
  });
});

/** The body of the Nth request, loosened to the one field an assertion wants. */
function bodyOf(sent: readonly Sent[], index: number): { folderId?: string | null } {
  return (sent[index]?.body ?? {}) as { folderId?: string | null };
}

describe('createNoteFromBuffer, the 404 escape hatch', () => {
  it('creates a new note with the retained text and no name, so the server generates one', async () => {
    const fetch = installFetch({
      [`POST ${ROUTES.notes}`]: () => ({ status: 201, body: noteBody({ version: 1, content: 'kept text' }) }),
    });

    const created = await createNoteFromBuffer('kept text', 'folder-1');

    expect(fetch.sent).toEqual([
      {
        method: 'POST',
        path: ROUTES.notes,
        body: { content: 'kept text', folderId: 'folder-1' },
        keepalive: undefined,
        csrf: 'token-abc',
      },
    ]);
    expect(created.content).toBe('kept text');
  });

  it('puts the new note in the root when the deleted one was in the root', async () => {
    const fetch = installFetch({
      [`POST ${ROUTES.notes}`]: () => ({ status: 201, body: noteBody({ version: 1 }) }),
    });

    await createNoteFromBuffer('text', null);
    expect(bodyOf(fetch.sent, 0).folderId).toBeNull();
  });
});

describe('syncSavedNote', () => {
  it('puts the written row in the note cache and marks the tree stale without refetching it', async () => {
    const client = createQueryClient();
    const fetch = installFetch({});
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    syncSavedNote(client, NOTE_ID, noteBody());

    expect(client.getQueryData(queryKeys.note(NOTE_ID))).toMatchObject({ version: 8 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tree'], refetchType: 'none' });
    // `refetchType: 'none'` is the whole story: autosave fires every debounce window, and a tree
    // refetch behind each one is a sidebar that never stops asking.
    await Promise.resolve();
    expect(fetch.sent).toEqual([]);
  });
});

describe('the two answers that are not the editor’s problem to solve', () => {
  it('401 reaches the app-wide sign-in hook, which is how autosave gets routed to /login', async () => {
    let routed = 0;
    setUnauthorizedHandler(() => {
      routed += 1;
    });
    installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'you are not signed in' } },
      }),
    });

    await expect(putNoteContent(NOTE_ID, { content: 'x', baseVersion: 7 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(routed).toBe(1);
  });

  it('403 costs exactly one CSRF refresh and one replay, and they are invisible above this line', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'you are not allowed to do that' } },
      }),
      [`GET ${ROUTES.auth.status}`]: () => ({
        status: 200,
        body: { needsSetup: false, registrationOpen: false },
      }),
    });

    await expect(putNoteContent(NOTE_ID, { content: 'x', baseVersion: 7 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(fetch.calls()).toEqual([
      `PUT ${CONTENT_PATH}`,
      `GET ${ROUTES.auth.status}`,
      `PUT ${CONTENT_PATH}`,
    ]);
  });
});
