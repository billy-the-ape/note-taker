// @vitest-environment jsdom
/**
 * The wiring: this hook, the real `lib/api.ts`, a stubbed `fetch`, and a fake clock
 * (docs/plans/mvp/MVP-14.md §8's unload and DOM criteria).
 *
 * The state table is asserted in `lib/autosave.test.ts` where it belongs; what this file owns is the
 * small print that only exists once the machine is attached to a browser — that `pagehide` produces
 * **one** `fetch(…, {keepalive: true})` with the CSRF header on it and never touches
 * `navigator.sendBeacon`, that unmounting and note-switching flush, that `Ctrl/Cmd+S` survives
 * `autosave: false`, that a `401` reaches the app-wide sign-in hook, that the machine's failure states
 * drive the pill's words, and that the `localStorage` mirror is written, restored, and cleared at the
 * moments §6 lists.
 *
 * `fetch` is stubbed rather than the client being mocked, so the CSRF header, the one-shot refresh and
 * the `401` hook are the shipped ones and not this file's opinion of them.
 */
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type NoteWithContent,
  ROUTES,
  type Settings,
} from '@note-taker/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_OFF_COPY, saveStatusText } from '../../components/editor/SaveStatus';
import { setUnauthorizedHandler } from '../../lib/api';
import { readDraft, writeDraft } from '../../lib/draft';
import { createQueryClient, queryKeys } from '../../lib/queryClient';
import { type UseAutosaveOptions, useAutosave } from './useAutosave';

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly keepalive: boolean | undefined;
  readonly csrf: string | null;
}

type Stub = (sent: Sent) => { readonly status: number; readonly body?: unknown };

function installFetch(routes: Readonly<Record<string, Stub>>) {
  const sent: Sent[] = [];

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const record: Sent = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: String(input).split('?')[0] ?? String(input),
      body: typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined,
      keepalive: init.keepalive,
      csrf: new Headers(init.headers).get(CSRF_HEADER_NAME),
    };
    sent.push(record);

    const reply = routes[`${record.method} ${record.path}`];
    if (reply === undefined) {
      return json(
        { error: { code: 'INTERNAL', message: `no stub for ${record.method} ${record.path}` } },
        500,
      );
    }
    const answer = reply(record);
    if (answer.body === undefined) return new Response(null, { status: answer.status });
    return json(answer.body, answer.status);
  };

  vi.stubGlobal('fetch', fetchImpl);
  /** Every request as `METHOD /path`, in order — the shape the CSRF and `401` criteria assert on. */
  return { sent, calls: () => sent.map((entry) => `${entry.method} ${entry.path}`) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const NOTE_ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
const CONTENT_PATH = ROUTES.noteContent(NOTE_ID);
const OTHER_PATH = ROUTES.noteContent(OTHER_ID);

function noteBody(id: string, overrides: Partial<NoteWithContent> = {}): NoteWithContent {
  return {
    id,
    name: 'draft',
    folderId: null,
    version: 8,
    contentBytes: 4,
    wordCount: 1,
    contentUpdatedAt: '2026-01-01T12:00:00.000Z',
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    content: 'new text',
    ...overrides,
  };
}

function settingsRow(autosave: boolean): Settings {
  return { autosave, theme: 'system', updatedAt: '2026-01-01T12:00:00.000Z' };
}

/** 40 KiB and 200 KiB, i.e. §8's two unload cases, in ASCII so the byte maths is the same maths. */
const SMALL = 'a'.repeat(40 * 1024);
const LARGE = 'b'.repeat(200 * 1024);

interface Boot {
  readonly result: { readonly current: ReturnType<typeof useAutosave> };
  readonly client: ReturnType<typeof createQueryClient>;
  readonly rerenderWith: (next: Partial<MutableProps>) => void;
  readonly unmount: () => void;
}

/** The hook's options, writable: a note switch is the same mounted editor with a different `id`. */
type MutableProps = { -readonly [Key in keyof UseAutosaveOptions]: UseAutosaveOptions[Key] };

/**
 * Mount the hook under a `QueryClient` of this test's own.
 *
 * `props` is mutated and re-rendered on purpose: switching notes must flush the outgoing one, and the
 * only way to say that from a test is to change the `id` the same hook instance is reading.
 */
function boot(options: Partial<UseAutosaveOptions> = {}): Boot {
  const props: MutableProps = { id: NOTE_ID, content: 'server text', version: 7, ...options };
  const client = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useAutosave(props), { wrapper });

  return {
    result: view.result,
    client,
    rerenderWith: (next) => {
      Object.assign(props, next);
      void act(() => {
        view.rerender();
      });
    },
    unmount: view.unmount,
  };
}

