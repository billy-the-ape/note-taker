// @vitest-environment jsdom
/**
 * Which chrome a page gets, and why there is only one of each
 * (docs/plans/mvp/MVP-12.md §4; PR-12 review, round two).
 *
 * The defect this file exists for was invisible to every test written before it: `__root.tsx` used to own a
 * centered `max-w-2xl` column, a wordmark and a theme toggle, and it wrapped *every* route in them — so the
 * authed shell rendered as a 672 px island under a second header, with a second `ThemeToggle` inside the
 * `TopBar`'s own, and a `<main>` nested in a `<main>`. Nothing failed, because the components are all correct
 * in isolation and only the composition was wrong.
 *
 * jsdom cannot see a computed width, so this file does not try. What it can pin, and what the fix really
 * claims, is the **count**: one chrome wrapper, one header, one theme knob, one `<main>`, whichever door you
 * came in through. A future PR that puts furniture back in the root route breaks that count on both pages at
 * once, which is the point of asserting the number rather than the CSS.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootAuth, TEST_USERNAME } from '../test/authHarness';
import { sessionUser } from '../test/fakeApi';

afterEach(() => vi.unstubAllGlobals());

/** The three numbers that say "there is exactly one screen's worth of chrome on the page". */
function chromeCounts(): { headers: number; knobs: number; mains: number } {
  return {
    headers: document.querySelectorAll('header').length,
    knobs: screen.queryAllByTestId('theme-toggle').length,
    mains: document.querySelectorAll('main').length,
  };
}

describe('the auth pages', () => {
  it.each(['/login', '/setup'] as const)('%s gets the centered column', async (path) => {
    await bootAuth(path, path === '/setup' ? { needsSetup: true } : {});

    expect(screen.getByTestId('auth-chrome')).not.toBeNull();
    // The column owns the wordmark and the knob, so it owns exactly one header and one `<main>` too — and the
    // knob matters twice as much after PR-16 moves it into settings.
    expect(chromeCounts()).toEqual({ headers: 1, knobs: 1, mains: 1 });
    expect(screen.getByRole('heading', { level: 1 })).not.toBeNull();
  });
});

describe('/app', () => {
  it('is the shell and nothing else around it', async () => {
    await bootAuth('/app', { user: sessionUser() });

    expect(screen.getByTestId('app-shell')).not.toBeNull();
    expect(screen.queryByTestId('auth-chrome')).toBeNull();
    // The three lines below are the review, restated as assertions: the shell used to sit inside the root's
    // column (its `main` inside another `main`), under a header that was not its own, beside a theme knob it
    // did not ask for. `TopBar` is the header and `app-main` is the `main`, and each is alone.
    expect(screen.getByTestId('topbar')).not.toBeNull();
    expect(chromeCounts()).toEqual({ headers: 1, knobs: 1, mains: 1 });
    expect(screen.getByTestId('app-main').tagName).toBe('MAIN');
  });

  it('still has the providers the pages read, which is what the root route is for', async () => {
    // Dropping the chrome out of `RootLayout` must not drop `ToastProvider`/`SessionProvider` with it: the
    // sidebar renders and the top bar reads the session, so both providers are live on this page.
    const { app } = await bootAuth('/app', { user: sessionUser() });
    expect(screen.getByTestId('topbar-user').textContent).toContain(TEST_USERNAME);
    expect(app.router.state.location.pathname).toBe('/app');
  });
});
