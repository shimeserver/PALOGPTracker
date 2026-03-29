const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

let localServer = null;

function startLocalServer(distDir) {
  return new Promise((resolve) => {
    const mimeTypes = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
    };
    localServer = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const resolvedDistDir = path.resolve(distDir);
      const resolvedFilePath = path.resolve(path.join(distDir, urlPath));
      if (!resolvedFilePath.startsWith(resolvedDistDir + path.sep) && resolvedFilePath !== resolvedDistDir) {
        res.writeHead(403); res.end(); return;
      }
      const filePath = fs.existsSync(resolvedFilePath) ? resolvedFilePath : path.join(distDir, 'index.html');
      const ext = path.extname(filePath);
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    });
    localServer.listen(0, '127.0.0.1', () => resolve(localServer.address().port));
  });
}

// Node.js native fetch（CORS無し）でFirebase Storage REST APIを直接呼ぶ
ipcMain.handle('upload-to-storage', async (event, { bucket, storagePath, idToken, data }) => {
  const buffer = Buffer.from(data);
  // Firebase Storage REST API: Authorization: Firebase {idToken} が正しい形式
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?name=${encodeURIComponent(storagePath)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Firebase ${idToken}`,
      'Content-Type': 'image/jpeg',
    },
    body: buffer,
  });
  const text = await response.text();
  if (!response.ok) {
    // フルエラーをログ出力（デバッグ用）
    console.error('[upload-to-storage] Firebase response:', response.status, text);
    throw new Error(`${response.status}: ${text}`);
  }
  return JSON.parse(text);
});

function createWindow(url) {
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
        { label: '開発者ツール', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // Google APIs (Maps, Places, Firebase Storage) へのCORSを許可
  // webSecurityは有効のままでrenderer側のXSSリスクは維持しつつ、
  // 信頼済みGoogle/Firebaseドメインへのリクエストのみ通す
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const origin = details.responseHeaders?.['access-control-allow-origin'];
    if (!origin) {
      const url = details.url || '';
      const isGoogleApi = url.includes('googleapis.com') || url.includes('firebasestorage.googleapis.com') || url.includes('maps.gstatic.com');
      if (isGoogleApi) {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Access-Control-Allow-Origin': ['*'],
          },
        });
        return;
      }
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  let url;
  if (isDev) {
    url = 'http://localhost:5173';
  } else {
    const distDir = path.join(__dirname, '../dist');
    const port = await startLocalServer(distDir);
    url = `http://127.0.0.1:${port}`;
  }
  createWindow(url);
});

app.on('window-all-closed', () => {
  if (localServer) localServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const port = localServer ? localServer.address().port : null;
    const url = isDev ? 'http://localhost:5173' : `http://127.0.0.1:${port}`;
    createWindow(url);
  }
});
