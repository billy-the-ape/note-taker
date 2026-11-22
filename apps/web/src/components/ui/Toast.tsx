import * as ToastPrimitive from '@radix-ui/react-toast';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Toasts (docs/plans/mvp/MVP-08.md §5, §6): the transient layer for *"a thing you asked for failed"*.
 *
 * The split with `FormMessage` is the one rule worth keeping — a failure that names a field belongs
 * next to that field (wrong password, name taken), and a toast is for the rest: a mutation that died
 * halfway, a background refetch that could not be done, an action that succeeded elsewhere. Both, not
 * one or the other, on a failed form submit: the inline message is the one that is read first, and
 * the toast is what stays after the user scrolls.
 *
 * `ToastProvider` lives here rather than in `main.tsx` so a test that renders a route renders the real
 * stack, and `useToast()` throws with a named provider in the message when it is missing, because
 * "nothing appeared" is the most expensive way to find that out.
 */
export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  /** Milliseconds before it goes away on its own. An error stays longer than a confirmation. */
  readonly durationMs?: number;
}

export interface ToastApi {
  /** Queues one toast and returns its id, so a caller can dismiss its own message later. */
  readonly toast: (input: ToastInput) => string;
  readonly dismiss: (id: string) => void;
}

interface ToastRecord extends ToastInput {
  readonly id: string;
}

const DEFAULT_DURATIONS: Record<ToastTone, number> = {
  info: 5_000,
  success: 4_000,
  // Twice as long: the point of an error toast is that it gets read, and it often needs re-reading.
  error: 10_000,
};

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-line',
  success: 'border-ok',
  error: 'border-danger',
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast() must be used inside <ToastProvider> (see apps/web/src/main.tsx)');
  }
  return context;
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  // A counter, not `crypto.randomUUID()`: two failures in the same millisecond (a rejected batch) have
  // to get two keys, and React would otherwise drop one of them as a duplicate list item.
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toastItem) => toastItem.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    nextId.current += 1;
    const id = `t${nextId.current}`;
    setToasts((current) => [...current, { ...input, id }]);
    return id;
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((toastItem) => (
          <ToastItem key={toastItem.id} toastItem={toastItem} onDismiss={dismiss} />
        ))}
        <ToastPrimitive.Viewport
          aria-label="Notifications"
          className="fixed bottom-0 right-0 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 p-4"
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toastItem,
  onDismiss,
}: {
  readonly toastItem: ToastRecord;
  readonly onDismiss: (id: string) => void;
}) {
  const tone = toastItem.tone ?? 'info';
  return (
    <ToastPrimitive.Root
      // Controlled and always open: the list *is* the open state, so Radix's own timers (duration,
      // swipe, hover) still decide when to ask for a close, and the answer is to remove the entry.
      open
      duration={toastItem.durationMs ?? DEFAULT_DURATIONS[tone]}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss(toastItem.id);
      }}
      className={`relative flex flex-col gap-1 overflow-hidden rounded-lg border bg-surface p-3 pr-9 shadow-lg
        ${TONE_CLASS[tone]}`}
      data-testid={`toast-${tone}`}
    >
      <ToastPrimitive.Title className="text-sm font-medium text-ink">{toastItem.title}</ToastPrimitive.Title>
      {/* Always rendered: Radix wants a description to point `aria-describedby` at, and an empty one is
          honest, where a missing one is a warning in the console and a guess for the reader. */}
      <ToastPrimitive.Description className="text-sm text-ink-muted">
        {toastItem.description ?? ''}
      </ToastPrimitive.Description>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="absolute right-2 top-2 text-ink-muted hover:text-ink"
      >
        <span aria-hidden>✕</span>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
