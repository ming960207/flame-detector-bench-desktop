import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { waveformPreviewPoints } from '../../utils/waveform.js';

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('main detector UI keeps full-rate data but throttles React rendering to 12.5 fps', () => {
  const field = source('components/FieldProcessStatusApp.tsx');

  assert.match(field, /const DASHBOARD_UI_RENDER_INTERVAL_MS = 80;/);
  assert.match(field, /detectorStateRef\.current = next;/);
  assert.match(field, /window\.setTimeout\(callback, DASHBOARD_UI_RENDER_INTERVAL_MS\)/);
  assert.match(field, /window\.clearTimeout\(handle\)/);
  assert.doesNotMatch(field, /requestAnimationFrame\(callback\)/);
});

test('completion summary and PLC status share one coalesced dashboard render queue', () => {
  const field = source('components/FieldProcessStatusApp.tsx');

  assert.match(field, /const DASHBOARD_UI_RENDER_INTERVAL_MS = 80;/);
  assert.match(field, /dashboardRenderSchedulerRef/);
  assert.match(field, /queueDashboardUpdate\(\{\s*summary:/);
  assert.match(field, /queueDashboardUpdate\(\{\s*status:/);
  assert.match(field, /if \(!isPLCProcessComplete\(next\)\)/);
  assert.doesNotMatch(field, /setStatus\(next\)/);
  assert.doesNotMatch(field, /applySummary\(message\.payload as FieldSummaryPayload\)/);
});

test('dashboard clock no longer drives the whole dashboard once per second', () => {
  const dashboard = source('components/WutosDashboard.tsx');

  assert.match(dashboard, /const DashboardClock: FC = \(\) =>/);
  assert.match(dashboard, /<DashboardClock \/>/);
  assert.match(dashboard, /const alarms = alarmRows\(new Date\(\),/);

  const mainDashboard = dashboard.slice(dashboard.indexOf('export function WutosDashboard'));
  assert.doesNotMatch(mainDashboard, /setClock|setInterval/);
});

test('live waveform rendering avoids backdrop blur and contains repeated paint', () => {
  const styles = source('components/wutos-performance.css');

  assert.match(styles, /\.wutos-sensor-wave\s*\{[\s\S]*?contain:\s*paint;/);
  assert.match(styles, /\.wutos-live-waveform\s*\{[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(styles, /\.wutos-live-waveform\.is-collapsed\s*\{[\s\S]*?contain:\s*paint;/);
});

test('live waveform previews retain narrow peaks while bounding SVG points to display resolution', () => {
  const samples = Array.from({ length: 1000 }, () => ({ probe1: 0, probe2: 0, probe3: 0 }));
  samples[537]!.probe1 = 4000;
  samples[540]!.probe1 = -4000;

  const preview = waveformPreviewPoints(samples, 'probe1', 240);
  const indexes = preview.map((point) => point.sampleIndex);

  assert.ok(preview.length <= 240);
  assert.ok(preview.some((point) => point.sampleIndex === 537 && point.value === 4000));
  assert.ok(preview.some((point) => point.sampleIndex === 540 && point.value === -4000));
  assert.equal(indexes[0], 0);
  assert.equal(indexes.at(-1), samples.length - 1);
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right));
});
