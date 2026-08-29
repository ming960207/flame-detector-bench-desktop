import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function source(relativePath) {
  return readFileSync(new URL(relativePath, new URL('../../', import.meta.url)), 'utf8');
}

test('production launchers explicitly start the field runtime', () => {
  assert.ok(projectRoot);
  const serverPackage = JSON.parse(source('server/package.json'));
  assert.equal(serverPackage.scripts['dev:field'], 'tsx watch src/field-main.ts');
  const fieldEntry = source('server/src/field-main.ts');
  assert.match(fieldEntry, /process\.env\.CLOSURE_MODE\s*=\s*['"]field['"]/);
  assert.match(fieldEntry, /process\.env\.SERVER_PORT\s*\?\?=\s*['"]3003['"]/);
  const fieldLauncher = source('start-all.bat');
  assert.match(fieldLauncher, /npm run dev:field/i);
  assert.match(fieldLauncher, /VITE_BACKEND_API_URL=http:\/\/127\.0\.0\.1:3003/i);
  assert.match(fieldLauncher, /VITE_BACKEND_WS_URL=ws:\/\/127\.0\.0\.1:3003/i);
  assert.match(fieldLauncher, /Backend\s+:\s+http:\/\/127\.0\.0\.1:3003/i);
  assert.match(fieldLauncher, /Frontend\s+:\s+http:\/\/127\.0\.0\.1:3002/i);
  const desktopSource = source('desktop/main.cjs');
  assert.match(desktopSource, /process\.env\.CLOSURE_MODE\s*=\s*['"]field['"]/);
  assert.match(desktopSource, /const DEFAULT_BACKEND_PORT\s*=\s*3003/);
  assert.match(desktopSource, /readBackendPort\(process\.argv\)/);
  assert.doesNotMatch(desktopSource, /findAvailablePort/);
  assert.match(source('desktop/webview/Program.cs'), /Environment\["CLOSURE_MODE"\]\s*=\s*"field"/);
});
