import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { FormMessage } from '../components/ui/Field';
import { useToast } from '../components/ui/Toast';
import { failureMessage } from '../features/auth/auth.api';
import { useSession } from '../features/auth/useSession';

/**
 * `/welcome` — the signed-in placeholder home, and the destination of every successful sign-in
 * (docs/plans/mvp/MVP-08.md §4).
 *
 * It exists so PR-08 is testable end to end: "a successful login lands on `/app`" cannot be asserted
 * before PR-12 builds `/app`, so the authed landing is this page, and PR-12 deletes it and repoints
 * every redirect. That is the whole reason a page this empty ships — the alternative is a landing URL
 * that 404s until five PRs land.
 *
 * The sign-out control is not decoration either: it is how the suite (and PR-19's e2e run, which
 * selects it by `data-testid="sign-out"`) proves that `POST /api/auth/logout` really did end the
 * session rather than merely losing the cookie.
 */
export const Route = createFileRoute('/welcome')({
  component: WelcomePage,
});

/** `owner` / `member` as the words a person reads, not the enum they store. */
function roleLabel(role: 'owner' | 'member'): string {
  return role === 'owner' ? 'the owner' : 'a member';
}

function WelcomePage() {
  const { user, signOut } = useSession();
  const { toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  async function onSignOut() {
    setSigningOut(true);
    setFailure(undefined);
    try {
      // The context owns the whole transition — request, cache, route — because a sign-out that
      // cleared the screen but left the cookie valid would be worse than one that failed loudly.
      await signOut();
    } catch (error) {
      const message = failureMessage(error);
      setFailure(message);
      toast({ title: 'Could not sign out', description: message, tone: 'error' });
    } finally {
      setSigningOut(false);
    }
  }

  // The guard will not let an anonymous visitor reach this page, so there is no signed-out state to
  // render — only the instant between `logout` answering and the route changing under us.
  if (user === null) return null;

  return (
    <section className="flex flex-col gap-4" data-testid="welcome">
      <h1 className="text-2xl font-semibold text-ink">Welcome, {user.username}</h1>
      <p className="text-ink-muted">
        You are signed in as {roleLabel(user.role)} of this instance. Everything you write stays on this
        machine, encrypted with a key that never leaves it.
      </p>
      <p className="text-sm text-ink-muted">
        The notes screen is not built yet — this placeholder is where signing in lands until it is.
      </p>

      {failure === undefined ? null : <FormMessage testId="sign-out-error">{failure}</FormMessage>}

      <div>
        <Button
          variant="secondary"
          onClick={onSignOut}
          loading={signingOut}
          data-testid="sign-out"
          className="self-start"
        >
          Sign out
        </Button>
      </div>
    </section>
  );
}
