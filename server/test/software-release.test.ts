import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveSoftwareRepositoryRoot } from '../src/software-release.js';

test('resolves the project root when the backend starts from its server directory', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'flame-software-release-root-'));
  const serverRoot = join(projectRoot, 'server');
  try {
    await mkdir(join(projectRoot, 'scripts'), { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), '{}', 'utf8');
    await writeFile(join(projectRoot, 'scripts', 'update-current-branch.ps1'), '', 'utf8');

    assert.equal(resolveSoftwareRepositoryRoot(serverRoot), projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
