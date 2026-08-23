// Use preloadRequire for Electron preload scripts
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

contextBridge.exposeInMainWorld('electronAPI', {
  path: path,
  fs: fs,
  selectFiles: () => ipcRenderer.invoke('select-files'),
  processFiles: (filePaths) => ipcRenderer.invoke('process-files', filePaths),
  saveSRT: (srtContent, defaultName) => ipcRenderer.invoke('save-srt', srtContent, defaultName),
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  mergeVideos: (options) => ipcRenderer.invoke('merge-videos', options),
  sortFilesByDate: (filePaths) => ipcRenderer.invoke('sort-files-by-date', filePaths),
  checkNominatim: () => ipcRenderer.invoke('check-nominatim'),
  startNominatim: () => ipcRenderer.invoke('start-nominatim'),
  stopNominatim: () => ipcRenderer.invoke('stop-nominatim'),
  getNominatimLogs: () => ipcRenderer.invoke('get-nominatim-logs'),
  onProgress: (callback) => {
    ipcRenderer.on('progress', (event, data) => callback(data));
  },
  onMergeProgress: (callback) => {
    ipcRenderer.on('merge-progress', (event, data) => callback(data));
  },
  // ===== Dashcam Merger =====
  dashcamPickFolder: () => ipcRenderer.invoke('dashcam:pick-folder'),
  dashcamPickOutput: () => ipcRenderer.invoke('dashcam:pick-output'),
  dashcamScanFolder: (folder) => ipcRenderer.invoke('dashcam:scan-folder', folder),
  dashcamProbe: (filePath) => ipcRenderer.invoke('dashcam:probe', filePath),
  dashcamMerge: (options) => ipcRenderer.invoke('dashcam:merge', options),
  dashcamCancel: () => ipcRenderer.invoke('dashcam:cancel'),
  dashcamReveal: (filePath) => ipcRenderer.invoke('dashcam:reveal', filePath),
  dashcamDetectResume: (options) => ipcRenderer.invoke('dashcam:detect-resume', options),
  dashcamDiscardResume: (options) => ipcRenderer.invoke('dashcam:discard-resume', options),
  dashcamSplit: (options) => ipcRenderer.invoke('dashcam:split', options),
  dashcamPickSplitFolder: () => ipcRenderer.invoke('dashcam:pick-folder'),
  dashcamPickSplitFiles: () => ipcRenderer.invoke('dashcam:pick-split-files'),
  onDashcamProgress: (callback) => {
    ipcRenderer.on('dashcam:progress', (event, data) => callback(data));
  }
});
