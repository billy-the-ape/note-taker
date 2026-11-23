/**
 * The note routes: `POST`/`GET`/`PATCH`/`DELETE /api/notes…` (docs/plans/mvp/MVP-09.md §4 #16–#17, #19–#20,
 * plan §9.2 #16–#20).
 *
 * **`PUT /api/notes/:id/content` is not here** (§4's last line): the versioned content write is PR-10. What this
 * file does own is the read that write compares against — #17 was placed in PR-09 precisely because it is the
 * first endpoint that has to *decrypt*, and "the API can round-trip a body through PR-06's envelope" is a
 * acceptance criterion that cannot be measured anywhere else.
 *
 * Handler shape is the same as the folder routes: parse with the contract, call the service, translate the
 * status. Two transport facts are the route's own:
 *
 * * **`GET` is `200` with `NoteWithContent`; `POST` is `201` with the same shape.** Both are the only responses
 *   in the API that carry `content` — `PATCH` answers the metadata row, because renaming or moving a note used
 *   no key and a body in that response would be a leak of work nobody asked for.
 * * **`GET` sends `ETag: W/"v<version>"`** (§4 #17), which is `notes.version` quoted and weak-marked — see
 *   {@link weakVersionEtag}.
 * * **`DELETE` is `204` with no body**, and the note's ciphertext goes with the row: a delete cannot orphan a key
 *   because there is nothing left to orphan.
 */
import {
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

export const noteRoutes: FastifyPluginAsync<NoteRoutesOptions> = async (app, { service, guard }) => {
  /**
   * §9.2 #16 — create. Every field is optional, which is the whole point: `POST /api/notes` with no body is
   * "new note", so the server generates the name and seals the empty string.
   */
  app.post(
    ROUTES.notes,
    { preHandler: guard.requireAuth },
    async (request, reply): Promise<NoteWithContent> => {
      const body = createNoteSchema.parse(request.body);
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
