"use strict";
// The entire bridge surface (window.lt). No fs, no spawn, no arbitrary paths
// cross this line — the renderer deals in setId/key and opaque ltfile:// URLs.
// pathForFile is the one exception-shaped case: Electron >= 32 removed
// File.path, so drag-to-open needs webUtils.getPathForFile here in the preload.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("lt", {
  openDialog: () => ipcRenderer.invoke("lt:openDialog"),
  openPath: (p) => ipcRenderer.invoke("lt:openPath", p),
  onOpen: (cb) => {
    ipcRenderer.on("lt:open", (_e, m) => cb(m));
  },
  recents: () => ipcRenderer.invoke("lt:recents"),
  thumbUrl: (setId, key, px) => ipcRenderer.invoke("lt:thumbUrl", setId, key, px),
  fullUrl: (setId, key) => ipcRenderer.invoke("lt:fullUrl", setId, key),
  revealInFolder: (setId, key) => ipcRenderer.invoke("lt:reveal", setId, key),
  pathForFile: (f) => {
    try {
      return webUtils.getPathForFile(f);
    } catch {
      return "";
    }
  },
  prefsGet: () => ipcRenderer.invoke("lt:prefsGet"),
  prefsSet: (p) => ipcRenderer.invoke("lt:prefsSet", p),
});
