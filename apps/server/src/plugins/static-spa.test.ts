/**
 * The built SPA on the API port (docs/plans/mvp/MVP-12.md §6, last acceptance box but one).
 *
 * Every case here is about one of the three rules in `static-spa.ts`, and the fixture is a temporary
 * directory rather than `apps/web/dist` for a reason: the assertions have to hold whatever the real
 * build happens to contain today, and "there is no build" is half the contract. The fixture is therefore
 * written per file (`index.html`, one hashed bundle, one nested asset, one file that must never be
 * reachable) and passed through `buildApp({ webDist })`, so it is the *whole app* that is under test —
 * the §9.1 envelope, `/api/health`, and the registration order — not the plugin in isolation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorResponseSchema } from '@note-taker/contracts';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { parseEnv } from '../env.js';
import { createTestLogger } from '../logger.js';
import { defaultWebDistRoot, registerStaticSpa } from './static-spa.js';

/** Vite's output shape: an `index.html`, hashed bundles under `assets/`, and a root-level icon. */
const INDEX_MARK = '<title>Note Taker fixture</title>';
const BUNDLE = 'console.log("the bundle");';
const SECRET = 'the file outside the served root that no URL may reach';

/**
 * `<parent>/dist` is the served root; `<parent>/secret.txt` sits one directory above it, which is the only
 * interesting thing a file can be to a static server.
 */
function makeDist(): { readonly parent: string; readonly dist: string } {
  const parent = mkdtempSync(join(tmpdir(), 'note-taker-spa-'));
  writeFileSync(join(parent, 'secret.txt'), SECRET);
  const dist = join(parent, 'dist');
  mkdirSync(dist);
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head>${INDEX_MARK}</head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'index-CqAz1234.js'), BUNDLE);
  writeFileSync(join(dist, 'assets', 'index-Dbe5678.css'), ':root{color:red}');
  return { parent, dist };
}

async function makeApp(webDist: string) {
  const app = await buildApp({
    env: parseEnv({ NODE_ENV: 'test' }),
    logger: createTestLogger(),
    webDist,
  });
  await app.ready();
  return app;
}

/** The served root and its temporary parent (which holds a file *outside* the root). */
let fixture: { readonly parent: string; readonly dist: string };
let dist: string;
let emptyDist: string;

beforeAll(() => {
  fixture = makeDist();
  dist = fixture.dist;
  emptyDist = mkdtempSync(join(tmpdir(), 'note-taker-spa-empty-'));
});

afterAll(() => {
  // The whole temporary parent, so the file *outside* the served root goes with it.
  for (const dir of [fixture.parent, emptyDist]) rmSync(dir, { recursive: true, force: true });
});

