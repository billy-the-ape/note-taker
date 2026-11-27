/**
 * A pino instance that records what the app logs, for the assertions a response body cannot carry.
 *
 * The envelope is deliberately lossy: a 500 says `internal error` and nothing else (PR-05), which is right for
 * the client and means the *only* record of what actually broke — and, since PR-09, of **which note** failed to
 * decrypt — is the log line the error handler writes beside the `requestId`. A criterion of the form "the client
 * gets `INTERNAL` and the note id is logged" therefore has a half that cannot be checked through
 * `app.inject()` at all, and this is the smallest thing that checks it.
 *
 * It is the real logger, not a fake: same `loggerOptions()` (level, redact paths, ISO timestamps) as production,
 * writing to a stream that appends rather than to stdout. Lines are parsed as they complete, so a test reads
 * objects rather than grep-ing a buffer, and `capture.lines()` after the request is enough — pino's write is
 * synchronous.
 */

import { Writable } from 'node:stream';
import { type Logger, pino } from 'pino';

import { loggerOptions } from '../../logger.js';

/** One parsed log line: pino's level/`msg` plus whatever fields the call site attached. */
export type LoggedLine = Record<string, unknown>;

export interface LogCapture {
  /** Pass to `withApp`'s `logger` option. */
  readonly logger: Logger;
  /** Every line logged so far, oldest first. */
  lines(): LoggedLine[];
  /**
   * The lines whose `msg` matches, as objects — the shape most of these assertions want, since "the failure was
   * logged once, against this id" is a statement about how many lines matched and not about how many substrings
   * appeared somewhere.
   */
  matching(msg: string): LoggedLine[];
}

export function captureLogs(
  level: 'silent' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' = 'info',
): LogCapture {
  const parsed: LoggedLine[] = [];
  let pending = '';

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString('utf8');
      const complete = pending.split('\n');
      // A chunk can end mid-line, and a half-line JSON blob is not a log line — keep it for the next write.
      pending = complete.pop() ?? '';
      for (const line of complete) {
        if (line.trim() === '') continue;
        try {
          parsed.push(JSON.parse(line) as LoggedLine);
        } catch {
          // A line that is not JSON is the app's problem to notice, not this helper's to invent a shape for.
          parsed.push({ msg: line });
        }
      }
      callback();
    },
  });

  const logger = pino(loggerOptions(level, 'test'), sink);

  return {
    logger,
    lines: () => [...parsed],
    matching: (msg: string) => parsed.filter((line) => line.msg === msg),
  };
}
