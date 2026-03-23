import { ComfyApp } from '@comfyorg/comfyui-frontend-types'
import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'

import './index.css'
import './utils/i18n'

declare global {
  interface Window {
    app?: ComfyApp
  }
}

const App = React.lazy(() => import('./App'))

const EXTENSION_NAME = 'ComfyUI.BtrFileBrowser'
const ROOT_ID = 'comfyui-btr-file-browser-root'

function waitForApp(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (window.app) {
      resolve()
      return
    }

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      if (window.app || Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

function registerExtension(app: ComfyApp): void {
  ;(app as any).registerExtension({
    name: EXTENSION_NAME,
    settings: [
      {
        id: 'btrfb.defaultRoot',
        name: 'Default root folder',
        type: 'combo',
        defaultValue: 'output',
        options: [
          { text: 'output', value: 'output' },
          { text: 'input', value: 'input' }
        ],
        category: ['Btr File Browser', 'General', 'Default root folder']
      },
      {
        id: 'btrfb.thumbSize',
        name: 'Thumbnail size',
        type: 'number',
        defaultValue: 176,
        attrs: {
          min: 96,
          max: 320,
          step: 16,
          showButtons: true
        },
        category: ['Btr File Browser', 'Performance', 'Thumbnail size']
      },
      {
        id: 'btrfb.pageSize',
        name: 'Page size',
        type: 'number',
        defaultValue: 120,
        attrs: {
          min: 40,
          max: 400,
          step: 20,
          showButtons: true
        },
        category: ['Btr File Browser', 'Performance', 'Page size']
      },
      {
        id: 'btrfb.thumbFormat',
        name: 'Thumbnail format',
        type: 'combo',
        defaultValue: 'webp',
        options: [
          { text: 'webp', value: 'webp' },
          { text: 'jpeg', value: 'jpeg' }
        ],
        category: ['Btr File Browser', 'Performance', 'Thumbnail format']
      },
      {
        id: 'btrfb.enableVideoThumb',
        name: 'Generate video thumbnails',
        type: 'boolean',
        defaultValue: true,
        category: ['Btr File Browser', 'Performance', 'Generate video thumbnails']
      }
    ]
  })

  ;(app.extensionManager as any).registerSidebarTab({
    id: 'comfyui-btr-file-browser',
    icon: 'pi pi-folder-open',
    title: 'File Browser',
    tooltip: 'Browse input/output assets',
    type: 'custom',
    render: (element: HTMLElement) => {
      if (element.querySelector(`#${ROOT_ID}`)) {
        return
      }

      const container = document.createElement('div')
      container.id = ROOT_ID
      container.style.height = '100%'
      element.appendChild(container)

      ReactDOM.createRoot(container).render(
        <React.StrictMode>
          <Suspense fallback={<div className="btrfb-loading">Loading file browser...</div>}>
            <App />
          </Suspense>
        </React.StrictMode>
      )
    }
  })
}

async function initialize(): Promise<void> {
  await waitForApp()
  if (!window.app) {
    console.error('[BtrFileBrowser] Comfy app is not available')
    return
  }
  registerExtension(window.app)
}

void initialize()
