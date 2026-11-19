import { type HealthResponse, ROUTES } from '@note-taker/contracts';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Liveness probes.
 *
 * `/api/health` is the public one; `/api/healthz` exists so the Docker `HEALTHCHECK` added in
 * PR-18 has a path whose meaning never changes even if the public contract grows.
 *
 * `db` is a **static `'ok'` in this PR** — there is no database code yet. PR-04 replaces it with a
 * real `SELECT 1` and turns a failed probe into a 503. The response type is PR-05's
 * `healthResponseSchema` from `@note-taker/contracts`, so the body this route returns is checked
 * against the same schema the client reads (`app.test.ts` parses it).
 */
export interface HealthRoutesOptions {
  readonly version: string;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, { version }) => {
  const payload: HealthResponse = { status: 'ok', db: 'ok', version };

  // The paths come from the shared table, so a probe path cannot drift from what the client,
  // `docs/API.md` and PR-18's `HEALTHCHECK` all spell out.
  app.get(ROUTES.health, () => payload);
  app.get(ROUTES.healthz, () => payload);
};
