/**
 * The route table is shared, so a mistake here is a mistake on both ends at once
 * (docs/plans/mvp/MVP-05.md §7).
 */
import { describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  CSRF_EXEMPT_ROUTES,
  folderDeletePath,
  isCsrfExempt,
  ROUTES,
  searchPath,
} from './routes.js';

/** Every path in the table that is a plain string, i.e. the ones with no id in them. */
const STATIC_PATHS: readonly string[] = [
  ROUTES.health,
  ROUTES.healthz,
  ROUTES.tree,
  ROUTES.users,
  ROUTES.folders,
  ROUTES.notes,
  ROUTES.search,
  ROUTES.settings,
  ROUTES.auth.status,
  ROUTES.auth.setup,
  ROUTES.auth.register,
  ROUTES.auth.login,
  ROUTES.auth.logout,
  ROUTES.auth.logoutAll,
  ROUTES.auth.session,
  ROUTES.auth.password,
];

describe('ROUTES', () => {
  it('puts every single route under /api', () => {
    expect(API_BASE_PATH).toBe('/api');
    for (const path of STATIC_PATHS) {
      expect(path.startsWith(`${API_BASE_PATH}/`), path).toBe(true);
    }
    for (const path of [
      ROUTES.folder('abc'),
      ROUTES.note('abc'),
      ROUTES.noteContent('abc'),
      folderDeletePath('abc', true),
      searchPath('q'),
    ]) {
      expect(path.startsWith(`${API_BASE_PATH}/`), path).toBe(true);
    }
  });

  it('names the two health paths and the hyphenated logout-all exactly as the plan spells them', () => {
    // `healthz` is the stable path the Docker HEALTHCHECK of PR-18 targets.
    expect(ROUTES.health).toBe('/api/health');
    expect(ROUTES.healthz).toBe('/api/healthz');
    expect(ROUTES.auth.logoutAll).toBe('/api/auth/logout-all');
    expect(ROUTES.auth.status).toBe('/api/auth/status');
    expect(ROUTES.folders).toBe('/api/folders');
    expect(ROUTES.notes).toBe('/api/notes');
    expect(ROUTES.settings).toBe('/api/settings');
    expect(ROUTES.tree).toBe('/api/tree');
    expect(ROUTES.users).toBe('/api/users');
  });

  it('has no duplicates', () => {
    expect(new Set(STATIC_PATHS).size).toBe(STATIC_PATHS.length);
  });

  it('builds the parameterised paths, URL-encoding the id', () => {
    expect(ROUTES.note('3f2504e0-4f89-41d3-9a0c-03253d952394')).toBe(
      '/api/notes/3f2504e0-4f89-41d3-9a0c-03253d952394',
    );
    expect(ROUTES.noteContent('abc')).toBe('/api/notes/abc/content');
    expect(ROUTES.folder('abc')).toBe('/api/folders/abc');
    // An id that reaches the path builder is a uuid, but a path builder that could be tricked into
    // traversing would be a bug worth refusing outright.
    expect(ROUTES.note('../evil')).toBe('/api/notes/..%2Fevil');
  });
});

describe('folderDeletePath', () => {
  it('spells the flag only when it is set, so the safe default is the shape of a hand-written request', () => {
    expect(folderDeletePath('abc', false)).toBe('/api/folders/abc');
    expect(folderDeletePath('abc', true)).toBe('/api/folders/abc?cascade=true');
  });
});

describe('searchPath', () => {
  it('always sends q, and only sends limit when the caller asks for one', () => {
    expect(searchPath('plan')).toBe('/api/search?q=plan');
    expect(searchPath('plan', 5)).toBe('/api/search?q=plan&limit=5');
  });

  it('encodes what it embeds, so a query cannot invent parameters', () => {
    expect(searchPath('a&b=c')).toBe('/api/search?q=a%26b%3Dc');
    expect(searchPath('  spaced  ')).toBe('/api/search?q=%20%20spaced%20%20');
  });
});

describe('isCsrfExempt', () => {
  it('is exactly the three login-family mutations of plan §9.3', () => {
    expect(CSRF_EXEMPT_ROUTES).toEqual([ROUTES.auth.setup, ROUTES.auth.register, ROUTES.auth.login]);
    for (const path of CSRF_EXEMPT_ROUTES) {
      expect(isCsrfExempt(path), path).toBe(true);
    }
  });

  it('does not exempt anything that already has a session', () => {
    for (const path of [ROUTES.auth.status, ROUTES.auth.logout, ROUTES.notes, ROUTES.settings]) {
      expect(isCsrfExempt(path), path).toBe(false);
    }
  });

  it('looks at the path, not the query string', () => {
    expect(isCsrfExempt(`${ROUTES.auth.login}?redirect=1`)).toBe(true);
    expect(isCsrfExempt(`${ROUTES.settings}?cascade=true`)).toBe(false);
  });
});
