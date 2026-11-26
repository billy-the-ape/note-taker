/**
 * The bar across the top of the app (docs/plans/mvp/MVP-12.md §4).
 *
 * Three things live here, and each is here for a reason: the **brand**, which is the only link that means
 * "the top of the tree" and is how a person on a deep link gets out of it; the **theme**, which PR-08 put in
 * the root chrome and PR-16 moves into settings without changing this line; and the **sign-out**, which is the
 * one control that has to be reachable from anywhere in the app because the reason people reach for it is that
 * something has gone wrong.
 *
 * The sign-out is PR-08's `signOut()` on purpose: that call owns the whole transition — `POST
 * /api/auth/logout`, then `queryClient.clear()`, then the route — so a sidebar cannot end up showing notes to
 * a person whose cookie is already gone. Its `data-testid="sign-out"` is the one selector PR-08 established on
 * `/welcome` and PR-19's e2e suite keeps using: the criterion it proves ("logout really ended the session") is
 * the same criterion, only one route deeper.
 *
 * PR-17's search box goes in the middle of this bar. It is not here now because a disabled input that does
 * nothing is a promise the app cannot keep, and §7 puts search in PR-17.
 */

import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { failureMessage } from '../../features/auth/auth.api';
import { useSession } from '../../features/auth/useSession';
import { Button } from '../ui/Button';
import { FormMessage } from '../ui/Field';
import { useToast } from '../ui/Toast';
import { ThemeToggle } from './ThemeToggle';

export function TopBar() {
  const { user, signOut } = useSession();
  const { toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  async function onSignOut(): Promise<void> {
    setSigningOut(true);
    setFailure(undefined);
    try {
      await signOut();
    } catch (error) {
      // The context owns the transition, so a failure here means the session is still alive: say so in both
      // places PR-08 established, next to the button that caused it and in the toast that outlives a scroll.
      const message = failureMessage(error);
      setFailure(message);
      toast({ title: 'Could not sign out', description: message, tone: 'error' });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header
      className="flex h-12 items-center gap-3 border-b border-line bg-surface px-3"
      data-testid="topbar"
    >
      <Link
        to="/app"
        className="rounded-md px-1 text-sm font-semibold tracking-wide text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        data-testid="brand-link"
      >
        Note Taker
      </Link>
      <span className="flex-1" />
      {user === null ? (
        // The guard should not allow this state, but the bar renders during the moment between the logout
        // response and the route changing under it, and a header that throws there is a white page.
        <span className="text-sm text-ink-muted" data-testid="topbar-user">
          signed out
        </span>
      ) : (
        <span className="truncate text-sm text-ink-muted" data-testid="topbar-user">
          {user.username}
        </span>
      )}
      <ThemeToggle />
      <Button variant="ghost" size="sm" onClick={onSignOut} loading={signingOut} data-testid="sign-out">
        Sign out
      </Button>
      {failure === undefined ? null : (
        <span className="max-w-64 truncate">
          {/* PR-08 put this message on `/welcome` and PR-19 selects it by that id; the control moved into the
              bar, the id did not. */}
          <FormMessage tone="error" testId="sign-out-error">
            {failure}
          </FormMessage>
        </span>
      )}
    </header>
  );
}
