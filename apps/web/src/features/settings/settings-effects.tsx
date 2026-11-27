/**
 * The app-wide half of PR-16: read the settings row once, and make `<html>` match it.
 *
 * `routes/app/route.tsx` mounts this — PR-12's layout route, which is the file that owns everything
 * authed, and the home this effect was always meant to have (PR-16 wrote it against the root while
 * PR-12 was still open). It renders nothing on purpose — the only thing it "outputs" is a class on
 * the document element, and a component that renders `<div/>` for that would put an empty box in
 * every layout that mounts it.
 *
 * Being under `/app` is also the honest scope: a signed-out visitor has no settings row to follow,
 * and the two ways that used to be true of this component now behave the same way. Mount it in the
 * root anyway and `GET /api/settings` answers `401` on every anonymous page load, the query holds no
 * row, `useSettingsTheme()` falls back to `system`, and the page follows the operating system — which
 * is what the media query in `styles/globals.css` would have done regardless, so the request bought
 * nothing. PR-08's per-browser knob (`components/layout/ThemeToggle.tsx`) stays the control for those
 * pages, and its `data-theme` attribute outranks this class when it states a choice — see the
 * precedence note in `styles/globals.css`. No error UI lives here; the screen that can *do* something
 * about a failed read is `/app/settings`.
 */
import { useThemeSync } from './theme.js';

export function SettingsEffects(): null {
  useThemeSync();
  return null;
}
