import { ComfyApp } from '@comfyorg/comfyui-frontend-types'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useSelectDialog } from './components/Dialog'

declare global {
  interface Window {
    app?: ComfyApp
  }
}

type SortType = 'name' | 'mtime' | 'size'
type SortOrder = 'asc' | 'desc'
type MediaType = 'image' | 'video' | null

interface RootInfo {
  name: string
  path: string
}

interface AssetItem {
  name: string
  path: string
  type: 'dir' | 'file'
  root: string
  size: number
  mtime: number
  mediaType: MediaType
  width: number | null
  height: number | null
}

interface AssetResponse {
  root: string
  currentPath: string
  parentPath: string
  items: AssetItem[]
  nextCursor: number | null
  total: number
}

interface Breadcrumb {
  label: string
  path: string
}

// ─── Native ComfyUI APIs ──────────────────────────────────────────────────────

type NativeConfirmType = 'default' | 'delete' | 'overwrite' | 'dirtyClose' | 'reinstall'

async function appConfirm(
  title: string,
  message: string,
  type: NativeConfirmType = 'default',
): Promise<boolean> {
  const dialog = (window.app?.extensionManager as any)?.dialog
  if (!dialog) return window.confirm(`${title}\n${message}`)
  const result = await dialog.confirm({ title, message, type })
  return result === true
}

async function appPrompt(title: string, defaultValue = ''): Promise<string | null> {
  const dialog = (window.app?.extensionManager as any)?.dialog
  if (!dialog) return window.prompt(title, defaultValue)
  return (await dialog.prompt({ title, defaultValue })) ?? null
}

