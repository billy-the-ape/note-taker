/**
 * The note routes: `POST`/`GET`/`PUT …/content`/`PATCH`/`DELETE /api/notes…` (docs/plans/mvp/MVP-09.md §4
 * #16–#17, #19–#20, docs/plans/mvp/MVP-10.md §5, plan §9.2 #16–#20).
 *
 * PR-09 put the read here and PR-10 put the write next to it, which is the split the briefs ask for: #17 was
 * placed in PR-09 because it is the first endpoint that has to *decrypt*, and "the API can round-trip a body
 * through PR-06's envelope" is a criterion that cannot be measured anywhere else — so #18 re-tests that
 * round-trip from the other side, in this file, against the same `ETag` the read issues.
 *
 * Handler shape is the same as the folder routes: parse with the contract, call the service, translate the
 * status. Four transport facts are the route's own:
 *
 * * **`GET` is `200` with `NoteWithContent`; `POST` is `201` with the same shape.** Both are the only responses
 *   in the API that carry `content` — `PATCH` answers the metadata row, because renaming or moving a note used
 *   no key and a body in that response would be a leak of work nobody asked for.
 * * **`GET` sends `ETag: W/"v<version>"`** (§4 #17), which is `notes.version` quoted and weak-marked — see
 *   {@link weakVersionEtag}.
 * * **`DELETE` is `204` with no body**, and the note's ciphertext goes with the row: a delete cannot orphan a key
 *   because there is nothing left to orphan.
 * * **`PUT …/content` sends the new `ETag` with its `200`** (PR-10 §5), and reads `If-Match` on the way in — see
 *   {@link ifMatchAdmits}. It is the only route in the API that both issues and honours an entity-tag, and the
 *   body cap that route runs into is the app-level `bodyLimit` in `app.ts`, not one declared here.
 */
import {
  contentUpdateSchema,
  createNoteSchema,
  type NoteNode,
  type NoteWithContent,
  noteIdParamsSchema,
  ROUTES,
  renameMoveSchema,
} from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { NoteService } from '../services/note.service.js';

export interface NoteRoutesOptions {
  readonly service: NoteService;
  readonly guard: AuthGuard;
}

/**
 * `notes.version` as the entity-tag §4 #17 asks for: `W/"v3"`.
 *
 * **Weak**, deliberately, and the reason is the byte-for-byte comparison a client may make later: the
 * representation is JSON, so its field order and number formatting are the serializer's business, and a future
 * Fastify or Node upgrade is allowed to change them without changing the note. A strong validator would promise
 * that two responses with the same tag are identical *strings*.
 *
 * The `v` prefix is not decoration either — it says "this is a version counter, not a hash of the bytes", which
 * is what makes `If-None-Match` useful here and `If-Match` (PR-10's conditional write) expressible without
 * pretending the server indexed content it cannot read.
 */
export function weakVersionEtag(version: number): string {
  return `W/"v${version}"`;
}

/** `*` — "whatever is there now", the one `If-Match` value that names no version. */
const ANY_ENTITY_TAG = '*';

/**
 * `W/"v7"` or `"v7"` — the two shapes this server's own `ETag` can come back as.
 *
 * The strong form is accepted as well as the weak one. The validator is a version counter rather than a digest,
 * so the `W/` marker carries no information a client could act on, and refusing a request whose author dropped it
 * would be a fight about syntax while pretending to be about state.
 */
const ENTITY_TAG = /^(?:W\/)?"v(\d+)"$/;

