/**
 * The API seams the browser-driven scenarios need, and an argument for why they are narrower than they look
 * (docs/plans/mvp/MVP-19.md §5).
 *
 * **What they are for.** Six of PR-19's seven scenarios are driven through `data-testid`s. Two facts about the
 * product *as merged today* mean the remaining two need a request the browser still makes itself:
 *
 * * `routes/app/note/$noteId.tsx` — the editor page — is PR-13's file and is not in this tree, so no page
 *   mounts a textarea, the toolbar, the preview or the `save-status` pill. Scenarios 2's editor half, 5 and 6
 *   are `test.fixme` in `notes.spec.ts`/`autosave.spec.ts` for exactly that reason, not stubbed here.
 * * `useNewNoteDialog()` (PR-15) is not mounted by `TopBar`/`StatusBar`/the tree context menu — PR-15 shipped
 *   the dialog and the handle, and its own brief (`MVP-15.md` §"neither Depends on UI PR was in this tree")
 *   records that the three buttons were never wired because PR-12 did not exist yet. So there is no click path
 *   that creates a note, and scenarios 3 and 4 (rename, move, typed delete of a note that lives in a folder)
 *   need a note to exist.
 *
 * **What they are not.** Not a faster way to skip the UI: every assertion those scenarios make is still made
 * against the rendered tree, and the seams only ever reach the state a scenario starts *from*. If a criterion
 * can be driven by a click, it is driven by a click. `notes.spec.ts`'s at-rest scenario is the one place a
 * request carries the payload under test, because the payload — a body whose ciphertext is read back from the
 * row — has no UI to type it into until PR-13 lands.
 *
 * **Why the request comes from the browser context.** These go out on `page.request`, so the session cookie and
 * the `note_csrf` cookie are the ones the running app just received, and `X-CSRF-Token` is the pair the guard
 * wants (`plugins/csrf.ts`: cookie-to-header double submit). `Origin` is spelled out because Playwright's
 * request context does not add it the way a page's `fetch` would, and the guard reads a missing `Origin` as
 * "not a browser" rather than as "same-origin". Paths come from `ROUTES`, never a literal (§9.2).
 */
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type NoteWithContent,
  ROUTES,
  type TreeResponse,
} from '@note-taker/contracts';
import type { APIResponse, Page } from '@playwright/test';

import { BASE_URL } from './env';

/** What one seam got back: the status the scenario should assert, and the parsed body when there was one. */
export interface SeamResult<T> {
  readonly status: number;
  readonly body: T;
}

type Json = Record<string, unknown>;

async function send<T>(page: Page, method: string, path: string, payload?: Json): Promise<SeamResult<T>> {
  const needsToken = method !== 'GET' && method !== 'HEAD';
  const headers: Record<string, string> = { origin: BASE_URL };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (needsToken) {
    const token = await csrfToken(page);
    // A missing token is a broken fixture, not a 403 to be read as a product failure: say which one it is.
    if (token === undefined) {
      throw new Error(
        `no ${CSRF_COOKIE_NAME} cookie for ${method} ${path} — sign the page in before the seam`,
      );
    }
    headers[CSRF_HEADER_NAME.toLowerCase()] = token;
  }

  const response: APIResponse = await page.request.fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    data: payload === undefined ? undefined : JSON.stringify(payload),
    // `failOnStatusCode` is off by default, and this suite depends on that: a failure is the answer some calls are
    // supposed to get (a blocked delete, a `409` conflict), and a thrown request would hide it.
  });

  const text = await response.text();
  const body = (text === '' ? {} : JSON.parse(text)) as T;
  return { status: response.status(), body };
}

/** The double-submit token, read out of the browser's own jar rather than from a re-implementation of it. */
async function csrfToken(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies(BASE_URL);
  return cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAME)?.value;
}

const CREDENTIALS = { username: 'e2eowner', password: 'E2e-Throwaway-Password-01' } as const;

/**
 * `POST /api/auth/setup` — the first-run bootstrap, in the one case a spec cannot drive it through the form:
 * the file is not the one that demonstrates `/setup`, but it still needs an instance to exist before
 * `POST /api/auth/register` will answer (`auth.service.ts` refuses to register a member with no owner).
 *
 * Returns `created` the first time and `already-setup` afterwards, which is the difference a caller may want to
 * assert on. The 409 is the documented answer of a set-up instance, so it is read as a result here, never as a
 * failure.
 */
export async function setupInstance(page: Page): Promise<'created' | 'already-setup'> {
  const response = await send<Json>(page, 'POST', ROUTES.auth.setup, { ...CREDENTIALS });
  if (response.status === 409) return 'already-setup';
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `POST ${ROUTES.auth.setup} answered ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return 'created';
}

/**
 * `POST /api/auth/register` — one account per spec file, because one user is one tree.
 *
 * Four files sharing the owner would make "the tree is empty" unassertable and would let one file's rename
 * satisfy another file's assertion. Registration is open in the suite only because `ALLOW_REGISTRATION=true`
 * is in `e2e/env.ts`'s `serverEnv()`, with the reason spelled out there.
 */
export async function signUp(page: Page, username: string): Promise<void> {
  const response = await send<Json>(page, 'POST', ROUTES.auth.register, {
    username,
    password: CREDENTIALS.password,
  });
  if (response.status === 403) {
    throw new Error(
      `POST ${ROUTES.auth.register} answered 403: this instance has no owner yet, so ` +
        '`setupInstance()` (or auth.spec.ts, which drives the form) has to run first',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `POST ${ROUTES.auth.register} answered ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

/** The password every e2e account uses — throwaway, on loopback, in a database emptied between files. */
export const E2E_PASSWORD = CREDENTIALS.password;

/** `POST /api/notes`. With no `name` the server generates `new-file-<msepoch>` (§9.2 #16, plan §8). */
export async function createNote(
  page: Page,
  input: { readonly name?: string; readonly folderId?: string | null; readonly content?: string },
): Promise<NoteWithContent> {
  const payload: Json = { folderId: input.folderId ?? null };
  if (input.name !== undefined) payload.name = input.name;
  if (input.content !== undefined) payload.content = input.content;
  const response = await send<NoteWithContent>(page, 'POST', ROUTES.notes, payload);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`POST ${ROUTES.notes} answered ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/**
 * `PUT /api/notes/:id/content` — the versioned write (§9.2 #18). Returned rather than thrown on 409, because
 * scenario 6's conflict assertion needs to see one; scenarios that expect success check `status` themselves.
 */
export async function writeNoteContent(
  page: Page,
  input: { readonly id: string; readonly content: string; readonly baseVersion: number },
): Promise<SeamResult<NoteWithContent>> {
  return await send<NoteWithContent>(page, 'PUT', ROUTES.noteContent(input.id), {
    content: input.content,
    baseVersion: input.baseVersion,
  });
}

/** `GET /api/tree` — the same response the sidebar renders, for the rare moment a scenario needs an id. */
export async function fetchTree(page: Page): Promise<TreeResponse> {
  const response = await send<TreeResponse>(page, 'GET', ROUTES.tree);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GET ${ROUTES.tree} answered ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** `GET /api/notes/:id` — the plaintext the app would have decrypted, for a scenario that must compare both sides. */
export async function readNote(page: Page, id: string): Promise<SeamResult<NoteWithContent>> {
  return await send<NoteWithContent>(page, 'GET', ROUTES.note(id));
}
