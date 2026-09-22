import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSyncProductDraft } from '../../components/ProductTypeControl.tsx';
import type { ProductDetectionConfig } from '../src/product-profile.js';

function config(): ProductDetectionConfig {
  return {
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: {
        label: '双波长',
        productModel: 'GHT-1050-02',
        expectedProbeCount: 2,
        expectedSoftwareVersion: '90.26.08.11',
        skipSoftwareVersionCheck: false,
        relayFunctionalTestEnabled: false,
        productCodeRule: {
          enabled: true,
          productNameCode: '4102',
          softwareVersionCode: '01',
          hardwareVersionCode: '01',
          producerCode: '01',
        },
      },
    },
  } as ProductDetectionConfig;
}

test('后台刷新不能覆盖产品配置未保存的复选框草稿', () => {
  const synced = config();
  const draft = structuredClone(synced);
  draft.profiles.DUAL_WAVELENGTH.skipSoftwareVersionCheck = true;

  assert.equal(shouldSyncProductDraft(draft, synced, structuredClone(synced)), false);
});

test('无脏修改或保存成功后允许用最新后台配置同步草稿', () => {
  const synced = config();
  assert.equal(shouldSyncProductDraft(structuredClone(synced), synced, structuredClone(synced)), true);

  const saved = structuredClone(synced);
  saved.profiles.DUAL_WAVELENGTH.skipSoftwareVersionCheck = true;
  assert.equal(shouldSyncProductDraft(saved, synced, structuredClone(saved)), true);
});
