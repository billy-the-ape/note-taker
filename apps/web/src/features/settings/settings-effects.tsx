/**
 * The app-wide half of PR-16: read the settings row once, and make `<html>` match it.
 *
 * `routes/__root.tsx` mounts this (PR-12 will move it into the app shell's layout route, which is the
 * other file that will want to own it). It renders nothing on purpose — the only thing it "outputs"
 * is a class on the document element, and a component that renders `<div/>` for that would put an
 * empty box in every layout that mounts it.
 *
 * A signed-out visitor is part of the contract, not an edge case: `GET /api/settings` answers `401`
 * there, the query holds no row, `useSettingsTheme()` falls back to `system`, and the page follows
 * the operating system — which is exactly what PR-08's `prefers-color-scheme` default did before
 * there was a signed-in user to remember a preference for. No error UI lives here; the screen that
 * can *do* something about a failed read is `/app/settings`.
 */
import { useThemeSync } from './theme.js';

export function SettingsEffects(): null {
  useThemeSync();
  return null;
}
