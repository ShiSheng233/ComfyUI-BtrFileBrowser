import { useEffect, useState } from 'react'

// SelectDialog — used for "Send To" root picker.
// Confirm / Prompt use the native app.extensionManager.dialog API instead.

// ─── Shared overlay ───────────────────────────────────────────────────────────

function Overlay({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[3000] bg-black/60 backdrop-blur-sm"
      onClick={onClick}
    />
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[3001] flex items-center justify-center p-4 pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-xs rounded-xl border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-strong)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

const cancelBtn =
  'w-full rounded-lg border border-[color:var(--btrfb-border)] bg-transparent px-3 py-2 text-xs font-medium text-[color:var(--btrfb-text-soft)] transition hover:bg-white/5 focus:outline-none'

// ─── SelectDialog ──────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string
  label: string
}

export interface SelectDialogProps {
  open: boolean
  title: string
  message?: string
  options: SelectOption[]
  onSelect: (value: string) => void
  onCancel: () => void
}

export function SelectDialog({
  open,
  title,
  message,
  options,
  onSelect,
  onCancel,
}: SelectDialogProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <>
      <Overlay onClick={onCancel} />
      <Panel>
        <div className="p-4 pb-2">
          <p className="text-sm font-semibold text-[color:var(--btrfb-text)]">{title}</p>
          {message && (
            <p className="mt-1 text-xs text-[color:var(--btrfb-text-soft)]">{message}</p>
          )}
        </div>
        <div className="px-2 pb-2">
          {options.map((opt) => (
            <button
              key={opt.value}
              className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium capitalize text-[color:var(--btrfb-text)] transition hover:bg-white/5"
              onClick={() => onSelect(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="border-t border-[color:var(--btrfb-border)] px-4 py-3">
          <button className={cancelBtn} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </Panel>
    </>
  )
}

// ─── useSelectDialog ───────────────────────────────────────────────────────────

interface SelectState {
  open: boolean
  title: string
  message?: string
  options: SelectOption[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: ((value: string | null) => void) | null
}

const CLOSED: SelectState = { open: false, title: '', options: [], resolve: null }

export function useSelectDialog() {
  const [state, setState] = useState<SelectState>(CLOSED)

  const close = (value: string | null) => {
    state.resolve?.(value)
    setState(CLOSED)
  }

  const select = (title: string, options: SelectOption[], message?: string): Promise<string | null> =>
    new Promise((resolve) => {
      setState({ open: true, title, message, options, resolve })
    })

  const dialog = (
    <SelectDialog
      open={state.open}
      title={state.title}
      message={state.message}
      options={state.options}
      onSelect={(v) => close(v)}
      onCancel={() => close(null)}
    />
  )

  return { select, dialog }
}
