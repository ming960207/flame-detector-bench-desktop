const { contextBridge } = require('electron');

const argument = process.argv.find((value) => value.startsWith('--desktop-backend-port='));
const port = argument ? Number(argument.slice('--desktop-backend-port='.length)) : 0;

if (Number.isInteger(port) && port > 0 && port < 65536) {
  contextBridge.exposeInMainWorld('desktopRuntime', {
    backendHttpUrl: `http://127.0.0.1:${port}`,
    backendWsUrl: `ws://127.0.0.1:${port}`,
  });
}
