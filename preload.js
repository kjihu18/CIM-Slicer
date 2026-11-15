const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cimDesktopBridge', {
  isElectron: true,
  loadAllSync: () => {
    try {
      return ipcRenderer.sendSync('storage:loadAllSync');
    } catch (e) {
      console.warn('[CIM Desktop Bridge] loadAllSync failed:', e);
      return {};
    }
  },
  getItemSync: (key) => {
    try {
      return ipcRenderer.sendSync('storage:getItemSync', key);
    } catch (e) {
      console.warn('[CIM Desktop Bridge] getItemSync failed:', e);
      return null;
    }
  },
  setItem: (key, value) => {
    return ipcRenderer.invoke('storage:setItem', key, value);
  },
  saveAll: (data) => {
    return ipcRenderer.invoke('storage:saveAll', data);
  },
  getVersion: () => {
    try {
      return ipcRenderer.sendSync('app:getVersion');
    } catch (e) {
      return '1.0.0';
    }
  },
  getUserDataPath: () => {
    try {
      return ipcRenderer.sendSync('app:getUserDataPath');
    } catch (e) {
      return '';
    }
  }
});
