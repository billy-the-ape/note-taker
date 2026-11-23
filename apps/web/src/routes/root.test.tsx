// @vitest-environment jsdom
/**
 * The two global boundaries `routes/__root.tsx` registers (docs/plans/mvp/MVP-08.md §5).
 *
 * They are tested directly rather than through a route that throws, because nothing in this PR's route
 * table throws on purpose — the point of the boundary is the case nobody predicted, and waiting for a
 * future bug to produce one would leave the last line of defence untested until it mattered.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api';
import { RootError, RootNotFound } from './__root';

describe('the global error boundary', () => {
  it('says what the server said, its code, and the request id', () => {
    render(
      <RootError
        error={
          new ApiError({
            status: 429,
            code: 'RATE_LIMITED',
            message: 'too many attempts, slow down',
            requestId: 'req_01H',
          })
        }
        reset={() => undefined}
      />,
    );

    const region = screen.getByTestId('route-error');
    expect(region.textContent).toContain('too many attempts, slow down');
    expect(region.textContent).toContain('RATE_LIMITED');
    // The `requestId` is the half a person can paste into an issue (docs/API.md), so it is on the page
    // rather than only in a console they would have to open on the machine that is already broken.
    expect(region.textContent).toContain('req_01H');
    // And no stack: a minified frame is not something you can act on while reading your own notes.
    expect(region.textContent).not.toContain('at ');
  });

  it('answers a plain Error without inventing a code, and a thrown non-Error at all', () => {
    render(<RootError error={new Error('a render fell over')} reset={() => undefined} />);
    const region = screen.getByTestId('route-error');
    expect(region.textContent).toContain('a render fell over');
    expect(region.textContent).not.toContain('undefined');
    // Not every thing thrown is an `Error` — a promise, a string, a proxy from a library. The boundary
    // still has to render something, or the whole app is a white page.
    render(
      <RootError
        // Deliberately not an `Error`: the props are typed, the runtime is not.
        error={'thrown from a non-Error' as unknown as Error}
        reset={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('route-error').at(-1)?.textContent).toContain('thrown from a non-Error');
  });

  it('wires the Try again button to reset, so a stale screen can be left', async () => {
    let resets = 0;
    const user = userEvent.setup();
    render(
      <RootError
        error={new ApiError({ status: 500, code: 'INTERNAL', message: 'the table is unhappy' })}
        reset={() => {
          resets += 1;
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(resets).toBe(1);
  });
});

describe('the global not-found boundary', () => {
  it('says the page is not there without pretending to know where it went', () => {
    render(<RootNotFound />);
    const region = screen.getByTestId('route-not-found');
    expect(region.textContent).toContain('No such page');
    // With `*` redirecting, this is only reachable when a route itself says "no such thing" — and it is
    // deliberately not a redirect in disguise.
    expect(region.querySelector('a')).toBeNull();
  });
});
