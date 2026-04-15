import { useEffect, useRef, useState } from 'react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DialogConfig {
  title: string
  message: string
  /** If set, show a text input pre-filled with this value. */
  inputValue?: string
  inputPlaceholder?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface AppDialogProps {
  config: DialogConfig | null
  onConfirm: (inputValue?: string) => void
  onCancel: () => void
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function AppDialog({ config, onConfirm, onCancel }: AppDialogProps) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const isPrompt = config?.inputValue !== undefined

  useEffect(() => {
    if (!config) return
    setInputValue(config.inputValue ?? '')
    window.setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }, 0)
  }, [config])

  useEffect(() => {
    if (!config) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [config, onCancel])

  if (!config) return null

  const confirmLabel = config.confirmLabel || (config.danger ? 'Delete' : 'OK')
  const cancelLabel = config.cancelLabel || 'Cancel'

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isPrompt) {
      const trimmed = inputValue.trim()
      if (!trimmed) return
      onConfirm(trimmed)
    } else {
      onConfirm()
    }
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog-container">
        <form className="dialog-box" onSubmit={handleSubmit}>
          <h3 className="dialog-title">{config.title}</h3>
          <p className="dialog-message">{config.message}</p>
          {isPrompt ? (
            <input
              ref={inputRef}
              className="dialog-input"
              type="text"
              value={inputValue}
              placeholder={config.inputPlaceholder}
              onChange={(e) => setInputValue(e.target.value)}
            />
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="submit"
              className={config.danger ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Hook: promise-based dialog API                                     */
/* ------------------------------------------------------------------ */

type DialogResolver = {
  resolve: (value: string | boolean | null) => void
}

export function useDialog() {
  const [config, setConfig] = useState<DialogConfig | null>(null)
  const resolverRef = useRef<DialogResolver | null>(null)

  /** Show a confirmation dialog. Returns `true` if confirmed. */
  function confirm(opts: Omit<DialogConfig, 'inputValue' | 'inputPlaceholder'>): Promise<boolean> {
    return new Promise((resolve) => {
      resolverRef.current = { resolve: (v) => resolve(v === true) }
      setConfig({ ...opts, inputValue: undefined })
    })
  }

  /** Show a prompt dialog. Returns the entered string, or `null` if cancelled. */
  function prompt(opts: DialogConfig): Promise<string | null> {
    return new Promise((resolve) => {
      resolverRef.current = { resolve: (v) => resolve(typeof v === 'string' ? v : null) }
      setConfig(opts)
    })
  }

  function handleConfirm(inputValue?: string) {
    const resolver = resolverRef.current
    resolverRef.current = null
    setConfig(null)
    if (resolver) {
      resolver.resolve(inputValue !== undefined ? inputValue : true)
    }
  }

  function handleCancel() {
    const resolver = resolverRef.current
    resolverRef.current = null
    setConfig(null)
    if (resolver) {
      resolver.resolve(null)
    }
  }

  const dialogElement = <AppDialog config={config} onConfirm={handleConfirm} onCancel={handleCancel} />

  return { confirm, prompt, dialogElement }
}
