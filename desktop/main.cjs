const { app, BrowserWindow, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('util');
const { pathToFileURL } = require('url');

const DEFAULT_BACKEND_PORT = 3003;
const LOG_RETENTION_DAYS = 30;
const LOG_MAX_SESSION_FILES = 60;
const desktopApiToken = crypto.randomBytes(32).toString('hex');

let mainWindow;
let backendRuntime;
let stopping = false;
let loggingInitError;
let logDirectory;
let sessionLogPath;
let latestLogPath;
let streamCaptureInstalled = false;

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function getLogDirectory() {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), 'logs')
    : path.join(getProjectRoot(), 'logs');
}

function logTimestamp() {
  return new Date().toISOString();
}

function sessionStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeDiagnostic(scope, message) {
  if (!sessionLogPath || !latestLogPath) return;
  const line = `[${logTimestamp()}][${scope}] ${String(message).replace(/\r?\n/g, '\n')}\r\n`;
  try {
    fs.appendFileSync(sessionLogPath, line, 'utf8');
    fs.appendFileSync(latestLogPath, line, 'utf8');
  } catch (error) {
    loggingInitError ??= error;
  }
}

function cleanupOldLogs(directory) {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const sessionFiles = fs.readdirSync(directory)
    .filter((name) => /^flame-detector-.*\.log$/i.test(name) && name.toLowerCase() !== 'latest.log')
    .map((name) => {
      const fullPath = path.join(directory, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const [index, file] of sessionFiles.entries()) {
    if (file.mtimeMs < cutoff || index >= LOG_MAX_SESSION_FILES) {
      try { fs.unlinkSync(file.fullPath); } catch { /* best-effort retention cleanup */ }
    }
  }
}

function mirrorStream(scope, originalWrite, chunk, encoding, callback) {
  try {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
      : String(chunk);
    const normalized = text.replace(/\r?\n$/, '');
    if (normalized) writeDiagnostic(scope, normalized);
  } catch { /* logging must never break stdout/stderr */ }
  return originalWrite(chunk, encoding, callback);
}

function installProcessStreamCapture() {
  if (streamCaptureInstalled) return;
  streamCaptureInstalled = true;

  if (process.stdout && typeof process.stdout.write === 'function') {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => mirrorStream('STDOUT', originalStdoutWrite, chunk, encoding, callback);
  }
  if (process.stderr && typeof process.stderr.write === 'function') {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, encoding, callback) => mirrorStream('STDERR', originalStderrWrite, chunk, encoding, callback);
  }
}

function initializeLogging() {
  try {
    logDirectory = getLogDirectory();
    fs.mkdirSync(logDirectory, { recursive: true });
    cleanupOldLogs(logDirectory);
    sessionLogPath = path.join(logDirectory, `flame-detector-${sessionStamp()}-pid${process.pid}.log`);
    latestLogPath = path.join(logDirectory, 'latest.log');
    fs.writeFileSync(sessionLogPath, '', 'utf8');
    fs.writeFileSync(latestLogPath, '', 'utf8');
    installProcessStreamCapture();
    writeDiagnostic('BOOT', `日志初始化完成 session=${sessionLogPath}`);
  } catch (error) {
    loggingInitError = error;
  }
}

function describeError(error) {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return util.inspect(error, { depth: 8, breakLength: 160 });
}

function installProcessDiagnostics() {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeDiagnostic('PROCESS/UNCAUGHT', `${origin}: ${describeError(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    writeDiagnostic('PROCESS/REJECTION', describeError(reason));
  });
  process.on('warning', (warning) => {
    writeDiagnostic('PROCESS/WARNING', describeError(warning));
  });
}

function logRuntimeEnvironment(port) {
  writeDiagnostic('BOOT', `app=${app.getName()} version=${app.getVersion()} packaged=${app.isPackaged}`);
  writeDiagnostic('BOOT', `exe=${process.execPath}`);
  writeDiagnostic('BOOT', `resources=${process.resourcesPath}`);
  writeDiagnostic('BOOT', `logs=${logDirectory}`);
  writeDiagnostic('BOOT', `platform=${process.platform} arch=${process.arch} pid=${process.pid}`);
  writeDiagnostic('BOOT', `electron=${process.versions.electron ?? '-'} chrome=${process.versions.chrome ?? '-'} node=${process.versions.node ?? '-'}`);
  writeDiagnostic('BOOT', `backendPort=${port} argv=${process.argv.map((value) => JSON.stringify(value)).join(' ')}`);
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
  writeDiagnostic('BOOT', `runtimeData=${dataDirectory}`);
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
  writeDiagnostic('BACKEND', `开始加载 ${serverEntry}`);
  const startedAt = Date.now();
  const serverModule = await import(pathToFileURL(serverEntry).href);
  backendRuntime = await serverModule.startConfiguredServer();
  writeDiagnostic('BACKEND', `启动完成 durationMs=${Date.now() - startedAt}`);
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
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) {
          writeDiagnostic('BACKEND', `健康检查通过 durationMs=${Date.now() - startedAt} status=${response.statusCode}`);
          return resolve();
        }
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
  window.webContents.session.webRequest.onErrorOccurred(
    { urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] },
    (details) => {
      writeDiagnostic('NETWORK/ERROR', `${details.method ?? '-'} ${details.url} error=${details.error ?? '-'} resource=${details.resourceType ?? '-'}`);
    },
  );
}

function installRendererDiagnostics(window) {
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level && typeof level === 'object') {
      writeDiagnostic('RENDERER/CONSOLE', util.inspect(level, { depth: 6, breakLength: 160 }));
      return;
    }
    writeDiagnostic(`RENDERER/${String(level).toUpperCase()}`, `${sourceId || '-'}:${line || 0} ${message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    writeDiagnostic('RENDERER/GONE', util.inspect(details, { depth: 6, breakLength: 160 }));
  });
  window.webContents.on('unresponsive', () => writeDiagnostic('RENDERER/UNRESPONSIVE', 'renderer became unresponsive'));
  window.webContents.on('responsive', () => writeDiagnostic('RENDERER/RESPONSIVE', 'renderer responsive again'));
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeDiagnostic('RENDERER/LOAD_FAIL', `code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`);
  });
  window.webContents.on('did-finish-load', () => writeDiagnostic('RENDERER/LOAD', 'did-finish-load'));
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
  installRendererDiagnostics(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => {
    writeDiagnostic('RENDERER', 'ready-to-show');
    mainWindow.show();
  });
  const page = path.join(app.getAppPath(), 'dist', 'index.html');
  writeDiagnostic('RENDERER', `loadFile=${page}`);
  await mainWindow.loadFile(page);
}

