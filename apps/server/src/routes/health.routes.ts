import type { FastifyPluginAsync } from 'fastify';

/**
 * Liveness probes.
 *
 * `/api/health` is the public one; `/api/healthz` exists so the Docker `HEALTHCHECK` added in
 * PR-18 has a path whose meaning never changes even if the public contract grows.
 *
 * `db` is a **static `'ok'` in this PR** — there is no database code yet. PR-04 replaces it with a
 * real `SELECT 1` and turns a failed probe into a 503; PR-05 replaces this hand-written type with
 * the Zod schema from `@note-taker/contracts`.
 */
export interface HealthResponse {
  readonly status: 'ok';
  readonly db: 'ok';
  readonly version: string;
}

export interface HealthRoutesOptions {
  readonly version: string;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, { version }) => {
  const payload: HealthResponse = { status: 'ok', db: 'ok', version };

  app.get('/api/health', () => payload);
  app.get('/api/healthz', () => payload);
};
