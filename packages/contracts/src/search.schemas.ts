/**
 * Search (docs/plans/mvp/MVP-05.md §7, plan §9.2 #21).
 *
 * `GET /api/search?q=&limit=` answers name matches from SQL and body matches after decryption, capped
 * at 500 candidate notes server-side; the **response** is capped at 25 results, which is what the
 * `limit` parameter can ask for and what the response schema promises.
 */
import { z } from 'zod';

import { noteIdSchema } from './notes.schemas.js';

/** The most results the API returns, and the most `limit` accepts (§9.2 #21). */
export const SEARCH_RESULT_MAX = 25;

/** How long a query may be: a whole sentence, not an essay (a search box is not an editor). */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * The query string. `q` is required and never blank — an empty search is a UI state ("nothing typed
 * yet"), not a request — and both fields arrive as strings, hence `z.coerce` on `limit`.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(SEARCH_RESULT_MAX).default(SEARCH_RESULT_MAX),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * One hit. `folderPath` is the display path of the note's folder, `/`-joined and **empty for a note
 * at the root**, which is what lets the search UI render a breadcrumb without a second request.
 * `snippet` is a window around the first match in the decrypted body, and is empty for a name-only
 * match; `score` orders the list, higher first.
 */
export const searchResultSchema = z.object({
  noteId: noteIdSchema,
  /** The stored, extension-free name; `withMd()` renders it. */
  name: z.string().min(1),
  folderPath: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/** `200` of `GET /api/search`; the cap here is what makes `limit` a promise rather than a suggestion. */
export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema).max(SEARCH_RESULT_MAX),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
