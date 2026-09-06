// MSIX loopback probe — main process.
// Mirrors Lamponi's Windows system-audio path exactly:
//   electron-audio-loopback initMain() registers the enable/disable IPC, the
//   renderer calls enable then getDisplayMedia({video:true,audio:true}), keeps
//   the audio track and drops the video track.
// The ONLY variable under test is whether the app is running inside an MSIX
// container. Everything else is held identical between the two runs.
const { app, BrowserWindow, ipcMain } = require('electron')
const { initMain } = require('electron-audio-loopback')
const fs = require('fs')
const path = require('path')

initMain()

// Electron sets process.windowsStore=true when running from an MSIX/AppX
// container. That is how each run labels its own result file.
const MODE = process.windowsStore ? 'msix' : 'plain'
const OUT_DIR = 'C:\\probeout'
const OUT_FILE = path.join(OUT_DIR, `result-${MODE}.json`)

function writeResult(payload) {
  const body = {
    mode: MODE,
    windowsStore: !!process.windowsStore,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    execPath: process.execPath,
    finishedAt: new Date().toISOString(),
    ...payload
  }
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(OUT_FILE, JSON.stringify(body, null, 2))
    console.log('PROBE_RESULT ' + JSON.stringify(body))
  } catch (e) {
    console.error('failed to write result:', e && e.message)
  }
}

ipcMain.on('probe:result', (_e, payload) => {
  writeResult(payload)
  setTimeout(() => app.exit(0), 300)
})

// Never let a hang look like a pass.
const watchdog = setTimeout(() => {
  writeResult({ ok: false, stage: 'watchdog', error: 'probe did not report within 90s' })
  app.exit(3)
}, 90000)
watchdog.unref?.()

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Autoplay of the probe tone must not be gated by a user gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.webContents.on('console-message', (_e, _lvl, message) => {
    console.log('[renderer] ' + message)
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())
