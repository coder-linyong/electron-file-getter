import { app, BrowserWindow, DownloadItem, Session, shell, WebContents } from 'electron'
import addNetListener from './net-listener/main'
import { CancelError, DownloadFile, DownloadOption, DownloadProgress, NetStatus } from './interface.js'
import { startNetListener } from './net-listener/browser'
import { getFilenameFromMime, unusedFilename } from './utils/filename'
import { majorElectronVersion } from './utils/version'
import { getWindowFromWebContents } from './utils/window'
import * as path from 'path'

const sessions = new Set<Session>()
const sessionListeners = new Map<Session, Set<DownloadItem>>()
const downloadItems = new Set<DownloadItem>()
let receivedBytes = 0
let totalBytes = 0
const activeDownloadItems = () => downloadItems.size
const progressDownloadItems = () => receivedBytes / totalBytes

addNetListener(
  () => {
    downloadItems.forEach((item) => item.resume())
  },
  () => {
  }
)
startNetListener()

function registerListener (
  session: Session,
  options: DownloadOption,
  callback: (err: CancelError | null, item: DownloadItem) => void = () => {
  }
) {
  options = {
    showBadge: true,
    showProgressBar: true,
    ...options
  }

  const listener = (_: any, item: DownloadItem, webContents: WebContents) => {
    downloadItems.add(item)

    const errorMessage = options.errorMessage || 'The download of {filename} was interrupted'

    const window =
      majorElectronVersion() >= 12
        ? BrowserWindow.fromWebContents(webContents)
        : getWindowFromWebContents(webContents)

    item.on('updated', () => {
      totalBytes = 0
      receivedBytes = 0
      for (const item of downloadItems) {
        receivedBytes += item.getReceivedBytes()
        totalBytes += item.getTotalBytes()
      }

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.badgeCount = activeDownloadItems()
      }

      if (window && !window.isDestroyed() && options.showProgressBar) {
        window.setProgressBar(progressDownloadItems())
      }

      if (typeof options.onProgress === 'function') {
        const itemTransferredBytes = item.getReceivedBytes()
        const itemTotalBytes = item.getTotalBytes()

        options.onProgress(
          {
            percent: itemTotalBytes ? itemTransferredBytes / itemTotalBytes : 0,
            transferredBytes: itemTransferredBytes,
            totalBytes: itemTotalBytes
          },
          item
        )
      }

      if (typeof options.onTotalProgress === 'function') {
        options.onTotalProgress(
          {
            percent: progressDownloadItems(),
            transferredBytes: receivedBytes,
            totalBytes
          },
          item
        )
      }
    })
    item.on('done', (_, state) => {
      downloadItems.delete(item)

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.badgeCount = activeDownloadItems()
      }

      if (window && !window.isDestroyed() && !activeDownloadItems()) {
        window.setProgressBar(-1)
        receivedBytes = 0
        totalBytes = 0
      }

      if (state === 'cancelled') {
        if (typeof options.onCancel === 'function') {
          options.onCancel(item)
        }
        callback(new CancelError(), item)
      } else if (state === 'interrupted') {
        callback(new Error(errorMessage), item)
      } else if (state === 'completed') {
        const savePath = item.getSavePath()

        if (process.platform === 'darwin') {
          app.dock.downloadFinished(savePath)
        }

        if (options.openFolderWhenDone) {
          shell.showItemInFolder(savePath)
        }

        if (typeof options.onCompleted === 'function') {
          options.onCompleted(
            {
              filename: item.getFilename(),
              path: savePath,
              fileSize: item.getReceivedBytes(),
              mimeType: item.getMimeType(),
              url: item.getURL()
            },
            item
          )
        }

        callback(null, item)
      }
    })

    if (options.directory && !path.isAbsolute(options.directory)) {
      throw new Error('The `directory` option must be an absolute path')
    }

    const directory = options.directory || app.getPath('downloads')

    let filePath: string
    if (options.filename) {
      filePath = path.join(directory, options.filename)
    } else {
      const filename = item.getFilename()
      const name = path.extname(filename)
        ? filename
        : getFilenameFromMime(filename, item.getMimeType())

      filePath = options.overwrite
        ? path.join(directory, name)
        : unusedFilename(path.join(directory, name))
    }

    if (options.saveAs) {
      item.setSaveDialogOptions({defaultPath: filePath, ...options.dialogOptions})
    } else {
      item.setSavePath(filePath)
    }

    if (typeof options.onStarted === 'function') {
      options.onStarted(item)
    }
  }

  if (sessions.has(session)) {
    return
  }
  sessions.add(session)
  session.on('will-download', listener)
}

export async function download (window: BrowserWindow, url: string, options: DownloadOption = {}): Promise<CancelError | DownloadItem> {
  return new Promise((resolve, reject) => {
    options = {
      ...options
    }

    window.on('closed', () => {
      sessionListeners.delete(window.webContents.session)
    })

    registerListener(window.webContents.session, options, (error, item) => {
      if (error) {
        reject(error)
      } else {
        resolve(item)
      }
    })

    window.webContents.downloadURL(url)
  })
}

export {
  DownloadFile,
  DownloadProgress,
  DownloadOption, NetStatus
}