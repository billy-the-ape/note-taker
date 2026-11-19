import process from 'node:process';

import { buildApp } from './app.js';
import { EnvError, loadDevEnvFile, parseEnv } from './env.js';

/** Reports a boot failure with no logger: there may be no valid configuration to build one from. */
function reportBootFailure(error: unknown): void {
  const detail =
    error instanceof EnvError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  process.stderr.write(`note-taker API failed to start:\n${detail}\n`);
}

async function main(): Promise<void> {
  // This order is the contract every later host entry point reuses (plan §16): load the dev/test
  // `.env` if there is one, then parse, then build, then listen. A configuration failure therefore
  // always happens before the port is bound, which is what the NODE_ENV acceptance criterion proves.
  loadDevEnvFile();
  const env = parseEnv();

  const app = await buildApp({ env });

  // ── migrations slot (owned by PR-04) ──────────────────────────────────────────────────────
  // PR-04 creates `db/migrate.ts` and runs it here — after the configuration is valid and BEFORE
  // listen() — so a container never serves traffic against an unmigrated schema:
  //
  //   const { migrateDatabase } = await import('./db/migrate.js');
  //   await migrateDatabase(env);
  //
  // PR-01 ships no database code at all, so the slot stays empty instead of pretending otherwise.
  // That also means nothing here resolves a DSN yet: `databaseUrl()` (plan §16) is called by
  // `db/client.ts`, `db/migrate.ts`, `drizzle.config.ts` and `scripts/seed-demo.ts` in PR-04/PR-09,
  // and calling it now would make a scaffold with no queries depend on a database.

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info({ host: env.HOST, port: env.PORT, appName: env.APP_NAME }, 'note-taker API listening');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal means the first one hit something that will not finish: exit immediately.
      app.log.warn({ signal }, 'second signal during shutdown, exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      },
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => shutdown(signal));
  }
}

main().catch((error: unknown) => {
  reportBootFailure(error);
  // The exit code is set rather than `process.exit()` called, so buffered stderr still flushes.
  // Nothing has bound a port: every failure path above sits before `listen()`.
  process.exitCode = 1;
});
