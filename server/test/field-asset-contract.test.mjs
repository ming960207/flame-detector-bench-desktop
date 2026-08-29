import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import {
  hasVerticalAddressContract,
  hasVerticalFeedbackWithSafeTimeout,
} from '../../scripts/field-readiness.mjs';

const assetRoot = process.env.FIELD_ASSET_ROOT ?? 'D:/code/PLC/SMART200-FLAME';

test('current PLC and HMI assets share the I0.3/I0.4 vertical limit contract', async () => {
  const [awl, flow, hmiProcess, hmiManual] = await Promise.all([
    readFile(join(assetRoot, 'Process_4Stage_DIDO_IMPORT.awl'), 'utf8'),
    readFile(join(assetRoot, '工序流程.txt'), 'utf8'),
    readFile(join(assetRoot, 'hmi_assets', 'current_process_controls_latest.csv'), 'utf8'),
    readFile(join(assetRoot, 'hmi_assets', 'manual_page_controls_latest.csv'), 'utf8'),
  ]);
  const sourceText = `${awl}\n${flow}\n${hmiProcess}\n${hmiManual}`;

  assert.equal(hasVerticalFeedbackWithSafeTimeout(awl), true);
  assert.equal(hasVerticalAddressContract(awl, flow, hmiProcess, hmiManual), true);
  assert.match(sourceText, /\bI0\.3\b/);
  assert.match(sourceText, /\bI0\.4\b/);
  assert.doesNotMatch(sourceText, /\bI1\.3\b|\bI1\.4\b/);
});
