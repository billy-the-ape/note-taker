/**
 * The change-password form (docs/plans/mvp/MVP-16.md §5, `docs/API.md` #9),
 * `data-testid="change-password-form"`.
 *
 * Two rules about where errors come from:
 *
 * * **The policy is checked twice, on purpose.** The contracts schema (`changePasswordSchema`: the
 *   new secret is ≥ 10 characters, ≤ 512 bytes, and not the current one) is run client-side so a
 *   typo does not cost a round trip, and the same schema runs on the server, whose answer is what
 *   actually renders. Client-side validation is a convenience, never the authority: PR-07 adds an
 *   issue the client *cannot* compute (plan §10's "not equal to the username", where the username
 *   comes from the session), and that one has to render too.
 * * **The server's `401` is the wrong-current-password answer.** It arrives as an `ApiError` with
 *   `code: 'UNAUTHORIZED'` and the message `the current password is not right`, and this form shows
 *   it inline against the field rather than reacting to it. Nothing here logs the person out,
 *   re-authenticates, or navigates — see `credential-mutations.ts` for why that would be wrong.
 *
 * A `204` clears both fields (the DOM should not keep holding a credential that is now invalid) and
 * says what happened, because "your other devices were signed out" is not something to guess.
 */

import { changePasswordSchema } from '@note-taker/contracts';
import { useState } from 'react';

import { ApiError } from '../../../lib/api.js';
import { useChangePassword } from '../credential-mutations.js';
import { FormSection, PendingNote } from './form-section.js';

const FIELD_ERROR_IDS = {
  currentPassword: 'change-password-current-error',
  newPassword: 'change-password-new-error',
} as const;

type FieldName = keyof typeof FIELD_ERROR_IDS;

const EMPTY_ERRORS: Record<FieldName, string | undefined> = {
  currentPassword: undefined,
  newPassword: undefined,
};

/** A field the response blamed, or `undefined` when the envelope said something general. */
function fieldOf(path: string): FieldName | undefined {
  if (path === 'currentPassword' || path === 'current_password') return 'currentPassword';
  if (path === 'newPassword' || path === 'new_password') return 'newPassword';
  return undefined;
}

/** Splits a failed `POST /api/auth/password` into "under this field" and "under the form". */
function serverErrors(error: Error | null): {
  fields: Record<FieldName, string | undefined>;
  general: string | undefined;
} {
  const fields: Record<FieldName, string | undefined> = { ...EMPTY_ERRORS };
  if (error === null) return { fields, general: undefined };
  if (!(error instanceof ApiError)) return { fields, general: error.message };

  let general: string | undefined;
  for (const detail of error.details ?? []) {
    const field = fieldOf(detail.path);
    if (field === undefined) continue;
    fields[field] = fields[field] === undefined ? detail.message : `${fields[field]}, ${detail.message}`;
  }
  // The wrong-current-password `401` (docs/API.md #9) carries no `details` at all: the message *is*
  // the answer, and it belongs on the form rather than silently on one input.
  if (fields.currentPassword === undefined && fields.newPassword === undefined) {
    general = error.message;
  }
  return { fields, general };
}

export function ChangePasswordForm(): React.JSX.Element {
  const mutation = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [localErrors, setFieldErrors] = useState<Record<FieldName, string | undefined>>(EMPTY_ERRORS);

  // Local issues show while a submit is being rejected client-side; once the server has answered,
  // its verdict replaces them, because the server is the authority on its own password policy.
  const failure = mutation.error === null ? undefined : serverErrors(mutation.error);
  const fieldErrors = failure === undefined ? localErrors : { ...localErrors, ...failure.fields };
  const generalError =
    failure === undefined || mutation.error === null
      ? undefined
      : (failure.general ?? (mutation.error instanceof Error ? mutation.error.message : undefined));

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const body = { currentPassword, newPassword };
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      const next: Record<FieldName, string | undefined> = { ...EMPTY_ERRORS };
      for (const issue of parsed.error.issues) {
        const path = issue.path[0];
        if (path === 'currentPassword' || path === 'newPassword') {
          next[path] = next[path] === undefined ? issue.message : `${next[path]}, ${issue.message}`;
        }
      }
      setFieldErrors(next);
      mutation.reset();
      return;
    }

    setFieldErrors(EMPTY_ERRORS);
    mutation.mutate(body, {
      onSuccess: () => {
        setCurrentPassword('');
        setNewPassword('');
      },
    });
  }

  return (
    <FormSection
      title="Change password"
      description="Your password is rotated, this device stays signed in, and every other device is signed out the moment it asks for anything."
    >
      <form data-testid="change-password-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex max-w-sm flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm" htmlFor="change-password-current">
            Current password
            <input
              id="change-password-current"
              data-testid="change-password-current"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
              aria-invalid={fieldErrors.currentPassword !== undefined}
              aria-describedby={
                fieldErrors.currentPassword === undefined ? undefined : FIELD_ERROR_IDS.currentPassword
              }
              className="rounded-md border border-ink/20 bg-paper px-3 py-1.5"
            />
          </label>
          {fieldErrors.currentPassword === undefined ? null : (
            <p data-testid={FIELD_ERROR_IDS.currentPassword} className="text-sm text-red-700">
              {fieldErrors.currentPassword}
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm" htmlFor="change-password-new">
            New password
            <input
              id="change-password-new"
              data-testid="change-password-new"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
              aria-invalid={fieldErrors.newPassword !== undefined}
              aria-describedby={
                fieldErrors.newPassword === undefined ? undefined : FIELD_ERROR_IDS.newPassword
              }
              className="rounded-md border border-ink/20 bg-paper px-3 py-1.5"
            />
          </label>
          {fieldErrors.newPassword === undefined ? null : (
            <p data-testid={FIELD_ERROR_IDS.newPassword} className="text-sm text-red-700">
              {fieldErrors.newPassword}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="change-password-submit"
            disabled={mutation.isPending}
            className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Update password
          </button>
          {mutation.isPending ? <PendingNote label="Updating…" /> : null}
        </div>

        {generalError === undefined ? null : (
          <p aria-live="assertive" data-testid="change-password-error" className="text-sm text-red-700">
            {generalError}
          </p>
        )}
        {mutation.isSuccess ? (
          <p aria-live="polite" data-testid="change-password-success" className="text-sm text-brand">
            Password updated. This device stays signed in; every other device will be asked to sign in again
            the next time it asks for anything.
          </p>
        ) : null}
      </form>
    </FormSection>
  );
}
