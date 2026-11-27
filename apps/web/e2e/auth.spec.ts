/**
 * Scenario 1 — the first run, and the way back in (docs/plans/mvp/MVP-19.md §5.1).
 *
 * This file is the one that walks `/setup` **in the browser**, which is why it is the file that owns the
 * instance's owner: `POST /api/auth/register` refuses to create a member until an owner exists
 * (`auth.service.ts`), and every other spec file creates its account through that route. It runs first because
 * the suite runs one worker over files in name order, and `auth` sorts before `autosave`, `folders` and `notes`
 * — but the ordering is not load-bearing, because each file truncates the database in its `beforeAll`
 * (`e2e/reset.ts`) and then boots its own owner, so a filtered run of `folders.spec.ts` alone works too.
 *
 * Everything the story asserts is through the hooks PR-08 left behind: `-form`, `-username`, `-password`,
 * `-confirm` on `CredentialsForm`, `topbar-user`/`sign-out` on `TopBar`, `tree-empty`/`app-shell` on PR-12's shell.
 *
 * The third test is the reason this file is a *browser* test rather than a fetch-layer one. `lib/api.ts` echoes
 * `note_csrf` into `X-CSRF-Token` on every mutation, so the app's own transport cannot produce the request that
 * proves the guard is loaded — only a page can, by sending the cookie and not the header. The cookie attributes
 * are asserted in the same breath because they are the other half of the same promise (§10, "implement exactly"):
 * `note_session` is `HttpOnly` so no XSS reads it, `note_csrf` deliberately is not so `api.ts` can read it back.
 */
import { CSRF_COOKIE_NAME, ROUTES, SESSION_COOKIE_NAME, type TreeResponse } from '@note-taker/contracts';
import { expect, test } from '@playwright/test';

import { E2E_PASSWORD, fetchTree, setupInstance, signUp } from './api';
import { BASE_URL } from './env';
import { ACCOUNT } from './fixtures';
import { closeResetPool, resetTestInstance } from './reset';

test.describe('the first run', () => {
  // The two tests are one story: the owner created by the first is the account the second signs out of.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  test('a fresh instance opens on /setup, and the owner it creates lands on /app', async ({ page }) => {
    await page.goto('/');

    // §4's guard table: no session and `needsSetup` is the only state in which `/setup` is the right page, and
    // the only state in which it is reachable at all.
    await expect(page).toHaveURL(/\/setup$/u);
    await expect(page.getByTestId('setup-form')).toBeVisible();

    await page.getByTestId('setup-username').fill(ACCOUNT.owner);
    await page.getByTestId('setup-password').fill(E2E_PASSWORD);
    await page.getByTestId('setup-confirm').fill(E2E_PASSWORD);
    await page.getByTestId('setup-submit').click();

    await expect(page).toHaveURL(/\/app$/u);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    // An owner on a truncated database has nothing: this is the sentence the shell is allowed to say.
    await expect(page.getByTestId('tree-empty')).toBeVisible();
    await expect(page.getByTestId('topbar-user')).toContainText(ACCOUNT.owner);

    // …and `/setup` closes behind its owner. Reaching it now is a redirect, not a second form — the `409` from
    // `POST /api/auth/setup` is the same rule a moment later, and a reachable-but-useless form is the failure.
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/app$/u);
  });

  test('signing out lands on /login, and the same credentials land back on /app', async ({ page }) => {
    // A fresh context has no session cookie, so the guarded half of the app is closed to it. `/login` is where
    // the guard puts that person, and it is the page that can explain a dead API by trying.
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login$/u);

    const signIn = async (): Promise<void> => {
      await page.getByTestId('login-username').fill(ACCOUNT.owner);
      await page.getByTestId('login-password').fill(E2E_PASSWORD);
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(/\/app$/u);
    };

    await signIn();

    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/login$/u);
    // Signed out means signed out: the guarded page is closed to this context again, and `/setup` is still shut.
    await expect(page.getByTestId('login-form')).toBeVisible();
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/login$/u);

    await signIn();
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });

  test('the cookie pair a browser needs, and the guard a cookie alone cannot satisfy', async ({ page }) => {
    // Each test gets its own browser context — a cookie the previous test minted is not in this jar, which is the
    // first draft's mistake — so this test signs itself in, and `setupInstance` makes the owner exist when the
    // file's `beforeAll` truncated the database on a standalone `-g 'cookie alone'` run. It is a seam rather than
    // the form because the form is what the first two tests already walk; the subject here is the jar.
    // Load the page before the seam: the app mints `note_csrf` on a response, and `e2e/api.ts` refuses to send a
    // mutation without the pair rather than letting a fixture bug read like a product 403.
    await page.goto('/');
    await setupInstance(page);
    // A registered account of its own, because this test has to mean the same thing when the file runs alone: the
    // owner is `e2eowner` if `setupInstance` bootstrapped it and `e2e.scenario1.owner` if the first test's form
    // created it, and only the second exists in suite order. `beforeAll` truncated the database, so the name is
    // free either way. Then the jar is cleared — the pair under test is the one the *login form* mints, and
    // `setupInstance` hands this context a session when it has to create the owner.
    await signUp(page, ACCOUNT.csrfPair);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByTestId('login-username').fill(ACCOUNT.csrfPair);
    await page.getByTestId('login-password').fill(E2E_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/\/app$/u);

    const jar = await page.context().cookies(BASE_URL);
    const session = jar.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
    const csrf = jar.find((cookie) => cookie.name === CSRF_COOKIE_NAME);
    // The two cookies disagree about one attribute, and that disagreement is the design: `note_session` is
    // `HttpOnly` so an injected script cannot read the token, `note_csrf` is not so `api.ts` can echo it.
    expect(session, 'no session cookie means the sign-in above did not stick').toBeDefined();
    expect(csrf, 'the CSRF pair is half-set if only one cookie exists').toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(csrf?.httpOnly).toBe(false);
    // Shared attributes, and not one token doubling as the other.
    for (const cookie of [session, csrf]) {
      expect(cookie?.sameSite).toBe('Lax');
      expect(cookie?.path).toBe('/');
    }
    expect(csrf?.value).not.toBe(session?.value);

    // The guard, from the one place it can be proven: a real same-origin `fetch`, carrying both cookies, with no
    // `X-CSRF-Token`. `decideCsrf` has to answer `missing-token`, which arrives as the ordinary `403 FORBIDDEN`
    // and not as a `401` — a refused cross-origin check is not a logout, and PR-07 made that a requirement.
    const refusal = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a mutation the page never authorized' }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error?: { code?: string } },
      };
    }, ROUTES.folders);
    expect(refusal.status).toBe(403);
    expect(refusal.body.error?.code).toBe('FORBIDDEN');

    // …and "refused" is not "accepted and then reported": the folder is not there. Reading the tree through the
    // properly-paired client says so, which also proves the 403 was the guard rather than a broken route.
    const tree: TreeResponse = await fetchTree(page);
    expect(JSON.stringify(tree)).not.toContain('a mutation the page never authorized');
  });
});
