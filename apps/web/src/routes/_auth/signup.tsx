import { createFileRoute, Link } from '@tanstack/react-router';

import { CredentialsForm } from '../../components/auth/CredentialsForm';

/**
 * `/signup` — self-sign-up for a `member`, driven by `POST /api/auth/register`
 * (docs/plans/mvp/MVP-08.md §4). This is the route that closes the loop PR-07 opens: the server has
 * the endpoint and the two guards, and this is the UI that reaches them.
 *
 * The page renders only when `registrationOpen && !needsSetup`, and that is enforced upstream (the
 * guard redirects a direct visit to `/setup` on a fresh install and to `/login` when the flag is
 * off), so there is no "sign-up is closed" panel to draw here. What *would* be a lie is a form that
 * looks available and then explains itself after the submit — the whole point of the redirect is that
 * the person never types a password into a form that can only answer `403 SELF_SIGNUP_CLOSED`.
 *
 * It is a `member`, never an `owner`: role promotion is an operator act in the MVP (PR-07 §2), and
 * there is deliberately no control here that looks like one.
 */
export const Route = createFileRoute('/_auth/signup')({
  component: SignUpPage,
});

function SignUpPage() {
  return (
    <CredentialsForm
      mode="signup"
      heading="Create an account"
      description="Self-sign-up is open on this instance. The account you create is a member: it can take its own notes, and nobody else's."
      submitLabel="Create account"
      footer={
        <Link to="/login" className="text-brand hover:underline" data-testid="login-link">
          Already have an account? Sign in
        </Link>
      }
    />
  );
}
