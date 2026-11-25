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
 */
import { type NoteWithContent, noteWithContentSchema, ROUTES } from '@note-taker/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthGuard } from '../plugins/auth-guard.js';
import { registerErrorHandlers } from '../plugins/error-handler.js';
import type { CreateNote, NoteService } from '../services/note.service.js';
import { noteRoutes } from './notes.routes.js';

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

/** Mounts the real route plugin over a service that only remembers what it was asked to create. */
async function makeApp(): Promise<{ app: FastifyInstance; calls: CreateNote[] }> {
  const calls: CreateNote[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error('this test only creates');
  };
  const service = {
    create: async (input: CreateNote) => {
      calls.push(input);
      return created;
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
  return { app, calls };
}

describe('POST /api/notes with no body (§9.2 #16)', () => {
  it('creates from a request that carried no body at all', async () => {
    const { app, calls } = await makeApp();
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
    expect(calls).toStrictEqual([{ userId: USER_ID, folderId: null }]);
    await app.close();
  });

  it('creates from the different request that is an explicit empty object', async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({ method: 'POST', url: ROUTES.notes, payload: {} });

    expect(response.statusCode, response.body).toBe(201);
    expect(calls).toStrictEqual([{ userId: USER_ID, folderId: null }]);
    await app.close();
  });

  it('refuses a name the contract refuses, so defaulting the body did not loosen the schema', async () => {
    const { app, calls } = await makeApp();
    // A path separator: `NOTE_NAME_RE`'s reserved set, refused for the sake of the breadcrumb and the FS-style
    // export of backlog PR-24. The body here is present and wrong, which is the case `?? {}` must not swallow, and
    // the detail still has to name the field.
    const response = await app.inject({ method: 'POST', url: ROUTES.notes, payload: { name: 'inner/plan' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path: 'name' }] },
    });
    expect(calls).toStrictEqual([]);
    await app.close();
  });

  it('is refused by the transport when JSON is announced and no JSON arrives', async () => {
    const { app, calls } = await makeApp();
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
    expect(calls).toStrictEqual([]);
    await app.close();
  });

  it('still refuses the mutation whose contract does refuse an empty body', async () => {
    // The asymmetry, on the record at the same altitude it is decided in: `POST` defaults an absent body because
    // every field is optional, while `PATCH /api/notes/:id` requires `name` and/or `folderId` (§9.2 #14's rule), so
    // the same bodyless request there is a `400` and must stay one. `notUsed` above is what makes that assertion
    // mean something: had the route defaulted this body too, the stub would have thrown instead.
    const { app, calls } = await makeApp();
    const response = await app.inject({ method: 'PATCH', url: `${ROUTES.notes}/${NOTE_ID}` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(calls).toStrictEqual([]);
    await app.close();
  });
});
