import type { SessionUser } from '@note-taker/contracts';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useId, useState } from 'react';

import {
  type CredentialField,
  type Credentials,
  type FieldErrors,
  failureMessage,
  fieldErrorsFromDetails,
  login as postLogin,
  registerAccount,
  retryAfterNotice,
  setupAccount,
  validateCredentials,
  validateLogin,
} from '../../features/auth/auth.api';
import { useSession } from '../../features/auth/useSession';
import { ApiError } from '../../lib/api';
import { Button } from '../ui/Button';
import { describeBy, Field, FormMessage } from '../ui/Field';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

/**
 * The one credentials form: `/login`, `/setup` and `/signup` are this component with different words
 * and a different endpoint (docs/plans/mvp/MVP-08.md §4, §6).
 *
 * One component because they are one problem. All three take a username and a password, all three must
 * survive an answer that is not a `2xx` without clearing what the person typed, all three render field
 * errors from `details[]` and a form-level message from `message`, and all three must keep the button
 * disabled until the request has an outcome. Written three times that is three chances for one of them
 * to lose its `autoComplete`.
 *
 * Four behaviours are load-bearing rather than incidental:
 *
 * * **The typed password survives a failure.** A `401` should cost a click, not the password somebody
 *   had to look up; the fields are ordinary controlled inputs and nothing here clears them on error.
 *   Only the username is normalised (trimmed) on the way out, because `usernameSchema` is `trim()`ed
 *   server-side too.
 * * **Validation is the shared schema** (`validateCredentials`), not a hand-listed rule set, so the
 *   browser enforces `@note-taker/contracts` and cannot drift from the server enforcing the same object.
 *   It is a courtesy, not a gate: the server still decides, and a `400 VALIDATION`'s `details[]` render
 *   through the same path as the client-side errors.
 * * **A failure is announced twice** — inline, because that is where the eyes already are, and as a
 *   toast, because the brief asks failed mutations to be toastable and a form scrolled out of view is
 *   not an announcement.
 * * **`autoComplete` is right**, per field, per mode (docs/plans/mvp/MVP-08.md §6).
 */
export type CredentialsFormMode = 'login' | 'setup' | 'signup';

/**
 * The three endpoints, keyed by the mode that calls them. A `Record` rather than a `switch` so adding a
 * fourth mode is a type error until it says which route it hits.
 */
const SUBMIT: Record<CredentialsFormMode, (credentials: Credentials) => Promise<SessionUser>> = {
  login: postLogin,
  setup: setupAccount,
  signup: registerAccount,
};

/** The order a refused submit walks the form in: top to bottom, as the eyes do. */
const FIELD_ORDER: readonly CredentialField[] = ['username', 'password', 'confirmPassword'];

/** Which box to focus when the browser refused to send the form at all. `undefined` means it was valid. */
export function firstInvalidField(errors: FieldErrors): CredentialField | undefined {
  return FIELD_ORDER.find((field) => errors[field] !== undefined);
}

export interface CredentialsFormProps {
  readonly mode: CredentialsFormMode;
  readonly heading: string;
  readonly description?: ReactNode | undefined;
  readonly submitLabel: string;
  /**
   * Under the button: the `/login` → `/signup` link, which only the route knows whether it is legal.
   * `| undefined` because a route's condition is an expression, and `exactOptionalPropertyTypes` would
   * otherwise make it write the JSX twice.
   */
  readonly footer?: ReactNode | undefined;
}

