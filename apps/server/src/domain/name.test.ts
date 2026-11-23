/**
 * The server's half of the name rules (docs/plans/mvp/MVP-09.md §5.5), and the shape of a sibling clash.
 *
 * Three of these four functions are one-line wrappers over `packages/contracts/src/names.ts`, and a test that only
 * checked "it called the contract" would be worthless. What is worth pinning is the three things the wrapper
 * decides:
 *
 * * **that it strips once.** `stripMd` twice turns `foo.md.md` into `foo` — a different name from the one the
 *   validator approved — so these tests include the input where double-stripping would show.
 * * **what the generated name looks like in the column**, character for character, because the display layer adds
 *   `.md` back and the SPA compares the two. `new-file-…` with no extension is the storage contract.
 * * **that the suffix runs on the stored base.** `new-file-1` colliding with itself yields `new-file-1-2`, not
 *   `new-file-1.md-2`: an extension that reappears mid-name is exactly what the contract's
 *   `nested-extension` rule refuses on input, so the server must not synthesize one.
 *
 * `nameClash` is tested through `mapError` rather than by reading its fields, because what a client sees is the
 * mapped envelope: `docs/API.md §2` pins the sentence, `details[].path`, and `error.data.id` together, and a change
 * to any of the three has to break something here.
 */
import { describe, expect, it } from 'vitest';

import { mapError } from '../plugins/error-handler.js';
import { ConflictError } from './errors.js';
import {
  generatedNoteName,
  NAME_CLASH_DETAIL_MESSAGE,
  NAME_CLASH_MESSAGES,
  nameClash,
  storedNoteName,
  uniqueNoteName,
} from './name.js';

describe('storedNoteName (§5.5)', () => {
  it('strips one trailing .md and nothing else', () => {
    expect(storedNoteName('foo.md')).toBe('foo');
    expect(storedNoteName('foo')).toBe('foo');
    expect(storedNoteName('README.MD')).toBe('README');
    // The double-strip case: the validator accepted `foo.md.md` as the name `foo.md` (one extension removed), so
    // storing `foo` would be a name nobody sent.
    expect(storedNoteName('foo.md.md')).toBe('foo.md');
    // The name that is not a name: `stripMd` empties it, and it is `isValidNoteName` — which runs on the raw value
    // first — that keeps this out of a repository, not a check here.
    expect(storedNoteName('.md')).toBe('');
  });

  it('is idempotent on a value that already came from the database', () => {
    // A rename that sends the display name back is the common path, and it must not shorten the row again.
    const once = storedNoteName('quarterly.report.md');
    expect(storedNoteName(once)).toBe(once);
  });
});

describe('generatedNoteName (§5.5)', () => {
  it('is the contract name with its extension removed', () => {
    // Pinned against the literal rather than against `newFileName(ms)` alone, because "extension-free" is the
    // property PR-12's tree renders against.
    expect(generatedNoteName(1_700_000_000_000)).toBe('new-file-1700000000000');
    expect(generatedNoteName(0)).toBe('new-file-0');
    expect(generatedNoteName(1)).not.toContain('.md');
  });

  it('defaults to the current clock, which is the only way the value is a name and not a collision', () => {
    const first = generatedNoteName();
    const later = generatedNoteName(Date.now() + 1_000);
    expect(first).toMatch(/^new-file-\d{10,}$/u);
    expect(first).not.toBe(later);
  });
});

describe('uniqueNoteName (§5.5)', () => {
  it('walks past every name the destination already holds', () => {
    expect(uniqueNoteName('plan', [])).toBe('plan');
    expect(uniqueNoteName('plan', ['plan'])).toBe('plan-2');
    expect(uniqueNoteName('plan', new Set(['plan', 'plan-2', 'plan-3']))).toBe('plan-4');
    // A gap is not a reason to stop early, and an unrelated suffix is not a reason to skip.
    expect(uniqueNoteName('plan', ['plan-2'])).toBe('plan');
    expect(uniqueNoteName('plan', ['plan', 'plan-2x'])).toBe('plan-2');
  });

  it('appends to the stored base, so no extension can reappear mid-name', () => {
    // The bug this exists to prevent: uniquifying a *display* name yields `new-file-1.md-2`, which the contract
    // would refuse as input and which `stripMd` cannot undo.
    expect(uniqueNoteName('new-file-1', ['new-file-1'])).toBe('new-file-1-2');
    // The contract strips before it counts, which is the difference between a stored `report-2` and a stored
    // `report.md-2` — the second is a name no client could have sent and no client could send again.
    expect(uniqueNoteName('report.md', ['report'])).toBe('report-2');
    expect(uniqueNoteName('report.md', ['report.md'])).toBe('report');
    expect(uniqueNoteName('report.md', [])).toBe('report');
  });
});

describe('nameClash (§5.5, API.md §2)', () => {
  it('is a CONFLICT carrying the winner, in the sentence the docs pin', () => {
    const id = '0f6f0c1a-0000-4000-8000-000000000000';
    const mapped = mapError(nameClash(id, 'note'));
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('CONFLICT');
    expect(mapped.message).toBe('name already exists in this folder');
    expect(mapped.details).toEqual([{ path: 'name', message: 'must be unique among siblings' }]);
    // `data.id` is the machine-readable half a double-clicked "Create" adopts.
    expect(mapped.data).toEqual({ id });
  });

  it('says the same sentence for a folder, on purpose', () => {
    // Two wordings would mean a client that shows `error.message` has two strings to compare; one code plus
    // `data.id` is the machine-readable answer, so the prose is allowed to be shared.
    expect(NAME_CLASH_MESSAGES.folder).toBe(NAME_CLASH_MESSAGES.note);
    expect(NAME_CLASH_DETAIL_MESSAGE).toBe('must be unique among siblings');
  });

  it('is a real ConflictError, so a repository that catches one catches this too', () => {
    expect(nameClash('0f6f0c1a-0000-4000-8000-000000000000', 'folder')).toBeInstanceOf(ConflictError);
  });
});
