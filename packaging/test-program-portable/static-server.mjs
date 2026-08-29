import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

const args = new Map();
for (let index = 0; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  args.set(token, next && !next.startsWith('--') ? next : 'true');
}

const host = args.get('--host') || '127.0.0.1';
const port = Number(args.get('--port') || '3002');
const backendPort = Number(args.get('--backend-port') || '3003');
const root = resolve(args.get('--root') || process.cwd());

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid frontend port: ${port}`);
}
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
  throw new Error(`Invalid backend port: ${backendPort}`);
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const runtimeScript = `<script>window.desktopRuntime=${JSON.stringify({
  backendHttpUrl: `http://127.0.0.1:${backendPort}`,
  backendWsUrl: `ws://127.0.0.1:${backendPort}`,
})};</script>`;

function resolveRequestPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(root, normalize(requested));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null;
  return candidate;
}

async function findFile(pathname) {
  const direct = resolveRequestPath(pathname);
  if (!direct) return null;

  try {
    const stats = await fs.stat(direct);
    if (stats.isFile()) return direct;
    if (stats.isDirectory()) {
      const indexPath = join(direct, 'index.html');
      const indexStats = await fs.stat(indexPath);
      return indexStats.isFile() ? indexPath : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isHtmlRequest(pathname) {
  return pathname === '/' || pathname.endsWith('/index.html') || !extname(pathname);
}

async function handleRequest(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
  let filePath = await findFile(requestUrl.pathname);
  if (!filePath && isHtmlRequest(requestUrl.pathname)) {
    filePath = join(root, 'index.html');
  }
  if (!filePath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const contentType = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  if (isHtmlRequest(requestUrl.pathname)) {
    try {
      const html = await fs.readFile(filePath, 'utf8');
      const body = html.includes('</head>')
        ? html.replace('</head>', `${runtimeScript}</head>`)
        : `${runtimeScript}${html}`;
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': contentType,
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
      return;
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
  }

  try {
    const stats = await fs.stat(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': stats.size,
      'Content-Type': contentType,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal server error');
  });
});

server.on('error', (error) => {
  console.error(`[static-server] ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[static-server] serving ${root} at http://${host}:${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
