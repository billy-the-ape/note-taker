/**
 * The folder routes: `POST`/`PATCH`/`DELETE /api/folders…` (docs/plans/mvp/MVP-09.md §4 #13–#15, plan
 * §9.2 #13–#15).
 *
 * Thin on purpose — parse with the contract's schema, hand the caller's id and the parsed body to
 * `services/folder.service.ts`, translate a success into a status. Every decision that could be argued about
 * (cycle, depth cap, name clash, cascade) is made in the service, which is also where the advisory lock is held;
 * a route that checked the depth itself would be checking it *outside* the lock, which is the one thing that
 * makes the check worthless (§5.3).
 *
 * Three transport details that do belong here:
 *
 * * **`201` for the create, `200` for the patch, `204` for the delete** — and `204` sends no body
 *   (`reply.code(204).send()`), because an async handler returning `undefined` is Fastify's "nobody answered"
 *   path rather than an empty response.
 * * **`:id` is registered as a path parameter, not built from `ROUTES.folder(id)`.** That helper URL-encodes a
 *   real id for a *client* to fetch; the server needs the pattern, so `${ROUTES.folders}/:id` — the prefix still
 *   comes from the table, so the two sides cannot drift.
 * * **`?cascade` is parsed, never coerced.** `deleteOptionsSchema` accepts only the literal `true`: a
 *   `Boolean('false')`-style read would turn "don't cascade" into a deleted subtree.
 *
 * Failures bubble to `plugins/error-handler.ts`: `409 CONFLICT` for a sibling clash (with the winner's id in
 * `data.id`), a cycle, or a non-empty folder without `cascade`; `400 VALIDATION` naming the depth cap; `404` for
 * a folder that is not the caller's — including one named in a *body* (§5.4), which is why the service looks the
 * parent up before it writes and this file never mentions ownership.
 */
import {
  createFolderSchema,
  deleteOptionsSchema,
  type FolderNode,
  folderIdParamsSchema,
  patchFolderSchema,
  ROUTES,
} from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { FolderService } from '../services/folder.service.js';

export interface FolderRoutesOptions {
  readonly service: FolderService;
  readonly guard: AuthGuard;
}

export const folderRoutes: FastifyPluginAsync<FolderRoutesOptions> = async (app, { service, guard }) => {
  /** §9.2 #13 — a new folder. `parentId` absent or `null` means the root. */
  app.post(ROUTES.folders, { preHandler: guard.requireAuth }, async (request, reply): Promise<FolderNode> => {
    const body = createFolderSchema.parse(request.body);
    reply.code(201);
    return service.create({ userId: guard.authenticated(request).user.id, ...body });
  });

  /** §9.2 #14 — rename and/or move, one request, one transaction, one lock. */
  app.patch(
    `${ROUTES.folders}/:id`,
    { preHandler: guard.requireAuth },
    async (request): Promise<FolderNode> => {
      const { id } = folderIdParamsSchema.parse(request.params);
      const body = patchFolderSchema.parse(request.body);
      return service.patch({ userId: guard.authenticated(request).user.id, id, ...body });
    },
  );

  /** §9.2 #15 — delete; a non-empty folder needs `?cascade=true`. */
  app.delete(`${ROUTES.folders}/:id`, { preHandler: guard.requireAuth }, async (request, reply) => {
    const { id } = folderIdParamsSchema.parse(request.params);
    const { cascade } = deleteOptionsSchema.parse(request.query);
    await service.remove({ userId: guard.authenticated(request).user.id, id, cascade });
    return reply.code(204).send();
  });
};
