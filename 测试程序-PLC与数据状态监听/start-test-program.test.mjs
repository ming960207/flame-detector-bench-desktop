import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLaunchPlan, validateLaunchPlan } from './start-test-program.mjs';

test('launch plan runs JavaScript entry points directly without a command shell', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'test-program-launch-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const currentDir = join(root, '测试程序-PLC与数据状态监听');
  await mkdir(join(root, 'server', 'node_modules', 'tsx', 'dist'), { recursive: true });
  await mkdir(join(root, 'server', 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'), ''),
    writeFile(join(root, 'server', 'src', 'test-program-main.ts'), ''),
    writeFile(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ''),
  ]);

  const plan = createLaunchPlan({ currentDir, execPath: 'portable-node.exe' });
  await validateLaunchPlan(plan);

  assert.equal(plan.backend.command, 'portable-node.exe');
  assert.equal(plan.frontend.command, 'portable-node.exe');
  assert.equal(plan.backend.options.shell, false);
  assert.equal(plan.frontend.options.shell, false);
  assert.equal(plan.backend.args.at(-1), join(root, 'server', 'src', 'test-program-main.ts'));
  assert.equal(plan.frontend.args[0], join(root, 'node_modules', 'vite', 'bin', 'vite.js'));
});

test('copied launcher folder alone fails with actionable distribution guidance', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'test-program-incomplete-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const currentDir = join(root, '测试程序-PLC与数据状态监听');
  await mkdir(currentDir, { recursive: true });
  const plan = createLaunchPlan({ currentDir, execPath: 'node.exe' });

  await assert.rejects(
    validateLaunchPlan(plan),
    /当前文件夹不能单独作为源码运行包复制.*FlameDetectorTestProgram\.exe/s,
  );
});
