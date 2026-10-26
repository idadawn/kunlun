import { useState } from 'react';
import { money, unitOf, type ContainerSummaryItem, type WaterProduct } from '@kunlun/shared';
import { Field, FormDialog, useApi, useDialogs, useToast } from '@kunlun/ui';
import { useAdminData } from '../data';

export function Products() {
  const { products, containers, refresh } = useAdminData();
  const dialogs = useDialogs();
  return <>
    <div className="page-head"><div><h2>水品与押金</h2><p>统一维护水品规格、零售价、配送要求和桶袋押金</p></div></div>
    <div className="product-config-grid">
      {products.length === 0 ? <p>正在加载…</p> : products.map(p => {
        const type = p.waterType === 'BUCKET_18_9L' ? 'BUCKET' : 'BAG';
        const deposit = containers.find(c => c.containerType === type);
        const unit = unitOf(p.waterType);
        return (
          <article key={p.waterType} className="setting-card product-config-card">
            <div className="product-config-heading"><h3>{p.name}</h3><button type="button" className="btn sm" onClick={() => dialogs.open(close => <ProductDialog product={p} onClose={close} onDone={refresh} />)}>编辑水品</button></div>
            <div className="setting-row"><span>规格</span><b>{p.capacityLiters} 升 / {unit}</b></div>
            <div className="setting-row"><span>包装</span><b>{p.packaging}</b></div>
            <div className="setting-row"><span>零售价</span><b>{p.retailPrice == null ? '未设置' : `¥${money(p.retailPrice)} / ${unit}`}</b></div>
            <div className="setting-row"><span>配送要求</span><b>{p.deliveryMinimum}{unit}起送 · {p.deliveryFee === 0 ? '免费' : `配送费 ¥${money(p.deliveryFee)}`}</b></div>
            <div className="product-deposit-summary">
              <div><small>{type === 'BUCKET' ? '周转桶押金' : '水袋押金'}</small><strong>{deposit ? <>¥{money(deposit.unitDeposit)} <span>/ 个</span></> : '未设置'}</strong></div>
              <button type="button" className="btn sm" disabled={!deposit} onClick={() => deposit && dialogs.open(close => <DepositPriceDialog config={deposit} onClose={close} onDone={refresh} />)}>修改押金</button>
            </div>
            <p className="product-deposit-note">押金单价修改仅影响新收押金，历史押金按原收款单价退款。</p>
          </article>
        );
      })}
    </div>
  </>;
}

function ProductDialog({ product: p, onClose, onDone }: { product: WaterProduct; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(p.name);
  const [capacity, setCapacity] = useState(String(p.capacityLiters));
  const [packaging, setPackaging] = useState(p.packaging);
  const [retail, setRetail] = useState(p.retailPrice == null ? '' : String(p.retailPrice));
  const [minimum, setMinimum] = useState(String(p.deliveryMinimum));
  return (
    <FormDialog title="编辑水品资料" onClose={onClose} onSubmit={async () => {
      await api.updateProduct(p.waterType, { name, capacityLiters: Number(capacity), packaging, retailPrice: retail === '' ? null : Number(retail), deliveryMinimum: Number(minimum) });
      await onDone();
      toast('水品资料已保存');
    }}>
      <Field label="水品名称" htmlFor="productName"><input id="productName" className="input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="每份容量（升）" htmlFor="productCapacity"><input id="productCapacity" className="input" type="number" required min={0.01} max={1000} step={0.01} value={capacity} onChange={e => setCapacity(e.target.value)} /></Field>
      <Field label="包装说明" htmlFor="productPackaging"><input id="productPackaging" className="input" required maxLength={80} value={packaging} onChange={e => setPackaging(e.target.value)} /></Field>
      <Field label="零售价（元；留空表示未设置）" htmlFor="productRetail"><input id="productRetail" className="input" type="number" min={0.01} max={99999999} step={0.01} value={retail} onChange={e => setRetail(e.target.value)} /></Field>
      <Field label="配送起送数量" htmlFor="productMinimum"><input id="productMinimum" className="input" type="number" required min={1} max={10000} step={1} value={minimum} onChange={e => setMinimum(e.target.value)} /></Field>
      <p className="membership-note">修改用于后续业务和新导出的价目表，历史单据保留原有快照。</p>
    </FormDialog>
  );
}

function DepositPriceDialog({ config, onClose, onDone }: { config: ContainerSummaryItem; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [value, setValue] = useState(String(config.unitDeposit));
  return (
    <FormDialog title="修改桶袋押金" onClose={onClose} onSubmit={async () => {
      await api.updateUnitDeposit(config.containerType, Number(value));
      await onDone();
      toast('押金标准已保存');
    }}>
      <Field label="新收押金单价（元/个）" htmlFor="unitDeposit"><input id="unitDeposit" className="input" type="number" required min={0.01} step={0.01} value={value} onChange={e => setValue(e.target.value)} /></Field>
      <p className="membership-note">只影响新收押金；历史押金仍按原收款单价退款。</p>
    </FormDialog>
  );
}