const versionConflictBody = (content: string, version: number) => ({
  error: {
    code: 'VERSION_CONFLICT' as const,
    message: 'someone saved this note first',
    data: { content, version },
  },
});

/** Move the fake clock with React allowed to react to what the machine does next. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Fire an unload-family event the way the browser does: cancelable, bubbling not required. */
function dispatch(name: 'pagehide' | 'beforeunload'): Event {
  const event = new Event(name, { cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

let sendBeacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:03:11.000Z'));
  // `lib/api.ts` reads the CSRF token out of `document.cookie`, and this file tests the shipped client
  // rather than a mocked one, so the cookie is part of what a test sets up.
  // biome-ignore lint/suspicious/noDocumentCookie: the client under test reads the CSRF cookie
  document.cookie = `${CSRF_COOKIE_NAME}=token-abc; path=/`;

  // §8 asks for a spy, and the honest version of "never called" is a call the test would notice. The
  // property does not exist in jsdom, so it is installed here and taken away again below.
  sendBeacon = vi.fn();
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
});

afterEach(() => {
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // biome-ignore lint/suspicious/noDocumentCookie: see the beforeEach above
  document.cookie = `${CSRF_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  setUnauthorizedHandler(undefined);
});

/** The body of the Nth request, loosened to the one field an assertion wants. */
function bodyOf(sent: readonly Sent[], index: number): { content?: string } {
  return (sent[index]?.body ?? {}) as { content?: string };
}

describe('the debounce, mounted', () => {
  it('writes once, with the CSRF header, and puts the row in the note cache', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 200,
        body: noteBody(NOTE_ID, { version: 8, content: 'typed' }),
      }),
    });
    const { result, client } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed');
    });
    expect(result.current.snapshot.state).toBe('dirty');

    await advance(1_200);

    expect(fetch.sent).toHaveLength(1);
    expect(fetch.sent[0]).toMatchObject({
      method: 'PUT',
      path: CONTENT_PATH,
      body: { content: 'typed', baseVersion: 7 },
      keepalive: undefined,
      csrf: 'token-abc',
    });
    expect(result.current.snapshot).toMatchObject({ state: 'clean', version: 8 });
    // `setQueryData`, not a refetch: nothing asked the server what it just answered (§7's wiring).
    expect(client.getQueryData(queryKeys.note(NOTE_ID))).toMatchObject({ version: 8 });
    expect(fetch.calls()).toEqual([`PUT ${CONTENT_PATH}`]);
  });

  it('flushes on unmount, which is the note switch the router is about to perform', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result, unmount } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed then navigated');
    });
    unmount();

    expect(fetch.sent).toEqual([
      {
        method: 'PUT',
        path: CONTENT_PATH,
        body: { content: 'typed then navigated', baseVersion: 7 },
        keepalive: undefined,
        csrf: 'token-abc',
      },
    ]);
  });

  it('flushes the outgoing note when the id changes, without sending anything for the incoming one', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
      [`PUT ${OTHER_PATH}`]: () => ({ status: 200, body: noteBody(OTHER_ID) }),
    });
    const { result, rerenderWith } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed in the first note');
    });
    rerenderWith({ id: OTHER_ID, content: 'the other note', version: 3 });

    expect(fetch.calls()).toEqual([`PUT ${CONTENT_PATH}`]);
    // The new note starts clean, from its own loaded content and version.
    expect(result.current.snapshot).toMatchObject({ buffer: 'the other note', version: 3, state: 'clean' });
  });

  it('takes Ctrl/Cmd+S whatever the flag says, which is the only reason the flag is a preference', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: false });

    act(() => {
      result.current.edit('typed with autosave off');
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    });

    expect(fetch.sent).toHaveLength(1);
    expect(bodyOf(fetch.sent, 0).content).toBe('typed with autosave off');
  });

  it('flushes on window blur and on visibilitychange → hidden, which is §6’s list of triggers', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed, then clicked away');
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(fetch.sent).toHaveLength(1); // the debounce had 1.2 s to run and did not need it
    await advance(0); // let the write settle, or the next edit would merely park behind it

    act(() => {
      result.current.edit('typed, then left the tab');
    });
    // jsdom ships no way to leave the tab, so the one property the listener reads is replaced for the
    // duration of the event and given back to the prototype afterwards.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }

    expect(fetch.sent).toHaveLength(2);
    expect(document.visibilityState).toBe('visible');
    expect(bodyOf(fetch.sent, 1).content).toBe('typed, then left the tab');
  });

  it('flushes for a folder rename or move, which is the trigger only a caller knows about', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed before the sidebar moved the note');
    });

    expect(result.current.flushForNavigation()).toBe('written');
    expect(fetch.sent).toHaveLength(1);
  });

  it('follows the server’s copy while nothing is unsaved, and never over a dirty buffer', () => {
    installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result, rerenderWith } = boot({ autosave: true });

    // A re-read of a clean note (PR-13’s refetch after a conflict resolution) moves the buffer.
    rerenderWith({ content: 'the server moved', version: 11 });
    expect(result.current.snapshot).toMatchObject({
      buffer: 'the server moved',
      version: 11,
      state: 'clean',
    });

    // …but a response never wins an argument with a keystroke: that is last-write-wins by another name.
    act(() => {
      result.current.edit('typed during the refetch');
    });
    rerenderWith({ content: 'a stranger’s answer', version: 12 });
    expect(result.current.snapshot.buffer).toBe('typed during the refetch');
  });

  it('lets a caller with its own toolbar take the shortcuts and the window listeners back', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true, saveShortcut: false, windowFlushes: false });

    act(() => {
      result.current.edit('typed with nobody listening');
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(fetch.sent).toEqual([]);
    // …and the caller can still ask for the write itself.
    expect(result.current.saveNow()).toBe('written');
    expect(fetch.sent).toHaveLength(1);
  });
});

describe('the flag', () => {
  it('writes nothing on its own while it is off, and never asks for the settings row it was given', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
      [`GET ${ROUTES.settings}`]: () => ({ status: 200, body: settingsRow(true) }),
    });
    const { result } = boot({ autosave: false });

    act(() => {
      result.current.edit('typed while off');
    });
    await advance(60_000);

    expect(fetch.calls()).toEqual([]);
    expect(result.current.autosave).toBe(false);
    expect(saveStatusText(result.current.snapshot, result.current.autosave)).toBe(AUTOSAVE_OFF_COPY);
  });

  it('takes the flag from the settings row when nobody injects one', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
      [`GET ${ROUTES.settings}`]: () => ({ status: 200, body: settingsRow(false) }),
    });
    const { result } = boot(); // no `autosave` in the options: §9.2 #22 decides

    await advance(0);
    expect(fetch.calls()).toEqual([`GET ${ROUTES.settings}`]);
    expect(result.current.autosave).toBe(false);

    act(() => {
      result.current.edit('typed while off');
    });
    await advance(60_000);
    expect(fetch.calls()).toEqual([`GET ${ROUTES.settings}`]); // still no write
  });
});

describe('the unload budget (§6, §8)', () => {
  it('sends exactly one keepalive PUT with the CSRF header for a 40 KiB dirty buffer, and no beacon', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit(SMALL);
    });
    const guard = dispatch('beforeunload');
    dispatch('pagehide');

    const writes = fetch.sent.filter((entry) => entry.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: CONTENT_PATH, keepalive: true, csrf: 'token-abc' });
    expect(bodyOf(writes, 0).content).toBe(SMALL);
    expect(sendBeacon).not.toHaveBeenCalled();
    // The prompt exists to cover a buffer the unload path cannot save. This one is on its way out.
    expect(guard.defaultPrevented).toBe(false);
  });

  it('attempts nothing for a 200 KiB buffer, keeps it dirty, keeps saying Unsaved changes, and prompts', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit(LARGE);
    });
    const guard = dispatch('beforeunload');
    dispatch('pagehide');

    expect(fetch.sent).toEqual([]); // no unload write attempted
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(result.current.snapshot).toMatchObject({ dirty: true, state: 'dirty', lastUnload: 'too-large' });
    expect(saveStatusText(result.current.snapshot, result.current.autosave)).toBe('Unsaved changes');
    expect(guard.defaultPrevented).toBe(true); // the dirty-guard prompt is all that stands between
  });

  it('prompts when autosave is off, because navigating away with a dirty buffer must not be silent', () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: false });

    act(() => {
      result.current.edit('typed while off');
    });
    const guard = dispatch('beforeunload');
    dispatch('pagehide');

    expect(guard.defaultPrevented).toBe(true);
    expect(fetch.sent).toEqual([]);
    expect(saveStatusText(result.current.snapshot, result.current.autosave)).toBe(AUTOSAVE_OFF_COPY);
  });

  it('does not prompt when there is nothing unsaved', () => {
    installFetch({});
    const { result } = boot({ autosave: true });
    const guard = dispatch('beforeunload');
    expect(guard.defaultPrevented).toBe(false);
    expect(result.current.snapshot.dirty).toBe(false);
  });
});

describe('the states a caller has to see (§4, §6)', () => {
  it('401: reaches the app-wide sign-in hook, stops autosaving, and leaves the text in the mirror', async () => {
    let routed = 0;
    setUnauthorizedHandler(() => {
      routed += 1;
    });
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'you are not signed in' } },
      }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('a paragraph written while signed in');
    });
    await advance(1_200);

    expect(routed).toBe(1); // PR-08's handler is what puts the browser on /login
    expect(result.current.snapshot).toMatchObject({ state: 'error', stopped: true });
    expect(fetch.sent).toHaveLength(1);
    // The one copy that survives the sign-in redirect.
    expect(readDraft(NOTE_ID)).toBe('a paragraph written while signed in');
  });

  it('403: one CSRF refresh and one replay, then the machine says so instead of trying again', async () => {
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
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed');
    });
    await advance(1_200);
    await advance(60_000);

    expect(fetch.calls()).toEqual([
      `PUT ${CONTENT_PATH}`,
      `GET ${ROUTES.auth.status}`,
      `PUT ${CONTENT_PATH}`,
    ]);
    expect(result.current.snapshot).toMatchObject({
      state: 'error',
      failure: { kind: 'forbidden', recoverable: true },
    });
  });

  it('404: stops with the deleted note, and the escape hatch creates a new one instead of resurrecting it', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'note not found' } },
      }),
      [`POST ${ROUTES.notes}`]: () => ({
        status: 201,
        body: noteBody(OTHER_ID, { id: OTHER_ID, version: 1, content: 'the text I kept' }),
      }),
    });
    const { result, client } = boot({ autosave: true });

    act(() => {
      result.current.edit('the text I kept');
    });
    await advance(1_200);

    expect(result.current.snapshot).toMatchObject({ state: 'error', stopped: true });
    expect(result.current.snapshot.failure?.kind).toBe('deleted');
    expect(saveStatusText(result.current.snapshot, true)).toBe('Note deleted elsewhere — not saved');

    const created = await act(async () => await result.current.saveAsNewNote());

    expect(created.content).toBe('the text I kept');
    expect(fetch.sent.at(-1)).toMatchObject({ method: 'POST', path: ROUTES.notes });
    expect(fetch.sent.at(-1)?.body).toEqual({ content: 'the text I kept', folderId: null });
    // The dead note's mirror goes with it, and the new row is in the cache under its own id.
    expect(readDraft(NOTE_ID)).toBeUndefined();
    expect(client.getQueryData(queryKeys.note(OTHER_ID))).toMatchObject({ version: 1 });
  });

  it('conflict: the banner state, then “use server” replaces the buffer and clears the mirror', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 409,
        body: versionConflictBody('what the other tab saved', 9),
      }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('my text, which is not saved');
    });
    await advance(1_200);

    expect(result.current.snapshot).toMatchObject({ state: 'conflict' });
    expect(result.current.snapshot.conflict).toEqual({
      serverContent: 'what the other tab saved',
      serverVersion: 9,
    });
    expect(readDraft(NOTE_ID)).toBe('my text, which is not saved'); // still the crash fallback
    expect(saveStatusText(result.current.snapshot, true)).toBe('Conflict');

    act(() => {
      result.current.resolveUseServer();
    });

    expect(result.current.snapshot).toMatchObject({ state: 'clean', buffer: 'what the other tab saved' });
    expect(readDraft(NOTE_ID)).toBeUndefined();
    expect(fetch.sent).toHaveLength(1); // resolving with the server's copy writes nothing back
  });

  it('republishes the buffer while a conflict is on the table, which is what a controlled editor renders', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 409,
        body: versionConflictBody('what the other tab saved', 9),
      }),
    });
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.edit('my text, which is not saved');
    });
    await advance(1_200);
    expect(result.current.snapshot.state).toBe('conflict');

    act(() => {
      result.current.edit('my text, and a sentence typed over the banner');
    });

    // PR-13's textarea renders `snapshot().buffer`. On a path that updates the machine without
    // publishing it, the banner still says `Conflict` while every character typed under it disappears
    // from the screen — and "keep mine" would then save text nobody can see.
    expect(result.current.snapshot.buffer).toBe('my text, and a sentence typed over the banner');
    expect(result.current.snapshot.dirty).toBe(true);
    expect(result.current.snapshot.state).toBe('conflict');
    expect(fetch.sent).toHaveLength(1); // typing is not an answer to the banner
  });
});

describe('the draft mirror as a prompt (§6)', () => {
  it('offers the text a crash kept, and restoring it puts it through the ordinary write path', async () => {
    writeDraft(NOTE_ID, 'what the crash kept');
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 200,
        body: noteBody(NOTE_ID, { version: 8, content: 'what the crash kept' }),
      }),
    });
    const { result } = boot({ autosave: true });

    expect(result.current.draft.content).toBe('what the crash kept');

    act(() => {
      result.current.draft.restore();
    });
    expect(result.current.snapshot.buffer).toBe('what the crash kept');
    expect(result.current.draft.content).toBeUndefined();

    await advance(1_200);
    expect(fetch.sent).toHaveLength(1);
    expect(bodyOf(fetch.sent, 0).content).toBe('what the crash kept');
  });

  it('discards it without writing, and the key stops existing', () => {
    writeDraft(NOTE_ID, 'what a previous visit left');
    const fetch = installFetch({});
    const { result } = boot({ autosave: true });

    act(() => {
      result.current.draft.discard();
    });

    expect(readDraft(NOTE_ID)).toBeUndefined();
    expect(result.current.draft.content).toBeUndefined();
    expect(result.current.snapshot.buffer).toBe('server text'); // the note was never touched
    expect(fetch.sent).toEqual([]);
  });

  it('stays quiet when the mirror already equals the server copy, which is a stale key, not a lost edit', async () => {
    writeDraft(NOTE_ID, 'server text');
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({ status: 200, body: noteBody(NOTE_ID) }),
    });
    const { result } = boot({ autosave: true });

    expect(result.current.draft.content).toBeUndefined();

    // …and the first confirmed write clears the untidy key, because the server has that text now.
    act(() => {
      result.current.edit('typed');
    });
    await advance(1_200);
    expect(fetch.sent).toHaveLength(1);
    expect(readDraft(NOTE_ID)).toBeUndefined();
  });

  it('leaves nothing behind for a reload to find, which is §9’s “reload immediately after typing”', async () => {
    const fetch = installFetch({
      [`PUT ${CONTENT_PATH}`]: () => ({
        status: 200,
        body: noteBody(NOTE_ID, { version: 8, content: 'typed before the reload' }),
      }),
    });
    const { result, unmount } = boot({ autosave: true });

    act(() => {
      result.current.edit('typed before the reload');
    });
    await advance(1_200);

    expect(fetch.sent).toHaveLength(1);
    // Nothing left for a crash to keep, and so nothing for a reload to offer.
    expect(readDraft(NOTE_ID)).toBeUndefined();
    unmount();

    const reloaded = boot({ autosave: true, content: 'typed before the reload', version: 8 });
    expect(reloaded.result.current.draft.content).toBeUndefined();
    expect(reloaded.result.current.snapshot.buffer).toBe('typed before the reload');
    // A reload of a note the server already has writes nothing, and asks for nothing but its own text.
    expect(fetch.calls()).toEqual([`PUT ${CONTENT_PATH}`]);
  });
});
