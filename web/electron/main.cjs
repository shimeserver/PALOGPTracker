const { app, BrowserWindow, shell, Menu, session } = require('electron');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: !isDev,
    },
    title: 'PALOGPTracker',
    show: false,
    backgroundColor: '#ffffff',
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        { label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => win.reload() },
        { type: 'separator' },
        { label: '終了', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: '拡大', accelerator: 'CmdOrCtrl+Plus', click: () => { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); } },
        { label: '縮小', accelerator: 'CmdOrCtrl+-', click: () => { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); } },
        { label: 'リセット', accelerator: 'CmdOrCtrl+0', click: () => { win.webContents.setZoomLevel(0); } },
        { type: 'separator' },
        ...(isDev ? [{ label: '開発者ツール', accelerator: 'F12', click: () => win.webContents.toggleDevTools() }] : []),
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Firebase Storage など外部APIへのアクセスを許可
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: " +
          "https://*.googleapis.com https://*.firebaseapp.com https://*.firebase.com " +
          "https://firebasestorage.googleapis.com https://maps.googleapis.com " +
          "https://*.openstreetmap.org https://*.tile.openstreetmap.org"
        ],
      },
    });
  });
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
