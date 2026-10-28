// Brücke zwischen Overlay-Fenster und Hauptprozess.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'settings', 'found:all', 'found:changed', 'tracker:status', 'data:markers',
  'view', 'minimap', 'cv:track', 'window:bounds', 'map:keyM', 'nearby:done', 'notice', 'panel:toggle', 'cursor',
  'hotkey:markCurrent', 'hotkey:markAt', 'hotkey:navigateTarget', 'appsample:status'
];

contextBridge.exposeInMainWorld('overlayApi', {
  on: (channel, callback) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
  send: (channel, ...args) => {
    ipcRenderer.send(channel, ...args);
  },
  mouse: (capture) => ipcRenderer.send('overlay:mouse', capture),
  keyboard: (wanted) => ipcRenderer.send('overlay:keyboard', wanted),
  saveSettings: (patch) => ipcRenderer.send('overlay:settings', patch),
  toggleFound: (id, state) => ipcRenderer.send('overlay:found-toggle', id, state),
  nearby: (id) => ipcRenderer.send('overlay:nearby', id),
  refreshData: () => ipcRenderer.send('overlay:refresh-data'),
  hide: () => ipcRenderer.send('overlay:hide'),
  icon: (type) => ipcRenderer.invoke('overlay:icon', type),
  comments: (type, id, page) => ipcRenderer.invoke('overlay:comments', type, id, page),
  commentImage: (imagePath) => ipcRenderer.invoke('overlay:comment-image', imagePath),
  videoThumb: (videoId) => ipcRenderer.invoke('overlay:video-thumb', videoId),
  openLink: (url) => ipcRenderer.send('overlay:open-link', url),
  panelOpen: (open) => ipcRenderer.send('overlay:panel-open', open),
  openAppSampleSync: () => ipcRenderer.send('appsample:open'),
  openChromeSync: () => ipcRenderer.send('appsample:open-chrome'),
  getSyncStatus: () => ipcRenderer.invoke('appsample:get-status'),
  openKongYingMap: () => ipcRenderer.send('kongying:open'),
  launchKongYingExe: () => ipcRenderer.send('kongying:launch-exe'),
});