function toast(
  severity: 'success' | 'info' | 'warn' | 'error',
  summary: string,
  detail?: string,
  life = 3000,
) {
  window.app?.extensionManager.toast.add({ severity, summary, detail, life })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSetting<T>(id: string, fallback: T): T {
  const settingApi = (window.app?.extensionManager as any)?.setting
  const value = settingApi?.get(id)
  return value === undefined || value === null ? fallback : (value as T)
}

function buildUrl(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}`
}

function formatBytes(value: number): string {
  if (value <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return debounced
}

function LazyRender({ children }: { children: ReactNode }): JSX.Element {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) { setVisible(true); obs.disconnect() } },
      { rootMargin: '300px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return (
    <div ref={ref} className="h-full w-full">
      {visible ? children : <div className="h-full w-full animate-pulse" style={{ background: 'var(--btrfb-surface-3)' }} />}
    </div>
  )
}

// ─── Icons ───────────────────────────────────────────────────────────────────

interface IconProps { className?: string; style?: React.CSSProperties }

// Folder — classic two-tier shape
const FolderIcon = ({ className, style }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className} style={style}>
    <path d="M2 6a2 2 0 0 1 2-2h3.586a1 1 0 0 1 .707.293L9.707 5.7A1 1 0 0 0 10.414 6H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Z" />
  </svg>
)

// Image — mountains + sun
const PhotoIcon = ({ className, style }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className} style={style}>
    <path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 0 1 3.25 3h13.5A2.25 2.25 0 0 1 19 5.25v9.5A2.25 2.25 0 0 1 16.75 17H3.25A2.25 2.25 0 0 1 1 14.75v-9.5Zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 0 0 .75-.75v-2.69l-2.22-2.219a.75.75 0 0 0-1.061 0l-1.106 1.105 .287.288a.75.75 0 1 1-1.061 1.06l-1.287-1.286a.75.75 0 0 0-1.061 0L2.5 11.06Zm9.25-7.06a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" clipRule="evenodd" />
  </svg>
)

// Refresh — circular arrow
const RefreshIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.389Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0v2.43l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clipRule="evenodd" />
  </svg>
)

// Up arrow — chevron up
const ArrowUpIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.832 6.29 12.77a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06Z" clipRule="evenodd" />
  </svg>
)

// Sort desc (↓)
const SortDescIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M2 3.75A.75.75 0 0 1 2.75 3h11.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75ZM2 7.5a.75.75 0 0 1 .75-.75h7.508a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.5ZM14 7a.75.75 0 0 1 .75.75v6.59l1.95-2.1a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0l-3.25-3.5a.75.75 0 1 1 1.1-1.02l1.95 2.1V7.75A.75.75 0 0 1 14 7ZM2 11.25a.75.75 0 0 1 .75-.75h4.562a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
  </svg>
)

// Sort asc (↑)
const SortAscIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M2 3.75A.75.75 0 0 1 2.75 3h11.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75ZM2 7.5a.75.75 0 0 1 .75-.75h7.508a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.5ZM14 13a.75.75 0 0 1-.75-.75V5.66l-1.95 2.1a.75.75 0 1 1-1.1-1.02l3.25-3.5a.75.75 0 0 1 1.1 0l3.25 3.5a.75.75 0 1 1-1.1 1.02l-1.95-2.1v6.59A.75.75 0 0 1 14 13ZM2 11.25a.75.75 0 0 1 .75-.75h4.562a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
  </svg>
)

// Multi-select / checkbox
const SelectIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M2.5 3A1.5 1.5 0 0 0 1 4.5v4A1.5 1.5 0 0 0 2.5 10h4A1.5 1.5 0 0 0 8 8.5v-4A1.5 1.5 0 0 0 6.5 3h-4Zm9 0A1.5 1.5 0 0 0 10 4.5v4A1.5 1.5 0 0 0 11.5 10h4A1.5 1.5 0 0 0 17 8.5v-4A1.5 1.5 0 0 0 15.5 3h-4Zm-9 9A1.5 1.5 0 0 0 1 13.5v4A1.5 1.5 0 0 0 2.5 19h4A1.5 1.5 0 0 0 8 17.5v-4A1.5 1.5 0 0 0 6.5 12h-4ZM10 13.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z" clipRule="evenodd" />
  </svg>
)

// New folder (+)
const FolderPlusIcon = ({ className, style }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className} style={style}>
    <path d="M2 6a2 2 0 0 1 2-2h3.586a1 1 0 0 1 .707.293L9.707 5.7A1 1 0 0 0 10.414 6H16a2 2 0 0 1 2 2v2h-2V8H4v7h6v2H4a2 2 0 0 1-2-2V6Z" />
    <path d="M17 12a1 1 0 1 0-2 0v1h-1a1 1 0 1 0 0 2h1v1a1 1 0 1 0 2 0v-1h1a1 1 0 1 0 0-2h-1v-1Z" />
  </svg>
)

// Close ✕
const XIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
  </svg>
)

// Chevron left / right for preview nav
const ChevronLeftIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
  </svg>
)
const ChevronRightIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
    <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
  </svg>
)

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const defaultRoot  = getSetting<string>('btrfb.defaultRoot', 'output')
  const pageSize     = getSetting<number>('btrfb.pageSize', 120)
  const thumbSize    = getSetting<number>('btrfb.thumbSize', 176)
  const thumbFormat  = getSetting<string>('btrfb.thumbFormat', 'webp')
  const enableVideo  = getSetting<boolean>('btrfb.enableVideoThumb', true)
  const showDims     = getSetting<boolean>('btrfb.showDimensions', true)

  const [availableRoots, setAvailableRoots] = useState<RootInfo[]>([
    { name: 'output', path: '' }, { name: 'input', path: '' },
  ])
  const [root, setRoot]               = useState<string>(defaultRoot)
  const [currentPath, setCurrentPath] = useState('')
  const [items, setItems]             = useState<AssetItem[]>([])
  const [nextCursor, setNextCursor]   = useState<number | null>(null)
  const [totalCount, setTotalCount]   = useState(0)
  const [loading, setLoading]         = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const [searchValue, setSearchValue] = useState('')
  const [sortBy, setSortBy]           = useState<SortType>('mtime')
  const [sortOrder, setSortOrder]     = useState<SortOrder>('desc')

  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [copied, setCopied]             = useState(false)

  const [multiSelect, setMultiSelect]   = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const { select, dialog: selectDialog } = useSelectDialog()
  const debouncedSearch = useDebouncedValue(searchValue, 220)

  // fetch roots
  useEffect(() => {
    fetch('/btrfb/roots')
      .then(r => r.json())
      .then((roots: RootInfo[]) => { if (Array.isArray(roots) && roots.length) setAvailableRoots(roots) })
      .catch(() => {})
  }, [])

  const breadcrumbs = useMemo<Breadcrumb[]>(() => {
    const chunks = currentPath.split('/').filter(Boolean)
    const label = root.charAt(0).toUpperCase() + root.slice(1)
    const parts: Breadcrumb[] = [{ label, path: '' }]
    let merged = ''
    for (const chunk of chunks) {
      merged = merged ? `${merged}/${chunk}` : chunk
      parts.push({ label: chunk, path: merged })
    }
    return parts
  }, [currentPath, root])

  const previewableItems = useMemo(() => items.filter(i => i.type === 'file'), [items])
  const previewItem = previewIndex !== null ? previewableItems[previewIndex] ?? null : null
  const previewUrl  = previewItem ? buildUrl('/btrfb/file', { root: previewItem.root, path: previewItem.path }) : null

  const fetchAssets = useCallback(async (cursor = 0, append = false) => {
    append ? setLoadingMore(true) : (setLoading(true), setError(null))
    try {
      const url = buildUrl('/btrfb/assets', {
        root, path: currentPath, cursor, limit: pageSize,
        q: debouncedSearch || undefined,
        sort: sortBy, order: sortOrder,
        dims: showDims ? '1' : undefined,
      })
      const res = await fetch(url)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load' }))
        throw new Error(err.error ?? 'Failed to load')
      }
      const data = (await res.json()) as AssetResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
      setTotalCount(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [root, currentPath, pageSize, debouncedSearch, sortBy, sortOrder, showDims])

  useEffect(() => { void fetchAssets(0, false) }, [fetchAssets])

  // keyboard nav for preview
  useEffect(() => {
    if (previewIndex === null) return
    const handler = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === 'ArrowLeft')  setPreviewIndex(i => (i !== null && i > 0 ? i - 1 : i))
      if (e.key === 'ArrowRight') setPreviewIndex(i => (i !== null && i < previewableItems.length - 1 ? i + 1 : i))
      if (e.key === 'Escape')     setPreviewIndex(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewIndex, previewableItems.length])

  const navigate = (path: string) => {
    setCurrentPath(path)
    setSelectedKeys(new Set())
    setMultiSelect(false)
  }

  const goUp = () => {
    if (!currentPath) return
    navigate(currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '')
  }

  // ── File ops ──────────────────────────────────────────────────────────────

  const removeAsset = async (item: AssetItem) => {
    const isDir = item.type === 'dir'
    const ok = await appConfirm(
      `Delete "${item.name}"?`,
      isDir ? 'This folder and all its contents will be permanently deleted.' : 'This file will be permanently deleted.',
      'delete',
    )
    if (!ok) return
    const res = await fetch('/btrfb/file/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: item.root, path: item.path, force: isDir }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      toast('error', 'Delete Failed', err.error, 4000)
      return
    }
    toast('success', 'Deleted', item.name, 1800)
    if (previewItem?.path === item.path && previewItem.root === item.root) setPreviewIndex(null)
    void fetchAssets(0, false)
  }

  const renameAsset = async (item: AssetItem) => {
    const name = await appPrompt('Rename', item.name)
    if (!name || name === item.name) return
    const res = await fetch('/btrfb/file/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: item.root, path: item.path, newName: name }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      toast('error', 'Rename Failed', err.error, 4000)
      return
    }
    if (previewItem?.path === item.path) setPreviewIndex(null)
    void fetchAssets(0, false)
  }

  const createFolder = async () => {
    const name = await appPrompt('New Folder', '')
    if (!name) return
    const res = await fetch('/btrfb/file/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: currentPath, name }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      toast('error', 'Create Folder Failed', err.error, 4000)
      return
    }
    void fetchAssets(0, false)
  }

  // ── Multi-select ──────────────────────────────────────────────────────────

  const itemKey = (item: AssetItem) => `${item.root}::${item.path}`

  const toggleSelect = (item: AssetItem) => {
    const k = itemKey(item)
    setSelectedKeys(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  }

  const batchDelete = async () => {
    if (!selectedKeys.size) return
    const ok = await appConfirm(
      `Delete ${selectedKeys.size} item${selectedKeys.size > 1 ? 's' : ''}?`,
      'This action cannot be undone.', 'delete',
    )
    if (!ok) return
    const targets = items.filter(i => selectedKeys.has(itemKey(i)))
    const results = await Promise.allSettled(targets.map(item =>
      fetch('/btrfb/file/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: item.root, path: item.path, force: item.type === 'dir' }),
      })
    ))
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length
    failed
      ? toast('warn', 'Partial Delete', `${targets.length - failed} deleted, ${failed} failed`, 4000)
      : toast('success', 'Deleted', `${targets.length} items removed`, 2000)
    setSelectedKeys(new Set())
    setMultiSelect(false)
    setPreviewIndex(null)
    void fetchAssets(0, false)
  }

  // ── Preview actions ───────────────────────────────────────────────────────

  const copyPath = async () => {
    if (!previewItem) return
    try {
      await navigator.clipboard.writeText(previewItem.path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast('warn', 'Clipboard unavailable', previewItem.path, 4000)
    }
  }

  const sendTo = async () => {
    if (!previewItem) return
    const others = availableRoots.filter(r => r.name !== previewItem.root)
    if (!others.length) return
    const targetRoot = await select(
      'Move to',
      others.map(r => ({ value: r.name, label: r.name.charAt(0).toUpperCase() + r.name.slice(1) })),
      `Move "${previewItem.name}" to another location`,
    )
    if (!targetRoot) return
    const res = await fetch('/btrfb/file/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRoot: previewItem.root, sourcePath: previewItem.path, targetRoot, targetDir: '' }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      toast('error', 'Move Failed', err.error, 4000)
      return
    }
    toast('success', 'Moved', `${previewItem.name} → ${targetRoot}`, 2000)
    setPreviewIndex(null)
    void fetchAssets(0, false)
  }

  // ── Shared class ──────────────────────────────────────────────────────────

  // h-7 = 28 px — all interactive toolbar/modal buttons share this height
  const btn        = 'inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium transition focus:outline-none'
  const btnNeutral = `${btn} border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-2)] text-[color:var(--btrfb-text)] hover:bg-[color:var(--btrfb-surface-3)]`
  const btnDanger  = `${btn} border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20`

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ background: 'var(--btrfb-surface)', color: 'var(--btrfb-text)', gap: '0' }}
    >
      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--btrfb-border-soft)' }}
      >
        {/* Title */}
        <span className="text-xs font-semibold tracking-wide" style={{ color: 'var(--btrfb-text-soft)' }}>
          BtrFB
        </span>

        {/* Root tabs */}
        <div
          className="flex rounded-lg p-0.5"
          style={{ background: 'var(--btrfb-surface-3)', marginLeft: '2px' }}
        >
          {availableRoots.map(ri => (
            <button
              key={ri.name}
              className="rounded-md px-2.5 py-1 text-xs font-medium capitalize transition"
              style={
                root === ri.name
                  ? { background: 'var(--btrfb-surface-2)', color: 'var(--btrfb-text)', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }
                  : { background: 'transparent', color: 'var(--btrfb-text-soft)' }
              }
              onClick={() => { setRoot(ri.name); setCurrentPath(''); setSelectedKeys(new Set()); setMultiSelect(false) }}
            >
              {ri.name}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Item count */}
        <span className="text-[11px]" style={{ color: 'var(--btrfb-text-soft)' }}>{totalCount}</span>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-2.5 py-2"
        style={{ borderBottom: '1px solid var(--btrfb-border-soft)' }}
      >
        {/* Search */}
        <input
          className="min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-xs"
          style={{
            background: 'var(--btrfb-surface-3)',
            border: '1px solid var(--btrfb-border)',
            color: 'var(--btrfb-text)',
            outline: 'none',
          }}
          placeholder="Search…"
          value={searchValue}
          onChange={e => setSearchValue(e.target.value)}
        />

        {/* Sort */}
        <select
          className="h-7 rounded-md pl-2 pr-5 text-xs"
          style={{
            background: 'var(--btrfb-surface-2)',
            border: '1px solid var(--btrfb-border)',
            color: 'var(--btrfb-text)',
            outline: 'none',
          }}
          value={sortBy}
          onChange={e => setSortBy(e.target.value as SortType)}
        >
          <option value="mtime">Date</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
        </select>

        {/* Sort order */}
        <button
          className={btnNeutral}
          onClick={() => setSortOrder(v => v === 'desc' ? 'asc' : 'desc')}
          title={sortOrder === 'desc' ? 'Descending' : 'Ascending'}
        >
          {sortOrder === 'desc'
            ? <SortDescIcon className="h-3.5 w-3.5" />
            : <SortAscIcon  className="h-3.5 w-3.5" />
          }
        </button>

        <div className="mx-0.5 h-4 w-px" style={{ background: 'var(--btrfb-border)' }} />

        {/* Refresh */}
        <button className={btnNeutral} onClick={() => void fetchAssets(0, false)} title="Refresh">
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>

        {/* New folder */}
        <button className={btnNeutral} onClick={createFolder} title="New folder">
          <FolderPlusIcon className="h-3.5 w-3.5" style={{ color: 'var(--btrfb-accent)' }} />
          Folder
        </button>

        {/* Multi-select toggle */}
        <button
          className={`${btn} ${multiSelect ? 'border-[color:var(--btrfb-accent)]' : 'border-[color:var(--btrfb-border)]'}`}
          style={{
            background: multiSelect ? 'var(--btrfb-accent-soft)' : 'var(--btrfb-surface-2)',
            color: multiSelect ? 'var(--btrfb-accent)' : 'var(--btrfb-text-soft)',
          }}
          onClick={() => { setMultiSelect(v => !v); setSelectedKeys(new Set()) }}
          title="Toggle selection mode"
        >
          <SelectIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Breadcrumb + batch bar ──────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-1 px-2.5 py-1.5"
        style={{ borderBottom: '1px solid var(--btrfb-border-soft)', minHeight: '32px' }}
      >
        {multiSelect ? (
          /* Batch delete bar */
          <>
            <span className="text-[11px]" style={{ color: 'var(--btrfb-text-soft)' }}>
              {selectedKeys.size} selected
            </span>
            <button
              className="rounded px-2 py-0.5 text-[11px] font-medium transition"
              style={{ background: 'var(--btrfb-surface-3)', color: 'var(--btrfb-text-soft)' }}
              onClick={() => setSelectedKeys(new Set(items.map(itemKey)))}
            >All</button>
            <div className="flex-1" />
            <button
              className={`${btnDanger} disabled:opacity-40`}
              disabled={!selectedKeys.size}
              onClick={() => void batchDelete()}
            >
              Delete {selectedKeys.size > 0 ? `(${selectedKeys.size})` : ''}
            </button>
          </>
        ) : (
          /* Breadcrumbs */
          <>
            <button
              className="inline-flex h-6 w-6 items-center justify-center rounded transition disabled:opacity-30"
              style={{ color: 'var(--btrfb-text-soft)' }}
              onClick={goUp}
              disabled={!currentPath}
              title="Go up"
            >
              <ArrowUpIcon className="h-3.5 w-3.5" />
            </button>
            {breadcrumbs.map((c, i) => (
              <span key={c.path || 'root'} className="flex items-center gap-1">
                {i > 0 && <span className="text-[10px]" style={{ color: 'var(--btrfb-border)' }}>/</span>}
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium transition"
                  style={{ color: i === breadcrumbs.length - 1 ? 'var(--btrfb-text)' : 'var(--btrfb-text-soft)' }}
                  onClick={() => navigate(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </>
        )}
      </div>

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="mx-2.5 mt-2 shrink-0 rounded-lg px-3 py-2 text-xs text-red-300" style={{ background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.25)' }}>
          {error}
        </div>
      )}

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      <div
        className="grid flex-1 content-start gap-2 overflow-y-auto p-2.5"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}
      >
        {loading && !items.length
          ? Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="aspect-square animate-pulse rounded-xl"
                style={{ background: 'var(--btrfb-surface-2)', border: '1px solid var(--btrfb-border-soft)' }}
              />
            ))
          : items.map(item => {
              const thumbUrl =
                item.type === 'file' && (item.mediaType === 'image' || (enableVideo && item.mediaType === 'video'))
                  ? buildUrl('/btrfb/thumb', { root: item.root, path: item.path, w: thumbSize, h: thumbSize, format: thumbFormat })
                  : null

              const key = itemKey(item)
              const isSelected = selectedKeys.has(key)
              const isDir = item.type === 'dir'

              return (
                <article
                  key={key}
                  className="group flex flex-col overflow-hidden rounded-xl transition"
                  style={{
                    background: 'var(--btrfb-surface-2)',
                    border: `1px solid ${isSelected ? 'var(--btrfb-accent)' : 'var(--btrfb-border-soft)'}`,
                    boxShadow: isSelected ? '0 0 0 1px var(--btrfb-accent-soft)' : undefined,
                  }}
                >
                  {/* ── Thumbnail ─────────────────────────────────────── */}
                  <button
                    className="relative w-full flex-1 overflow-hidden"
                    style={{ aspectRatio: '1 / 1' }}
                    onClick={() => {
                      if (multiSelect) { toggleSelect(item); return }
                      if (isDir) { navigate(item.path); return }
                      const idx = previewableItems.findIndex(p => p.path === item.path && p.root === item.root)
                      setPreviewIndex(idx >= 0 ? idx : null)
                    }}
                  >
                    {/* Image / folder icon */}
                    {isDir ? (
                      <div className="grid h-full w-full place-items-center" style={{ background: 'var(--btrfb-surface-3)' }}>
                        <FolderIcon className="h-10 w-10" style={{ color: 'var(--btrfb-text-soft)', opacity: 0.5 } as React.CSSProperties} />
                      </div>
                    ) : thumbUrl ? (
                      <LazyRender>
                        <img
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          src={thumbUrl}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                        />
                      </LazyRender>
                    ) : (
                      <div className="grid h-full w-full place-items-center" style={{ background: 'var(--btrfb-surface-3)' }}>
                        <PhotoIcon className="h-8 w-8" style={{ color: 'var(--btrfb-text-soft)', opacity: 0.3 } as React.CSSProperties} />
                      </div>
                    )}

                    {/* Hover actions (top-right) */}
                    <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                      <button
                        className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm transition hover:text-white"
                        style={{ background: 'rgba(0,0,0,.55)' }}
                        onClick={e => { e.stopPropagation(); void renameAsset(item) }}
                      >
                        Rename
                      </button>
                      <button
                        className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-red-300 backdrop-blur-sm transition hover:text-red-200"
                        style={{ background: 'rgba(0,0,0,.55)' }}
                        onClick={e => { e.stopPropagation(); void removeAsset(item) }}
                      >
                        Delete
                      </button>
                    </div>

                    {/* Checkbox overlay */}
                    {multiSelect && (
                      <div
                        className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border-2 transition"
                        style={{
                          background: isSelected ? 'var(--btrfb-accent)' : 'rgba(0,0,0,.45)',
                          borderColor: isSelected ? 'var(--btrfb-accent)' : 'rgba(255,255,255,.5)',
                        }}
                      >
                        {isSelected && (
                          <svg viewBox="0 0 12 12" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2,6 5,9 10,3" />
                          </svg>
                        )}
                      </div>
                    )}
                  </button>

                  {/* ── Info footer ──────────────────────────────────── */}
                  <div
                    className="shrink-0 px-2 py-1.5"
                    style={{ borderTop: '1px solid var(--btrfb-border-soft)' }}
                  >
                    {/* Filename — always shown here */}
                    <p className="truncate text-[11px] font-medium leading-snug" style={{ color: 'var(--btrfb-text)' }}>
                      {item.name}
                    </p>
                    {/* Single meta line */}
                    <p className="truncate text-[10px] leading-snug" style={{ color: 'var(--btrfb-text-soft)' }}>
                      {isDir
                        ? 'Folder · ' + formatDate(item.mtime)
                        : [
                            item.mediaType === 'video' ? 'Video' : 'Image',
                            item.width && item.height ? `${item.width}×${item.height}` : null,
                            formatBytes(item.size),
                          ].filter(Boolean).join(' · ')
                      }
                    </p>
                  </div>
                </article>
              )
            })}
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!loading && !items.length && !error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-12" style={{ color: 'var(--btrfb-text-soft)' }}>
          <PhotoIcon className="h-9 w-9 opacity-20" />
          <p className="text-xs opacity-60">
            {debouncedSearch ? `No results for "${debouncedSearch}"` : 'This folder is empty'}
          </p>
        </div>
      )}

      {/* ── Load more ───────────────────────────────────────────────────── */}
      {nextCursor !== null && (
        <div className="flex shrink-0 justify-center px-2.5 py-2">
          <button className={btnNeutral} onClick={() => { if (nextCursor !== null && !loadingMore) void fetchAssets(nextCursor, true) }} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {/* ── Preview modal ────────────────────────────────────────────────── */}
      {previewItem && previewUrl && (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,.85)' }}
          onClick={() => setPreviewIndex(null)}
        >
          {/* Prev */}
          {previewIndex !== null && previewIndex > 0 && (
            <button
              className="absolute left-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-white/70 transition hover:text-white"
              style={{ background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.15)' }}
              onClick={e => { e.stopPropagation(); setPreviewIndex(i => i !== null ? i - 1 : null) }}
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
          )}
          {/* Next */}
          {previewIndex !== null && previewIndex < previewableItems.length - 1 && (
            <button
              className="absolute right-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-white/70 transition hover:text-white"
              style={{ background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.15)' }}
              onClick={e => { e.stopPropagation(); setPreviewIndex(i => i !== null ? i + 1 : null) }}
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          )}

          {/* Panel */}
          <div
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
            style={{ background: 'var(--btrfb-surface-2)', border: '1px solid var(--btrfb-border)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              className="flex items-center gap-2 px-4 py-2.5"
              style={{ borderBottom: '1px solid var(--btrfb-border-soft)' }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--btrfb-text)' }}>{previewItem.name}</p>
                <p className="truncate text-[10px]" style={{ color: 'var(--btrfb-text-soft)' }}>
                  {[
                    previewItem.mediaType === 'video' ? 'Video' : 'Image',
                    previewItem.width && previewItem.height ? `${previewItem.width}×${previewItem.height}` : null,
                    formatBytes(previewItem.size),
                    previewableItems.length > 1 ? `${(previewIndex ?? 0) + 1} / ${previewableItems.length}` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button className={btnNeutral} onClick={() => void copyPath()}>
                  {copied ? '✓ Copied' : 'Copy Path'}
                </button>
                {availableRoots.length > 1 && (
                  <button className={btnNeutral} onClick={() => void sendTo()}>Send To</button>
                )}
                <button className={btnDanger} onClick={() => void removeAsset(previewItem)}>Delete</button>
                <button
                  className={btnNeutral}
                  onClick={() => setPreviewIndex(null)}
                  title="Close"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Media */}
            <div className="overflow-auto p-3">
              {previewItem.mediaType === 'video' ? (
                <video key={previewUrl} className="mx-auto max-h-[75vh] max-w-full rounded-xl" controls preload="metadata" src={previewUrl} />
              ) : (
                <img key={previewUrl} className="mx-auto max-h-[75vh] max-w-full rounded-xl" src={previewUrl} alt={previewItem.name} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Select dialog */}
      {selectDialog}
    </div>
  )
}

export default App
