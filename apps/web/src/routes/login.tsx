import { createFileRoute, Link } from '@tanstack/react-router';

import { CredentialsForm } from '../components/auth/CredentialsForm';
import { FormMessage } from '../components/ui/Field';
import { useSession } from '../features/auth/useSession';

/**
 * `/login` — the only page an unauthenticated visitor is allowed to stay on
 * (docs/plans/mvp/MVP-08.md §4, §6).
 *
 * The route file is five lines because there is nothing here to design: the guard already decided who
 * may see it (`features/auth/session.tsx`), and the form is the shared one. What is *not* shared is the
 * footer link below.
 *
 * No guard of its own: the root's `beforeLoad` owns the whole table, and a second copy here is the
 * "guards per page" the brief rules out.
 */
export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { snapshot, bootFailed } = useSession();

  // The visible half of PR-07's `403 SELF_SIGNUP_CLOSED`/`SETUP_FIRST` pair (§4): the link is offered
  // only when the route behind it would answer. `!needsSetup` is what stops a fresh install — where
  // `ALLOW_REGISTRATION=true` makes `registrationOpen` true all by itself — from advertising a form
  // whose only possible answer is "the owner account does not exist yet".
  const signUpOpen = snapshot.registrationOpen && !snapshot.needsSetup;

  return (
    <>
      <CredentialsForm
        mode="login"
        heading="Sign in"
        description="Your notes live on this machine and nowhere else."
        submitLabel="Sign in"
        footer={
          signUpOpen ? (
            <Link to="/signup" className="text-brand hover:underline" data-testid="signup-link">
              Create an account
            </Link>
          ) : undefined
        }
      />

      {bootFailed ? (
        <FormMessage tone="info" testId="login-boot-failed">
          The API is not answering, so this page cannot know whether the instance is set up yet. Check that
          the server is running before blaming the password.
        </FormMessage>
      ) : null}
    </>
  );
}
