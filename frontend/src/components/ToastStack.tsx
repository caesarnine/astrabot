import type { ToastItem } from '../types'

interface ToastStackProps {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}

function toastIcon(kind: ToastItem['kind']) {
  switch (kind) {
    case 'success':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3.5 8.5l3 3 6-6" />
        </svg>
      )
    case 'error':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      )
    case 'attention':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 5v3M8 10.5v.5" />
          <circle cx="8" cy="8" r="6" />
        </svg>
      )
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 6v4" />
        </svg>
      )
  }
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.slice(0, 4).map((toast) => (
        <div key={toast.id} className={`toast-item toast-${toast.kind}`}>
          <span className="toast-icon">{toastIcon(toast.kind)}</span>
          <span className="toast-message">{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action!.callback()
                onDismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
