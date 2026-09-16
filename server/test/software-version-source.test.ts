import { execFile as execFileCallback } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { softwareVersionRevListArgs } from '../src/software-release.js';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd });
  return String(result.stdout ?? '').trim();
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('software version resolver ignores diagnostic-only Git commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flame-software-version-source-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Version Test']);
    await git(root, ['config', 'user.email', 'version-test@example.invalid']);

    await writeFile(join(root, 'app.txt'), 'software-v1\n', 'utf8');
    const softwareV1 = await commitAll(root, 'feat: software v1');

    await mkdir(join(root, 'diagnostic-logs', 'run-1'), { recursive: true });
    await writeFile(join(root, 'diagnostic-logs', 'run-1', 'latest.log'), 'run 1\n', 'utf8');
    await commitAll(root, 'logs: auto upload completed test');

    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'runtime.log'), 'runtime diagnostics\n', 'utf8');
    await commitAll(root, 'logs: runtime diagnostics');

    assert.equal(await git(root, softwareVersionRevListArgs('HEAD')), softwareV1);

    await writeFile(join(root, 'app.txt'), 'software-v2\n', 'utf8');
    await writeFile(join(root, 'diagnostic-logs', 'run-1', 'latest.log'), 'run 1 updated\n', 'utf8');
    const softwareV2 = await commitAll(root, 'fix: software plus diagnostics');

    assert.equal(await git(root, softwareVersionRevListArgs('HEAD')), softwareV2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updater targets latest software commit instead of remote repository tip', async () => {
  const script = await readFile(join(projectRoot, 'scripts', 'update-current-branch.ps1'), 'utf8');

  assert.match(script, /function Get-LatestSoftwareCommit/);
  assert.match(script, /'\:\(exclude\)diagnostic-logs\/\*\*'/);
  assert.match(script, /'\:\(exclude\)logs\/\*\*'/);
  assert.match(script, /\$repositoryTipCommit = \(& git rev-parse \$remoteRef\)\.Trim\(\)/);
  assert.match(script, /\$remoteCommit = Get-LatestSoftwareCommit \$repositoryTipCommit/);
  assert.match(script, /git checkout -f -B \$targetBranch \$remoteCommit/);
  assert.doesNotMatch(script, /fast-forward local branch to latest log-only commit/i);
});

test('diagnostic uploader commits on remote tip without moving local software HEAD', async () => {
  const script = await readFile(join(projectRoot, 'scripts', 'upload-current-logs.ps1'), 'utf8');

  assert.match(script, /\$softwareHead = \(& git rev-parse HEAD\)\.Trim\(\)/);
  assert.match(script, /\$env:GIT_INDEX_FILE = \$tempIndex/);
  assert.match(script, /git read-tree \$remoteTip/);
  assert.match(script, /git commit-tree \$tree -p \$remoteTip -m \$commitMessage/);
  assert.match(script, /push origin "\$\{newCommit\}:refs\/heads\/\$branch"/);
  assert.match(script, /if \(\$afterSoftwareHead -ne \$softwareHead\)/);
  assert.doesNotMatch(script, /git commit --only/);
});
