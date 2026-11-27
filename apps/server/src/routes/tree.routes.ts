/**
 * `GET /api/tree` — one request for the whole tree (docs/plans/mvp/MVP-09.md §4 #12, plan §9.2 #12).
 *
 * The route exists to say two things about the payload and nothing else:
 *
 * * **Metadata only.** The service never reads a ciphertext and never takes a key, so the tree can be served
 *   while the note bodies are unreadable to anybody but their owner. A response that carried `content` would
 *   make the cheapest request in the product the most expensive one, and would put every note body in the same
 *   response a client polls on every folder click.
 * * **Two flat lists**, in the contract's shape, ordered by name in byte collation. Re-nesting is the client's
 *   job (PR-12's `features/tree/tree.selectors.ts`); the server's job is that both lists are *complete* and
 *   consistently ordered.
 *
 * Like every route here, it decides no policy. The only question of substance — whose tree is this — was
 * answered by the session guard before the handler ran, and the answer is `request.auth`, never a query parameter.
 */
import { ROUTES, type TreeResponse } from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { TreeService } from '../services/tree.service.js';

export interface TreeRoutesOptions {
  readonly service: TreeService;
  readonly guard: AuthGuard;
}

export const treeRoutes: FastifyPluginAsync<TreeRoutesOptions> = async (app, { service, guard }) => {
  /** §9.2 #12 — the caller's folders and notes, metadata only, in two flat lists. */
  app.get(ROUTES.tree, { preHandler: guard.requireAuth }, async (request): Promise<TreeResponse> => {
    return service.get({ userId: guard.authenticated(request).user.id });
  });
};
