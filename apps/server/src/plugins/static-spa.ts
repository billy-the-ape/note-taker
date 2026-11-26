/**
 * The built SPA, from the API port (docs/plans/mvp/MVP-12.md §4) — the half of "self hosted and
 * assigned to a port" (README) that means one port rather than two processes.
 *
 * Three rules, and the third is the whole reason this file is a plugin rather than two lines in
 * `app.ts`:
 *
 * 1. **Real build artifacts are served as files.** `pnpm build` puts Vite's output in `apps/web/dist`
 *    (`index.html`, `assets/<hashed>.js`, `assets/<hashed>.css`, favicons). `@fastify/static` is asked
 *    for `wildcard: false`, which registers **one route per file it finds on disk** instead of a `/*`
 *    catch-all. That is what keeps this plugin out of the API's way: with no wildcard route there is
 *    nothing for `/api/anything` to fall into, so the API's routing — and the §9.1 envelope of an
 *    unknown `/api` path — is exactly what it was before the SPA existed. `static-spa.test.ts` asserts
 *    that with a built fixture, `POST /api/notes` included, because a plugin that quietly swallowed a
 *    mutation would show up as a lost note rather than as a failing test anywhere else.
 * 2. **A deep link is the app, not a 404.** `/app`, `/app/note/<id>`, `/app/settings`: those URLs exist
 *    only inside the client's router, and a person who refreshes one deserves the SPA, so
 *    `GET|HEAD /app` and `/app/*` answer `index.html`. Only `/app` is claimed, because after PR-16/PR-17
 *    the whole *routable* surface of the SPA sits under it; `/some-random-path` deliberately stays a
 *    §9.1 `404` envelope (it is also the half of this contract that keeps a probe, a crawler or a
 *    mis-typed asset URL from getting a couple of kilobytes of HTML and calling it a success).
 * 3. **No build is not an error.** `pnpm dev` runs the SPA in Vite on `:5173` and the API on `:3000`, so
 *    a host with no `apps/web/dist` is the normal development state, and the test suites boot the app
 *    with no build at all. A missing `index.html` therefore registers *nothing*: `/api/*` answers as
 *    before and everything else keeps the envelope 404. The alternative — a hard failure — would make
 *    every API test depend on a `vite build`.
 *
 * **Caching is set here rather than inherited.** Vite's file names are content-hashed, so `assets/*`
 *    can be `immutable` for a year and `index.html` must not be cached at all — a stale `index.html`
 *    after an upgrade points at hashes the new image no longer contains, which is a blank page every
 *    visitor gets until their cache expires.
 *
 * **The shell is a normal route, which is the point.** These are ordinary handlers on this instance, so
 *    `@fastify/helmet`'s root hooks cover them: `index.html` arrives with the same CSP as `/api/health`
 *    (`script-src 'self'`, which is what Vite's hashed bundles need and nothing wider), and a build that
 *    started inlining a `<script>` into the shell would be blocked by the browser rather than silently
 *    trusted. `web/dist` is also never a prefix an attacker steers: the plugin resolves it once and
 *    `@fastify/static` refuses a path that resolves outside it.
 *
 * **Where the root comes from.** `registerStaticSpa()` takes an explicit `root`; `buildApp()` passes
 *    `options.webDist` and otherwise falls back to {@link defaultWebDistRoot}. There is deliberately no
 *    new environment variable: the path is a *layout fact* about this repository (and PR-18's image),
 *    not an operator's knob, and `env.ts` is where operator knobs are parsed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** `index.html` is the app's entry: caching it is how an upgrade fails to arrive. */
const NO_STORE = 'no-cache';
/** `assets/*` is content-hashed by Vite, so it can never be served stale to the app that shipped it. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Where `pnpm build` puts the SPA, resolved from this file so it works from `src` and from `dist`. */
export function defaultWebDistRoot(): string {
  // `src/plugins/static-spa.ts` and `dist/plugins/static-spa.js` sit at the same depth inside
  // `apps/server`, which is what `rootDir: src`/`outDir: dist` guarantees (apps/server/tsconfig.json).
  // One path for the development process, the test suite, and PR-18's image is the whole point.
  return resolve(import.meta.dirname, '..', '..', '..', 'web', 'dist');
}

export interface StaticSpaOptions {
  /**
   * The built SPA's directory. Defaults to {@link defaultWebDistRoot}; a test passes a fixture, and a
   * later PR that ever needs a different layout passes it through `buildApp({ webDist })`.
   */
  readonly root?: string;
}

/**
 * What was registered, so the caller (and a test) can tell "serving the SPA" from "nothing configured"
 * without inspecting the route table.
 */
export interface StaticSpaStatus {
  readonly served: boolean;
  readonly root: string;
}

/**
 * Puts `root`'s files on the API port, plus the `/app` fallback. Returns `served: false` — having
 * registered nothing — when the build is not there; see rule 3 above.
 */
export async function registerStaticSpa(
  app: FastifyInstance,
  options: StaticSpaOptions = {},
): Promise<StaticSpaStatus> {
  const root = resolve(options.root ?? defaultWebDistRoot());
  const indexPath = join(root, 'index.html');

  if (!existsSync(indexPath)) {
    app.log.debug({ root }, 'no built SPA to serve; the API answers every route itself');
    return { served: false, root };
  }

  const assetsDir = join(root, 'assets') + sep;

  await app.register(fastifyStatic, {
    root,
    // Rule 1: a route per file, never a `/*` route that `/api/…` could be swallowed by.
    wildcard: false,
    // One hook covers both halves of the cache decision, because it is the only place that knows which
    // file is being sent.
    setHeaders: (reply: FastifyReply, absolutePath: string) => {
      reply.header('cache-control', absolutePath.startsWith(assetsDir) ? IMMUTABLE : NO_STORE);
    },
  });

  const sendIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('cache-control', NO_STORE);
    // Read per request rather than once at registration, so a rebuilt `index.html` — same path, new bytes —
    // is served without restarting the process that booted against the old one.
    //
    // Sent as a buffer, and the `async`/`await` on this handler is load-bearing: `send(createReadStream(file))`
    // puts the `200` and the `text/html` on the wire before the file is opened, so a shell that has vanished
    // under a running process would reach the browser as an empty document *called* the app. Read this way the
    // `ENOENT` is thrown before anything is committed and `plugins/error-handler.ts` answers it with the app's
    // own envelope (a 5xx `INTERNAL`, which is the honest thing to say when a part of the deployment is
    // missing; `NOT_FOUND` would claim the deep link does not exist, and it does). There is nothing to stream
    // here: the shell is a few kilobytes, and reading it per request costs less than that confusion.
    return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath));
  };

  // `HEAD` is registered explicitly because Fastify does not derive it from `GET`, and a probe or a
  // download manager that asks for headers alone should not get a 404 for the app's own home page.
  app.route({ method: ['GET', 'HEAD'], url: '/app', handler: sendIndex });
  app.route({ method: ['GET', 'HEAD'], url: '/app/*', handler: sendIndex });

  app.log.info({ root }, 'serving the built SPA from the API port');
  return { served: true, root };
}
