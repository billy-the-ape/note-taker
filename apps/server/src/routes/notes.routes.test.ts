/**
 * The bodyless half of `POST /api/notes` (§9.2 #16), asserted without a database on purpose.
 *
 * `docs/API.md` row 16 and this file's own header both claim that **no body is a valid note**: every field of
 * `createNoteSchema` is optional, so `POST /api/notes` with nothing in it means "new note", the server generates
 * `new-file-<msepoch>`, and the empty string gets sealed. Whether that is true is decided two statements before any
 * service code runs — by what Fastify hands the handler for a request that carried no body, and by what the schema
 * then makes of it — so it is testable with a stub service in the Postgres-free `unit` job, and it belongs there
 * precisely because the integration suite is where a missing `?? {}` is slowest to notice.
 *
 * The route is mounted with the real plugin and the real contract; only what it collaborates with is stubbed. The
 * stub service records what the route asked for, which is the assertion that matters: the difference between "no
 * body" and "`{}`" is invisible in the response and visible in whether `name` and `content` were passed at all.
 *
 * PR-10 joined it with `PUT /api/notes/:id/content`, because the same reasoning applies to the two decisions that
 * route makes for itself — what an `If-Match` header means, and which body it refuses before a service exists — and
 * neither needs a database to answer. What stays in the integration suite is the part that does: the conditional
 * statement, the 1 MiB transport cap, and the `404`-or-`VERSION_CONFLICT` re-read.
 */
import { type NoteWithContent, noteWithContentSchema, ROUTES } from '@note-taker/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthGuard } from '../plugins/auth-guard.js';
import { registerErrorHandlers } from '../plugins/error-handler.js';
import type { CreateNote, NoteService, PutNoteContent } from '../services/note.service.js';
import { ifMatchAdmits, noteRoutes } from './notes.routes.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '00000000-0000-4000-8000-000000000000';

/** The row the service would hand back; this file is not about its contents, only that they reach the wire. */
const created: NoteWithContent = {
  id: NOTE_ID,
  name: `new-file-1700000000000`,
  folderId: null,
  version: 1,
  contentBytes: 0,
  wordCount: 0,
  contentUpdatedAt: '2023-11-14T22:13:20.000Z',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  content: '',
};

/**
 * A guard that lets everything in. The route touches exactly two members of `AuthGuard`, and the session plumbing
 * behind them is `auth-guard.test.ts`'s business, not this file's — so the object is asserted rather than built,
 * with the two members it calls implemented.
 */
const guard = {
  requireAuth: async () => undefined,
  authenticated: () => ({ user: { id: USER_ID } }),
} as unknown as AuthGuard;

/** Mounts the real route plugin over a service that only remembers what it was asked to write. */
async function makeApp(): Promise<{
  app: FastifyInstance;
  creates: CreateNote[];
  puts: PutNoteContent[];
}> {
  const creates: CreateNote[] = [];
  const puts: PutNoteContent[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error('this test only creates and writes content');
  };
  const service = {
    create: async (input: CreateNote) => {
      creates.push(input);
      return created;
    },
    // Records the whole input, `ifMatchAdmitsBase` included, because the split between the route and the service
    // is exactly that field: the header's syntax is decided up here and its meaning down there.
    putContent: async (input: PutNoteContent) => {
      puts.push(input);
      return { ...created, version: input.baseVersion + 1, content: input.content };
    },
    read: notUsed,
    patch: notUsed,
    remove: notUsed,
  } satisfies NoteService;

  const app = Fastify({ logger: false });
  // The envelope, so a rejected body in the last two cases is the answer a client would actually read.
  registerErrorHandlers(app);
  await app.register(noteRoutes, { service, guard });
  await app.ready();
  return { app, creates, puts };
}

