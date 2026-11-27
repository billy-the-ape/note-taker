/**
 * The `/app/settings` route (docs/plans/mvp/MVP-16.md).
 *
 * The file is the route; the screen lives in `features/settings/settings-page.tsx`, both because
 * that is where its hooks, mutations and components live and because the component is what the unit
 * tests render directly — a route file has no props to hand a fake `ApiClient` to.
 *
 * There is no `beforeLoad` guard here. PR-12 owns `routes/app/route.tsx`, the layout route that
 * guards everything under `/app` by reading the session context, and a guard written here would be a
 * second, weaker copy of it (MVP-08 §4: guards live in the layout's `beforeLoad`, never per page).
 */
import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '../../features/settings/settings-page.js';

export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
});
