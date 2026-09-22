import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SystemConfigRepository } from '../src/system-config-store.js';

test('concurrent stale snapshots merge their independent changes instead of overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-system-config-'));
  const repository = new SystemConfigRepository(join(directory, 'system-config.json'));
  try {
    await repository.update((current) => ({
      ...current,
      tempConfig: { baseline: true },
      lastUpdated: 1,
    }));

    const first = await repository.load();
    const second = await repository.load();
    assert.ok(first);
    assert.ok(second);

    await Promise.all([
      repository.save({
        ...first,
        wateringConfig: { productSide: 'saved' },
        lastUpdated: 2,
      }),
      repository.save({
        ...second,
        mqttConfig: { mqttEnabled: true, brokerUrl: 'mqtt://example.local:1883' },
        lastUpdated: 3,
      }),
    ]);

    const final = await repository.load();
    assert.deepEqual(final?.tempConfig, { baseline: true });
    assert.deepEqual(final?.wateringConfig, { productSide: 'saved' });
    assert.deepEqual(final?.mqttConfig, { mqttEnabled: true, brokerUrl: 'mqtt://example.local:1883' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('update serializes true read-modify-write mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-system-config-update-'));
  const repository = new SystemConfigRepository(join(directory, 'system-config.json'));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => repository.update((current) => ({
      ...current,
      tempConfig: {
        count: Number((current.tempConfig as { count?: number } | undefined)?.count ?? 0) + 1,
        lastIndex: index,
      },
      lastUpdated: Date.now(),
    }))));

    const final = await repository.load();
    assert.equal((final?.tempConfig as { count?: number } | undefined)?.count, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows read-only config files remain persistable', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-system-config-readonly-'));
  const file = join(directory, 'system-config.json');
  const repository = new SystemConfigRepository(file);
  try {
    await repository.update((current) => ({ ...current, tempConfig: { version: 1 }, lastUpdated: 1 }));
    await chmod(file, 0o444);

    await repository.update((current) => ({ ...current, tempConfig: { version: 2 }, lastUpdated: 2 }));

    const final = await repository.load();
    assert.deepEqual(final?.tempConfig, { version: 2 });
  } finally {
    await chmod(file, 0o666).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
