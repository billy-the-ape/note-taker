/**
 * The settings routes: `GET`/`PATCH /api/settings` (docs/plans/mvp/MVP-09.md §4 #22, plan §9.2 #22).
 *
 * They live here rather than in PR-16's settings screen because PR-14's autosave engine has to read the
 * `autosave` flag before there is a screen to set it from, and PR-16 depends on PR-14 — putting the endpoints
 * there would be a cycle. §5.7 is the reason a `GET` here can never be a 404: the service get-or-creates.
 *
 * One route file with no id in sight: the caller is the whole subject. `userId` comes from the session and the
 * contract's `settingsSchema` has no `userId` field, so there is nothing to guess, nothing to enumerate, and no
 * cross-user case to write a test for.
 */
import { patchSettingsSchema, ROUTES, type Settings } from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

import type { AuthGuard } from '../plugins/auth-guard.js';
import type { SettingsService } from '../services/settings.service.js';

export interface SettingsRoutesOptions {
  readonly service: SettingsService;
  readonly guard: AuthGuard;
}

export const settingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = async (app, { service, guard }) => {
  /** §9.2 #22 — the caller's settings, with the row defaults when the row is not there yet. */
  app.get(ROUTES.settings, { preHandler: guard.requireAuth }, async (request): Promise<Settings> => {
    return service.get({ userId: guard.authenticated(request).user.id });
  });

  /**
   * §9.2 #22 — the toggle, and nothing else. `patchSettingsSchema` refuses an empty body: answering `200` to a
   * request that changed nothing would tell a UI that its toggle had stuck.
   */
  app.patch(ROUTES.settings, { preHandler: guard.requireAuth }, async (request): Promise<Settings> => {
    const body = patchSettingsSchema.parse(request.body);
    return service.patch({ userId: guard.authenticated(request).user.id, ...body });
  });
};
