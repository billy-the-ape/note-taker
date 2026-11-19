import { type HealthResponse, ROUTES } from '@note-taker/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Liveness probes.
 *
 * `/api/health` is the public one; `/api/healthz` exists so the Docker `HEALTHCHECK` added in
 * PR-18 has a path whose meaning never changes even if the public contract grows.
 *
 * PR-04 wires the pool: pass `checkDb` and the probe runs `SELECT 1`, answering `503` when the database does
 * not answer. Leave it out (the unit tests, and any caller that has no pool) and `db` stays the static
 * `'ok'` PR-01 shipped.
 *
 * The response type is PR-05's `healthResponseSchema` from `@note-taker/contracts` — not a hand-written
 * interface — so the body this route returns is checked against the same schema the client reads
 * (`app.test.ts` parses it). That schema therefore describes *both* answers, `ok` and `error`: the probe
 * failing is a designed response, not an unexpected one.
 */
export interface HealthRoutesOptions {
  readonly version: string;
  /**
   * Resolves when the database answers, throws when it does not. Kept as a function rather than a pool so a
   * test can exercise the failure without switching off a real database, and so this module does not depend
   * on `db/client.ts`.
   */
  readonly checkDb?: () => Promise<unknown>;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, { version, checkDb }) => {
  const staticPayload: HealthResponse = { status: 'ok', db: 'ok', version };

  // The paths come from the shared table, so a probe path cannot drift from what the client,
  // `docs/API.md` and PR-18's `HEALTHCHECK` all spell out.
  if (!checkDb) {
    app.get(ROUTES.health, () => staticPayload);
    app.get(ROUTES.healthz, () => staticPayload);
    return;
  }

  const probe = async (request: FastifyRequest, reply: FastifyReply): Promise<HealthResponse> => {
    try {
      await checkDb();
      return staticPayload;
    } catch (error) {
      // The failure often contains the DSN, so it is logged and never sent: the client is told the shape of
      // the problem, not its cause.
      request.log.warn({ err: error }, 'database health probe failed');
      reply.code(503);
      return { status: 'error', db: 'error', version };
    }
  };

  app.get(ROUTES.health, probe);
  app.get(ROUTES.healthz, probe);
};
