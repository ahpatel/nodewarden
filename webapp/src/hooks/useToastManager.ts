import { useRef, useState } from 'preact/hooks';
import type { ToastMessage } from '@/lib/types';

/* Keep in sync with the toast-life duration in styles/overlays.css. */
const TOAST_LIFE_MS = 4500;
/* Equals --dur-fast, the duration of .toast-item.closing in styles/overlays.css. */
const TOAST_EXIT_MS = 180;

export type ManagedToast = ToastMessage & { closing: boolean };

export function useToastManager() {
  const [toasts, setToasts] = useState<ManagedToast[]>([]);
  const closingIdsRef = useRef(new Set<string>());

  function beginClosing(id: string) {
    if (closingIdsRef.current.has(id)) return;
    closingIdsRef.current.add(id);
    setToasts((prev) => prev.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)));
  }

  function unmount(id: string) {
    closingIdsRef.current.delete(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  function removeToast(id: string) {
    /* Manual close: play the exit animation, then unmount. */
    beginClosing(id);
    window.setTimeout(() => unmount(id), TOAST_EXIT_MS);
  }

  function pushToast(type: ToastMessage['type'], text: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-3), { id, type, text, closing: false }]);
    window.setTimeout(() => beginClosing(id), TOAST_LIFE_MS - TOAST_EXIT_MS);
    window.setTimeout(() => unmount(id), TOAST_LIFE_MS);
  }

  return {
    toasts,
    pushToast,
    removeToast,
  };
}
