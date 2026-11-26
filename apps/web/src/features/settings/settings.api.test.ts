/**
 * The settings read PR-14 needs and the rule that makes it safe (docs/plans/mvp/MVP-14.md §6,
 * docs/API.md §9.2 #22).
 *
 * The default is the criterion here, stated in the brief as "a missing settings row can never silently
 * flip autosave": the endpoint get-or-creates so a *row* is never missing, but a **read** can be — in
 * flight, or failed, or the app booted on a dead network. A note that quietly stops autosaving because
 * a preferences request was slow is a bug a person cannot see, so the answer to "no answer" is on.
 */
import { API_BASE_PATH } from '@note-taker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEFAULT, autosaveFlag, fetchSettings, settingsOptions } from './settings.api';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The row `settingsSchema` accepts (§9.2 #22). */
const row = (autosave: boolean) => ({
  autosave,
  theme: 'system' as const,
  updatedAt: '2026-01-01T12:00:00.000Z',
});

describe('autosaveFlag', () => {
  it('is on when the row has not arrived, which is the brief’s “never silently flip” rule', () => {
    expect(AUTOSAVE_DEFAULT).toBe(true);
    expect(autosaveFlag(undefined)).toBe(true);
  });

  it('follows the row once it has, in both directions', () => {
    expect(autosaveFlag(row(true))).toBe(true);
    expect(autosaveFlag(row(false))).toBe(false);
  });
});

describe('fetchSettings', () => {
  it('reads the one settings row, and the key is the one PR-16 patches', () => {
    expect(settingsOptions().queryKey).toEqual(['settings']);
    expect(API_BASE_PATH).toBe('/api');
  });

  it('GETs the settings path and parses the answer with the contract', async () => {
    const calls: { url: string; method: string | undefined; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      calls.push({ url: input, method: init.method, headers: new Headers(init.headers) });
      return new Response(JSON.stringify(row(false)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(fetchSettings()).resolves.toMatchObject({ autosave: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/settings');
    expect(calls[0]?.method).toBe('GET'); // an explicit GET, and therefore no CSRF header
    expect(calls[0]?.headers.get('accept')).toContain('application/json');
  });

  it('refuses a body that is not the contract, rather than guessing at a flag', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ autosave: 'yes', theme: 'system', updatedAt: '2026-01-01T12:00:00.000Z' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    // A string where a boolean belongs must not become `Boolean('')`-adjacent truthiness: the whole
    // point of parsing at the edge is that a lie from the wire stops here.
    await expect(fetchSettings()).rejects.toThrow();
  });
});
