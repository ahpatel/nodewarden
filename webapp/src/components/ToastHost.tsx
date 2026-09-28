import type { ManagedToast } from '@/hooks/useToastManager';
import { t } from '@/lib/i18n';

interface ToastHostProps {
  toasts: ManagedToast[];
  onClose: (id: string) => void;
  onAction: (id: string) => void;
}

export default function ToastHost({ toasts, onClose, onAction }: ToastHostProps) {
  if (!toasts.length) return null;
  return (
    <ul className="toast-stack">
      {toasts.map((toast) => (
        <li
          key={toast.id}
          className={`toast-item ${toast.type}${toast.closing ? ' closing' : ''}`}
          style={toast.durationMs ? ({ '--toast-life': `${toast.durationMs}ms` } as Record<string, string>) : undefined}
        >
          <div className="toast-text">{toast.text}</div>
          {toast.action ? (
            <button type="button" className="toast-action" onClick={() => onAction(toast.id)}>
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-close" onClick={() => onClose(toast.id)} aria-label={t('txt_close')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
          <div className="toast-progress" />
        </li>
      ))}
    </ul>
  );
}
