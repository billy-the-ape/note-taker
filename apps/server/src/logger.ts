import { type Logger, type LoggerOptions, pino } from 'pino';

import type { LogLevel, NodeEnv } from './env.js';

/** Everything pino accepts as a level, including the code-only `silent`. */
export type LogLevels = LogLevel | 'silent';

/**
 * The process-wide logging defaults (plan §16's `LOG_LEVEL`).
 *
 * The transport is deliberately left unset: pino-pretty is not a dependency, and JSON lines are
 * what the container ships (PR-18). Pretty output stays a per-machine choice
 * (`LOG_LEVEL=debug pnpm dev | pino-pretty`).
 */
export function loggerOptions(level: LogLevels, nodeEnv: NodeEnv): LoggerOptions {
  return {
    level,
    base: { service: 'note-taker-api', env: nodeEnv },
    // Cookie and credential material never reach the log, even at debug (PR-07 makes them real).
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/**
 * Builds the pino instance a process logs with. The mode is a required argument on purpose:
 * `NODE_ENV` is never defaulted anywhere in this repository (§16), including in the log line.
 */
export function createLogger(level: LogLevels, nodeEnv: NodeEnv): Logger {
  return pino(loggerOptions(level, nodeEnv));
}

/** A logger for tests: silent, so suites stay readable. */
export function createTestLogger(): Logger {
  return createLogger('silent', 'test');
}
