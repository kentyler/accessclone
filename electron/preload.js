/**
 * Preload script - exposes safe APIs to renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('save-api-key', apiKey),

  // Project setup
  selectAccessDatabase: () => ipcRenderer.invoke('select-access-database'),
  selectDestinationFolder: () => ipcRenderer.invoke('select-destination-folder'),
  saveProjectSettings: (settings) => ipcRenderer.invoke('save-project-settings', settings),

  // Chat
  sendMessage: (message) => ipcRenderer.invoke('send-message', message),

  // Commands (user must approve in UI)
  runCommand: (command) => ipcRenderer.invoke('run-command', command),

  // Files
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),

  // Setup status
  checkSetup: () => ipcRenderer.invoke('check-setup'),
  launchApp: () => ipcRenderer.invoke('launch-app'),

  // Install log
  getInstallLog: () => ipcRenderer.invoke('get-install-log'),
  clearInstallLog: () => ipcRenderer.invoke('clear-install-log'),
  setCurrentDirectory: (dir) => ipcRenderer.invoke('set-current-directory', dir)
});
