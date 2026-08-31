import { useMemo, useState } from 'react';
import { ChevronDown, Package2 } from 'lucide-react';
import {
  PRODUCT_TYPE_ORDER,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
  type ProductType,
} from '../server/src/product-profile';

interface Props {
  config: ProductDetectionConfig | null;
  locked: boolean;
  precheck: ProductPrecheckReport | null;
  busy: boolean;
  onUpdate: (patch: Partial<ProductDetectionConfig>) => Promise<void>;
  onOpenDetails?: () => void;
}

function stateLabel(precheck: ProductPrecheckReport | null, busy: boolean): { text: string; tone: string } {
  if (busy || precheck?.verdict === 'PENDING') return { text: '预检中', tone: 'is-warn' };
  if (precheck?.verdict === 'PASS') return { text: '预检通过', tone: 'is-pass' };
  if (precheck?.verdict === 'FAIL') return { text: '预检异常', tone: 'is-fail' };
  return { text: '等待预检', tone: 'is-muted' };
}

export function ProductModelDock({ config, locked, precheck, busy, onUpdate, onOpenDetails }: Props) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const profile = useMemo(() => config ? selectedProductProfile(config) : null, [config]);
  const state = stateLabel(precheck, busy);

  const switchModel = async (selectedType: ProductType) => {
    if (!config || locked || switching || selectedType === config.selectedType) return;
    setSwitching(true);
    setError('');
    try {
      await onUpdate({ selectedType });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSwitching(false);
    }
  };

  return <section className="wutos-product-model-dock" aria-label="当前生产产品型号">
    <span className="wutos-product-model-dock__icon"><Package2 /></span>
    <span className="wutos-product-model-dock__label">当前产品</span>
    <label className="wutos-product-model-dock__select-wrap">
      <select
        value={config?.selectedType ?? 'THREE_WAVELENGTH'}
        disabled={!config || locked || switching}
        onChange={(event) => void switchModel(event.target.value as ProductType)}
        title={locked ? '流程运行中型号已锁定' : '选择本批次生产型号'}
      >
        {PRODUCT_TYPE_ORDER.map((type) => {
          const item = config?.profiles[type];
          return <option value={type} key={type}>{item?.productModel?.trim() || item?.label || type}</option>;
        })}
      </select>
      <ChevronDown aria-hidden="true" />
    </label>
    <span className={`wutos-product-model-dock__state ${state.tone}`}>{locked ? '已锁定' : state.text}</span>
    {onOpenDetails && <button type="button" onClick={onOpenDetails} title="打开产品详细配置">配置</button>}
    {error && <small title={error}>型号切换失败</small>}
    {!error && profile?.expectedProbeCount ? <small>{profile.expectedProbeCount} 路探头</small> : null}
  </section>;
}
