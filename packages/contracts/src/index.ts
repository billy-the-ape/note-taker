/**
 * `@note-taker/contracts` — every payload shared by the client and the server
 * (docs/plans/mvp/MVP-05.md).
 *
 * Import from this barrel only: `import { createNoteSchema, ROUTES } from '@note-taker/contracts'`.
 * The package resolves through `package.json#exports`, i.e. from `dist`, in the API, in the SPA, in
 * `tsc` and in the production image — there is no source alias anywhere, so `pnpm build:packages`
 * runs before anything typechecks or tests an app.
 */
export * from './api-envelope.js';
export * from './auth.schemas.js';
export * from './folders.schemas.js';
export * from './names.js';
export * from './notes.schemas.js';
export * from './routes.js';
export * from './search.schemas.js';
export * from './settings.schemas.js';
export * from './tree.schemas.js';
