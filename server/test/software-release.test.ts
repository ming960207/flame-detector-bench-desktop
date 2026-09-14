import { execFile as execFileCallback } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildSoftwareReleaseLaunch, resolveSoftwareRepositoryRoot } from '../src/software-release.js';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('resolves the project root when the backend starts from its server directory', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'flame-software-release-root-'));
  const serverRoot = join(temporaryRoot, 'server');
  try {
    await mkdir(join(temporaryRoot, 'scripts'), { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(temporaryRoot, 'package.json'), '{}', 'utf8');
    await writeFile(join(temporaryRoot, 'scripts', 'update-current-branch.ps1'), '', 'utf8');

    assert.equal(resolveSoftwareRepositoryRoot(serverRoot), temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('software release PowerShell scripts pass parser validation', async () => {
  const parseCommand = (scriptPath: string) => {
    const escapedPath = scriptPath.replace(/'/g, "''");
    return `[scriptblock]::Create([System.IO.File]::ReadAllText('${escapedPath}')) | Out-Null`;
  };

  for (const scriptName of ['update-current-branch.ps1', 'rollback-last-update.ps1']) {
    await execFile('powershell.exe', [
      '-NoProfile',
      '-Command',
      parseCommand(join(projectRoot, 'scripts', scriptName)),
    ]);
  }
});

test('launches software release scripts through an independent cmd process', () => {
  assert.deepEqual(buildSoftwareReleaseLaunch('D:\\repo\\scripts\\update-current-branch.ps1', ['-StartAfterUpdate']), {
    command: 'cmd.exe',
    args: [
      '/d',
      '/c',
      'start',
      '',
      '/b',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'D:\\repo\\scripts\\update-current-branch.ps1',
      '-StartAfterUpdate',
    ],
  });
});

test('independent cmd launcher keeps a PowerShell operation alive after its caller exits', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'flame-software-release-launch-'));
  const scriptPath = join(temporaryRoot, 'probe.ps1');
  const markerPath = join(temporaryRoot, 'started.txt');
  try {
    const escapedMarkerPath = markerPath.replace(/'/g, "''");
    await writeFile(scriptPath, `[System.IO.File]::WriteAllText('${escapedMarkerPath}', 'started')`, 'utf8');
    const launch = buildSoftwareReleaseLaunch(scriptPath, []);
    const launcherCode = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(${JSON.stringify(launch.command)}, ${JSON.stringify(launch.args)}, { cwd: ${JSON.stringify(temporaryRoot)}, detached: true, stdio: 'ignore', windowsHide: true });`,
      'child.unref();',
    ].join('');

    await execFile(process.execPath, ['-e', launcherCode], { cwd: temporaryRoot });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await access(markerPath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.fail('PowerShell operation did not start after its caller exited');
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('cmd update entrypoint explicitly loads the PowerShell utility module', async () => {
  const [entrypoint, updateScript, rollbackScript] = await Promise.all([
    readFile(join(projectRoot, 'update-current-version.cmd'), 'utf8'),
    readFile(join(projectRoot, 'scripts', 'update-current-branch.ps1'), 'utf8'),
    readFile(join(projectRoot, 'scripts', 'rollback-last-update.ps1'), 'utf8'),
  ]);

  assert.match(entrypoint, /where powershell\.exe/);
  assert.match(entrypoint, /powershell\.exe -NoProfile/);
  assert.match(updateScript, /Import-Module Microsoft\.PowerShell\.Utility/);
  assert.match(rollbackScript, /Import-Module Microsoft\.PowerShell\.Utility/);
});