async function stopBackend() {
  if (!backendRuntime) return;
  stopping = true;
  const runtime = backendRuntime;
  backendRuntime = undefined;
  writeDiagnostic('BACKEND', '开始关闭');
  const startedAt = Date.now();
  await runtime.close();
  writeDiagnostic('BACKEND', `关闭完成 durationMs=${Date.now() - startedAt}`);
}

initializeLogging();
installProcessDiagnostics();

if (!app.requestSingleInstanceLock()) {
  writeDiagnostic('BOOT', '检测到已有实例，当前实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    writeDiagnostic('BOOT', '收到第二实例启动请求');
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    try {
      if (loggingInitError) {
        throw new Error(`无法在程序同目录创建调试日志：${getLogDirectory()}\n${describeError(loggingInitError)}`);
      }
      const port = readBackendPort(process.argv);
      logRuntimeEnvironment(port);
      await startBackend(port);
      await waitForBackend(port);
      await createWindow(port);
      writeDiagnostic('BOOT', '桌面程序启动完成');
    } catch (error) {
      writeDiagnostic('BOOT/FAIL', describeError(error));
      dialog.showErrorBox(
        '火焰探测器检测台启动失败',
        `${error instanceof Error ? error.message : String(error)}\n\n调试日志：${sessionLogPath || getLogDirectory()}`,
      );
      await stopBackend();
      app.quit();
    }
  });
  app.on('before-quit', (event) => {
    writeDiagnostic('BOOT', '收到退出请求');
    if (stopping || !backendRuntime) return;
    event.preventDefault();
    void stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', (_event, exitCode) => writeDiagnostic('BOOT', `进程退出 exitCode=${exitCode}`));
}
