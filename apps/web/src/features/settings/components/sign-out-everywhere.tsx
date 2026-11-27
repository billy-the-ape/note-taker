/**
 * "Sign out everywhere" (docs/plans/mvp/MVP-16.md §5, `docs/API.md` #7),
 * `data-testid="sign-out-everywhere"`.
 *
 * One click, no confirmation dialog. It is destructive in the sense that every other device has to
 * sign in again, and recoverable in the sense that this device stays signed in until the request
 * answers — and PR-08 owns the dialog kit that would make a real confirmation worth adding. What the
 * copy promises is exactly what §9.2 #7 does: this device too, and every other one the moment it
 * asks for anything.
 */
import { useSignOutEverywhere } from '../credential-mutations.js';
import { FormSection, PendingNote } from './form-section.js';

export function SignOutEverywhere(): React.JSX.Element {
  const mutation = useSignOutEverywhere();

  return (
    <FormSection
      title="Sign out everywhere"
      description="Deletes every session belonging to you, including this one. The other tabs will not know until they ask for something."
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="sign-out-everywhere"
          disabled={mutation.isPending}
          onClick={() => {
            mutation.mutate();
          }}
          className="rounded-md border border-red-700/40 px-4 py-1.5 text-sm font-medium text-red-700 disabled:opacity-60"
        >
          Sign out everywhere
        </button>
        {mutation.isPending ? <PendingNote label="Signing out…" /> : null}
      </div>
      {mutation.error === null ? null : (
        <p aria-live="assertive" data-testid="sign-out-everywhere-error" className="text-sm text-red-700">
          {mutation.error.message}
        </p>
      )}
    </FormSection>
  );
}
