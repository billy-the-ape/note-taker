/**
 * `GET /api/search?q=&limit=` — the only route in the API whose answer is not one row the caller named
 * (docs/plans/mvp/MVP-11.md §4, plan §9.2 #21).
 *
 * It is thin for the same reason its siblings are: parse with the contract's schema, hand the caller's id to
 * `services/search.service.ts`, send what comes back. The two decisions that are transport's, and only two:
 *
 * * **`q` is parsed, never defaulted.** `searchQuerySchema` requires a trimmed, non-blank string, so `?q=`,
 *   `?q=%20%20` and a missing `q` are all `400 VALIDATION` from `mapError()` before a search runs. An empty
 *   search is a UI state ("nothing typed yet") and answering it with the whole corpus would be a way to make the
 *   most expensive request in the product the cheapest one to trigger. `limit` is coerced by that schema and
 *   capped at `SEARCH_RESULT_MAX` there — which is what "never let a caller force more than the 500-candidate
 *   scan implies" reduces to on the wire.
 *
 * * **The caller is the whole subject, again.** `userId` comes from the session, so there is no id to check
 *   ownership of and no cross-user result to leak: the service asks for the caller's notes and every statement it
 *   issues is scoped by `user_id` in `notes.repo.ts`. A search for a string only somebody else's notes contain
 *   answers `200` with `results: []` — the same answer an empty corpus gives, so the endpoint cannot be used to
 *   ask whether some other user has the word.
 *
 * `GET` carries no CSRF token, so the guard's order (the CSRF `onRequest` first, then `requireAuth`) is not even
 * visible here: an anonymous `GET /api/search` is `401 UNAUTHORIZED`, and that is the only failure the route can
 * produce before the handler runs.
 */
import { ROUTES, type SearchResponse, searchQuerySchema } from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { SearchService } from '../services/search.service.js';

export interface SearchRoutesOptions {
  readonly service: SearchService;
  readonly guard: AuthGuard;
}

export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, { service, guard }) => {
  /** §9.2 #21 — name/path hits from SQL, body hits from the ≤500 most recently updated notes, ≤25 results. */
  app.get(ROUTES.search, { preHandler: guard.requireAuth }, async (request): Promise<SearchResponse> => {
    const { q, limit } = searchQuerySchema.parse(request.query);
    return service.search({
      userId: guard.authenticated(request).user.id,
      q,
      limit,
      // The request's logger, not the app's: a skipped note is worth reading on the line the envelope's
      // `x-request-id` already points at.
      log: request.log,
    });
  });
};
