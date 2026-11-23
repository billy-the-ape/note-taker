import { useContext } from 'react';

import { SessionContext, type SessionContextValue } from './session';

export type { SessionContextValue };

/**
 * The session, from the nearest `SessionProvider` (docs/plans/mvp/MVP-08.md §5).
 *
 * A component that needs the *status* booleans reads `snapshot`; one that needs the user reads `user`.
 * There is deliberately no `useUser()` alias — two names for one object is how a codebase ends up with
 * three of them and no owner.
 *
 * The throw is a programming-error message, not a runtime state: every route of this app renders under
 * the provider, which `routes/__root.tsx` mounts, so reaching it means somebody added a page outside the
 * root route or rendered one without a router at all.
 */
export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error(
      'useSession() must be used inside <SessionProvider> (see apps/web/src/routes/__root.tsx)',
    );
  }
  return context;
}
