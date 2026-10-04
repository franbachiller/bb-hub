const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ringController", {
  getSnapshot: () => ipcRenderer.invoke("controller:getSnapshot"),
  applyTiming: (payload) => ipcRenderer.invoke("controller:applyTiming", payload),
  setTimingHotkey: (value) => ipcRenderer.invoke("controller:setTimingHotkey", value),
  checkUpdates: () => ipcRenderer.invoke("controller:checkUpdates"),
  installUpdate: () => ipcRenderer.invoke("controller:installUpdate"),
  applyMovePunch: (payload) => ipcRenderer.invoke("controller:applyMovePunch", payload),
  applyDropHunter: (payload) => ipcRenderer.invoke("controller:applyDropHunter", payload),
  saveDraftConfig: (mode, payload) => ipcRenderer.invoke("controller:saveDraftConfig", mode, payload),
  resetTickAuto: () => ipcRenderer.invoke("controller:resetTickAuto"),
  setTickAim: (value) => ipcRenderer.invoke("controller:setTickAim", value),
  applyExit: (payload) => ipcRenderer.invoke("controller:applyExit", payload),
  applyStepWalk: (payload) => ipcRenderer.invoke("controller:applyStepWalk", payload),
  applyFreeFire: (payload) => ipcRenderer.invoke("controller:applyFreeFire", payload),
  setAllies: (value) => ipcRenderer.invoke("controller:setAllies", value),
  setAutoRun: (value) => ipcRenderer.invoke("controller:setAutoRun", value),
  setEmotes: (value) => ipcRenderer.invoke("controller:setEmotes", value),
  setCocoSelf: (mode) => ipcRenderer.invoke("controller:setCocoSelf", mode),
  setCocoSelfKey: (code) => ipcRenderer.invoke("controller:setCocoSelfKey", code),
  cocoSelfNow: () => ipcRenderer.invoke("controller:cocoSelfNow"),
  setAdvanced: (value) => ipcRenderer.invoke("controller:setAdvanced", value),
  setRequeueKey: (value) => ipcRenderer.invoke("controller:setRequeueKey", value),
  requeueNow: () => ipcRenderer.invoke("controller:requeueNow"),
  resetExit: () => ipcRenderer.invoke("controller:resetExit"),
  setRingBoardArmed: (value) => ipcRenderer.invoke("controller:setRingBoardArmed", value),
  ringBoardAction: (action, value) => ipcRenderer.invoke("controller:ringBoardAction", action, value),
  setPunchPackets: (packets) => ipcRenderer.invoke("controller:setPunchPackets", packets),
  selectTarget: (targetId) => ipcRenderer.invoke("controller:selectTarget", targetId),
  rawPunch: () => ipcRenderer.invoke("controller:rawPunch"),
  stopModes: () => ipcRenderer.invoke("controller:stopModes"),
  clearLogs: () => ipcRenderer.invoke("controller:clearLogs"),
  launchGame: () => ipcRenderer.invoke("game:launch"),
  submitGameCode: (code) => ipcRenderer.invoke("game:submitCode", code),
  saveGameAccount: (username, password) => ipcRenderer.invoke("game:saveAccount", username, password),
  forgetGameAccount: () => ipcRenderer.invoke("game:forgetAccount"),
  findGameClient: () => ipcRenderer.invoke("game:findClient"),
  selectGameClient: () => ipcRenderer.invoke("game:selectClient"),
  setCombatLog: (enabled) => ipcRenderer.invoke("game:setDiagnostics", enabled),
  openCombatLogs: () => ipcRenderer.invoke("game:openCaptures"),
  onSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("controller:snapshot", handler);
    return () => ipcRenderer.removeListener("controller:snapshot", handler);
  }
});
