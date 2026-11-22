import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The API the dev server proxies to.
 *
 * Development runs two processes (`tsx watch` on 3000, this server on 5173) and the browser only
 * ever talks to `/api/*`, so PR-12 can fold the built SPA into the API process on one port without
 * touching a single call site. Only two things are read here, and neither is a mode: the default
 * target, and `VITE_API_TARGET` for the machine where `:3000` is already taken (this file must not
 * grow into a second env-consuming entry point — every one of those has to declare its own
 * `NODE_ENV`, plan §16).
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [
    // File-based routing: watches src/routes and regenerates src/routeTree.gen.ts on dev and build.
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        // **`changeOrigin` stays `false`, and PR-07's CSRF guard is the reason it is written at all.** The guard
        // compares the browser's `Origin` with the `Host` the API actually saw, and `changeOrigin: true` rewrites
        // `Host` to `127.0.0.1:3000` while `Origin` stays `http://localhost:5173` — every mutation the dev SPA
        // makes, `/api/auth/login` and `/api/auth/setup` included, would then be answered `403`, and the
        // client's one-shot re-issue could not fix a header the proxy rewrote. Fastify does not route on `Host`,
        // so there was never anything for the rewrite to buy here; a deployment behind a proxy that *does*
        // rewrite it sets `TRUST_PROXY=true` and forwards `X-Forwarded-Host`/`X-Forwarded-Proto`
        // (`ownOriginOf` in `apps/server/src/plugins/csrf.ts`).
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
