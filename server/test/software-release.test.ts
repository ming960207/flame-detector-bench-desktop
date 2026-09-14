import { execFile as execFileCallback } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { resolveSoftwareRepositoryRoot } from '../src/software-release.js';

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
