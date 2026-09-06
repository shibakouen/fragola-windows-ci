// Same shape as Lamponi's preload: window.<api>.loopback.enable/disable over
// the IPC channels electron-audio-loopback's initMain() registers.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probe', {
  loopback: {
    enable: () => ipcRenderer.invoke('enable-loopback-audio'),
    disable: () => ipcRenderer.invoke('disable-loopback-audio')
  },
  report: (payload) => ipcRenderer.send('probe:result', payload)
})
