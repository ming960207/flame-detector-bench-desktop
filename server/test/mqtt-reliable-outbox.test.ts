import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MQTT_OUTBOX_BACKLOG_WARNING_THRESHOLD, ReliableMQTTOutbox } from '../src/mqtt-reliable-outbox.js';

test('reliable outbox keeps more than the old 100-message limit without eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-mqtt-outbox-'));
  const file = join(directory, 'outbox.json');
  try {
    const outbox = new ReliableMQTTOutbox(file);
    const count = MQTT_OUTBOX_BACKLOG_WARNING_THRESHOLD + 25;
    for (let index = 0; index < count; index += 1) {
      assert.equal(outbox.set(`production:batch-${index}`, {
        topic: 'dt/up/test/inspection',
        payload: { batch: index },
        queuedAt: 1_000 + index,
      }), true);
    }

    assert.equal(outbox.size, count);
    assert.equal(outbox.status().backlogWarning, true);
    assert.equal(outbox.status().oldestPendingAt, 1_000);

    const restored = new ReliableMQTTOutbox(file);
    assert.equal(restored.size, count);
    assert.equal(restored.entries()[0]?.[0], 'production:batch-0');
    assert.equal(restored.entries().at(-1)?.[0], `production:batch-${count - 1}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt outbox is preserved instead of silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-mqtt-corrupt-'));
  const file = join(directory, 'outbox.json');
  try {
    await writeFile(file, '{not-json', 'utf8');
    const outbox = new ReliableMQTTOutbox(file);
    const status = outbox.status();
    assert.equal(status.persistenceHealthy, false);
    assert.match(status.lastError ?? '', /MQTT_OUTBOX_READ_FAILED/);

    const names = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    const preserved = names.find((name) => name.startsWith('outbox.json.corrupt-'));
    assert.ok(preserved);
    assert.equal(await readFile(join(directory, preserved!), 'utf8'), '{not-json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
