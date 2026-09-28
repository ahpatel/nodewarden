import { useRef, useState } from 'preact/hooks';
import type { ToastAction, ToastMessage } from '@/lib/types';

/* Keep in sync with the toast-life duration in styles/overlays.css. */
const TOAST_LIFE_MS = 4500;
/* Equals --dur-fast, the duration of .toast-item.closing in styles/overlays.css. */
const TOAST_EXIT_MS = 180;

export type ManagedToast = ToastMessage & { closing: boolean };

export interface ToastOptions {
  /** Overrides the default toast lifetime (TOAST_LIFE_MS). */
  durationMs?: number;
  /** Renders an inline action control (e.g. Undo) on the toast. */
  action?: ToastAction;
}

export function useToastManager() {
  const [toasts, setToasts] = useState<ManagedToast[]>([]);
  const closingIdsRef = useRef(new Set<string>());
  const actionsRef = useRef(new Map<string, ToastAction>());
  const runningActionIdsRef = useRef(new Set<string>());

  function beginClosing(id: string) {
    if (closingIdsRef.current.has(id)) return;
    closingIdsRef.current.add(id);
    setToasts((prev) => prev.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)));
  }

  function unmount(id: string) {
    closingIdsRef.current.delete(id);
    actionsRef.current.delete(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  function removeToast(id: string) {
    /* Manual close: play the exit animation, then unmount. */
    beginClosing(id);
    window.setTimeout(() => unmount(id), TOAST_EXIT_MS);
  }

  function pushToast(type: ToastMessage['type'], text: string, options?: ToastOptions) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (options?.action) actionsRef.current.set(id, options.action);
    const life = Math.max(options?.durationMs ?? TOAST_LIFE_MS, TOAST_EXIT_MS);
    setToasts((prev) => [...prev.slice(-3), { id, type, text, closing: false, action: options?.action, durationMs: options?.durationMs }]);
    window.setTimeout(() => beginClosing(id), life - TOAST_EXIT_MS);
    window.setTimeout(() => unmount(id), life);
  }

  function runToastAction(id: string) {
    const action = actionsRef.current.get(id);
    if (!action || runningActionIdsRef.current.has(id)) return;
    runningActionIdsRef.current.add(id);
    void Promise.resolve()
      .then(() => action.onAction())
      .catch(() => undefined)
      .finally(() => {
        runningActionIdsRef.current.delete(id);
        removeToast(id);
      });
  }

  return {
    toasts,
    pushToast,
    removeToast,
    runToastAction,
  };
}
