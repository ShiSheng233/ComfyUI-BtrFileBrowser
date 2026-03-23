import { ComfyApp } from '@comfyorg/comfyui-frontend-types'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

declare global {
  interface Window {
    app?: ComfyApp
  }
}

type RootType = 'input' | 'output'
type SortType = 'name' | 'mtime' | 'size'
type SortOrder = 'asc' | 'desc'
type MediaType = 'image' | 'video' | null

interface AssetItem {
  name: string
  path: string
  type: 'dir' | 'file'
  root: RootType
  size: number
  mtime: number
  mediaType: MediaType
}

interface AssetResponse {
  root: RootType
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

function getSetting<T>(id: string, fallback: T): T {
  const settingApi = (window.app?.extensionManager as any)?.setting
  const value = settingApi?.get(id)
  return value === undefined || value === null ? fallback : (value as T)
}

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  return `${url.pathname}${url.search}`
}

function formatBytes(value: number): string {
  if (value <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function LazyRender({ children }: { children: ReactNode }): JSX.Element {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '260px' }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="h-full w-full">
      {visible ? children : <div className="h-full w-full animate-pulse bg-slate-700/20" />}
    </div>
  )
}

function App() {
  const defaultRoot = getSetting<RootType>('btrfb.defaultRoot', 'output')

  const [root, setRoot] = useState<RootType>(defaultRoot)
  const [currentPath, setCurrentPath] = useState('')
  const [items, setItems] = useState<AssetItem[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [searchValue, setSearchValue] = useState('')
  const [sortBy, setSortBy] = useState<SortType>('mtime')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  const [selected, setSelected] = useState<AssetItem | null>(null)

  const pageSize = getSetting<number>('btrfb.pageSize', 120)
  const thumbSize = getSetting<number>('btrfb.thumbSize', 176)
  const thumbFormat = getSetting<string>('btrfb.thumbFormat', 'webp')
  const enableVideoThumb = getSetting<boolean>('btrfb.enableVideoThumb', true)

  const debouncedSearch = useDebouncedValue(searchValue, 220)

  const breadcrumbs = useMemo(() => {
    const chunks = currentPath.split('/').filter(Boolean)
    const parts: Breadcrumb[] = [{ label: root === 'output' ? 'Output' : 'Input', path: '' }]
    let merged = ''
    for (const chunk of chunks) {
      merged = merged ? `${merged}/${chunk}` : chunk
      parts.push({ label: chunk, path: merged })
    }
    return parts
  }, [currentPath, root])

  const fetchAssets = useCallback(
    async (cursor = 0, append = false) => {
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
        setError(null)
      }

      try {
        const url = buildUrl('/btrfb/assets', {
          root,
          path: currentPath,
          cursor,
          limit: pageSize,
          q: debouncedSearch || undefined,
          sort: sortBy,
          order: sortOrder
        })

        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(await response.text())
        }

        const payload = (await response.json()) as AssetResponse
        setItems((previous) => (append ? [...previous, ...payload.items] : payload.items))
        setNextCursor(payload.nextCursor)
        setTotalCount(payload.total)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load assets'
        setError(message)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [root, currentPath, pageSize, debouncedSearch, sortBy, sortOrder]
  )

  useEffect(() => {
    void fetchAssets(0, false)
  }, [fetchAssets])

  const openDirectory = (path: string) => {
    setCurrentPath(path)
  }

  const goUp = () => {
    if (!currentPath) return
    const parent = currentPath.includes('/')
      ? currentPath.slice(0, currentPath.lastIndexOf('/'))
      : ''
    setCurrentPath(parent)
  }

  const refresh = () => {
    void fetchAssets(0, false)
  }

  const loadMore = () => {
    if (nextCursor === null || loadingMore) return
    void fetchAssets(nextCursor, true)
  }

  const removeAsset = async (item: AssetItem) => {
    const ok = window.confirm(`Delete ${item.name}?`)
    if (!ok) return

    const response = await fetch('/btrfb/file/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: item.root, path: item.path })
    })

    if (!response.ok) {
      const message = await response.text()
      window.app?.extensionManager.toast.add({
        severity: 'error',
        summary: 'Delete Failed',
        detail: message,
        life: 4000
      })
      return
    }

    window.app?.extensionManager.toast.add({
      severity: 'success',
      summary: 'Deleted',
      detail: item.name,
      life: 1800
    })
    if (selected?.path === item.path && selected.root === item.root) {
      setSelected(null)
    }
    void fetchAssets(0, false)
  }

  const renameAsset = async (item: AssetItem) => {
    const nextName = window.prompt('Rename To', item.name)
    if (!nextName || nextName === item.name) return

    const response = await fetch('/btrfb/file/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: item.root, path: item.path, newName: nextName })
    })

    if (!response.ok) {
      const message = await response.text()
      window.app?.extensionManager.toast.add({
        severity: 'error',
        summary: 'Rename Failed',
        detail: message,
        life: 4000
      })
      return
    }

    void fetchAssets(0, false)
  }

  const createFolder = async () => {
    const name = window.prompt('Folder Name')
    if (!name) return
    const response = await fetch('/btrfb/file/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: currentPath, name })
    })

    if (!response.ok) {
      const message = await response.text()
      window.app?.extensionManager.toast.add({
        severity: 'error',
        summary: 'Create Folder Failed',
        detail: message,
        life: 4000
      })
      return
    }

    void fetchAssets(0, false)
  }

  const previewUrl = selected
    ? buildUrl('/btrfb/file', { root: selected.root, path: selected.path })
    : null

  const controlButtonClass =
    'rounded-md border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--btrfb-text)] shadow-sm transition hover:bg-[color:var(--btrfb-surface-strong)]'

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden bg-[color:var(--btrfb-surface)] p-3 text-[color:var(--btrfb-text)]">
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold tracking-wide">Btr File Browser</h2>
        <div className="inline-flex rounded-md border border-[color:var(--btrfb-border)] p-0.5">
          <button
            className={`rounded px-2.5 py-1 text-xs font-medium transition ${
              root === 'output'
                ? 'bg-[color:var(--btrfb-surface-strong)] text-[color:var(--btrfb-text)]'
                : 'text-[color:var(--btrfb-text-soft)] hover:bg-white/5'
            }`}
            onClick={() => {
              setRoot('output')
              setCurrentPath('')
            }}
          >
            Output
          </button>
          <button
            className={`rounded px-2.5 py-1 text-xs font-medium transition ${
              root === 'input'
                ? 'bg-[color:var(--btrfb-surface-strong)] text-[color:var(--btrfb-text)]'
                : 'text-[color:var(--btrfb-text-soft)] hover:bg-white/5'
            }`}
            onClick={() => {
              setRoot('input')
              setCurrentPath('')
            }}
          >
            Input
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        <input
          className="col-span-2 rounded-md border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-strong)] px-3 py-1.5 text-xs text-[color:var(--btrfb-text)] placeholder:text-[color:var(--btrfb-text-soft)] focus:outline-none"
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder="Search Images Or Videos"
        />
        <select
          className={controlButtonClass}
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as SortType)}
        >
          <option value="mtime">Sort: Modified Time</option>
          <option value="name">Sort: Name</option>
          <option value="size">Sort: Size</option>
        </select>
        <button
          className={controlButtonClass}
          onClick={() => setSortOrder((value) => (value === 'desc' ? 'asc' : 'desc'))}
          title="Toggle Sort Order"
        >
          {sortOrder === 'desc' ? 'Descending' : 'Ascending'}
        </button>
        <button className={controlButtonClass} onClick={refresh}>
          Refresh
        </button>
        <button className={controlButtonClass} onClick={createFolder}>
          New Folder
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button className={controlButtonClass} onClick={goUp} disabled={!currentPath}>
          Up
        </button>
        {breadcrumbs.map((crumb) => (
          <button
            key={crumb.path || 'root'}
            className="rounded-full border border-[color:var(--btrfb-border)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[color:var(--btrfb-text-soft)] transition hover:bg-white/5"
            onClick={() => openDirectory(crumb.path)}
          >
            {crumb.label}
          </button>
        ))}
      </div>

      <div className="text-[11px] font-medium text-[color:var(--btrfb-text-soft)]">{totalCount} Assets</div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/15 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div
        className="grid flex-1 auto-rows-max content-start gap-2 overflow-y-auto pr-1"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`
        }}
      >
        {loading && items.length === 0
          ? Array.from({ length: 10 }).map((_, idx) => (
              <div
                key={`s-${idx}`}
                className="aspect-square animate-pulse rounded-xl border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-strong)]"
              />
            ))
          : items.map((item) => {
              const thumbUrl =
                item.type === 'file' && (item.mediaType === 'image' || enableVideoThumb)
                  ? buildUrl('/btrfb/thumb', {
                      root: item.root,
                      path: item.path,
                      w: thumbSize,
                      h: thumbSize,
                      format: thumbFormat
                    })
                  : null

              return (
                <article
                  key={`${item.type}-${item.path}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-strong)]"
                >
                  <button
                    className="relative aspect-square border-b border-[color:var(--btrfb-border)] bg-black/20"
                    onClick={() => {
                      if (item.type === 'dir') {
                        openDirectory(item.path)
                      } else {
                        setSelected(item)
                      }
                    }}
                  >
                    {item.type === 'dir' ? (
                      <div className="grid h-full w-full place-items-center text-xs font-semibold tracking-wide text-[color:var(--btrfb-text-soft)]">
                        Folder
                      </div>
                    ) : thumbUrl ? (
                      <LazyRender>
                        <img
                          className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                          src={thumbUrl}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                        />
                      </LazyRender>
                    ) : (
                      <div className="grid h-full w-full place-items-center text-xs font-semibold tracking-wide text-[color:var(--btrfb-text-soft)]">
                        File
                      </div>
                    )}

                    {item.type === 'file' && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0">
                        <div className="h-14 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />
                        <div className="absolute inset-x-0 bottom-0 px-2 pb-2 text-left">
                          <p className="truncate text-[11px] font-medium text-white/95">{item.name}</p>
                        </div>
                      </div>
                    )}
                  </button>

                  <div className="space-y-1 px-2.5 py-2">
                    <div className="text-[10px] text-[color:var(--btrfb-text-soft)]">
                      {item.type === 'dir' ? 'Folder' : item.mediaType === 'video' ? 'Video' : 'Image'}
                    </div>
                    <div className="truncate text-[10px] text-[color:var(--btrfb-text-soft)]">
                      {formatDate(item.mtime)}
                    </div>
                    <div className="text-[10px] text-[color:var(--btrfb-text-soft)]">
                      {item.type === 'dir' ? '-' : formatBytes(item.size)}
                    </div>
                  </div>

                  <div className="mt-auto grid grid-cols-2 border-t border-[color:var(--btrfb-border)]">
                    <button
                      className="border-r border-[color:var(--btrfb-border)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--btrfb-text-soft)] transition hover:bg-white/5 hover:text-[color:var(--btrfb-text)]"
                      onClick={() => renameAsset(item)}
                    >
                      Rename
                    </button>
                    <button
                      className="px-2 py-1.5 text-[11px] font-medium text-[color:var(--btrfb-text-soft)] transition hover:bg-red-500/10 hover:text-red-300"
                      onClick={() => void removeAsset(item)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )
            })}
      </div>

      {nextCursor !== null && (
        <div className="flex justify-center pt-1">
          <button className={controlButtonClass} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load More'}
          </button>
        </div>
      )}

      {selected && previewUrl && (
        <div
          className="fixed inset-0 z-[2000] grid place-items-center bg-black/75 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[color:var(--btrfb-border)] bg-[color:var(--btrfb-surface-strong)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[color:var(--btrfb-border)] p-3">
              <div className="min-w-0">
                <strong className="block truncate text-sm text-[color:var(--btrfb-text)]">{selected.name}</strong>
                <div className="truncate text-xs text-[color:var(--btrfb-text-soft)]">{selected.path}</div>
              </div>
              <button className={controlButtonClass} onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <div className="overflow-auto p-2">
              {selected.mediaType === 'video' ? (
                <video className="mx-auto max-h-[75vh] max-w-full rounded-lg" controls preload="metadata" src={previewUrl} />
              ) : (
                <img className="mx-auto max-h-[75vh] max-w-full rounded-lg" src={previewUrl} alt={selected.name} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
