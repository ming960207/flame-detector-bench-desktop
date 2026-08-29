const { app, BrowserWindow, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_BACKEND_PORT = 3003;
const desktopApiToken = crypto.randomBytes(32).toString('hex');

let mainWindow;
let backendRuntime;
let stopping = false;

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function getServerRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server')
    : path.join(getProjectRoot(), 'server');
}

function prepareRuntimeData() {
  if (!app.isPackaged) return undefined;
  const dataDirectory = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dataDirectory, { recursive: true });
  for (const fileName of ['system-config.json', 'plc-configs.json']) {
    const source = path.join(getServerRoot(), fileName);
    const target = path.join(dataDirectory, fileName);
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
  }
  return dataDirectory;
}

async function startBackend(port) {
  const serverEntry = path.join(getServerRoot(), 'dist', 'main.js');
  if (!fs.existsSync(serverEntry)) throw new Error(`未找到后端构建文件：${serverEntry}`);
  process.env.NODE_ENV = 'production';
  process.env.SERVER_PORT = String(port);
  process.env.DESKTOP_EMBEDDED_SERVER = '1';
  process.env.CLOSURE_MODE = 'field';
  process.env.DESKTOP_API_TOKEN = desktopApiToken;
  const dataDirectory = prepareRuntimeData();
  if (dataDirectory) process.env.APP_DATA_DIR = dataDirectory;
  const serverModule = await import(pathToFileURL(serverEntry).href);
  backendRuntime = await serverModule.startConfiguredServer();
}

function readBackendPort(args) {
  let raw = String(DEFAULT_BACKEND_PORT);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--backend-port' && index + 1 < args.length) {
      raw = args[index + 1];
      break;
    }
    if (token.startsWith('--backend-port=')) {
      raw = token.slice('--backend-port='.length);
      break;
    }
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效的正式程序后端端口：${raw}`);
  }
  return port;
}

function waitForBackend(port) {
  const deadline = Date.now() + 30000;
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => Date.now() >= deadline
      ? reject(new Error('本地后端在 30 秒内未就绪'))
      : setTimeout(check, 250);
    check();
  });
}

function installBackendSessionHeader(window, port) {
  const exactHttpPrefix = `http://127.0.0.1:${port}/`;
  const exactWsPrefix = `ws://127.0.0.1:${port}/`;
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (details.url.startsWith(exactHttpPrefix) || details.url.startsWith(exactWsPrefix)) {
        headers['X-Desktop-Session'] = desktopApiToken;
      }
      callback({ requestHeaders: headers });
    },
  );
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
      additionalArguments: [`--desktop-backend-port=${port}`],
    },
  });
  installBackendSessionHeader(mainWindow, port);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
}

async function stopBackend() {
  if (!backendRuntime) return;
  stopping = true;
  const runtime = backendRuntime;
  backendRuntime = undefined;
  await runtime.close();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    try {
      const port = readBackendPort(process.argv);
      await startBackend(port);
      await waitForBackend(port);
      await createWindow(port);
    } catch (error) {
      dialog.showErrorBox('火焰探测器检测台启动失败', error instanceof Error ? error.message : String(error));
      await stopBackend();
      app.quit();
    }
  });
  app.on('before-quit', (event) => {
    if (stopping || !backendRuntime) return;
    event.preventDefault();
    void stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
