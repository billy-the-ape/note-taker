/**
 * The route table (docs/plans/mvp/MVP-05.md §7, plan §9.2).
 *
 * Every path in the API, as a constant, so the client and the server cannot drift: PR-09…PR-17
 * register handlers at `ROUTES.notes` and call them with the same object. A literal `'/api/notes'`
 * in an app is a bug waiting for the next rename.
 *
 * Paths that take an id are functions, because the value that gets URL-embedded has to be encoded by
 * whoever knows its type — and because a typo in `'/api/notes/' + id + '/content'` is exactly the
 * class of mistake a constant table exists to prevent.
 */

/** Every route lives under this prefix; the SPA dev proxy (`/api` → the API process) depends on it. */
export const API_BASE_PATH = '/api';

const AUTH = `${API_BASE_PATH}/auth`;
const FOLDERS = `${API_BASE_PATH}/folders`;
const NOTES = `${API_BASE_PATH}/notes`;
const USERS = `${API_BASE_PATH}/users`;

export const ROUTES = {
  /** Liveness probe, plus `healthz` as the stable path the Docker `HEALTHCHECK` of PR-18 targets. */
  health: `${API_BASE_PATH}/health`,
  healthz: `${API_BASE_PATH}/healthz`,

  auth: {
    /** Also (re-)issues the `note_csrf` cookie (PR-07), which is why the client may refetch it only once per `403`. */
    status: `${AUTH}/status`,
    /** First-run bootstrap that creates the single `owner`. */
    setup: `${AUTH}/setup`,
    /** Public self-sign-up; only when `ALLOW_REGISTRATION` and an owner already exists. */
    register: `${AUTH}/register`,
    login: `${AUTH}/login`,
    logout: `${AUTH}/logout`,
    /** "Sign out everywhere": every session row of the current user. */
    logoutAll: `${AUTH}/logout-all`,
    session: `${AUTH}/session`,
    /** Rotates the password and deletes every other session. */
    password: `${AUTH}/password`,
  },

  /** Owner-created accounts (always `member`) and the minimal admin list. */
  users: USERS,

  /** The whole tree as metadata, in one request. */
  tree: `${API_BASE_PATH}/tree`,

  folders: FOLDERS,
  folder: (id: string) => `${FOLDERS}/${encodeURIComponent(id)}`,

  notes: NOTES,
  note: (id: string) => `${NOTES}/${encodeURIComponent(id)}`,
  /** The versioned content write (§9.2 #18): `PUT` with `{content, baseVersion}`. */
  noteContent: (id: string) => `${NOTES}/${encodeURIComponent(id)}/content`,

  search: `${API_BASE_PATH}/search`,
  settings: `${API_BASE_PATH}/settings`,
} as const;

/**
 * The three mutations that never carry `X-CSRF-Token` (§9.3): they have no session and, on a first
 * visit, no `note_csrf` cookie either, so they are guarded by the `Origin`/`Sec-Fetch-Site` check
 * instead. PR-07's guard reads this list; the client sends the header anyway where it has a token.
 */
export const CSRF_EXEMPT_ROUTES: readonly string[] = [
  ROUTES.auth.setup,
  ROUTES.auth.register,
  ROUTES.auth.login,
];

/** Whether a request path is exempt from the CSRF header. Ignores any query string. */
export function isCsrfExempt(path: string): boolean {
  const queryStart = path.indexOf('?');
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  return CSRF_EXEMPT_ROUTES.includes(pathname);
}

/**
 * `DELETE /api/folders/:id` (§9.2 #15). The `cascade` flag is only spelled out when it is `true`, so
 * the safe default is what a hand-written request looks like: no query, no cascade.
 */
export function folderDeletePath(id: string, cascade: boolean): string {
  const path = ROUTES.folder(id);
  return cascade ? `${path}?cascade=true` : path;
}

/** `GET /api/search?q=…&limit=…` (§9.2 #21). `limit` is omitted when the caller wants the default. */
export function searchPath(query: string, limit?: number): string {
  const search = `q=${encodeURIComponent(query)}`;
  return limit === undefined
    ? `${ROUTES.search}?${search}`
    : `${ROUTES.search}?${search}&limit=${encodeURIComponent(String(limit))}`;
}
