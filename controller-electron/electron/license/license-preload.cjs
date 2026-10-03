"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bbLicense", {
  ready: () => ipcRenderer.send("license:ready"),
  activate: (key) => ipcRenderer.invoke("license:activate", key),
  recheck: () => ipcRenderer.invoke("license:recheck"),
  quit: () => ipcRenderer.send("license:quit"),
  minimize: () => ipcRenderer.send("license:minimize"),
  onState: (cb) => ipcRenderer.on("license:state", (_e, payload) => cb(payload)),
  onLocked: (cb) => ipcRenderer.on("license:locked", (_e, state) => cb(state))
});
