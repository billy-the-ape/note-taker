import process from 'node:process';

import { buildApp } from './app.js';
import { closeDb, getDb, probeDb } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { EnvError, loadDevEnvFile, parseEnv } from './env.js';
import { createLogger } from './logger.js';

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

  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV);

  // ── migrations: after the configuration is valid, BEFORE listen() ───────────────────────────
  // Plan §6: "migrations run at container start before `listen()`", and PR-18's container entrypoint is only
  // `exec node dist/index.js`, so this is the migration step a container gets — there is no `db:migrate` in
  // the image. A DSN that cannot be resolved or a statement that fails is a boot failure with the port still
  // unbound, and the pool is released on the way out so the process is actually able to exit.
  const { db, close: closePool } = getDb();
  try {
    await migrateDatabase({ db, log: logger });
  } catch (error) {
    await closePool();
    throw error;
  }

  const app = await buildApp({ env, logger, checkDb: () => probeDb(db) });
  app.addHook('onClose', async () => {
    await closeDb();
  });

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
