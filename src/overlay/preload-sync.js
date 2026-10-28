const { ipcRenderer } = require('electron');

window.__OVERLAY_SYNC__ = {
  importMarkers: (payload) => {
    ipcRenderer.send('appsample:import-markers', payload);
  },
  getOverlayMarkers: () => {
    return ipcRenderer.invoke('appsample:get-markers');
  },
  notify: (msg) => {
    ipcRenderer.send('appsample:notify', msg);
  }
};
