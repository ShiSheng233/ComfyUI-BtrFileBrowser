import { ComfyApp } from '@comfyorg/comfyui-frontend-types'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import './App.css'

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
      { rootMargin: '240px' }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return <div ref={ref}>{visible ? children : <div className="btrfb-thumb-placeholder" />}</div>
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
    const parts: Breadcrumb[] = [{ label: root, path: '' }]
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
        summary: 'Delete failed',
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
    const nextName = window.prompt('New name', item.name)
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
        summary: 'Rename failed',
        detail: message,
        life: 4000
      })
      return
    }

    void fetchAssets(0, false)
  }

  const createFolder = async () => {
    const name = window.prompt('Folder name')
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
        summary: 'Create folder failed',
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

  return (
    <div className="btrfb-container">
      <header className="btrfb-header">
        <h2>Btr File Browser</h2>
        <div className="btrfb-root-toggle">
          <button
            className={root === 'output' ? 'active' : ''}
            onClick={() => {
              setRoot('output')
              setCurrentPath('')
            }}
          >
            output
          </button>
          <button
            className={root === 'input' ? 'active' : ''}
            onClick={() => {
              setRoot('input')
              setCurrentPath('')
            }}
          >
            input
          </button>
        </div>
      </header>

      <div className="btrfb-controls">
        <input
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder="Search images/videos"
        />
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortType)}>
          <option value="mtime">Sort: time</option>
          <option value="name">Sort: name</option>
          <option value="size">Sort: size</option>
        </select>
        <button
          onClick={() => setSortOrder((value) => (value === 'desc' ? 'asc' : 'desc'))}
          title="Toggle order"
        >
          {sortOrder === 'desc' ? 'DESC' : 'ASC'}
        </button>
        <button onClick={refresh}>Refresh</button>
        <button onClick={createFolder}>New Folder</button>
      </div>

      <div className="btrfb-breadcrumbs">
        <button onClick={goUp} disabled={!currentPath}>
          Up
        </button>
        {breadcrumbs.map((crumb) => (
          <button key={crumb.path || 'root'} onClick={() => openDirectory(crumb.path)}>
            {crumb.label}
          </button>
        ))}
      </div>

      <div className="btrfb-meta">{totalCount} assets</div>

      {error && <div className="btrfb-error">{error}</div>}

      <div
        className="btrfb-grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`
        }}
      >
        {loading && items.length === 0
          ? Array.from({ length: 10 }).map((_, idx) => (
              <div key={`s-${idx}`} className="btrfb-card btrfb-card-skeleton" />
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
                <article key={`${item.type}-${item.path}`} className="btrfb-card">
                  <button
                    className="btrfb-preview"
                    onClick={() => {
                      if (item.type === 'dir') {
                        openDirectory(item.path)
                      } else {
                        setSelected(item)
                      }
                    }}
                  >
                    {item.type === 'dir' ? (
                      <div className="btrfb-dir">DIR</div>
                    ) : thumbUrl ? (
                      <LazyRender>
                        <img src={thumbUrl} alt={item.name} loading="lazy" decoding="async" />
                      </LazyRender>
                    ) : (
                      <div className="btrfb-file">FILE</div>
                    )}
                  </button>

                  <div className="btrfb-card-body">
                    <div className="btrfb-name" title={item.name}>
                      {item.name}
                    </div>
                    <div className="btrfb-sub">
                      {item.type === 'dir' ? 'folder' : item.mediaType} • {formatDate(item.mtime)}
                    </div>
                    <div className="btrfb-sub">{item.type === 'dir' ? '-' : formatBytes(item.size)}</div>
                  </div>

                  <div className="btrfb-actions">
                    <button onClick={() => renameAsset(item)}>Rename</button>
                    <button onClick={() => void removeAsset(item)}>Delete</button>
                  </div>
                </article>
              )
            })}
      </div>

      {nextCursor !== null && (
        <div className="btrfb-load-more">
          <button onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}

      {selected && previewUrl && (
        <div className="btrfb-modal" onClick={() => setSelected(null)}>
          <div className="btrfb-modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="btrfb-modal-head">
              <div>
                <strong>{selected.name}</strong>
                <div className="btrfb-sub">{selected.path}</div>
              </div>
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="btrfb-modal-preview">
              {selected.mediaType === 'video' ? (
                <video controls preload="metadata" src={previewUrl} />
              ) : (
                <img src={previewUrl} alt={selected.name} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
