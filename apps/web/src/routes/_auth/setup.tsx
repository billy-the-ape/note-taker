import { createFileRoute } from '@tanstack/react-router';

import { CredentialsForm } from '../../components/auth/CredentialsForm';

/**
 * `/setup` — first-run account creation, shown only while `needsSetup` (docs/plans/mvp/MVP-08.md §4).
 *
 * The form is the shared one; what belongs to this page is the promise in the copy. `POST
 * /api/auth/setup` creates the single `owner` and answers `409 SETUP_ALREADY_DONE` afterwards (PR-07),
 * so this page is a one-time door — which is also why the guard pulls it away the moment the owner
 * exists rather than leaving a form here whose every submit is an error.
 *
 * No `POST /api/auth/register` here: a fresh install has no member to register *into*. The status
 * payload's `registrationOpen` is `true` in exactly that state whenever the operator set
 * `ALLOW_REGISTRATION=true`, and treating that as an invitation to offer sign-up is the dead end §4
 * exists to close.
 */
export const Route = createFileRoute('/_auth/setup')({
  component: SetupPage,
});

function SetupPage() {
  return (
    <CredentialsForm
      mode="setup"
      heading="Create the owner account"
      description="This instance has no accounts yet. The first one is the owner — there is only ever one, and it cannot sign anyone else up unless ALLOW_REGISTRATION is set."
      submitLabel="Create owner account"
    />
  );
}