/** The version one entity-tag names, or `undefined` when it names none (a digest, a typo, a version of zero). */
function entityTagVersion(tag: string): number | undefined {
  const match = ENTITY_TAG.exec(tag);
  if (match?.[1] === undefined) return undefined;
  const version = Number(match[1]);
  // `notes.version` starts at 1 and lives in an `int4`; a tag outside that range cannot name this row's state, so
  // it is reported as naming nothing rather than as a version nobody can send back.
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

/**
 * Whether an `If-Match` header admits a write against `version` (the `baseVersion` the body names).
 *
 * * **absent** — `true`. §5 makes the header optional, and PR-14's engine is not required to send one: the body's
 *   `baseVersion` is the load-bearing half and it is checked in the database, where a lost response cannot make it
 *   lie.
 * * **`*`** — `true`, which is what the RFC means by it ("apply this to whatever is there"). Existence is not this
 *   function's business: the write 404s for a note the caller does not have either way.
 * * **a tag naming this version** — `true`. Comma lists are answered `some`, not `every`: a client may legitimately
 *   send the list of states it is willing to overwrite.
 * * **anything else, including a tag naming another version, a malformed header and an empty one** — `false`. That
 *   is not a `412`, and deliberately so: this API's nine codes have no precondition-failed member, `412` would be
 *   a status a client has no recovery for, and the answer the client *does* have a recovery for is the
 *   `VERSION_CONFLICT` (or `404`) that the service's scoped re-read produces, with the server's current body and
 *   version in it.
 */
export function ifMatchAdmits(ifMatch: string | string[] | undefined, version: number): boolean {
  if (ifMatch === undefined) return true;
  // A repeated header arrives as an array and a list arrives comma-separated; both are candidate sets, and
  // `split` on the joined value would have made one header's `"a, b"` another header's problem.
  const tags = (Array.isArray(ifMatch) ? ifMatch : [ifMatch]).flatMap((header) => header.split(','));
  if (tags.some((tag) => tag.trim() === ANY_ENTITY_TAG)) return true;
  return tags.some((tag) => entityTagVersion(tag.trim()) === version);
}

export const noteRoutes: FastifyPluginAsync<NoteRoutesOptions> = async (app, { service, guard }) => {
  /**
   * §9.2 #16 — create. Every field is optional, which is the whole point: `POST /api/notes` with no body is
   * "new note", so the server generates the name and seals the empty string.
   */
  app.post(
    ROUTES.notes,
    { preHandler: guard.requireAuth },
    async (request, reply): Promise<NoteWithContent> => {
      // `?? {}` is what makes "no body is a valid note" true rather than merely documented. A request with no
      // `Content-Type` — `fetch(url, { method: 'POST' })`, which is what `apps/web/src/lib/api.ts` sends when it
      // has no body — is parsed by no content-type parser at all, so `request.body` is `undefined`, and
      // `createNoteSchema` is an object schema: `undefined` is a `ZodError` and the caller gets `400 VALIDATION`
      // for the request the contract calls the simplest one in the API. Every test posted `{}`, which is a
      // different request, so none of them could tell.
      //
      // The one case this cannot fix, and should not: a request that *declares* `application/json` and sends an
      // empty body is refused by Fastify's own parser (`FST_ERR_CTP_EMPTY_JSON_BODY`) before this handler runs,
      // and `error-handler.ts` renders that as `400 VALIDATION` too. That is a client that announced JSON and
      // sent none; defaulting it here would be the route disagreeing with the transport about what a header means.
      const body = createNoteSchema.parse(request.body ?? {});
      reply.code(201);
      return service.create({ userId: guard.authenticated(request).user.id, ...body });
    },
  );

  /** §9.2 #17 — the row plus the decrypted body, with the version as a weak entity-tag. */
  app.get(
    `${ROUTES.notes}/:id`,
    { preHandler: guard.requireAuth },
    async (request, reply): Promise<NoteWithContent> => {
      const { id } = noteIdParamsSchema.parse(request.params);
      const note = await service.read({ userId: guard.authenticated(request).user.id, id });
      // Set before returning, so the header is on the response whether the body is served from this decryption
      // or, later, from something that answers faster.
      reply.header('ETag', weakVersionEtag(note.version));
      return note;
    },
  );

  /**
   * §9.2 #18 — the versioned content write (docs/plans/mvp/MVP-10.md §5).
   *
   * The route is thin on purpose: the cap, the precondition, the conditional statement and the re-read that
   * turns its zero rows into `404`-or-`VERSION_CONFLICT` are the service's, and duplicating any of them here
   * would be a second answer to the same question.
   *
   * Two things belong to this file:
   *
   * * **The 1 MiB body cap is not declared here.** It is the app-level `bodyLimit: env.MAX_NOTE_BYTES` in
   *   `app.ts`, the same cap every other route meets, so `PUT` cannot get a bigger note through than `POST` can
   *   and a future route cannot quietly get a smaller one. An over-cap request is refused by Fastify before this
   *   handler runs, and `mapError()` renders its `413` as `PAYLOAD_TOO_LARGE`; a body that survived the transport
   *   but broke `contentUpdateSchema` is the other door — `400 VALIDATION`, which is the right code for a request
   *   whose own fields disagree with the contract.
   * * **The new `ETag` goes out with the `200`**, so a client that just saved a note has the validator for the
   *   state it just created and can send it straight back as the next request's `If-Match`. A `409` carries no
   *   tag: it carries `data.content` and `data.version`, which is the same information in the shape PR-14 reads.
   */
  app.put(
    `${ROUTES.notes}/:id/content`,
    { preHandler: guard.requireAuth },
    async (request, reply): Promise<NoteWithContent> => {
      const { id } = noteIdParamsSchema.parse(request.params);
      // Unlike #16, there is no valid body-less form of this request: a content write has to say what the content
      // is, and `undefined` is a `ZodError` that `mapError()` renders as `400 VALIDATION`.
      const body = contentUpdateSchema.parse(request.body);
      const note = await service.putContent({
        userId: guard.authenticated(request).user.id,
        id,
        ...body,
        ifMatchAdmitsBase: ifMatchAdmits(request.headers['if-match'], body.baseVersion),
      });
      reply.header('ETag', weakVersionEtag(note.version));
      return note;
    },
  );

  /** §9.2 #19 — rename and/or move. `folderId: null` moves to the root; the name stays extension-free. */
  app.patch(`${ROUTES.notes}/:id`, { preHandler: guard.requireAuth }, async (request): Promise<NoteNode> => {
    const { id } = noteIdParamsSchema.parse(request.params);
    const body = renameMoveSchema.parse(request.body);
    return service.patch({ userId: guard.authenticated(request).user.id, id, ...body });
  });

  /** §9.2 #20 — hard delete of the row and its ciphertext together. */
  app.delete(`${ROUTES.notes}/:id`, { preHandler: guard.requireAuth }, async (request, reply) => {
    const { id } = noteIdParamsSchema.parse(request.params);
    await service.remove({ userId: guard.authenticated(request).user.id, id });
    return reply.code(204).send();
  });
};
