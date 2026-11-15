const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function getStorageFilePath() {
  const userData = app.getPath('userData');
  return path.join(userData, 'cim_slicer_storage.json');
}

function readStorageData() {
  try {
    const filePath = getStorageFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn('[CIM Slicer Storage] Failed to read storage file:', err.message);
  }
  return {};
}

function writeStorageData(data) {
  try {
    const filePath = getStorageFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[CIM Slicer Storage] Failed to write storage file:', err.message);
    return false;
  }
}

const FORBIDDEN_STORAGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeStorageKey(key) {
  return typeof key === 'string' && key.length > 0 && !FORBIDDEN_STORAGE_KEYS.has(key);
}

// IPC Handlers for synchronous initial load & async updates
ipcMain.on('storage:loadAllSync', (event) => {
  event.returnValue = readStorageData();
});

ipcMain.on('storage:getItemSync', (event, key) => {
  if (!isSafeStorageKey(key)) {
    event.returnValue = undefined;
    return;
  }
  const data = readStorageData();
  event.returnValue = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
});

ipcMain.handle('storage:setItem', (event, key, value) => {
  if (!isSafeStorageKey(key)) {
    return false;
  }
  const data = readStorageData();
  data[key] = value;
  return writeStorageData(data);
});

ipcMain.handle('storage:saveAll', (event, allData) => {
  if (!allData || typeof allData !== 'object' || Array.isArray(allData)) {
    return false;
  }
  const sanitized = {};
  for (const key of Object.keys(allData)) {
    if (isSafeStorageKey(key)) {
      sanitized[key] = allData[key];
    }
  }
  return writeStorageData(sanitized);
});

ipcMain.on('app:getVersion', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on('app:getUserDataPath', (event) => {
  event.returnValue = app.getPath('userData');
});

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0c0e',
    title: 'CIM Slicer 0.4.0 - Jihu Studio',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile('index.html');

  // Block in-app navigation away from local application files
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsed = new URL(navigationUrl);
      if (parsed.protocol !== 'file:') {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  // Deny all popup windows; only allow explicit https external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