describe('If-Match (§9.2 #18) — the header the route reads', () => {
  it('is not a precondition when the request did not send one', () => {
    // §5 makes `If-Match` optional, and `baseVersion` is the load-bearing half precisely because a response can be
    // lost and a header cannot be replayed by an engine that never stored it.
    expect(ifMatchAdmits(undefined, 4)).toBe(true);
  });

  it('admits the version its own ETag named, in either form', () => {
    // The weak form is what `GET` sends and PR-14 echoes back. The strong one is accepted too: this validator is a
    // counter, so `W/` carries nothing a client acts on, and refusing it would be syntax pedantry dressed up as a
    // statement about the row.
    expect(ifMatchAdmits('W/"v4"', 4)).toBe(true);
    expect(ifMatchAdmits('"v4"', 4)).toBe(true);
    expect(ifMatchAdmits('  W/"v4"  ', 4)).toBe(true);
  });

  it('refuses a tag that names a different version', () => {
    expect(ifMatchAdmits('W/"v3"', 4)).toBe(false);
    expect(ifMatchAdmits('W/"v5"', 4)).toBe(false);
  });

  it('treats * as "whatever is there now", which admits any version', () => {
    // `*` is the one `If-Match` value that names no state, so it cannot be contradicted — whether the note exists
    // is the write's business, and a missing one is a 404 either way.
    expect(ifMatchAdmits('*', 4)).toBe(true);
    expect(ifMatchAdmits(' W/"v1", * ', 4)).toBe(true);
  });

  it('reads a comma list as the set of states the caller will overwrite', () => {
    expect(ifMatchAdmits('W/"v2", W/"v3", W/"v4"', 4)).toBe(true);
    expect(ifMatchAdmits('W/"v2", W/"v3"', 4)).toBe(false);
    // A repeated header arrives as an array. Joining before splitting would have let one header's list masquerade
    // as another one's, which is the difference between "either may be overwritten" and "this text is the state".
    expect(ifMatchAdmits(['W/"v2"', 'W/"v4"'], 4)).toBe(true);
    expect(ifMatchAdmits(['W/"v2"', 'W/"v3"'], 4)).toBe(false);
  });

  it('refuses a header that cannot name a version at all, and never a version it cannot hold', () => {
    // None of these is a `412`: the answer these requests get is the service's scoped re-read, i.e. `404` or a
    // `VERSION_CONFLICT` carrying the server's current content and version, which is the only shape PR-14 can act
    // on. `v0` is in the same class: `notes.version` starts at 1, so no state of this row was ever tagged 0.
    for (const header of ['', 'not-an-etag', 'W/"7"', 'W/"abc"', 'W/v4', 'W/"v0"', 'W/"v-1"']) {
      expect(ifMatchAdmits(header, 4), header).toBe(false);
    }
    // A tag above `int4` cannot name this row's version either, however well-formed it looks.
    expect(ifMatchAdmits('W/"v99999999999"', 4)).toBe(false);
  });
});

