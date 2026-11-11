import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { defaultConfig, scan } from './scanner'
import { macPlatform } from './platform'
import { RemovalService } from './removal'
import { trashWithFinder } from './finder-trash'
import type { ReviewRequest, ScanSnapshot } from '../shared/api'

let window: BrowserWindow | null = null
let snapshot: ScanSnapshot | null = null
let scanning = false,
  removing = false,
  reviewing = false
const iconCache = new Map<string, string | null>()
const config = defaultConfig()
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#141a17' : '#f8faf8')
async function loadBundleIcon(bundlePath: string): Promise<string | null> {
  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(bundlePath, {
      width: 32,
      height: 32
    })
    if (thumbnail.isEmpty()) return null
    return `data:image/png;base64,${thumbnail.toPNG().toString('base64')}`
  } catch {
    return null
  }
}
const removal = new RemovalService(
  config,
  macPlatform,
  async (path) => {
    if (!app.isPackaged && process.env.MACSTODIAN_VERIFY_READ_ONLY === '1')
      throw new Error('Trash is disabled during read-only verification.')
    await shell.trashItem(path)
  },
  {
    async approve(path) {
      if (!window || (!app.isPackaged && process.env.MACSTODIAN_VERIFY_READ_ONLY === '1'))
        return false
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Try moving this item with Finder?',
        message: 'Macstodian could not move this item to Trash because access was denied.',
        detail: `${path}\n\nFinder may be able to move it, or macOS may ask for permission. The item will still go to Trash, not be permanently deleted.`,
        buttons: ['Cancel', 'Try with Finder'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return response === 1
    },
    async trash(path) {
      if (!app.isPackaged && process.env.MACSTODIAN_VERIFY_READ_ONLY === '1')
        throw new Error('Finder Trash is disabled during read-only verification.')
      await trashWithFinder(path)
    }
  }
)

function registerIPC() {
  const handle = (channel: string, action: (payload: unknown) => unknown) =>
    ipcMain.handle(channel, (event, payload: unknown) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted IPC sender.')
      return action(payload)
    })
  handle('storage:scan', async () => {
    if (process.platform !== 'darwin') throw new Error('Macstodian scans macOS only.')
    if (scanning || removing || reviewing)
      throw new Error('A scan, review, or removal is already in progress.')
    scanning = true
    snapshot = null
    removal.setSnapshot(null)
    try {
      const result = await scan(config, macPlatform, (progress) =>
        window?.webContents.send('storage:progress', progress)
      )
      removal.setSnapshot(result)
      snapshot = result.view
      return result.view
    } finally {
      scanning = false
    }
  })
  handle('storage:app-icons', async (payload) => {
    if (
      !Array.isArray(payload) ||
      payload.length > 512 ||
      payload.some((id) => typeof id !== 'string')
    )
      throw new Error('Invalid application icon request.')
    if (!snapshot) throw new Error('No scan is available for application icons.')

    const apps = new Map(snapshot.apps.map((app) => [app.id, app]))
    const icons: Record<string, string | null> = {}
    const loadIcon = async (id: string) => {
        const appInfo = apps.get(id)
        if (!appInfo) {
          icons[id] = null
          return
        }
        const cached = iconCache.get(appInfo.path)
        if (cached !== undefined) {
          icons[id] = cached
          return
        }
        try {
          const dataUrl = await loadBundleIcon(appInfo.path)
          iconCache.set(appInfo.path, dataUrl)
          icons[id] = dataUrl
        } catch {
          iconCache.set(appInfo.path, null)
          icons[id] = null
        }
    }
    for (let index = 0; index < payload.length; index += 8)
      await Promise.all(payload.slice(index, index + 8).map(loadIcon))
    return icons
  })
  handle('storage:review', async (payload) => {
    if (scanning || removing || reviewing)
      throw new Error('Wait for the current operation to finish.')
    reviewing = true
    try {
      return await removal.review(payload as ReviewRequest)
    } finally {
      reviewing = false
    }
  })
  handle('storage:confirm', async (payload) => {
    if (typeof payload !== 'string' || scanning || removing || reviewing)
      throw new Error('Invalid removal request or operation in progress.')
    removing = true
    try {
      return await removal.confirm(payload)
    } finally {
      removing = false
    }
  })
  handle('storage:reveal', async (payload) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('scanId' in payload) ||
      !('itemId' in payload) ||
      typeof payload.scanId !== 'string' ||
      typeof payload.itemId !== 'string'
    )
      throw new Error('Invalid reveal request.')
    const path = await removal.reveal(payload.scanId, payload.itemId)
    shell.showItemInFolder(path)
  })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: 'Macstodian',
    backgroundColor: windowBackground(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  const devOrigin =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : null
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const local = url.protocol === 'file:' || url.protocol === 'devtools:'
    const dev =
      !!devOrigin &&
      (url.origin === devOrigin || (url.protocol === 'ws:' && `http://${url.host}` === devOrigin))
    callback({ cancel: !local && !dev })
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    window = null
  })
}

app.whenReady().then(() => {
  app.setName('Macstodian')
  nativeTheme.themeSource = 'system'
  nativeTheme.on('updated', () => window?.setBackgroundColor(windowBackground()))
  registerIPC()
  createWindow()
  app.on('activate', () => {
    if (!window) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