export function CredentialsForm({ mode, heading, description, submitLabel, footer }: CredentialsFormProps) {
  // `useId`, not a constant: a label that matches two inputs labels neither, and this form is on the
  // page twice as soon as a dialog reuses it.
  const fieldId = useId();
  const ids: Record<CredentialField, string> = {
    username: `${fieldId}-username`,
    password: `${fieldId}-password`,
    confirmPassword: `${fieldId}-confirm`,
  };

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | undefined>(undefined);
  const [retryNotice, setRetryNotice] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const { setUser, refreshStatus } = useSession();
  const navigate = useNavigate();
  const { toast } = useToast();
  const isLogin = mode === 'login';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const draft = { username, password, confirmPassword: isLogin ? undefined : confirmPassword };
    const errors = isLogin ? validateLogin(draft) : validateCredentials(draft);
    setFieldErrors(errors);
    // A new attempt clears the last answer, so a stale "wrong username or password" cannot sit above a
    // form that has since been fixed, and an expired `Retry-After` cannot keep accusing.
    setFormMessage(undefined);
    setRetryNotice(undefined);
    if (Object.keys(errors).length > 0) {
      const field = firstInvalidField(errors);
      if (field !== undefined) document.getElementById(ids[field])?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const user = await SUBMIT[mode]({ username: username.trim(), password });
      // These three responses all set the session cookie, so this is the one moment the SPA learns it is
      // signed in. The guard that runs on the navigation below then reads this cache entry rather than a
      // stale `{user: null}`, and a refresh still re-reads the row from §9.2 #8.
      setUser(user);
      if (mode === 'setup') {
        // The install stopped being new the moment that call returned, and the cache has not heard:
        // `needsSetup` is 30 s fresh (`staleTime` in `lib/queryClient.ts`) and `guardNavigation` reads the
        // entry through `ensureQueryData`, which answers a fresh entry rather than re-asking. Left alone,
        // the owner this form just created could stay on `/setup` — §4's row is `needsSetup ? ALLOW :
        // home`, and every submit there is now `409 SETUP_ALREADY_DONE` — and a later `401` would be
        // routed to that same page by `SessionProvider`. Re-reading costs one `GET` and learns
        // `registrationOpen` from the server instead of guessing what the other boolean did.
        //
        // A failed re-read is not a failed setup. The owner exists whatever the API answers next, so the
        // error is swallowed here rather than announced above a form that worked; the next navigation
        // asks again.
        await refreshStatus().catch(() => undefined);
      }
      await navigate({ to: '/app', replace: true });
    } catch (error) {
      const serverFields = error instanceof ApiError ? fieldErrorsFromDetails(error.details) : {};
      setFieldErrors((current) => ({ ...current, ...serverFields }));
      const message = failureMessage(error);
      setFormMessage(message);
      setRetryNotice(retryAfterNotice(error));
      toast({ title: `${heading} failed`, description: message, tone: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-semibold text-ink">{heading}</h1>
      {description ? <p className="mt-1 text-ink-muted">{description}</p> : null}

      <form className="mt-6 flex flex-col gap-4" onSubmit={submit} data-testid={`${mode}-form`} noValidate>
        <Field
          label="Username"
          htmlFor={ids.username}
          error={fieldErrors.username}
          hint={isLogin ? undefined : '3–32 characters: letters, numbers, and `.` `-` `_`.'}
        >
          <Input
            id={ids.username}
            name="username"
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            invalid={fieldErrors.username !== undefined}
            aria-describedby={describeBy(ids.username, {
              error: fieldErrors.username !== undefined,
              hint: !isLogin && fieldErrors.username === undefined,
            })}
            disabled={submitting}
            data-testid={`${mode}-username`}
          />
        </Field>

        <Field
          label="Password"
          htmlFor={ids.password}
          error={fieldErrors.password}
          hint={isLogin ? undefined : 'At least 10 characters, and not your username.'}
        >
          <Input
            id={ids.password}
            name="password"
            type="password"
            value={password}
            // `current-password` tells the manager to fill the secret it has; `new-password` tells it to
            // offer a generated one. Backwards, and the sign-in page fights the user's own tooling.
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            onChange={(event) => setPassword(event.target.value)}
            invalid={fieldErrors.password !== undefined}
            aria-describedby={describeBy(ids.password, {
              error: fieldErrors.password !== undefined,
              hint: !isLogin && fieldErrors.password === undefined,
            })}
            disabled={submitting}
            data-testid={`${mode}-password`}
          />
        </Field>

        {isLogin ? null : (
          <Field label="Confirm password" htmlFor={ids.confirmPassword} error={fieldErrors.confirmPassword}>
            <Input
              id={ids.confirmPassword}
              name="confirmPassword"
              type="password"
              value={confirmPassword}
              // The same value as the box above: this is the second half of one secret, not a second
              // credential, and a manager that fills only one of the two manufactures a mismatch.
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
              invalid={fieldErrors.confirmPassword !== undefined}
              aria-describedby={describeBy(ids.confirmPassword, {
                error: fieldErrors.confirmPassword !== undefined,
              })}
              disabled={submitting}
              data-testid={`${mode}-confirm`}
            />
          </Field>
        )}

        {formMessage === undefined ? null : (
          <FormMessage testId={`${mode}-error`}>
            {formMessage}
            {retryNotice === undefined ? null : <span className="ml-1 font-medium">{retryNotice}</span>}
          </FormMessage>
        )}

        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          className="w-full"
          data-testid={`${mode}-submit`}
        >
          {submitLabel}
        </Button>
      </form>

      {footer === undefined ? null : (
        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">{footer}</div>
      )}
    </section>
  );
}
