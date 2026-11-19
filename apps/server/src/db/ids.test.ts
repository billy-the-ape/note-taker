import { describe, expect, it } from 'vitest';

import { newId } from './ids.js';

/**
 * PR-04's one id generator (docs/plans/mvp/MVP-04.md §4).
 *
 * The version nibble and the variant bits are the whole contract: they are what make the ids UUIDv7 rather
 * than "some UUIDs", and the monotonic millisecond prefix is what the ordering guarantee rests on. The
 * *within*-a-millisecond order is explicitly not guaranteed (v7 leaves those bits random unless a caller asks
 * for a sequence), which is why this asserts the prefix, not the full string, is sorted.
 */
describe('newId()', () => {
  it('returns a canonical lowercase UUIDv7 string', () => {
    const id = newId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.length).toBe(36);
    // Version 7 in the 13th hex digit, variant 10 in the 17th — the two bits that make it v7.
    expect(id[14]).toBe('7');
  });

  it('is unique across a burst of calls', () => {
    const ids = Array.from({ length: 200 }, () => newId());

    expect(new Set(ids).size).toBe(200);
  });

  it('is time-ordered at millisecond resolution, which is the index-locality property', () => {
    const startedAt = Date.now();
    const ids = Array.from({ length: 100 }, () => newId());
    const millis = ids.map((id) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16));

    expect([...millis].sort((a, b) => a - b)).toStrictEqual(millis);
    expect(millis[0]).toBeGreaterThanOrEqual(startedAt);
    expect(millis[99]).toBeLessThanOrEqual(Date.now());
  });
});
