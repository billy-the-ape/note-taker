/**
 * The one timestamp sentence in the app (PR-12's rule, moved out of `routes/app/index.tsx` when PR-13's
 * editor needed the same words).
 *
 * It is a slice of an ISO-8601 string, and the test for a slice looks like the test for a slice — which is
 * fine, because the thing under test is not the arithmetic but the *promise*: no locale, no timezone, no
 * `TZ` in the CI image can change `2026-01-02`. A `toLocaleDateString` here would be a one-line change that
 * turns three e2e assertions into whichever locale the container happens to have.
 */
import { describe, expect, it } from 'vitest';

import { formatInstant } from './format';

describe('formatInstant', () => {
  it('keeps the day and drops everything a reader is not scanning for', () => {
    expect(formatInstant('2026-01-02T14:23:45.678Z')).toBe('2026-01-02');
  });

  it('is the same string whatever the container thinks the locale is', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(formatInstant('2026-01-02T23:59:59.999Z')).toBe('2026-01-02');
    } finally {
      process.env.TZ = previous;
    }
  });

  it('says nothing rather than something wrong about a timestamp it did not get', () => {
    // Defensive, and cheap: this runs over rows the server just sent, so a missing field is a bug in
    // whoever produced the row, and the honest rendering of "no date" is no date.
    expect(formatInstant('')).toBe('');
  });
});
