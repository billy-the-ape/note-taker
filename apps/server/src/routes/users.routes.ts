/**
 * The owner's admin surface: `POST /api/users` and `GET /api/users` (plan §9.2 #10, #11;
 * docs/plans/mvp/MVP-07.md §4).
 *
 * Both are behind `guard.requireOwner`, and that is the whole authorisation model of the MVP: there is no
 * "admin" role, no per-object permission, and no member can reach either route (a `403 FORBIDDEN`, since the
 * caller *is* authenticated and simply lacks the capability).
 *
 * What the two routes are careful about:
 *
 * * **There is no `role` in the body.** `createUserSchema` in `@note-taker/contracts` has no such field, so a
 *   client cannot ask for an owner and the service cannot be talked into writing one: the only write of
 *   `role='owner'` in this codebase is `POST /api/auth/setup`, and `users_one_owner_uidx` is what makes the
 *   claim stick.
 * * **`POST` is `201` and returns `{user}`** — the same shape as a sign-in — while creating no session for the
 *   new account. An owner who creates a colleague's account stays signed in as themselves; a response that
 *   carried a cookie for the new user would log the owner in as somebody else without anyone asking.
 * * **`GET` is the whole list, unpaginated.** The plan calls it "the minimal admin surface" and the user table
 *   of a self-hosted install is tens of rows, so a `limit` parameter would be a half-built feature; a future
 *   PR-20-scale need for pagination changes both apps at once through the contract.
 */
import { ROUTES, type UsersResponse } from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { AuthService } from '../services/auth.service.js';
import { createUserBodySchema } from './auth.schemas.js';

export interface UsersRoutesOptions {
  readonly service: AuthService;
  readonly guard: AuthGuard;
}

export const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (app, { service, guard }) => {
  /** §9.2 #10 — an owner creates a `member`. `409 CONFLICT` when the username is taken (case-insensitively). */
  app.post(ROUTES.users, { preHandler: guard.requireOwner }, async (request, reply) => {
    const input = createUserBodySchema.parse(request.body);
    reply.code(201);
    return { user: await service.createMember(input) };
  });

  /** §9.2 #11 — every account, oldest first, as the same `SessionUser` object every auth response uses. */
  app.get(ROUTES.users, { preHandler: guard.requireOwner }, async (): Promise<UsersResponse> => {
    return { users: await service.listUsers() };
  });
};