describe('the SPA on the API port', () => {
  it('serves index.html for / so one port is the whole app', async () => {
    const app = await makeApp(dist);
    const response = await app.inject('/');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(INDEX_MARK);
    // `index.html` is the one file that must never be served stale: it names the hashed bundles, and a
    // cached copy after an upgrade is a blank page pointing at files the new image does not have.
    expect(response.headers['cache-control']).toBe('no-cache');

    await app.close();
  });

  it('gives the shell the security headers of the API, not a special case of its own', async () => {
    // `@fastify/helmet` is a root hook and `@fastify/static` is a route, so the served `index.html` answers with
    // exactly the headers the API answers with — including the CSP that lets Vite's hashed bundle run
    // (`script-src 'self'`). This fixture has no database and therefore no `registerAuth()`, which is where
    // helmet is registered, so the assertion is about the *equality* of the two responses rather than the
    // presence of a value: whenever the API has the headers, the shell has them; when the API has none, the
    // shell is not quietly getting some. A production boot always has a database, and so always has helmet.
    const app = await makeApp(dist);
    const shell = await app.inject('/');
    const api = await app.inject('/api/health');

    expect(shell.headers['content-security-policy']).toEqual(api.headers['content-security-policy']);
    expect(shell.headers['x-frame-options']).toEqual(api.headers['x-frame-options']);
    expect(shell.headers['x-content-type-options']).toEqual(api.headers['x-content-type-options']);

    await app.close();
  });

  it('serves the hashed bundles with a year of immutable, because the name is the content', async () => {
    const app = await makeApp(dist);
    const response = await app.inject('/assets/index-CqAz1234.js');

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BUNDLE);
    expect(response.headers['cache-control']).toContain('immutable');
    // …and the bundle is *typed* as JavaScript, because a `<script type="module">` refuses a wrong MIME
    // type and the app would be blank with nothing in the console but a sniffing complaint.
    expect(response.headers['content-type']).toContain('javascript');

    await app.close();
  });

  it.each([
    ['/app', 'the app itself'],
    ['/app/', 'the same URL with its trailing slash'],
    ['/app/note/019a3b4c-5d6e-7f80-9123-456789abcdef', "a note deep link (PR-13's editor)"],
    ['/app/settings', 'a settings deep link (PR-16)'],
    ['/app/search', 'a search deep link (PR-17)'],
  ])('falls back to index.html for %s — %s', async (url) => {
    const app = await makeApp(dist);
    const response = await app.inject(url);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(INDEX_MARK);

    await app.close();
  });

  it('answers HEAD for the deep link too, so a probe is not a 404', async () => {
    const app = await makeApp(dist);
    const response = await app.inject({ method: 'HEAD', url: '/app' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('never swallows /api/*, which is the rule the whole plugin is shaped around', async () => {
    const app = await makeApp(dist);

    // A real route still routes: the health probe is the one endpoint every deployment already pings, and
    // PR-18's `HEALTHCHECK` is the one thing that must not start returning HTML.
    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');

    // An unknown API path keeps the §9.1 envelope rather than becoming a 2 000-byte HTML success page —
    // the difference between a client that can tell "wrong path" from "the server is broken".
    const missing = await app.inject('/api/nope');
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(missing.json()).success).toBe(true);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // …including a POST to a path that is an SPA deep link's prefix, and a mutation-shaped method.
    const wrongMethod = await app.inject({ method: 'POST', url: '/app' });
    expect(wrongMethod.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(wrongMethod.json()).success).toBe(true);

    await app.close();
  });

  it('answers an unknown path outside /app with the envelope, not with the app', async () => {
    // Deliberately not a fallback: `/some-random-path` is either a mistake or a probe, and both want a 404
    // they can branch on. Only the routable half of the SPA (`/app/…`, from PR-16/PR-17 onward) falls back.
    const app = await makeApp(dist);
    const response = await app.inject('/totally-not-a-note');
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('never reaches behind the build directory, whatever the URL claims', async () => {
    // Everything inside `dist` is public by definition (`index.html` names every one of those files), so the
    // question this file has to answer is only whether a URL can get *behind* it — and `/assets/../../x` is
    // not that question, because `/assets/../../x` normalises to `/x`, which is a route for a file that is
    // legitimately served. The two forms below are the ones that survive normalisation, and `@fastify/static`
    // answers both without this plugin adding a line of path handling of its own.
    const app = await makeApp(dist);

    const traversal = await app.inject('/assets/../../secret.txt');
    expect(traversal.body).not.toContain(SECRET);

    const encoded = await app.inject('/%2e%2e/secret.txt');
    expect(encoded.statusCode).not.toBe(200);
    expect(encoded.body).not.toContain(SECRET);

    const inside = await app.inject('/secret.txt');
    expect(inside.statusCode).toBe(404);
    expect(inside.body).not.toContain(SECRET);

    await app.close();
  });

  it('answers the envelope, and never a half-sent shell, when index.html vanishes after registration', async () => {
    // The registration decision and the request are separate moments: an image copied over a running process,
    // or a `pnpm build` caught mid-write, leaves a registered route whose file is gone by the time it is asked
    // for. What has to hold is that the answer is still the app's error envelope — with `reply.send(stream)`,
    // the 200 and the `text/html` are already on the wire by then and the body aborts, so the browser is left
    // holding an empty document and calling it the app.
    //
    // The status is a 5xx and `INTERNAL`, which is the honest reading: the shell is a part of this process
    // that has gone missing, and `NOT_FOUND` would claim the deep link does not exist when the route plainly
    // does. `plugins/error-handler.ts` logs the ENOENT behind it.
    const temp = makeDist();
    const app = await makeApp(temp.dist);
    rmSync(join(temp.dist, 'index.html'));

    const response = await app.inject({ method: 'GET', url: '/app' });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type'] ?? '').not.toContain('text/html');
    expect((response.json() as { error: { code: string } }).error.code).toBe('INTERNAL');

    await app.close();
    rmSync(temp.parent, { recursive: true, force: true });
  });

  it('boots and serves the API untouched when there is no build at all', async () => {
    // `pnpm dev` and every test suite live here: the SPA is Vite's job on another port until someone runs
    // `pnpm build`, so a missing `index.html` is a state with a name, not a crash.
    const app = await makeApp(emptyDist);

    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    const index = await app.inject('/');
    expect(index.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(index.json()).success).toBe(true);
    const deepLink = await app.inject('/app');
    expect(deepLink.statusCode).toBe(404);

    await app.close();
  });

  it('reports what it did, so a caller can tell the two states apart without the route table', async () => {
    // A bare Fastify, not `buildApp`: `buildApp` registers the plugin itself (that is PR-12's wiring, and the
    // routes below prove it), and `@fastify/static` adds a decorator — registering it twice on one instance is
    // a hard error, which is a fact about the plugin's shape rather than about this test's wishes. The two
    // states of the *report* are what is under test here, and nothing else about the app is. (`logger: false`
    // rather than the test logger keeps the instance on Fastify's own type parameters, which is what the
    // plugin's signature accepts; nothing logs here anyway.)
    const served = Fastify({ logger: false });
    expect((await registerStaticSpa(served, { root: dist })).served).toBe(true);
    await served.close();

    const absent = Fastify({ logger: false });
    const status = await registerStaticSpa(absent, { root: join(emptyDist, 'never-built') });
    expect(status).toEqual({ served: false, root: join(emptyDist, 'never-built') });
    await absent.close();
  });
});

describe('the default root', () => {
  it('points at apps/web/dist from wherever this file is compiled', () => {
    // `src/plugins/static-spa.ts` (tsx, Vitest) and `dist/plugins/static-spa.js` (tsc, PR-18's image) are at
    // the same depth, so the one relative path is also the one the image gets — worth a test, because
    // "the image serves the SPA" is otherwise only provable by booting the image.
    const root = defaultWebDistRoot();
    expect(root.endsWith(join('apps', 'web', 'dist'))).toBe(true);
    expect(root.includes(join('server'))).toBe(false);
  });
});