describe('POST /api/notes with no body (§9.2 #16)', () => {
  it('creates from a request that carried no body at all', async () => {
    const { app, creates } = await makeApp();
    // No `payload`, so light-my-request sends no body and no `Content-Type` — which is what
    // `fetch(url, { method: 'POST' })` does, and what `apps/web/src/lib/api.ts` does whenever it has no body to
    // send. Fastify runs no content-type parser, `request.body` is `undefined`, and the route has to read that as
    // "no fields" rather than as a validation failure.
    const response = await app.inject({ method: 'POST', url: ROUTES.notes });

    expect(response.statusCode, response.body).toBe(201);
    expect(noteWithContentSchema.safeParse(response.json()).success).toBe(true);
    // The service is asked to create a note with no name and no content — not with `name: undefined`, which is the
    // same thing here only because `CreateNote` documents it that way — and `folderId` arrives defaulted to the
    // root by the schema, which is the one field with a default.
    expect(creates).toStrictEqual([{ userId: USER_ID, folderId: null }]);
    await app.close();
  });

  it('creates from the different request that is an explicit empty object', async () => {
    const { app, creates } = await makeApp();
    const response = await app.inject({ method: 'POST', url: ROUTES.notes, payload: {} });

    expect(response.statusCode, response.body).toBe(201);
    expect(creates).toStrictEqual([{ userId: USER_ID, folderId: null }]);
    await app.close();
  });

  it('refuses a name the contract refuses, so defaulting the body did not loosen the schema', async () => {
    const { app, creates } = await makeApp();
    // A path separator: `NOTE_NAME_RE`'s reserved set, refused for the sake of the breadcrumb and the FS-style
    // export of backlog PR-24. The body here is present and wrong, which is the case `?? {}` must not swallow, and
    // the detail still has to name the field.
    const response = await app.inject({ method: 'POST', url: ROUTES.notes, payload: { name: 'inner/plan' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path: 'name' }] },
    });
    expect(creates).toStrictEqual([]);
    await app.close();
  });

  it('is refused by the transport when JSON is announced and no JSON arrives', async () => {
    const { app, creates } = await makeApp();
    // The boundary of the fix, asserted rather than assumed: a client that *declares* `application/json` and sends
    // an empty body never reaches the handler — Fastify's own parser rejects it — and `error-handler.ts` maps that
    // to the same `VALIDATION` code. `?? {}` deliberately does not try to overrule a header.
    const response = await app.inject({
      method: 'POST',
      url: ROUTES.notes,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(creates).toStrictEqual([]);
    await app.close();
  });

  it('still refuses the mutation whose contract does refuse an empty body', async () => {
    // The asymmetry, on the record at the same altitude it is decided in: `POST` defaults an absent body because
    // every field is optional, while `PATCH /api/notes/:id` requires `name` and/or `folderId` (§9.2 #14's rule), so
    // the same bodyless request there is a `400` and must stay one. `notUsed` above is what makes that assertion
    // mean something: had the route defaulted this body too, the stub would have thrown instead.
    const { app, creates } = await makeApp();
    const response = await app.inject({ method: 'PATCH', url: `${ROUTES.notes}/${NOTE_ID}` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(creates).toStrictEqual([]);
    await app.close();
  });
});

describe('PUT /api/notes/:id/content (§9.2 #18)', () => {
  it('writes the body and the version it was written against, and answers with the new ETag', async () => {
    const { app, puts } = await makeApp();
    const response = await app.inject({
      method: 'PUT',
      // The contract's own path builder, so a route pattern that drifted from `ROUTES.noteContent()` — a missing
      // `/content`, a `:id` in the wrong place — fails here instead of in PR-14's autosave engine.
      url: ROUTES.noteContent(NOTE_ID),
      payload: { content: 'the second draft', baseVersion: 4 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(puts).toStrictEqual([
      {
        userId: USER_ID,
        id: NOTE_ID,
        content: 'the second draft',
        baseVersion: 4,
        // No `If-Match` on this request, and the service is told that in the same words the route settled on.
        ifMatchAdmitsBase: true,
      },
    ]);
    // The version the client just made, quoted the way `GET` quotes it: the round-trip this pair of endpoints
    // promises is `GET` → `ETag` → `PUT` with that tag → a new `ETag` for the next write.
    expect(response.headers.etag).toBe('W/"v5"');
    expect(noteWithContentSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('hands the service a precondition it decided, so a stale tag never reaches the write', async () => {
    const { app, puts } = await makeApp();
    const stale = await app.inject({
      method: 'PUT',
      url: ROUTES.noteContent(NOTE_ID),
      headers: { 'if-match': 'W/"v3"' },
      payload: { content: 'text', baseVersion: 4 },
    });
    expect(stale.statusCode, stale.body).toBe(200);
    // This stub cannot conflict; what is under test is that the *route* passes the verdict down rather than
    // quietly dropping a header it disagreed with. `false` is what makes the service refuse to write.
    expect(puts.at(-1)?.ifMatchAdmitsBase).toBe(false);

    const agreed = await app.inject({
      method: 'PUT',
      url: ROUTES.noteContent(NOTE_ID),
      headers: { 'if-match': 'W/"v4"' },
      payload: { content: 'text', baseVersion: 4 },
    });
    expect(agreed.statusCode, agreed.body).toBe(200);
    expect(puts.at(-1)?.ifMatchAdmitsBase).toBe(true);
    await app.close();
  });

  it('has no valid bodyless form, unlike the create above', async () => {
    const { app, puts } = await makeApp();
    // The asymmetry with #16 stated on the wire: `POST` defaults an absent body because every field is optional,
    // while a content write that does not say what the content is cannot be honoured.
    const response = await app.inject({ method: 'PUT', url: ROUTES.noteContent(NOTE_ID) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(puts).toStrictEqual([]);
    await app.close();
  });

  it('refuses a baseVersion that is not a version', async () => {
    const { app, puts } = await makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: ROUTES.noteContent(NOTE_ID),
      payload: { content: 'text', baseVersion: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path: 'baseVersion' }] },
    });
    expect(puts).toStrictEqual([]);
    await app.close();
  });
});
